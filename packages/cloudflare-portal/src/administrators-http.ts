import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import { adminApiContract } from "@unidocs/protocol-admin-portal";
import {
  AdministratorOperationError,
  boundedBytes,
  createAdministratorService,
  parseStrictJson,
  type AdminContext,
  type AdministratorRepository,
} from "@unidocs/portal-service";

export function createAdministratorsHttp(repository: AdministratorRepository) {
  const contract = { list: adminApiContract.members.list, get: adminApiContract.members.get, add: adminApiContract.members.add, remove: adminApiContract.members.remove };
  const implementation = implement(contract).$context<{ admin: AdminContext; requestId: string }>();
  const service = createAdministratorService(repository);
  const router = {
    list: implementation.list.handler(({ input, context }) => service.list(context.admin, input.query ?? {})),
    get: implementation.get.handler(({ input, context }) => service.get(context.admin, input.params.adminId)),
    add: implementation.add.handler(({ input, context }) => service.add(context.admin, input.body, input.headers["idempotency-key"], context.requestId)),
    remove: implementation.remove.handler(async ({ input, context }) => {
      await service.remove(context.admin, input.params.adminId, input.headers["idempotency-key"], input.headers["if-match"], context.requestId);
      return undefined;
    }),
  };
  return async (request: Request, admin: AdminContext, requestId: string): Promise<Response> => {
    const url = new URL(request.url);
    const seen = new Set<string>();
    let invalidQuery = false;
    url.searchParams.forEach((value, name) => {
      if (request.method !== "GET" || seen.has(name) || !["limit", "cursor"].includes(name) || (name === "limit" && !/^[1-9][0-9]*$/.test(value))) invalidQuery = true;
      seen.add(name);
    });
    if (invalidQuery) return Response.json({ error: { code: "invalid_request", message: "The query is invalid", requestId } }, { status: 400 });
    if (request.method === "DELETE" && !request.headers.has("if-match")) {
      return Response.json({ error: { code: "precondition_required", message: "The If-Match precondition is required", requestId } }, { status: 428 });
    }
    const handler = new OpenAPIHandler(router, {
      plugins: request.method === "GET" ? [new experimental_ZodSmartCoercionPlugin()] : [],
      interceptors: [async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          if (error instanceof AdministratorOperationError) {
            throw new ORPCError(error.code.toUpperCase(), {
              status: {
                invalid_request: 400, not_found: 404, idempotency_conflict: 409, administrator_exists: 409, precondition_failed: 412,
                cannot_remove_self: 409, last_administrator: 409, forbidden: 403,
              }[error.code], message: error.message, data: { requestId }
            });
          }
          throw error;
        }
      }],
      customErrorResponseBodyEncoder: error => {
        const code = error.status >= 500 ? "internal_error" : error.code === "BAD_REQUEST" ? "invalid_request" : error.code.toLowerCase();
        return { error: { code, message: error.status >= 500 ? "Administrator operation failed" : error.status === 400 ? "The request is invalid" : error.message, requestId } };
      },
    });
    let boundedRequest = request;
    if (request.method === "POST") {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) {
        return Response.json({ error: { code: "invalid_request", message: "A JSON request body is required", requestId } }, { status: 400 });
      }
      try {
        if (!request.body) throw new Error();
        const content = new Uint8Array(16_384);
        let length = 0;
        for await (const chunk of boundedBytes(request.body, content.length)) {
          content.set(chunk, length);
          length += chunk.byteLength;
        }
        const body = parseStrictJson(content.subarray(0, length));
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some(field => field !== "email")) throw new Error();
        boundedRequest = new Request(request.url, { method: request.method, headers: request.headers, body: content.slice(0, length) });
      } catch {
        return Response.json({ error: { code: "invalid_request", message: "Invalid or oversized JSON request", requestId } }, { status: 400 });
      }
    }
    const result = await handler.handle(boundedRequest, { context: { admin, requestId } });
    return result.matched ? result.response : new Response(null, { status: 404 });
  };
}