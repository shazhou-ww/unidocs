import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import { adminApiContract } from "@unidocs/protocol-admin-portal";
import {
  BundleZipError,
  TypeCardBundleOperationError,
  boundedBytes,
  createTypeCardBundleService,
  parseStrictJson,
  type AdminContext,
  type BundleObjectStore,
  type TypeCardBundleRepository,
} from "@unidocs/portal-service";

export function createTypeCardBundlesHttp(repository: TypeCardBundleRepository, objectStore: BundleObjectStore, bundleOrigin: string) {
  const contract = adminApiContract.typeCardBundles;
  const implementation = implement(contract).$context<{ admin: AdminContext; requestId: string }>();
  const service = createTypeCardBundleService(repository, objectStore, { bundleOrigin });
  const router = {
    upload: implementation.upload.handler(({ input, context }) => service.upload(context.admin, input.query, input.body, input.headers["idempotency-key"], context.requestId)),
    list: implementation.list.handler(({ input, context }) => service.list(context.admin, input.query)),
    get: implementation.get.handler(({ input, context }) => service.get(context.admin, input.params.typeCardBundleId)),
    updateMetadata: implementation.updateMetadata.handler(({ input, context }) => service.updateMetadata(context.admin, input.params.typeCardBundleId, input.body,
      input.headers["idempotency-key"], input.headers["if-match"], context.requestId)),
  };
  function operationError(error: unknown, requestId: string): Response | null {
    if (error instanceof BundleZipError) return Response.json({ error: { code: "bundle_invalid", message: "The uploaded bundle is invalid", requestId } }, { status: 422 });
    if (error instanceof TypeCardBundleOperationError) return Response.json({
      error: { code: error.code, message: error.message, requestId, ...(error.details ? { details: error.details } : {}) },
    }, { status: { invalid_request: 400, not_found: 404, idempotency_conflict: 409, precondition_failed: 412, forbidden: 403, bundle_already_exists: 409 }[error.code] });
    return null;
  }
  return async (request: Request, admin: AdminContext, requestId: string): Promise<Response> => {
    const url = new URL(request.url);
    const collection = url.pathname === "/admin/api/v1/type-card-bundles";
    const allowedQuery = request.method === "POST" && collection ? ["name", "description"] : request.method === "GET" && collection ? ["documentType", "limit", "cursor"] : [];
    const seen = new Set<string>();
    let invalidQuery = false;
    url.searchParams.forEach((value, name) => {
      if (seen.has(name) || !allowedQuery.includes(name) || (name === "limit" && !/^[1-9][0-9]*$/.test(value))) invalidQuery = true;
      seen.add(name);
    });
    if (invalidQuery) return Response.json({ error: { code: "invalid_request", message: "The query is invalid", requestId } }, { status: 400 });
    if (request.method === "PATCH" && !request.headers.has("if-match")) {
      return Response.json({ error: { code: "precondition_required", message: "The If-Match precondition is required", requestId } }, { status: 428 });
    }
    if (request.method === "POST" && (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/zip" || request.headers.has("content-encoding"))) {
      return Response.json({ error: { code: "unsupported_content_type", message: "An application/zip request body is required", requestId } }, { status: 415 });
    }
    if (request.method === "POST" && collection) {
      try {
        if (!request.body) throw new TypeCardBundleOperationError("invalid_request");
        const result = await service.upload(admin, Object.fromEntries(url.searchParams), request.body, request.headers.get("idempotency-key") ?? "", requestId);
        return Response.json(result, { status: 201 });
      } catch (error) {
        const response = operationError(error, requestId);
        if (response) return response;
        throw error;
      }
    }
    const handler = new OpenAPIHandler(router, {
      plugins: request.method === "GET" ? [new experimental_ZodSmartCoercionPlugin()] : [],
      interceptors: [async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          if (error instanceof BundleZipError) throw new ORPCError("BUNDLE_INVALID", { status: 422, message: "The uploaded bundle is invalid", data: { requestId } });
          if (error instanceof TypeCardBundleOperationError) throw new ORPCError(error.code.toUpperCase(), {
            status: { invalid_request: 400, not_found: 404, idempotency_conflict: 409, precondition_failed: 412, forbidden: 403, bundle_already_exists: 409 }[error.code],
            message: error.message,
            data: { requestId, ...(error.details ? { details: error.details } : {}) },
          });
          throw error;
        }
      }],
      customErrorResponseBodyEncoder: error => {
        const data = error.data as { details?: unknown } | undefined;
        const code = error.status >= 500 ? "internal_error" : error.code === "BAD_REQUEST" ? "invalid_request" : error.code.toLowerCase();
        return { error: { code, message: error.status >= 500 ? "Administrator operation failed" : error.status === 400 ? "The request is invalid" : error.message, requestId, ...(data?.details !== undefined ? { details: data.details } : {}) } };
      },
    });
    let boundedRequest = request;
    if (request.method === "PATCH") {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) {
        return Response.json({ error: { code: "invalid_request", message: "A JSON request body is required", requestId } }, { status: 400 });
      }
      try {
        if (!request.body) throw new Error();
        const content = new Uint8Array(8_192);
        let length = 0;
        for await (const chunk of boundedBytes(request.body, content.length)) { content.set(chunk, length); length += chunk.byteLength; }
        const body = parseStrictJson(content.subarray(0, length));
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some(field => !["name", "description"].includes(field))) throw new Error();
        boundedRequest = new Request(request.url, { method: request.method, headers: request.headers, body: content.slice(0, length) });
      } catch {
        return Response.json({ error: { code: "invalid_request", message: "Invalid or oversized JSON request", requestId } }, { status: 400 });
      }
    }
    const result = await handler.handle(boundedRequest, { context: { admin, requestId } });
    return result.matched ? result.response : new Response(null, { status: 404 });
  };
}