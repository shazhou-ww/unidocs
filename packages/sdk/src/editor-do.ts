/**
 * EditorDO — base Durable Object for document editing.
 *
 * Handles HTTP routing, state persistence, history management.
 * Document types provide a DocumentType config; this class wires it all together.
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

// KV keys for document context and state
const CONTEXT_KEY = "__context";       // { docType, docId }
const DOC_KEY = "__doc";               // Uint8Array (serialized document)
const HISTORY_KEY = "__history";       // DeltaEntry[]
const SNAPSHOT_INDEX_KEY = "__snapshots"; // { version, timestamp, deltaCount }[]

export interface DocContext {
  docType: string;
  docId: string;
}

export interface SnapshotRecord {
  version: string;
  timestamp: number;
  deltaCount: number;
}

async function computeHash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createEditorDO<TDoc, TQuery, TOp>(config: DocumentType<TDoc, TQuery, TOp>) {
  return class EditorDO {
    #doc: TDoc | null = null;
    #version: string = "";
    #history: HistoryEntry<TOp>[] = [];
    #snapshots: SnapshotRecord[] = [];
    #context: DocContext | null = null;
    #ctx: DurableObjectState;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.#ctx = ctx;
    }

    async #ensureLoaded(): Promise<void> {
      if (this.#doc !== null) return;

      // Load context
      this.#context = (await this.#ctx.storage.get<DocContext>(CONTEXT_KEY)) ?? null;

      // Load document
      const bytes = await this.#ctx.storage.get<Uint8Array>(DOC_KEY);
      if (bytes) {
        this.#doc = config.load(bytes);
        this.#version = await computeHash(bytes);
        this.#history = (await this.#ctx.storage.get<HistoryEntry<TOp>[]>(HISTORY_KEY)) ?? [];
        this.#snapshots = (await this.#ctx.storage.get<SnapshotRecord[]>(SNAPSHOT_INDEX_KEY)) ?? [];
      }
      // If no bytes, doc is uninitialized — create must be called first
    }

    async #persist(): Promise<string> {
      if (!this.#doc) throw new Error("Document not loaded");
      const bytes = config.save(this.#doc);
      const hash = await computeHash(bytes);
      await this.#ctx.storage.put(DOC_KEY, bytes);
      this.#version = hash;
      return hash;
    }

    async #shouldSnapshot(): Promise<boolean> {
      if (this.#snapshots.length === 0) return true;
      if (this.#history.length === 0) return false;
      const lastSnapshot = this.#snapshots[this.#snapshots.length - 1];
      const lastSnapshotTs = new Date(lastSnapshot.timestamp).getTime();
      const deltasSince = this.#history.filter(e => new Date(e.timestamp).getTime() > lastSnapshotTs).length;
      return deltasSince >= 20;
    }

    async #saveSnapshot(): Promise<void> {
      if (!this.#doc || !this.#context) return;

      const bytes = config.save(this.#doc);
      const r2Key = `${this.#context.docType}/${this.#context.docId}/${this.#version}`;

      // TODO: Store to R2 bucket
      // await env.R2.put(r2Key, bytes);

      this.#snapshots.push({
        version: this.#version,
        timestamp: Date.now(),
        deltaCount: 0, // Will be calculated on next check
      });
      await this.#ctx.storage.put(SNAPSHOT_INDEX_KEY, this.#snapshots);
    }

    async fetch(request: Request): Promise<Response> {
      await this.#ensureLoaded();

      const url = new URL(request.url);
      const method = request.method;
      const endpoint = url.pathname;

      try {
        // POST /_internal/create — create new document
        if (method === "POST" && endpoint === "/_internal/create") {
          if (this.#doc !== null) {
            return Response.json({ success: false, error: "Document already exists" }, { status: 409 });
          }

          // Extract docType and docId from headers (set by Gateway)
          const docType = request.headers.get("X-Doc-Type") || "unknown";
          const docId = request.headers.get("X-Doc-Id") || this.#ctx.id.toString();

          this.#context = { docType, docId };
          await this.#ctx.storage.put(CONTEXT_KEY, this.#context);

          const formData = await request.formData();
          const file = formData.get("file") as File | null;
          const sourceId = formData.get("sourceId") as string | null;
          const sourceVersion = formData.get("version") as string | null;

          if (file) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            this.#doc = config.load(bytes);
          } else if (sourceId) {
            // TODO: Clone from another document (worker handles this, not DO)
            return Response.json({ success: false, error: "Clone should be handled at worker level" }, { status: 400 });
          } else {
            this.#doc = config.init();
          }

          const version = await this.#persist();
          await this.#saveSnapshot(); // Initial snapshot

          return Response.json({ success: true, docId: this.#context.docId, version });
        }

        // All other endpoints require an initialized document
        if (this.#doc === null) {
          return Response.json({ success: false, error: "Document not initialized. POST /{docType}/ to create." }, { status: 404 });
        }

        // GET /_internal/export — download document
        if (method === "GET" && endpoint === "/_internal/export") {
          const bytes = config.save(this.#doc);
          // Content-Type could be provided by config, default to octet-stream
          const contentType = config.contentType || "application/octet-stream";
          return new Response(bytes, {
            headers: {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename="${this.#context?.docId || "document"}"`,
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
            baseVersion: string;
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

          // Apply all operations transactionally
          let newDoc: TDoc = this.#doc!;
          try {
            for (const op of body.operations) {
              newDoc = config.apply(op, newDoc);
            }
          } catch (err) {
            // Transaction failed — document unchanged
            return Response.json(
              { success: false, version: this.#version, error: `Delta failed: ${err}` },
              { status: 400 },
            );
          }

          // All operations succeeded — persist
          this.#doc = newDoc;
          const version = await this.#persist();

          // Record delta in history
          this.#history.push({
            version,
            timestamp: new Date().toISOString(),
            description: body.description,
            operations: body.operations,
          });
          await this.#ctx.storage.put(HISTORY_KEY, this.#history);

          // Check if we need a snapshot
          if (await this.#shouldSnapshot()) {
            await this.#saveSnapshot();
          }

          const result: ApplyResult = { success: true, version };
          return Response.json(result);
        }

        // GET /_internal/history
        if (method === "GET" && endpoint === "/_internal/history") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          let entries = this.#history;

          if (from || to) {
            const fromTs = from ? new Date(from).getTime() : 0;
            const toTs = to ? new Date(to).getTime() : Date.now();
            entries = this.#history.filter(e => {
              const ts = new Date(e.timestamp).getTime();
              return ts >= fromTs && ts <= toTs;
            });
          }

          return Response.json({ success: true, data: entries, version: this.#version });
        }

        // POST /_internal/rollback
        if (method === "POST" && endpoint === "/_internal/rollback") {
          const body = await request.json() as { version: string };

          // Find target version in history
          const targetEntry = this.#history.find(e => e.version === body.version);
          if (!targetEntry) {
            return Response.json(
              { success: false, version: this.#version, error: `Version ${body.version} not found` },
              { status: 404 },
            );
          }

          // TODO: Implement rollback by finding nearest snapshot in R2 and replaying deltas
          // For now, just return not implemented
          return Response.json(
            { success: false, version: this.#version, error: "Rollback not yet implemented (requires R2 + delta replay)" },
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
