import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import { adminApiContract } from "@unidocs/protocol-admin-portal";
import { AuditOperationError, createAuditEventService, type AdminContext, type AuditEventRepository } from "@unidocs/portal-service";

const queryNames = new Set(["actorId", "action", "resourceType", "documentType", "occurredFrom", "occurredTo", "limit", "cursor", "callerChannel", "toolName"]);

export function createAuditEventsHttp(repository: AuditEventRepository) {
  const contract = { list: adminApiContract.audit.list };
  const implementation = implement(contract).$context<{ admin: AdminContext; requestId: string }>();
  const service = createAuditEventService(repository);
  const router = { list: implementation.list.handler(({ input, context }) => service.list(context.admin, input.query ?? {})) };
  return async (request: Request, admin: AdminContext, requestId: string): Promise<Response> => {
    const url = new URL(request.url);
    const seen = new Set<string>();
    let invalidQuery = request.method !== "GET";
    url.searchParams.forEach((value, name) => {
      if (seen.has(name) || !queryNames.has(name) || (name === "limit" && !/^[1-9][0-9]*$/.test(value))) invalidQuery = true;
      seen.add(name);
    });
    if (invalidQuery) return Response.json({ error: { code: "invalid_request", message: "The query is invalid", requestId } }, { status: 400 });
    const handler = new OpenAPIHandler(router, {
      plugins: [new experimental_ZodSmartCoercionPlugin()],
      interceptors: [async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          if (error instanceof AuditOperationError) throw new ORPCError(error.code.toUpperCase(), {
            status: error.code === "forbidden" ? 403 : 400, message: error.message, data: { requestId },
          });
          throw error;
        }
      }],
      customErrorResponseBodyEncoder: error => {
        const code = error.status >= 500 ? "internal_error" : error.code === "BAD_REQUEST" ? "invalid_request" : error.code.toLowerCase();
        return { error: { code, message: error.status >= 500 ? "Administrator operation failed" : error.status === 400 ? "The request is invalid" : error.message, requestId } };
      },
    });
    const result = await handler.handle(request, { context: { admin, requestId } });
    return result.matched ? result.response : new Response(null, { status: 404 });
  };
}