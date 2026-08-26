/**
 * Cloud-neutral UniDocs API Gateway routing.
 *
 * HTTP proxy that routes requests to document type workers based on a
 * caller-supplied registry lookup, and allowlist-proxies public CAS routes
 * to the CAS worker/service.
 *
 * Identity:
 *   Public tenantId comes from the URL path.
 *   The identity resolver authenticates the user and authorizes that tenant.
 *
 * Internal auth:
 *   Gateway → doc worker / CAS worker: X-Internal-Token
 *   Gateway → CAS worker: X-Tenant-Id resolved by Gateway
 */

import type { HttpFetcher } from "@unidocs/cas-client";
import { casRoutes, matchCasRoute } from "@unidocs/protocol-cas-legacy";
import type { CasRoute } from "@unidocs/protocol-cas-legacy";
import { docRoutes } from "@unidocs/protocol-doc";
import type { DocOperation } from "@unidocs/protocol-doc";
import {
  GatewayDirectoryConflictError,
  type GatewayDocumentDirectory,
  type GatewayDocumentRecord,
} from "./document-directory.js";
import type { GatewayIdentityResolver } from "./identity.js";
import { casCapabilityPolicy, docCapabilityPolicy } from "./capability-policy.js";
import type { GatewayCapabilityAuthority } from "./capability-authority.js";

export type GatewayInternalAuthMode = "legacy" | "dual" | "capability";

export function parseGatewayInternalAuthMode(
  value: string | undefined,
): GatewayInternalAuthMode {
  if (value === "legacy" || value === "dual" || value === "capability") return value;
  throw new TypeError("Gateway internal auth mode must be explicit");
}

export interface GatewayHandlerConfig {
  internalAuthMode: GatewayInternalAuthMode;
  casAccessKey?: string;
  capabilityAuthority?: GatewayCapabilityAuthority;
  identityResolver: GatewayIdentityResolver;
  resolveDocService(docType: string): Promise<DocServiceRegistration | null>;
  casFetcher: HttpFetcher;
  directory: GatewayDocumentDirectory;
  /** Gateway-owned CAS exposure policy, applied after route matching. */
  isGatewayExposedCasRoute(route: CasRoute): boolean;
  generateId?(): string;
  now?(): number;
}

export interface DocServiceRegistration {
  readonly serviceId: string;
  readonly url: string;
  readonly accessKey?: string;
  readonly audience?: string;
}

const EDITOR_METHODS = new Set([
  "apply", "query", "export", "history", "rollback",
  "snapshot", "ir",
]);

const OPERATOR_METHODS = new Set(["run", "reset"]);
const MUTATING_METHODS = new Set(["apply", "rollback", "run", "reset"]);

const CAS_FORWARDED_HEADERS = [
  "Content-Type",
  "Content-Length",
  "X-CAS-Refs",
  "X-CAS-Lease-Duration",
];

