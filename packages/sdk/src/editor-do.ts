/**
 * EditorDO — base Durable Object for document editing.
 *
 * Handles HTTP routing, state persistence, history management.
 * Document types provide a DocumentType config; this class wires it all together.
 *
 * Storage layout:
 *   KV:
 *     - docType: string (immutable)
 *     - docId: string (immutable)
 *     - snapshot: { version: number, bytes: Uint8Array } (latest known version, may lag one delta)
 *
 *   sqlite:
 *     - deltas(version INTEGER PK, timestamp INTEGER, description TEXT, operations TEXT)
 *     - snapshots(version INTEGER PK, timestamp INTEGER)
 *
 * Write order (consistency guarantee):
 *   1. sqlite INSERT delta
 *   2. KV PUT snapshot
 *   → worst case: snapshot lags one delta, but never inconsistent
 *
 * Internal endpoints (called by Gateway):
 *   POST /_internal/create    — create new document (multipart/form-data)
 *   POST /_internal/query     — query document (body: TQuery) → { data, version }
 *   POST /_internal/apply     — apply delta (body: { operations[], description, baseVersion }) → { version }
 *   GET  /_internal/export    — download document as binary
 *   GET  /_internal/history   — get delta history
 *   POST /_internal/rollback  — rollback to version (body: { version })
 */

import type { DocumentType } from "./types.js";
import type { HistoryEntry, ApplyResult, RollbackResult } from "./history.js";

// KV keys
const KEY_DOC_TYPE = "docType";
const KEY_DOC_ID = "docId";
const KEY_SNAPSHOT = "snapshot";

interface SnapshotKV {
  version: number;
  bytes: Uint8Array;
}

export interface DocContext {
  docType: string;
  docId: string;
}

export interface SnapshotRecord {
  version: number;
  timestamp: number;
}

