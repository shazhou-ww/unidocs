import { SqliteCommitJournal, type TerminalCommitReceipt } from "../../../packages/cloudflare-sdk/src/commit-journal.js";
import type { CommitPayload } from "../../../packages/doctype-server-common/src/commit-request.js";
import type { CommitRequestIdentity } from "../../../packages/protocol-doc/src/commit-receipt.js";

export class CommitJournalProbe {
  readonly journal: SqliteCommitJournal;
  constructor(private readonly ctx: DurableObjectState) {
    this.journal = new SqliteCommitJournal(ctx.storage, { tenantId: "test", docType: "markdown", sessionId: "test-session" });
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS local_versions(version INTEGER PRIMARY KEY)");
  }

  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as {
      action: string; opId: string; payload: CommitPayload; receipt: TerminalCommitReceipt & CommitRequestIdentity; fail?: boolean;
    };
    try {
      switch (body.action) {
        case "begin": return Response.json(await this.journal.begin(body.opId, body.payload));
        case "recover": return Response.json(await this.journal.recoverPending());
        case "lookup": return Response.json(this.journal.lookup(body.receipt));
        case "settle": return Response.json(this.journal.settle(body.receipt, () => {
          this.ctx.storage.sql.exec("INSERT INTO local_versions VALUES (?)", body.receipt.baseVersion + 1);
          if (body.fail) throw new Error("injected local failure");
        }));
        case "versions": return Response.json(this.ctx.storage.sql.exec("SELECT version FROM local_versions ORDER BY version").toArray());
        default: return new Response("Unknown test action", { status: 400 });
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "test failure" }, { status: 409 });
    }
  }
}

export default {
  fetch(request: Request, env: { PROBE: DurableObjectNamespace }): Promise<Response> {
    return env.PROBE.get(env.PROBE.idFromName("commit-journal")).fetch(request);
  },
};