export function createGatewayHandler(
  cfg: GatewayHandlerConfig,
): (request: Request) => Promise<Response> {
  validateInternalAuthConfig(cfg);
  const generateId = cfg.generateId ?? (() => crypto.randomUUID());
  const now = cfg.now ?? (() => Date.now());

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 3 || parts[0] !== "tenants") {
      return Response.json({
        error: "Use /tenants/{tenantId}/docs/{docType}/* or /tenants/{tenantId}/cas/* endpoints",
      }, { status: 404 });
    }

    const tenantId = parts[1];
    const namespace = parts[2];
    const identity = await cfg.identityResolver.resolve(request, tenantId);
    if (!identity) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    if (identity.tenantId !== tenantId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    if (namespace === "cas") {
      const casRoute = matchCasRoute(request.method, url.pathname);
      if (!casRoute || !cfg.isGatewayExposedCasRoute(casRoute)) {
        return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
      }
      const policy = casCapabilityPolicy(casRoute);
      if (policy.requiresTenantAdmin && !identity.canManageTenant) {
        return Response.json({ error: "Tenant administration required" }, { status: 403 });
      }
      const headers = new Headers();
      for (const name of CAS_FORWARDED_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (usesLegacyAuth(cfg.internalAuthMode)) {
        headers.set("X-Internal-Token", cfg.casAccessKey!);
        headers.set("X-Tenant-Id", tenantId);
      }
      if (usesCapabilityAuth(cfg.internalAuthMode)) {
        headers.set(
          "Authorization",
          await cfg.capabilityAuthority!.issueCasOperation(casRoute),
        );
      }
      const targetUrl = new URL(request.url);
      targetUrl.pathname = publicCasPath(casRoute);
      return cfg.casFetcher.fetch(new Request(targetUrl, {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
      } as RequestInit));
    }

    if (namespace !== "docs") {
      return Response.json({
        error: "Use /tenants/{tenantId}/docs/{docType}/* or /tenants/{tenantId}/cas/* endpoints",
      }, { status: 404 });
    }

    const docType = parts[3];
    const docId = parts[4];
    const method = parts[5];

    if (!docType) {
      return Response.json({
        error: "Use /tenants/{tenantId}/docs/{docType}/* endpoints",
      }, { status: 404 });
    }

    const docService = await cfg.resolveDocService(docType);
    if (!docService) {
      return Response.json({
        error: `Unknown document type: ${docType}`,
      }, { status: 404 });
    }

    if (!docId) {
      if (request.method === "POST") {
        const cloneSource = await readCloneSource(request);
        if (cloneSource instanceof Response) return cloneSource;
        if (cloneSource) {
          return cloneDocument({
            request,
            cfg,
            docService,
            tenantId,
            docType,
            sourceDocId: cloneSource,
            generateId,
            now,
          });
        }
        return createDocument({
          request,
          cfg,
          docService,
          tenantId,
          docType,
          generateId,
          now,
        });
      }
      if (request.method === "GET") {
        return listDocuments(cfg.directory, tenantId, docType);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const record = await cfg.directory.get(tenantId, docId);
    if (!record || record.docType !== docType) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }
    if (record.serviceId !== docService.serviceId) {
      return Response.json({
        error: "Document service is unavailable",
      }, { status: 503 });
    }

    if (!method && request.method === "GET") {
      return documentStatus(record);
    }

    if (record.state !== "ready") {
      return Response.json({
        error: `Document is ${record.state}`,
        docId: record.docId,
        state: record.state,
      }, { status: 409 });
    }

    if (method && (EDITOR_METHODS.has(method) || OPERATOR_METHODS.has(method))) {
      const operation = docOperation(method);
      const response = await forwardToWorker(
        request,
        cfg,
        docService.url,
        tenantId,
        docType,
        docService,
        record.sessionId,
        operation,
      );
      if (response.ok && MUTATING_METHODS.has(method)) {
        await cfg.directory.touch(tenantId, docId, now());
      }
      return response;
    }

    return Response.json({
      error: `Unknown endpoint: ${method}`,
    }, { status: 404 });
  };
}

async function forwardToWorker(
  request: Request,
  cfg: GatewayHandlerConfig,
  workerUrl: string,
  tenantId: string,
  docType: string,
  docService: DocServiceRegistration,
  sessionId: string,
  operation: DocOperation,
): Promise<Response> {
  const originalUrl = new URL(request.url);
  const targetPath = usesCapabilityAuth(cfg.internalAuthMode)
    ? docRoutes[operation]({ tenantId, sessionId })
    : legacyDocPath(sessionId, operation);
  const targetUrl = `${workerUrl}${targetPath}${originalUrl.search}`;

  const headers = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (usesLegacyAuth(cfg.internalAuthMode)) {
    if (!docService.accessKey) {
      return Response.json({ error: "Document service legacy credential is unavailable" }, { status: 503 });
    }
    headers.set("X-Internal-Token", docService.accessKey);
    headers.set("X-Tenant-Id", tenantId);
    headers.set("X-Doc-Type", docType);
    headers.set("X-Session-Id", sessionId);
  }
  const operationSignal = usesCapabilityAuth(cfg.internalAuthMode)
    ? AbortSignal.any([
      request.signal,
      AbortSignal.timeout(
        docCapabilityPolicy(operation, tenantId, sessionId).deadlineSeconds * 1000,
      ),
    ])
    : request.signal;
  if (usesCapabilityAuth(cfg.internalAuthMode)) {
    if (!docService.audience) {
      return Response.json({ error: "Document service capability audience is unavailable" }, { status: 503 });
    }
    const credentials = await cfg.capabilityAuthority!.issueDocOperation({
      operation,
      docType,
      docAudience: docService.audience,
      tenantId,
      sessionId,
    });
    headers.set("Authorization", credentials.authorization);
    if (credentials.delegatedCasCapability) {
      headers.set("X-UniDocs-CAS-Capability", credentials.delegatedCasCapability);
    }
  }
  headers.set("Accept-Encoding", "identity");

  try {
    return await fetch(targetUrl, {
      method: operation === "create" ? "PUT" : request.method,
      headers,
      body: request.body,
      duplex: "half",
      signal: operationSignal,
    } as RequestInit);
  } catch (err) {
    return Response.json({
      error: `Document worker unreachable: ${err}`,
    }, { status: 502 });
  }
}

async function listDocuments(
  directory: GatewayDocumentDirectory,
  tenantId: string,
  docType: string,
): Promise<Response> {
  const records = await directory.list(tenantId, docType);

  return Response.json({
    success: true,
    data: records.map((rec) => ({
      doc_id: rec.docId,
      doc_type: rec.docType,
      owner_id: rec.tenantId,
      version: rec.version,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
    })),
    count: records.length,
  });
}

interface CreateDocumentContext {
  request: Request;
  cfg: GatewayHandlerConfig;
  docService: DocServiceRegistration;
  tenantId: string;
  docType: string;
  generateId(): string;
  now(): number;
  requestedDocId?: string;
  createMethod?: string;
}

interface CloneDocumentContext extends Omit<CreateDocumentContext, "requestedDocId" | "createMethod"> {
  sourceDocId: string;
}

async function cloneDocument(context: CloneDocumentContext): Promise<Response> {
  const {
    request,
    cfg,
    docService,
    tenantId,
    docType,
    sourceDocId,
    generateId,
    now,
  } = context;
  const source = await cfg.directory.get(tenantId, sourceDocId);
  if (!source || source.docType !== docType || source.tenantId !== tenantId) {
    return Response.json({ error: "Source document not found" }, { status: 404 });
  }
  if (source.serviceId !== docService.serviceId) {
    return Response.json({ error: "Document service is unavailable" }, { status: 503 });
  }
  if (source.state !== "ready") {
    return Response.json({
      error: `Source document is ${source.state}`,
      state: source.state,
    }, { status: 409 });
  }

  const snapshot = await forwardToWorker(
    new Request(request.url, { method: "GET" }),
    cfg,
    docService.url,
    tenantId,
    docType,
    docService,
    source.sessionId,
    "snapshot",
  );
  if (!snapshot.ok) return snapshot;

  const sourceSnapshot = await snapshot.json().catch(() => null) as {
    success?: unknown;
    hash?: unknown;
    version?: unknown;
  } | null;
  if (sourceSnapshot?.success !== true
    || typeof sourceSnapshot.hash !== "string"
    || !Number.isSafeInteger(sourceSnapshot.version)
    || (sourceSnapshot.version as number) < 1) {
    return Response.json({ error: "Document service returned an invalid snapshot" }, { status: 502 });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of ["Idempotency-Key", "X-Doc-Id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const initRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      hash: sourceSnapshot.hash,
      sourceVersion: sourceSnapshot.version,
    }),
  });
  return createDocument({
    request: initRequest,
    cfg,
    docService,
    tenantId,
    docType,
    generateId,
    now,
    createMethod: "init-from-hash",
  });
}

