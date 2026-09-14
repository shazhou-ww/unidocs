import { implement, ORPCError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import { adminApiContract } from "@unidocs/protocol-admin-portal";
import { AdminOperationError, createDocumentTypeService, type AdminContext, type DocumentTypeRepository } from "@unidocs/portal-service";
import { readBoundedJsonRequest } from "./bounded-json-request.js";

export function createDocumentTypesHttp(repository: DocumentTypeRepository) {
  const contract = { list: adminApiContract.documentTypes.list, get: adminApiContract.documentTypes.get, create: adminApiContract.documentTypes.create, update: adminApiContract.documentTypes.update };
  const implementation = implement(contract).$context<{ admin: AdminContext; requestId: string }>();
  const service = createDocumentTypeService(repository);
  const router = {
    list: implementation.list.handler(({ input, context }) => service.list(context.admin, input.query ?? {})),
    get: implementation.get.handler(({ input, context }) => service.get(context.admin, input.params.documentType)),
    create: implementation.create.handler(({ input, context }) => service.create(context.admin, input.body, input.headers["idempotency-key"], context.requestId)),
    update: implementation.update.handler(({ input, context }) => service.update(context.admin, input.params.documentType, input.body,
      input.headers["idempotency-key"], input.headers["if-match"], context.requestId)),
  };
  return async (request: Request, admin: AdminContext, requestId: string): Promise<Response> => {
    const url = new URL(request.url);
    const seen = new Set<string>();
    let invalidQuery = false;
    url.searchParams.forEach((value, name) => {
      if (request.method !== "GET" || seen.has(name) || !["q", "enabled", "limit", "cursor"].includes(name) || (name === "enabled" && value !== "true" && value !== "false") || (name === "limit" && !/^[1-9][0-9]*$/.test(value))) invalidQuery = true;
      seen.add(name);
    });
    if (invalidQuery) return Response.json({ error: { code: "invalid_request", message: "The query is invalid", requestId } }, { status: 400 });
    if (request.method === "PATCH" && !request.headers.has("if-match")) {
      return Response.json({ error: { code: "precondition_required", message: "The If-Match precondition is required", requestId } }, { status: 428 });
    }
    const handler = new OpenAPIHandler(router, {
      plugins: request.method === "GET" ? [new experimental_ZodSmartCoercionPlugin()] : [],
      interceptors: [async ({ next }) => {
        try { return await next(); } catch (error) {
          if (error instanceof AdminOperationError) throw new ORPCError(error.code.toUpperCase(), { status: { invalid_request: 400, not_found: 404, idempotency_conflict: 409, precondition_failed: 412, forbidden: 403 }[error.code], message: error.message, data: { requestId } });
          throw error;
        }
      }],
      customErrorResponseBodyEncoder: error => {
        const status = error.status;
        const code = status >= 500 ? "internal_error" : error.code === "BAD_REQUEST" ? "invalid_request" : error.code.toLowerCase();
        return { error: { code, message: status >= 500 ? "Administrator operation failed" : status === 400 ? "The request is invalid" : error.message, requestId } };
      },
    });
    let boundedRequest = request;
    if (request.method === "POST" || request.method === "PATCH") {
      const bounded = await readBoundedJsonRequest(request, 16_384);
      if (!bounded.ok && bounded.reason === "not_json") {
        return Response.json({ error: { code: "invalid_request", message: "A JSON request body is required", requestId } }, { status: 400 });
      }
      const allowedFields = request.method === "POST" ? ["internalName"] : ["internalName", "typeCardBundleId", "viewBundleId", "builtinOperatorId", "enabled", "reason"];
      const allowed = (body: unknown) => typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).every(field => allowedFields.includes(field));
      if (!bounded.ok || !allowed(bounded.body)) {
        return Response.json({ error: { code: "invalid_request", message: "Invalid or oversized JSON request", requestId } }, { status: 400 });
      }
      boundedRequest = bounded.request;
    }
    const result = await handler.handle(boundedRequest, { context: { admin, requestId } });
    return result.matched ? result.response : new Response(null, { status: 404 });
  };
}