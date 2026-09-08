import { PlatformDocument } from "../../../packages/cloudflare-gateway/src/platform-document-do.js";
import { commitPlatformDocument, createPlatformDocument } from "../../../packages/cloudflare-gateway/src/platform-commit-coordinator.js";
import { createPlatformRootRetention } from "../../../packages/cloudflare-gateway/src/platform-root-retention.js";

export { PlatformDocument };

interface Env {
  readonly DOCUMENTS: DurableObjectNamespace<PlatformDocument>;
  readonly CAS_SERVICE?: Fetcher;
  readonly CAS_STACK_ID?: string;
  readonly PLATFORM_CAS_AUTHORIZATION?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const body = await request.json<Record<string, unknown>>();
    const tenantId = String(body.tenantId ?? "tenant-1");
    const docId = String(body.docId ?? "doc-1");
    const document = env.DOCUMENTS.getByName(JSON.stringify([tenantId, docId]));
    try {
      switch (body.action) {
        case "create": {
          if (env.CAS_SERVICE && env.CAS_STACK_ID && env.PLATFORM_CAS_AUTHORIZATION) {
            const roots = createPlatformRootRetention({ stackId: env.CAS_STACK_ID, tenantId,
              fetcher: env.CAS_SERVICE, getAuthorization: async () => env.PLATFORM_CAS_AUTHORIZATION! });
            return Response.json(await createPlatformDocument(
              document, roots, body.identity as never, String(body.stateHash), Number(body.at),
            ));
          }
          await document.beginCreate(body.identity as never, String(body.stateHash));
          return Response.json(await document.createRetained(body.identity as never, String(body.stateHash), Number(body.at)));
        }
        case "read": return Response.json(await document.read());
        case "begin": return Response.json(await document.beginCommit(body.candidate as never));
        case "commit": return Response.json(await document.commitRetained(String(body.operationId), Number(body.at)));
        case "status": return Response.json(await document.commitStatus(String(body.operationId)));
        case "pending": return Response.json(await document.pendingCommit(String(body.operationId)));
        case "save": {
          if (!env.CAS_SERVICE || !env.CAS_STACK_ID || !env.PLATFORM_CAS_AUTHORIZATION) throw new Error("CAS unavailable");
          const roots = createPlatformRootRetention({ stackId: env.CAS_STACK_ID, tenantId,
            fetcher: env.CAS_SERVICE, getAuthorization: async () => env.PLATFORM_CAS_AUTHORIZATION! });
          return Response.json(await commitPlatformDocument(document, roots, body.candidate as never, Number(body.at)));
        }
        default: return new Response(null, { status: 404 });
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 409 });
    }
  },
} satisfies ExportedHandler<Env>;