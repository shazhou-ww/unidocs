import { AdminDirectory, AdminDirectoryError, type AdminActor, type AdminGoogleIdentity } from "../../../packages/gateway-common/src/admin-directory.js";
import { SqliteAdminDirectoryStore } from "../../../packages/cloudflare-gateway/src/admin-directory-sqlite.js";
import { AdminTypeDirectory } from "../../../packages/gateway-common/src/admin-type-directory.js";
import { adminTypeEtag } from "../../../packages/gateway-common/src/admin-type-contract.js";

export class AdminDirectoryProbe {
  private readonly directory: AdminDirectory;
  private readonly types: AdminTypeDirectory;
  private failAudit = false;

  constructor(ctx: DurableObjectState) {
    this.directory = new AdminDirectory(new SqliteAdminDirectoryStore({
      sql: {
        exec: (query, ...bindings) => {
          if (this.failAudit && query.startsWith("INSERT INTO unidocs_admin_audit")) { this.failAudit = false; throw new Error("injected audit failure"); }
          return ctx.storage.sql.exec(query, ...bindings);
        }
      },
      transactionSync: callback => ctx.storage.transactionSync(callback),
    }));
    const descriptor = { docType: "markdown", displayName: "Markdown", description: "Test type", serviceId: "test-md", storageIdentity: "test-store", audience: "test-md", protocol: "unidocs-doctype/1", editorProtocol: "0.1", formats: [".md"], capabilities: { preview: true, edit: false } };
    this.types = new AdminTypeDirectory(this.directory, [{ baseUrl: "https://types.example.com/markdown/", ...descriptor }], async input => String(input).endsWith("unidocs-doctype") ? Response.json(descriptor) : new Response(null, { headers: { "Content-Type": "text/html" } }));
  }

  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as { action: string; email: string; actor: AdminActor; identity: AdminGoogleIdentity; adminId: string; revision: number; key: string; validationId: string };
    try {
      switch (body.action) {
        case "bootstrap": return Response.json(await this.directory.bootstrap(body.email));
        case "bind": return Response.json(await this.directory.bindGoogleIdentity(body.identity));
        case "add": return Response.json(await this.directory.add(body.actor, body.email, body.key));
        case "remove": return Response.json(await this.directory.remove(body.actor, body.adminId, body.revision, body.key));
        case "list": return Response.json(await this.directory.list(body.actor));
        case "audit": return Response.json(await this.directory.listAudit(body.actor));
        case "type-validate": return Response.json(await this.types.validate(body.actor, { baseUrl: "https://types.example.com/markdown/" }));
        case "type-register": return Response.json(await this.types.register(body.actor, { baseUrl: "https://types.example.com/markdown/", enabled: true, validationId: body.validationId }, body.key));
        case "type-list": return Response.json(await this.types.list(body.actor));
        case "type-disable": {
          const current = await this.types.get(body.actor, "markdown");
          return Response.json(await this.types.update(body.actor, "markdown", adminTypeEtag(current), { enabled: false, reason: "test" }, body.key));
        }
        case "fail-audit": this.failAudit = true; return Response.json({ armed: true });
        default: return new Response("Unknown test action", { status: 400 });
      }
    } catch (error) {
      return Response.json({ error: error instanceof AdminDirectoryError ? error.code : "storage_failure" }, { status: error instanceof AdminDirectoryError ? error.status : 503 });
    }
  }
}

export default {
  fetch(request: Request, env: { PROBE: DurableObjectNamespace }): Promise<Response> {
    return env.PROBE.get(env.PROBE.idFromName("admin-directory")).fetch(request);
  },
};