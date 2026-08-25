/**
 * Cloud-neutral UniDocs API Gateway routing.
 *
 * HTTP proxy that routes requests to document type workers based on a
 * caller-supplied registry lookup, and allowlist-proxies public CAS routes
 * to the CAS worker/service.
 *
 * Identity:
 *   Public userId comes from the URL path.
 *   Future Bearer tokens must bind to that userId.
 *   CAS receives only the tenant resolved by Gateway, never the userId.
 *
 * Internal auth:
 *   Gateway → doc worker / CAS worker: X-Internal-Token
 *   Gateway → CAS worker: X-Tenant-Id resolved by Gateway
 */

import type { HttpFetcher } from "@unidocs/http-protocol";
import {
  GatewayDirectoryConflictError,
  type GatewayDocumentDirectory,
  type GatewayDocumentRecord,
} from "./document-directory.js";
import type { GatewayIdentityResolver } from "./identity.js";

export interface GatewayHandlerConfig {
  casAccessKey: string;
  identityResolver: GatewayIdentityResolver;
  resolveDocService(docType: string): Promise<DocServiceRegistration | null>;
  casFetcher: HttpFetcher;
  directory: GatewayDocumentDirectory;
  isPublicCasRoute(method: string, pathname: string): boolean;
  generateId?(): string;
  now?(): number;
}

export interface DocServiceRegistration {
  readonly serviceId: string;
  readonly url: string;
  readonly accessKey: string;
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
  const generateId = cfg.generateId ?? (() => crypto.randomUUID());
  const now = cfg.now ?? (() => Date.now());

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 3 || parts[0] !== "users") {
      return Response.json({
        error: "Use /users/{userId}/docs/{docType}/* or /users/{userId}/cas/* endpoints",
      }, { status: 404 });
    }

    const userId = parts[1];
    const namespace = parts[2];
    const identity = await cfg.identityResolver.resolve(request, userId);
    if (!identity) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    if (identity.userId !== userId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const tenantId = identity.tenantId;

    if (namespace === "cas") {
      if (!cfg.isPublicCasRoute(request.method, url.pathname)) {
        return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
      }
      if (parts[3] === "usage" && !identity.canManageTenant) {
        return Response.json({ error: "Tenant administration required" }, { status: 403 });
      }
      const headers = new Headers();
      for (const name of CAS_FORWARDED_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set("X-Internal-Token", cfg.casAccessKey);
      headers.set("X-Tenant-Id", tenantId);
      const targetUrl = new URL(request.url);
      targetUrl.pathname = `/tenants/${encodeURIComponent(tenantId)}/cas/${parts.slice(3).join("/")}`;
      return cfg.casFetcher.fetch(new Request(targetUrl, {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
      } as RequestInit));
    }

    if (namespace !== "docs") {
      return Response.json({
        error: "Use /users/{userId}/docs/{docType}/* or /users/{userId}/cas/* endpoints",
      }, { status: 404 });
    }

    const docType = parts[3];
    const docId = parts[4];
    const method = parts[5];

    if (!docType) {
      return Response.json({
        error: "Use /users/{userId}/docs/{docType}/* endpoints",
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
            userId,
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
          userId,
          tenantId,
          docType,
          generateId,
          now,
        });
      }
      if (request.method === "GET") {
        return listDocuments(cfg.directory, userId, docType);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const record = await cfg.directory.get(userId, docId);
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
      const response = await forwardToWorker(
        request,
        docService.url,
        tenantId,
        docType,
        docService.accessKey,
        record.sessionId,
        method,
      );
      if (response.ok && MUTATING_METHODS.has(method)) {
        await cfg.directory.touch(userId, docId, now());
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
  workerUrl: string,
  tenantId: string,
  docType: string,
  accessKey: string,
  sessionId?: string,
  method?: string,
): Promise<Response> {
  const originalUrl = new URL(request.url);
  if (!sessionId) throw new Error("Doc forwarding requires a sessionId");
  const targetPath = ["sessions", sessionId, method].filter(Boolean).join("/");
  const targetUrl = `${workerUrl}/${targetPath}${originalUrl.search}`;

  const headers = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-Internal-Token", accessKey);
  headers.set("X-Tenant-Id", tenantId);
  headers.set("X-Doc-Type", docType);
  headers.set("X-Session-Id", sessionId);
  headers.set("Accept-Encoding", "identity");

  try {
    return await fetch(targetUrl, {
      method: method ? request.method : "PUT",
      headers,
      body: request.body,
      duplex: "half",
    } as RequestInit);
  } catch (err) {
    return Response.json({
      error: `Document worker unreachable: ${err}`,
    }, { status: 502 });
  }
}

async function listDocuments(
  directory: GatewayDocumentDirectory,
  userId: string,
  docType: string,
): Promise<Response> {
  const records = await directory.list(userId, docType);

  return Response.json({
    success: true,
    data: records.map((rec) => ({
      doc_id: rec.docId,
      doc_type: rec.docType,
      owner_id: rec.userId,
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
  userId: string;
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
    userId,
    tenantId,
    docType,
    sourceDocId,
    generateId,
    now,
  } = context;
  const source = await cfg.directory.get(userId, sourceDocId);
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
    docService.url,
    tenantId,
    docType,
    docService.accessKey,
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
    userId,
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
    userId,
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
      userId,
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
    docService.url,
    tenantId,
    docType,
    docService.accessKey,
    record.sessionId,
    createMethod,
  );
  const body = await upstream.clone().json().catch(() => null) as {
    success?: unknown;
    version?: unknown;
    error?: unknown;
  } | null;

  if (upstream.ok && body?.success === true && Number.isSafeInteger(body.version)) {
    const ready = await cfg.directory.markReady(
      userId,
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
      userId,
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
  const targetUrl = `${docService.url}/sessions/${encodeURIComponent(record.sessionId)}/status`;
  let response: Response;
  try {
    response = await fetch(targetUrl, {
      headers: {
        "X-Internal-Token": docService.accessKey,
        "X-Tenant-Id": record.tenantId,
        "X-Doc-Type": record.docType,
        "X-Session-Id": record.sessionId,
      },
    });
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
    record.userId,
    record.docId,
    status.version as number,
    timestamp,
  );
}
