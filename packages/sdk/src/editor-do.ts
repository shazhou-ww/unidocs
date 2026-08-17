/**
 * EditorDO — base Durable Object for document editing.
 *
 * Handles HTTP routing, state persistence, history management.
 * Document types provide a DocumentType config; this class wires it all together.
 */

import type { DocumentType } from "./types.js";
import type { HistoryEntry, ApplyResult, RollbackResult } from "./history.js";

const HISTORY_KEY = "__history";
const DOC_KEY = "__doc";
const VERSION_KEY = "__version";

export function createEditorDO<TDoc, TQuery, TOp>(config: DocumentType<TDoc, TQuery, TOp>) {
  return class EditorDO {
    #doc: TDoc | null = null;
    #version: number = 0;
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
        this.#version = (await this.#ctx.storage.get<number>(VERSION_KEY)) ?? 0;
        this.#history = (await this.#ctx.storage.get<HistoryEntry<TOp>[]>(HISTORY_KEY)) ?? [];
      } else {
        this.#doc = config.init();
        this.#version = 0;
        this.#history = [];
        await this.#persist();
      }
    }

    async #persist(): Promise<void> {
      if (!this.#doc) throw new Error("Document not loaded");
      await this.#ctx.storage.put(DOC_KEY, config.save(this.#doc));
      await this.#ctx.storage.put(VERSION_KEY, this.#version);
      await this.#ctx.storage.put(HISTORY_KEY, this.#history);
    }

    async fetch(request: Request): Promise<Response> {
      await this.#ensureLoaded();

      const url = new URL(request.url);
      const method = request.method;

      try {
        // POST /query — execute a query
        if (method === "POST" && url.pathname === "/query") {
          const q = await request.json() as TQuery;
          const result = config.query(q, this.#doc!);
          return Response.json({ success: true, data: result });
        }

        // POST /apply — apply an operation
        if (method === "POST" && url.pathname === "/apply") {
          const body = await request.json() as { operation: TOp; description: string };
          const newDoc = config.apply(body.operation, this.#doc!);
          this.#doc = newDoc;
          this.#version++;
          this.#history.push({
            version: this.#version,
            timestamp: new Date().toISOString(),
            description: body.description,
            operation: body.operation,
          });
          await this.#persist();
          const result: ApplyResult = { success: true, version: this.#version };
          return Response.json(result);
        }

        // GET /history — retrieve history entries
        if (method === "GET" && url.pathname === "/history") {
          const from = url.searchParams.get("from") ? parseInt(url.searchParams.get("from")!) : undefined;
          const to = url.searchParams.get("to") ? parseInt(url.searchParams.get("to")!) : undefined;
          const entries = this.#history.filter(e => {
            if (from !== undefined && e.version < from) return false;
            if (to !== undefined && e.version > to) return false;
            return true;
          });
          return Response.json({ success: true, data: entries });
        }

        // POST /rollback — rollback to a specific version
        if (method === "POST" && url.pathname === "/rollback") {
          const body = await request.json() as { version: number };
          if (body.version > this.#version || body.version < 0) {
            const result: RollbackResult = { success: false, version: this.#version, error: "Invalid version" };
            return Response.json(result, { status: 400 });
          }
          const result: RollbackResult = { success: false, version: this.#version, error: "Rollback not yet implemented" };
          return Response.json(result, { status: 501 });
        }

        // GET /version — current version number
        if (method === "GET" && url.pathname === "/version") {
          return Response.json({ success: true, data: this.#version });
        }

        return new Response("Not found", { status: 404 });
      } catch (err) {
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    }
  };
}
