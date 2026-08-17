/**
 * EditorDO — base Durable Object for document editing.
 *
 * Handles HTTP routing, state persistence, history management.
 * Document types provide a DocumentType config; this class wires it all together.
 *
 * Internal endpoints (called by Gateway):
 *   POST /_internal/create    — create new document (body: { content?: Uint8Array } | { sourceId, sourceVersion? })
 *   POST /_internal/query     — query document (body: TQuery) → { data, version }
 *   POST /_internal/apply     — apply operation (body: { operation, description, baseVersion }) → { version }
 *   GET  /_internal/history   — get history entries
 *   POST /_internal/rollback  — rollback to version (body: { version })
 */

import xxhash from "xxhash-wasm";
import type { DocumentType } from "./types.js";
import type { HistoryEntry, ApplyResult, RollbackResult } from "./history.js";

const DOC_KEY = "__doc";
const HISTORY_KEY = "__history";

// Singleton xxhash instance, lazy initialized
let hasher: Awaited<ReturnType<typeof xxhash>> | null = null;
async function getHasher() {
  if (!hasher) hasher = await xxhash();
  return hasher;
}

async function computeHash(data: Uint8Array): Promise<string> {
  const h = await getHasher();
  const bigint = h.h64Raw(data);
  return bigint.toString(16).padStart(16, "0");
}

export function createEditorDO<TDoc, TQuery, TOp>(config: DocumentType<TDoc, TQuery, TOp>) {
  return class EditorDO {
    #doc: TDoc | null = null;
    #version: string = "";
    #history: HistoryEntry<TOp>[] = [];
    #ctx: DurableObjectState;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.#ctx = ctx;
    }

    async #ensureLoaded(): Promise<void> {
      if (this.#doc !== null) return;

      const bytes = await this.#ctx.storage.get<Uint8Array>(DOC_KEY);
      if (bytes) {
        this.#doc = config.load(bytes);
        this.#version = await computeHash(config.save(this.#doc));
        this.#history = (await this.#ctx.storage.get<HistoryEntry<TOp>[]>(HISTORY_KEY)) ?? [];
      }
      // If no bytes, doc is uninitialized — create must be called first
    }

    async #persist(op?: TOp, description?: string): Promise<string> {
      if (!this.#doc) throw new Error("Document not loaded");
      const bytes = config.save(this.#doc);
      const hash = await computeHash(bytes);
      await this.#ctx.storage.put(DOC_KEY, bytes);

      if (op && description) {
        this.#history.push({
          version: hash,
          timestamp: new Date().toISOString(),
          description,
          operation: op,
        });
        await this.#ctx.storage.put(HISTORY_KEY, this.#history);
      }

      this.#version = hash;
      return hash;
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

          let body: Record<string, unknown> = {};
          if (request.body) {
            const text = await request.text();
            if (text) body = JSON.parse(text);
          }

          if (body.content) {
            // Initialize from binary content
            const content = new Uint8Array(Object.values(body.content as Record<string, number>));
            this.#doc = config.load(content);
          } else if (body.sourceId) {
            // TODO: Clone from another document (needs cross-DO communication via env)
            return Response.json({ success: false, error: "Clone not yet implemented" }, { status: 501 });
          } else {
            // Initialize empty document
            this.#doc = config.init();
          }

          const version = await this.#persist();
          return Response.json({ success: true, docId: this.#ctx.id.toString(), version });
        }

        // All other endpoints require an initialized document
        if (this.#doc === null) {
          return Response.json({ success: false, error: "Document not initialized. POST /{docType}/ to create." }, { status: 404 });
        }

        // POST /_internal/query
        if (method === "POST" && endpoint === "/_internal/query") {
          const q = await request.json() as TQuery;
          const data = config.query(q, this.#doc);
          return Response.json({ success: true, data, version: this.#version });
        }

        // POST /_internal/apply — with optimistic locking
        if (method === "POST" && endpoint === "/_internal/apply") {
          const body = await request.json() as {
            operation: TOp;
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

          const newDoc = config.apply(body.operation, this.#doc);
          this.#doc = newDoc;
          const version = await this.#persist(body.operation, body.description);
          const result: ApplyResult = { success: true, version };
          return Response.json(result);
        }

        // GET /_internal/history
        if (method === "GET" && endpoint === "/_internal/history") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          let entries = this.#history;
          if (from || to) {
            const fromIdx = from ? this.#history.findIndex(e => e.version === from) : 0;
            const toIdx = to ? this.#history.findIndex(e => e.version === to) + 1 : this.#history.length;
            entries = this.#history.slice(
              fromIdx >= 0 ? fromIdx : 0,
              toIdx > 0 ? toIdx : this.#history.length,
            );
          }
          return Response.json({ success: true, data: entries, version: this.#version });
        }

        // POST /_internal/rollback
        if (method === "POST" && endpoint === "/_internal/rollback") {
          const body = await request.json() as { version: string };
          // TODO: Implement snapshot-based rollback using stored snapshots
          return Response.json(
            { success: false, version: this.#version, error: "Rollback not yet implemented" },
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
