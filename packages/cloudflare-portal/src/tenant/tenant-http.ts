import { implement, ORPCError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import { tenantApiContract } from "@unidocs/protocol-tenant-portal";
import {
  createTenantCatalogService, createTenantDocumentService, createTenantThreadService, createTenantVersionService,
  requireTenantScope, TenantAccessError, TenantOperationError,
  type DocumentLocationValidator, type TenantCatalogRepository, type TenantContext, type TenantDocumentRepository,
  type TenantThreadRepository, type TenantVersionRepository,
} from "@unidocs/portal-service";
import { readBoundedJsonRequest } from "../bounded-json-request.js";
import { VersionConflictError } from "./document-repository.js";
import type { CommittedTenantWrite } from "./operator-dispatch.js";

export interface TenantHttpDependencies {
  readonly catalog: TenantCatalogRepository;
  readonly documents: TenantDocumentRepository;
  readonly versions: TenantVersionRepository;
  readonly threads: TenantThreadRepository;
  readonly validateLocation: DocumentLocationValidator;
  /**
   * Told about each write once the service has returned it, never before and
   * never for a refused one. An idempotent replay is reported again: webhook
   * delivery is at-least-once, so the Operator already tolerates duplicates,
   * and a replay may be the retry of a request whose first notification was lost.
   */
  readonly onCommitted?: (write: CommittedTenantWrite) => void;
  /**
   * Told when a browser session reads a document that has no version yet, the
   * one signal that its `document.created` may have been lost (see
   * initialization-redelivery.ts). An Agent's read is not reported: the Agent
   * reading it is the Operator initializing it.
   */
  readonly onUninitializedRead?: (document: { readonly tenantId: string; readonly documentId: string }) => void;
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

/**
 * Largest accepted request body. The biggest legitimate body is a comment:
 * TENANT_LIMITS.messageText is 16 384 UTF-16 code units, which is at most
 * ~65 KB as UTF-8 (JSON escaping aside), plus up to 8 KB of location payload
 * and 20 attachment references. 128 KiB leaves headroom for all of that
 * without letting a caller make the Worker buffer an unbounded body.
 */
const MAX_BODY_BYTES = 131_072;

const STATUS = {
  invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, limit_exceeded: 413,
  location_contract_violation: 422, document_type_disabled: 409, version_conflict: 409,
  idempotency_conflict: 409, content_unavailable: 409, unavailable: 503,
} as const;

/**
 * R10: an Agent bearer reads the tenant API and submits through the Agent API;
 * the browser's write operations are not in its grant. Checked before the
 * service runs, so a bearer write has no effect even when it would succeed.
 */
function forbidBearerWrite(tenant: TenantContext): void {
  if (tenant.transport === "bearer") throw new TenantAccessError("forbidden");
}

export function createTenantHttp(dependencies: TenantHttpDependencies):
  (request: Request, tenant: TenantContext, requestId: string) => Promise<Response> {
  const implementation = implement(tenantApiContract).$context<TenantHttpContext>();
  const catalog = createTenantCatalogService(dependencies.catalog);
  const documents = createTenantDocumentService(dependencies.documents);
  const versions = createTenantVersionService(dependencies.versions);
  const threads = createTenantThreadService(dependencies.threads, { validateLocation: dependencies.validateLocation });
  const committed = (write: CommittedTenantWrite) => dependencies.onCommitted?.(write);

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
      create: implementation.documents.create.handler(async ({ input, context }) => {
        forbidBearerWrite(context.tenant);
        const { tenantId } = input.params;
        const record = await documents.create(context.tenant, tenantId, input.body, input.headers["idempotency-key"], context.requestId);
        committed({ kind: "document.created", tenantId, documentId: record.documentId });
        return record;
      }),
      get: implementation.documents.get.handler(async ({ input, context }) => {
        const record = await documents.get(context.tenant, input.params.tenantId, input.params.documentId);
        if (record.currentVersionIdx === null && context.tenant.transport === "session") {
          dependencies.onUninitializedRead?.({ tenantId: input.params.tenantId, documentId: record.documentId });
        }
        return record;
      }),
      moveCurrentVersion: implementation.documents.moveCurrentVersion.handler(async ({ input, context }) => {
        forbidBearerWrite(context.tenant);
        const { tenantId, documentId } = input.params;
        const record = await documents.moveCurrentVersion(context.tenant, tenantId, documentId, input.body, context.requestId);
        committed({ kind: "current_version.moved", tenantId, documentId });
        return record;
      }),
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
      create: implementation.threads.create.handler(async ({ input, context }) => {
        forbidBearerWrite(context.tenant);
        const { tenantId, documentId } = input.params;
        const thread = await threads.create(context.tenant, tenantId, documentId, input.body, input.headers["idempotency-key"]);
        // A new thread is its first comment, so the Operator hears comment 0 appended.
        committed({ kind: "comment.appended", tenantId, documentId, threadId: thread.threadId, commentIdx: thread.comments[0].commentIdx });
        return thread;
      }),
      get: implementation.threads.get.handler(({ input, context }) =>
        threads.get(context.tenant, input.params.tenantId, input.params.documentId, input.params.threadId)),
      appendComment: implementation.threads.appendComment.handler(async ({ input, context }) => {
        forbidBearerWrite(context.tenant);
        const { tenantId, documentId, threadId } = input.params;
        const comment = await threads.appendComment(context.tenant, tenantId, documentId, threadId, input.body, input.headers["idempotency-key"]);
        committed({ kind: "comment.appended", tenantId, documentId, threadId, commentIdx: comment.commentIdx });
        return comment;
      }),
    },
    cas: {
      // v0 does not issue direct-UniCAS capabilities (spec §1.3: browser-direct
      // UniCAS is deferred). Answer 503 rather than a fake grant or a 404, so a
      // caller can tell "not yet" from "no such operation". Authorization still
      // comes first, so "not yet" is never said to a caller who may not ask.
      issueCapability: implementation.cas.issueCapability.handler(({ input, context }) => {
        forbidBearerWrite(context.tenant);
        requireTenantScope(context.tenant, input.params.tenantId);
        throw new TenantOperationError("unavailable");
      }),
    },
  });

  return async (request, tenant, requestId) => {
    const path = new URL(request.url).pathname;
    let boundedRequest = request;
    if (request.method === "POST") {
      // Checked here, before oRPC sees the body: its codec would buffer a body of
      // any size and keep the last of two duplicate keys.
      const bounded = await readBoundedJsonRequest(request, MAX_BODY_BYTES);
      if (!bounded.ok) {
        const message = bounded.reason === "not_json" ? "A JSON request body is required" : "Invalid or oversized JSON request";
        return Response.json({ error: { code: "invalid_request", message, requestId } }, { status: 400 });
      }
      boundedRequest = bounded.request;
    }
    const handler = new OpenAPIHandler(router, {
      // Query strings arrive as strings; limit, open and versionIdx must be coerced before validation.
      plugins: request.method === "GET" ? [new experimental_ZodSmartCoercionPlugin()] : [],
      // Client interceptors wrap the procedure call only - input validation, the
      // handler and output validation - never request decoding, so a body the
      // codec could not read stays a plain 400 and is not logged as a failure.
      clientInterceptors: [async ({ next }) => {
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
          // A 4xx ORPCError (such as failed input validation) is the caller's
          // mistake, not an operation failure; only the unexpected is logged.
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
    const result = await handler.handle(boundedRequest, { context: { tenant, requestId, response: overrides } });
    if (!result.matched) {
      return Response.json({ error: { code: "not_found", message: "The requested resource was not found", requestId } }, { status: 404 });
    }
    if (overrides.contentType && result.response.ok) result.response.headers.set("content-type", overrides.contentType);
    return result.response;
  };
}
