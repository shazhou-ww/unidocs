import { implement, ORPCError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import { tenantApiContract } from "@unidocs/protocol-tenant-portal";
import {
  createTenantCatalogService, createTenantDocumentService, createTenantThreadService, createTenantVersionService,
  TenantAccessError, TenantOperationError,
  type DocumentLocationValidator, type TenantCatalogRepository, type TenantContext, type TenantDocumentRepository,
  type TenantThreadRepository, type TenantVersionRepository,
} from "@unidocs/portal-service";
import { VersionConflictError } from "./document-repository.js";

export interface TenantHttpDependencies {
  readonly catalog: TenantCatalogRepository;
  readonly documents: TenantDocumentRepository;
  readonly versions: TenantVersionRepository;
  readonly threads: TenantThreadRepository;
  readonly validateLocation: DocumentLocationValidator;
}

/**
 * Per-request, mutable. A handler whose contract output is a bare stream has no
 * way to set response headers, so it records what it needs here and the adapter
 * applies it to the Response after oRPC has built it.
 */
interface ResponseOverrides {
  contentType?: string;
}

interface TenantHttpContext {
  readonly tenant: TenantContext;
  readonly requestId: string;
  readonly response: ResponseOverrides;
}

const STATUS = {
  invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, limit_exceeded: 413,
  location_contract_violation: 422, document_type_disabled: 409, version_conflict: 409,
  idempotency_conflict: 409, content_unavailable: 409, unavailable: 503,
} as const;

export function createTenantHttp(dependencies: TenantHttpDependencies):
  (request: Request, tenant: TenantContext, requestId: string) => Promise<Response> {
  const implementation = implement(tenantApiContract).$context<TenantHttpContext>();
  const catalog = createTenantCatalogService(dependencies.catalog);
  const documents = createTenantDocumentService(dependencies.documents);
  const versions = createTenantVersionService(dependencies.versions);
  const threads = createTenantThreadService(dependencies.threads, { validateLocation: dependencies.validateLocation });

  const router = implementation.router({
    documentTypes: {
      list: implementation.documentTypes.list.handler(({ input, context }) =>
        catalog.listDocumentTypes(context.tenant, input.params.tenantId, input.query ?? {})),
      getDocumentContract: implementation.documentTypes.getDocumentContract.handler(({ input, context }) =>
        catalog.getDocumentContract(context.tenant, input.params.tenantId, input.params.documentType, input.params.documentContractIdx)),
    },
    documents: {
      list: implementation.documents.list.handler(({ input, context }) =>
        documents.list(context.tenant, input.params.tenantId, input.query ?? {})),
      // Task 7 replaces this placeholder with documents.create.
      create: implementation.documents.create.handler(() => { throw new TenantOperationError("unavailable"); }),
      get: implementation.documents.get.handler(({ input, context }) =>
        documents.get(context.tenant, input.params.tenantId, input.params.documentId)),
      // Task 7 replaces this placeholder with documents.moveCurrentVersion.
      moveCurrentVersion: implementation.documents.moveCurrentVersion.handler(() => { throw new TenantOperationError("unavailable"); }),
      listAudit: implementation.documents.listAudit.handler(({ input, context }) =>
        documents.listAuditEvents(context.tenant, input.params.tenantId, input.params.documentId, input.query ?? {})),
    },
    versions: {
      list: implementation.versions.list.handler(({ input, context }) =>
        versions.list(context.tenant, input.params.tenantId, input.params.documentId, input.query ?? {})),
      get: implementation.versions.get.handler(({ input, context }) =>
        versions.get(context.tenant, input.params.tenantId, input.params.documentId, input.params.versionIdx)),
      getSnapshot: implementation.versions.getSnapshot.handler(async ({ input, context }) => {
        const snapshot = await versions.getSnapshot(context.tenant, input.params.tenantId, input.params.documentId, input.params.versionIdx);
        context.response.contentType = snapshot.contentType;
        return snapshot.body;
      }),
    },
    threads: {
      list: implementation.threads.list.handler(({ input, context }) =>
        threads.list(context.tenant, input.params.tenantId, input.params.documentId, input.query ?? {})),
      // Task 7 replaces this placeholder with threads.create.
      create: implementation.threads.create.handler(() => { throw new TenantOperationError("unavailable"); }),
      get: implementation.threads.get.handler(({ input, context }) =>
        threads.get(context.tenant, input.params.tenantId, input.params.documentId, input.params.threadId)),
      // Task 7 replaces this placeholder with threads.appendComment.
      appendComment: implementation.threads.appendComment.handler(() => { throw new TenantOperationError("unavailable"); }),
    },
    cas: {
      // v0 does not issue direct-UniCAS capabilities (spec §1.3: browser-direct
      // UniCAS is deferred). Answer 503 rather than a fake grant or a 404, so a
      // caller can tell "not yet" from "no such operation".
      issueCapability: implementation.cas.issueCapability.handler(() => { throw new TenantOperationError("unavailable"); }),
    },
  });

  return async (request, tenant, requestId) => {
    const path = new URL(request.url).pathname;
    const handler = new OpenAPIHandler(router, {
      // Query strings arrive as strings; limit, open and versionIdx must be coerced before validation.
      plugins: request.method === "GET" ? [new experimental_ZodSmartCoercionPlugin()] : [],
      interceptors: [async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          if (error instanceof TenantAccessError || error instanceof TenantOperationError) {
            // VersionConflictError is a TenantOperationError; check it first so its current pointer reaches the caller.
            const details = error instanceof VersionConflictError ? { currentVersionIdx: error.currentVersionIdx } : undefined;
            throw new ORPCError(error.code.toUpperCase(), {
              status: STATUS[error.code], message: error.message,
              data: { requestId, ...(details ? { details } : {}) },
            });
          }
          if (!(error instanceof ORPCError) || error.status >= 500) {
            // Name and message only: repository errors can carry SQL fragments,
            // which belong in the log and never in the response body.
            console.error(JSON.stringify({
              event: "portal_operation_failed", requestId, path,
              name: error instanceof Error ? error.name : typeof error,
              message: error instanceof Error ? error.message : String(error),
            }));
          }
          throw error;
        }
      }],
      customErrorResponseBodyEncoder: error => {
        if (error.status === 500) return { error: { code: "internal_error", message: "Tenant operation failed", requestId } };
        if (error.code === "BAD_REQUEST") return { error: { code: "invalid_request", message: "The request is invalid", requestId } };
        const data: unknown = error.data;
        const details = typeof data === "object" && data !== null && "details" in data ? (data as { details: unknown }).details : undefined;
        return { error: { code: error.code.toLowerCase(), message: error.message, requestId, ...(details === undefined ? {} : { details }) } };
      },
    });
    const overrides: ResponseOverrides = {};
    const result = await handler.handle(request, { context: { tenant, requestId, response: overrides } });
    if (!result.matched) {
      return Response.json({ error: { code: "not_found", message: "The requested resource was not found", requestId } }, { status: 404 });
    }
    if (overrides.contentType && result.response.ok) result.response.headers.set("content-type", overrides.contentType);
    return result.response;
  };
}