async function readCloneSource(request: Request): Promise<string | Response | null> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  let source: FormDataEntryValue | unknown = null;

  if (contentType.startsWith("application/json")) {
    const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !("sourceId" in body)) return null;
    source = body.sourceId;
  } else if (contentType.startsWith("multipart/form-data")) {
    const form = await request.clone().formData().catch(() => null);
    if (!form || !form.has("sourceId")) return null;
    if (form.has("file")) {
      return Response.json({ error: "file and sourceId are mutually exclusive" }, { status: 400 });
    }
    source = form.get("sourceId");
  } else {
    return null;
  }

  if (typeof source !== "string" || source.trim().length === 0) {
    return Response.json({ error: "sourceId must be a non-empty string" }, { status: 400 });
  }
  return source.trim();
}

async function createDocument(context: CreateDocumentContext): Promise<Response> {
  const {
    request,
    cfg,
    docService,
    tenantId,
    docType,
    generateId,
    now,
    requestedDocId,
    createMethod,
  } = context;
  const headerDocId = request.headers.get("X-Doc-Id")?.trim();
  const docId = (requestedDocId ?? headerDocId) || generateId();
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim()
    || (requestedDocId || headerDocId ? `doc:${docId}` : `request:${docId}`);

  let reservation;
  try {
    reservation = await cfg.directory.reserve({
      docId,
      tenantId,
      docType,
      serviceId: docService.serviceId,
      sessionId: generateId(),
      idempotencyKey,
      requestedDocId: requestedDocId ?? headerDocId ?? null,
      now: now(),
    });
  } catch (err) {
    if (err instanceof GatewayDirectoryConflictError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const record = reservation.record;
  if (!reservation.created) {
    if (record.state === "ready") {
      return Response.json({
        success: true,
        docId: record.docId,
        version: record.version,
        state: record.state,
      });
    }
    if (record.state === "creating") {
      const reconciled = await reconcileCreatingDocument(
        cfg,
        docService,
        record,
        now(),
      );
      if (reconciled) {
        return Response.json({
          success: true,
          docId: reconciled.docId,
          version: reconciled.version,
          state: reconciled.state,
        });
      }
      return Response.json({
        success: true,
        docId: record.docId,
        state: record.state,
      }, { status: 202 });
    }
    return Response.json({
      success: false,
      docId: record.docId,
      state: record.state,
      error: record.error,
    }, { status: 409 });
  }

  const upstream = await forwardToWorker(
    request,
    cfg,
    docService.url,
    tenantId,
    docType,
    docService,
    record.sessionId,
    createMethod === "init-from-hash" ? "initFromHash" : "create",
  );
  const body = await upstream.clone().json().catch(() => null) as {
    success?: unknown;
    version?: unknown;
    error?: unknown;
  } | null;

  if (upstream.ok && body?.success === true && Number.isSafeInteger(body.version)) {
    const ready = await cfg.directory.markReady(
      tenantId,
      record.docId,
      body.version as number,
      now(),
    );
    return Response.json({
      success: true,
      docId: ready.docId,
      version: ready.version,
      state: ready.state,
    }, {
      status: upstream.status,
    });
  }

  if (upstream.status < 500) {
    await cfg.directory.markFailed(
      tenantId,
      record.docId,
      String(body?.error ?? upstream.statusText),
      now(),
    );
  }
  return upstream;
}

function documentStatus(record: GatewayDocumentRecord): Response {
  return Response.json({
    success: true,
    data: {
      doc_id: record.docId,
      doc_type: record.docType,
      state: record.state,
      version: record.version,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    },
  });
}

async function reconcileCreatingDocument(
  cfg: GatewayHandlerConfig,
  docService: DocServiceRegistration,
  record: GatewayDocumentRecord,
  timestamp: number,
): Promise<GatewayDocumentRecord | null> {
  let response: Response;
  try {
    response = await forwardToWorker(
      new Request("https://gateway.internal/status", { method: "GET" }),
      cfg,
      docService.url,
      record.tenantId,
      record.docType,
      docService,
      record.sessionId,
      "status",
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const status = await response.json().catch(() => null) as {
    exists?: unknown;
    version?: unknown;
  } | null;
  if (status?.exists !== true || !Number.isSafeInteger(status.version)) return null;
  return cfg.directory.markReady(
    record.tenantId,
    record.docId,
    status.version as number,
    timestamp,
  );
}

function docOperation(method: string): DocOperation {
  if (method === "apply"
    || method === "query"
    || method === "export"
    || method === "history"
    || method === "rollback"
    || method === "snapshot"
    || method === "ir"
    || method === "run"
    || method === "reset") {
    return method;
  }
  throw new TypeError(`Unsupported Doc operation: ${method}`);
}

function legacyDocPath(sessionId: string, operation: DocOperation): string {
  if (operation === "create") return `/sessions/${encodeURIComponent(sessionId)}`;
  const segment = operation === "initFromHash" ? "init-from-hash" : operation;
  return `/sessions/${encodeURIComponent(sessionId)}/${segment}`;
}

function usesLegacyAuth(mode: GatewayInternalAuthMode): boolean {
  return mode === "legacy" || mode === "dual";
}

function usesCapabilityAuth(mode: GatewayInternalAuthMode): boolean {
  return mode === "capability" || mode === "dual";
}

function validateInternalAuthConfig(cfg: GatewayHandlerConfig): void {
  parseGatewayInternalAuthMode(cfg.internalAuthMode);
  if (usesLegacyAuth(cfg.internalAuthMode) && !cfg.casAccessKey) {
    throw new TypeError("Legacy Gateway auth requires a CAS access key");
  }
  if (usesCapabilityAuth(cfg.internalAuthMode) && !cfg.capabilityAuthority) {
    throw new TypeError("Capability Gateway auth requires a capability authority");
  }
}

function publicCasPath(route: CasRoute): string {
  switch (route.operation) {
    case "readContent":
      return casRoutes.readContent(route);
    case "readMetadata":
      return casRoutes.readMetadata(route);
    case "leaseNode":
      return casRoutes.leaseNode(route);
    case "leaseExisting":
      return casRoutes.leaseExisting(route);
    case "usage":
      return casRoutes.usage(route);
    case "gc":
      return casRoutes.gc(route);
    default:
      throw new TypeError(`CAS operation ${route.operation} is not public`);
  }
}
