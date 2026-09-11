import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { adminApiContract } from "@unidocs/protocol-admin-portal";
import { OperatorValidationOperationError, boundedBytes, createOperatorValidationService, parseStrictJson,
  type AdminContext, type OperatorValidationKeyResolver, type OperatorValidationRepository, type OperatorValidationTransport } from "@unidocs/portal-service";

export function createOperatorValidationsHttp(repository: OperatorValidationRepository, transport: OperatorValidationTransport, keys: OperatorValidationKeyResolver, options: { readonly now?: () => Date } = {}) {
  const implementation = implement(adminApiContract.operatorValidations).$context<{ admin: AdminContext; requestId: string }>();
  const service = createOperatorValidationService(repository, transport, keys, options);
  const router = {
    create: implementation.create.handler(({ input, context }) => service.validate(context.admin, input.body, input.headers["idempotency-key"], context.requestId)),
    get: implementation.get.handler(({ input, context }) => service.get(context.admin, input.params.validationId)),
  };
  return async (request: Request, admin: AdminContext, requestId: string): Promise<Response> => {
    const url = new URL(request.url);
    if (url.search) return Response.json({ error: { code: "invalid_request", message: "The query is invalid", requestId } }, { status: 400 });
    const handler = new OpenAPIHandler(router, {
      interceptors: [async ({ next }) => {
        try { return await next(); } catch (error) {
          if (error instanceof OperatorValidationOperationError) throw new ORPCError(error.code.toUpperCase(), {
            status: { invalid_request: 400, not_found: 404, idempotency_conflict: 409, forbidden: 403, operator_validation_failed: 422 }[error.code],
            message: error.message, data: { requestId },
          });
          throw error;
        }
      }],
      customErrorResponseBodyEncoder: error => ({ error: {
        code: error.status >= 500 ? "internal_error" : error.code === "BAD_REQUEST" ? "invalid_request" : error.code.toLowerCase(),
        message: error.status >= 500 ? "Administrator operation failed" : error.status === 400 ? "The request is invalid" : error.message,
        requestId,
      } }),
    });
    let boundedRequest = request;
    if (request.method === "POST") {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) {
        return Response.json({ error: { code: "invalid_request", message: "A JSON request body is required", requestId } }, { status: 400 });
      }
      try {
        if (!request.body) throw new Error();
        const content = new Uint8Array(8_192);
        let length = 0;
        for await (const chunk of boundedBytes(request.body, content.length)) { content.set(chunk, length); length += chunk.byteLength; }
        const body = parseStrictJson(content.subarray(0, length));
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some(field => !["baseUrl", "expectedDocumentType", "expectedConfigEtag"].includes(field))) throw new Error();
        boundedRequest = new Request(request.url, { method: request.method, headers: request.headers, body: content.slice(0, length) });
      } catch {
        return Response.json({ error: { code: "invalid_request", message: "Invalid or oversized JSON request", requestId } }, { status: 400 });
      }
    }
    const result = await handler.handle(boundedRequest, { context: { admin, requestId } });
    return result.matched ? result.response : new Response(null, { status: 404 });
  };
}