export function createEditorDO<TDoc, TQuery, TOp>(config: DocumentType<TDoc, TQuery, TOp>) {
  return class EditorDO {
    #doc: TDoc | null = null;
    #version: number = 0;
    #ctx: DurableObjectState;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.#ctx = ctx;
    }

    async #ensureLoaded(): Promise<void> {
      if (this.#doc !== null) return;

      // Init sqlite tables
      this.#ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deltas (
          version INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          description TEXT,
          operations TEXT NOT NULL
        )
      `);
      this.#ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
          version INTEGER PRIMARY KEY,
          timestamp INTEGER NOT NULL
        )
      `);

      // Load from KV snapshot
      const snapshot = await this.#ctx.storage.get<SnapshotKV>(KEY_SNAPSHOT);
      if (snapshot) {
        this.#doc = config.load(snapshot.bytes);
        this.#version = snapshot.version;
      }

      // Replay deltas after snapshot version
      const result = this.#ctx.storage.sql.exec(
        `SELECT version, operations FROM deltas WHERE version > ? ORDER BY version ASC`,
        this.#version,
      );

      for (const row of result.toArray()) {
        const ops = JSON.parse(row.operations as string) as TOp[];
        for (const op of ops) {
          this.#doc = config.apply(op, this.#doc!);
        }
        this.#version = row.version as number;
      }

      // If we replayed any deltas, persist the updated snapshot to KV
      if (snapshot && this.#version > snapshot.version) {
        await this.#saveSnapshotKV();
      }
    }

    async #saveSnapshotKV(): Promise<void> {
      if (!this.#doc) return;
      const bytes = config.save(this.#doc);
      const snapshotKV: SnapshotKV = { version: this.#version, bytes };
      await this.#ctx.storage.put(KEY_SNAPSHOT, snapshotKV);
    }

    async #getNextVersion(): Promise<number> {
      const result = this.#ctx.storage.sql.exec(`SELECT MAX(version) as max_v FROM deltas`);
      const row = result.one();
      return (row.max_v as number) + 1;
    }

    async #shouldSnapshot(): Promise<boolean> {
      const snapResult = this.#ctx.storage.sql.exec(`SELECT MAX(version) as max_v FROM snapshots`);
      const snapRow = snapResult.one();
      const lastSnapshotVersion = (snapRow.max_v as number) ?? 0;

      const deltaResult = this.#ctx.storage.sql.exec(
        `SELECT COUNT(*) as cnt FROM deltas WHERE version > ?`,
        lastSnapshotVersion,
      );
      const deltaRow = deltaResult.one();
      const deltasSince = (deltaRow.cnt as number) ?? 0;

      return deltasSince >= 20;
    }

    async #saveSnapshot(): Promise<void> {
      // Record in sqlite snapshots table
      this.#ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO snapshots (version, timestamp) VALUES (?, ?)`,
        this.#version,
        Date.now(),
      );

      // TODO (#2): Write to R2 — key = {docType}/{docId}/{version}
    }

    async fetch(request: Request): Promise<Response> {
      await this.#ensureLoaded();

      const url = new URL(request.url);
      const method = request.method;
      const endpoint = url.pathname;

      try {
        // POST /_internal/create — create new document
        if (method === "POST" && endpoint === "/_internal/create") {
          const existingDocType = await this.#ctx.storage.get<string>(KEY_DOC_TYPE);
          if (existingDocType) {
            return Response.json({ success: false, error: "Document already exists" }, { status: 409 });
          }

          // Store immutable context in KV
          const docType = request.headers.get("X-Doc-Type") || "unknown";
          const docId = request.headers.get("X-Doc-Id") || this.#ctx.id.toString();
          await this.#ctx.storage.put(KEY_DOC_TYPE, docType);
          await this.#ctx.storage.put(KEY_DOC_ID, docId);

          const formData = await request.formData();
          const file = formData.get("file") as File | null;
          const sourceId = formData.get("sourceId") as string | null;

          if (file) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            this.#doc = config.load(bytes);
          } else if (sourceId) {
            return Response.json({ success: false, error: "Clone should be handled at worker level" }, { status: 400 });
          } else {
            this.#doc = config.init();
          }

          // Insert initial delta in sqlite
          this.#version = 1;
          this.#ctx.storage.sql.exec(
            `INSERT INTO deltas (version, timestamp, description, operations) VALUES (?, ?, ?, ?)`,
            1,
            Date.now(),
            "Document created",
            JSON.stringify([]),
          );

          // Write snapshot to KV + sqlite snapshots table
          await this.#saveSnapshotKV();
          await this.#saveSnapshot();

          return Response.json({ success: true, docId, version: 1 });
        }

        // All other endpoints require an initialized document
        if (this.#doc === null) {
          return Response.json({ success: false, error: "Document not initialized. POST /{docType}/ to create." }, { status: 404 });
        }

        // GET /_internal/export — download document
        if (method === "GET" && endpoint === "/_internal/export") {
          const bytes = config.save(this.#doc);
          const contentType = config.contentType || "application/octet-stream";
          const docId = await this.#ctx.storage.get<string>(KEY_DOC_ID);
          return new Response(bytes, {
            headers: {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename="${docId || "document"}"`,
            },
          });
        }

        // POST /_internal/query
        if (method === "POST" && endpoint === "/_internal/query") {
          const q = await request.json() as TQuery;
          const data = config.query(q, this.#doc);
          return Response.json({ success: true, data, version: this.#version });
        }

        // POST /_internal/apply — apply delta (batch of operations, transactional)
        if (method === "POST" && endpoint === "/_internal/apply") {
          const body = await request.json() as {
            operations: TOp[];
            description: string;
            baseVersion: number;
          };

          // Optimistic lock check
          if (body.baseVersion !== this.#version) {
            return Response.json(
              {
                success: false,
                version: this.#version,
                error: `Version conflict: baseVersion ${body.baseVersion} does not match current ${this.#version}`,
              },
              { status: 409 },
            );
          }

          // Apply all operations transactionally (in-memory)
          let newDoc: TDoc = this.#doc!;
          try {
            for (const op of body.operations) {
              newDoc = config.apply(op, newDoc);
            }
          } catch (err) {
            return Response.json(
              { success: false, version: this.#version, error: `Delta failed: ${err}` },
              { status: 400 },
            );
          }

          // All operations succeeded
          this.#doc = newDoc;

          // 1. sqlite: INSERT delta (first — source of truth)
          const newVersion = await this.#getNextVersion();
          this.#ctx.storage.sql.exec(
            `INSERT INTO deltas (version, timestamp, description, operations) VALUES (?, ?, ?, ?)`,
            newVersion,
            Date.now(),
            body.description,
            JSON.stringify(body.operations),
          );
          this.#version = newVersion;

          // 2. KV: PUT snapshot (may lag if crashes here, but won't be inconsistent)
          await this.#saveSnapshotKV();

          // 3. Check if we need an R2 snapshot
          if (await this.#shouldSnapshot()) {
            await this.#saveSnapshot();
          }

          const result: ApplyResult = { success: true, version: newVersion };
          return Response.json(result);
        }

        // GET /_internal/history
        if (method === "GET" && endpoint === "/_internal/history") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");

          let query = `SELECT version, timestamp, description, operations FROM deltas`;
          const params: (string | number)[] = [];
          const conditions: string[] = [];

          if (from) {
            conditions.push("version >= ?");
            params.push(parseInt(from));
          }
          if (to) {
            conditions.push("version <= ?");
            params.push(parseInt(to));
          }
          if (conditions.length > 0) {
            query += " WHERE " + conditions.join(" AND ");
          }
          query += " ORDER BY version ASC";

          const result = this.#ctx.storage.sql.exec(query, ...params);
          const entries: HistoryEntry<TOp>[] = result.toArray().map(row => ({
            version: row.version as number,
            timestamp: new Date(row.timestamp as number).toISOString(),
            description: row.description as string,
            operations: JSON.parse(row.operations as string) as TOp[],
          }));

          return Response.json({ success: true, data: entries, version: this.#version });
        }

        // POST /_internal/rollback
        if (method === "POST" && endpoint === "/_internal/rollback") {
          const body = await request.json() as { version: number };

          // Check target version exists
          const checkResult = this.#ctx.storage.sql.exec(
            `SELECT COUNT(*) as cnt FROM deltas WHERE version = ?`,
            body.version,
          );
          const exists = ((checkResult.one()).cnt as number) > 0;

          if (!exists) {
            return Response.json(
              { success: false, version: this.#version, error: `Version ${body.version} not found` },
              { status: 404 },
            );
          }

          // TODO (#3): Implement rollback with snapshot + delta replay
          return Response.json(
            { success: false, version: this.#version, error: "Rollback not yet implemented (requires #2 R2 + #3 delta replay)" },
            { status: 501 },
          );
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${endpoint}` }, { status: 404 });
      } catch (err) {
        return Response.json({ success: false, error: String(err), version: this.#version }, { status: 500 });
      }
    }
  };
}
