/**
 * 把 PlatformRequest 路由到 MemoryStore。它扮演服务器，所以必须按路径反解 operation。
 */
import type { ApiError } from "@unidocs/protocol-platform";
import type { PlatformRequest, PlatformResponse, PlatformTransport } from "../transport.js";
import {
  Conflict,
  InvalidRequest,
  MemoryStore,
  NotFound,
  createMemoryStore,
} from "./store.js";
import type { MemorySeed } from "./store.js";
import { createScriptedAgent } from "./agent.js";

type Handler = (store: MemoryStore, request: PlatformRequest, params: readonly string[]) => unknown;

interface Route {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly handle: Handler;
}

const TENANT = String.raw`/api/v1/tenants/[^/]+`;
const page = <T>(items: readonly T[]) => ({ items, nextCursor: null });

const readRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents$`),
    handle: (store, request) => {
      const documentType = request.query?.documentType;
      return page(store.listDocuments(documentType === undefined ? undefined : String(documentType)));
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)$`),
    handle: (store, _request, [documentId]) => store.toRecord(store.requireDocument(documentId)),
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/versions$`),
    handle: (store, _request, [documentId]) => page(store.listVersions(documentId)),
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/versions/(\\d+)$`),
    handle: (store, _request, [documentId, versionIdx]) => store.getVersion(documentId, Number(versionIdx)),
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/threads$`),
    handle: (store, request, [documentId]) => {
      const open = request.query?.open;
      const ids = store.listThreadIds(documentId, open === undefined ? undefined : open === true || open === "true");
      return page(ids.map((threadId) => ({ threadId })));
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/threads/([^/]+)$`),
    handle: (store, _request, [documentId, threadId]) => store.getThread(documentId, threadId),
  },
];

const writeRoutes: readonly Route[] = [
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/documents$`),
    handle: (store, request) => {
      const body = request.body as { documentType?: unknown; name?: unknown };
      if (typeof body?.name !== "string" || typeof body?.documentType !== "string") {
        throw new InvalidRequest("documentType and name are required");
      }
      return store.withIdempotency("createDocument", request.idempotencyKey, request.body, () =>
        store.createDocument(body.name as string, body.documentType as string));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/threads$`),
    handle: (store, request, [documentId]) =>
      store.withIdempotency(`createThread:${documentId}`, request.idempotencyKey, request.body, () =>
        store.createThread(documentId, request.body as Parameters<MemoryStore["createThread"]>[1])),
  },
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/threads/([^/]+)/pings$`),
    handle: (store, request, [documentId, threadId]) =>
      store.withIdempotency(`appendPing:${documentId}:${threadId}`, request.idempotencyKey, request.body, () =>
        store.appendPing(documentId, threadId, request.body as Parameters<MemoryStore["appendPing"]>[2])),
  },
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/current-version$`),
    handle: (store, request, [documentId]) =>
      store.moveCurrentVersion(documentId, request.body as Parameters<MemoryStore["moveCurrentVersion"]>[1]),
  },
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/cas-capabilities$`),
    handle: () => {
      throw new NotFound("cas capabilities are not available against the memory backend");
    },
  },
];

export const memoryRoutes: Route[] = [...readRoutes, ...writeRoutes];

let requestCounter = 0;

function apiError(code: string, message: string): ApiError {
  requestCounter += 1;
  return { error: { code, message, requestId: `mem-${requestCounter}` } };
}

export function createMemoryTransport(options: {
  store?: MemoryStore;
  seed?: MemorySeed;
  agent?: { autoRun?: boolean; respond?: Parameters<typeof createScriptedAgent>[0]["respond"] };
} = {}): PlatformTransport {
  const store = options.store ?? createMemoryStore(options.seed);
  const agent = createScriptedAgent({ store, respond: options.agent?.respond });
  const autoRun = options.agent?.autoRun ?? false;

  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    for (const route of memoryRoutes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(request.path);
      if (match === null) continue;

      const params = match.slice(1).map((value) => decodeURIComponent(value));
      try {
        const data = route.handle(store, request, params);
        if (autoRun && request.method === "POST") agent.runPending();
        return { ok: true, data };
      } catch (cause) {
        if (cause instanceof NotFound) return { ok: false, error: apiError("not_found", cause.message) };
        if (cause instanceof InvalidRequest) return { ok: false, error: apiError("invalid_request", cause.message) };
        if (cause instanceof Conflict) return { ok: false, error: apiError(cause.code, cause.message) };
        throw cause;
      }
    }
    return { ok: false, error: apiError("not_found", `no route for ${request.method} ${request.path}`) };
  };
}
