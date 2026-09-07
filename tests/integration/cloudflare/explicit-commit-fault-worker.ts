import worker, { MarkdownEditor as ProductionEditor, MarkdownOperator } from "../../../packages/cloudflare-markdown/src/worker.js";
export { MarkdownOperator };

type Fault = "before-roots" | "before-pending" | "after-pending" | "after-delta" | "after-snapshot" | "after-clear" | "after-receipt" | "after-finalize";

export class MarkdownEditor extends ProductionEditor {
  readonly #state: DurableObjectState;
  readonly #arm: (fault: Fault) => void;
  readonly #faultState: () => { fired: boolean };

  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof ProductionEditor>[1]) {
    let fault: Fault | null = null;
    let fired = false;
    let registered = false;
    const fail = (stage: Fault) => {
      if (fault !== stage) return;
      fired = true; fault = null;
      throw new Error(`Injected commit failure: ${stage}`);
    };
    const sql = new Proxy(ctx.storage.sql, {
      get(target, property) {
        if (property === "exec") return (query: string, ...bindings: unknown[]) => {
          if (registered && query.startsWith("SELECT version,") && query.includes("FROM svalue_pending")) fail("before-roots");
          if (query.includes("INSERT OR REPLACE INTO svalue_pending")) fail("before-pending");
          const result = target.exec(query, ...bindings);
          if (query.includes("INSERT INTO doc_commit_intents_v1")) registered = true;
          if (query.includes("INSERT OR REPLACE INTO svalue_pending")) fail("after-pending");
          if (query.includes("INSERT OR REPLACE INTO svalue_deltas")) fail("after-delta");
          if (query.includes("INSERT OR REPLACE INTO svalue_snapshots")) fail("after-snapshot");
          if (query.startsWith("DELETE FROM svalue_pending")) fail("after-clear");
          if (query.startsWith("UPDATE doc_commit_intents_v1 SET state")) fail("after-receipt");
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const storage = new Proxy(ctx.storage, {
      get(target, property) {
        if (property === "sql") return sql;
        if (property === "transactionSync") return (callback: () => unknown) => {
          const result = target.transactionSync(callback);
          if (fault === "after-finalize" && target.sql.exec("SELECT op_id FROM doc_commit_intents_v1 WHERE state = 'committed'").toArray().length) {
            fail("after-finalize");
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const state = new Proxy(ctx, {
      get(target, property) {
        if (property === "storage") return storage;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super(state, env);
    this.#state = ctx;
    this.#arm = next => { fault = next; fired = false; registered = false; };
    this.#faultState = () => ({ fired });
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/_test/arm") {
      const { fault } = await request.json() as { fault: Fault };
      this.#arm(fault);
      return Response.json({ armed: fault });
    }
    if (path === "/_test/inspect") {
      const sql = this.#state.storage.sql;
      const exists = sql.exec("SELECT name FROM sqlite_master WHERE name = 'doc_commit_intents_v1'").toArray().length > 0;
      return Response.json({
        ...this.#faultState(),
        deltas: sql.exec("SELECT version FROM svalue_deltas ORDER BY version").toArray(),
        snapshots: sql.exec("SELECT version FROM svalue_snapshots ORDER BY version").toArray(),
        pending: sql.exec("SELECT version, commit_op_id FROM svalue_pending").toArray(),
        receipts: exists ? sql.exec("SELECT op_id, state, length(payload) AS payload_bytes FROM doc_commit_intents_v1").toArray() : [],
      });
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Parameters<typeof worker.fetch>[1]): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_test/")) {
      const objectName = url.searchParams.get("object");
      if (!objectName) return new Response("Missing test object", { status: 400 });
      return env.MARKDOWN_EDITOR.get(env.MARKDOWN_EDITOR.idFromName(objectName)).fetch(request);
    }
    return worker.fetch(request, env);
  },
};