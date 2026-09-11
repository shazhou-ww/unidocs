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

/** Task 5 会在这里追加写路由。 */
export const memoryRoutes: Route[] = [...readRoutes];

let requestCounter = 0;

function apiError(code: string, message: string): ApiError {
  requestCounter += 1;
  return { error: { code, message, requestId: `mem-${requestCounter}` } };
}

export function createMemoryTransport(options: {
  store?: MemoryStore;
  seed?: MemorySeed;
} = {}): PlatformTransport {
  const store = options.store ?? createMemoryStore(options.seed);

  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    for (const route of memoryRoutes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(request.path);
      if (match === null) continue;

      const params = match.slice(1).map((value) => decodeURIComponent(value));
      try {
        return { ok: true, data: route.handle(store, request, params) };
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
