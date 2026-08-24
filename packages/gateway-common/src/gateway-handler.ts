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
 *
 * Internal auth:
 *   Gateway → doc worker / CAS worker: X-Internal-Token
 *   Gateway → CAS worker: X-User-Id from the URL path
 */

import type { HttpFetcher, DocIndexQuery } from "@unidocs/http-protocol";

export interface GatewayHandlerConfig {
  internalToken: string;
  resolveWorkerUrl(docType: string): Promise<string | null>;
  casFetcher: HttpFetcher;
  docIndex: DocIndexQuery;
  isPublicCasRoute(method: string, pathname: string): boolean;
}

const EDITOR_METHODS = new Set([
  "apply", "query", "export", "history", "rollback",
  "snapshot", "ir", "init_from_hash",
]);

const OPERATOR_METHODS = new Set(["run", "reset"]);

export function createGatewayHandler(
  cfg: GatewayHandlerConfig,
): (request: Request) => Promise<Response> {
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

    if (namespace === "cas") {
      if (!cfg.isPublicCasRoute(request.method, url.pathname)) {
        return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
      }
      const headers = new Headers(request.headers);
      headers.set("X-Internal-Token", cfg.internalToken);
      headers.set("X-User-Id", userId);
      return cfg.casFetcher.fetch(new Request(request, { headers }));
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

    const workerUrl = await cfg.resolveWorkerUrl(docType);
    if (!workerUrl) {
      return Response.json({
        error: `Unknown document type: ${docType}`,
      }, { status: 404 });
    }

    if (!docId) {
      if (request.method === "POST") {
        return forwardToWorker(request, workerUrl, userId, docType, cfg.internalToken);
      }
      if (request.method === "GET") {
        return listDocuments(cfg.docIndex, userId, docType);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (method && (EDITOR_METHODS.has(method) || OPERATOR_METHODS.has(method))) {
      return forwardToWorker(request, workerUrl, userId, docType, cfg.internalToken);
    }

    return Response.json({
      error: `Unknown endpoint: ${method}`,
    }, { status: 404 });
  };
}

async function forwardToWorker(
  request: Request,
  workerUrl: string,
  userId: string,
  docType: string,
  internalToken: string,
): Promise<Response> {
  const originalUrl = new URL(request.url);
  const parts = originalUrl.pathname.split("/").filter(Boolean);
  const targetPath = [parts[0], parts[1], ...parts.slice(4)].join("/");
  const targetUrl = `${workerUrl}/${targetPath}${originalUrl.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "host" && key.toLowerCase() !== "connection") {
      headers.set(key, value);
    }
  });
  headers.set("X-Internal-Token", internalToken);
  headers.set("X-User-Id", userId);
  headers.set("X-Doc-Type", docType);
  headers.set("Accept-Encoding", "identity");

  try {
    return await fetch(targetUrl, {
      method: request.method,
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
  docIndex: DocIndexQuery,
  userId: string,
  docType: string,
): Promise<Response> {
  const records = await docIndex.list(userId, docType);

  return Response.json({
    success: true,
    data: records.map((rec) => ({
      doc_id: rec.docId,
      doc_type: rec.docType,
      owner_id: rec.ownerId,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
    })),
    count: records.length,
  });
}
