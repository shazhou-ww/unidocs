import { CanonicalNodeContentType } from "@unicas/server-common";
import { casRoutes } from "@unicas/protocol";
import type {
  CasGcResult,
  CasNodeMetadata,
  CasRootRefUpdate,
  CasUsage,
} from "@unicas/protocol";
import { CasClientError } from "./errors.js";
import type {
  CasGcOptions,
  CasLeaseOptions,
  CasNodeRange,
  CasNodeSource,
  CasRootRefsResult,
  TenantCasClient,
  TenantCasClientConfig,
} from "./types.js";

function validateRange(range: CasNodeRange): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
    throw new TypeError("CAS node range offset must be a non-negative safe integer");
  }
  if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0)) {
    throw new TypeError("CAS node range length must be a non-negative safe integer");
  }
}

export function createTenantCasClient(config: TenantCasClientConfig): TenantCasClient {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const fetcher = config.fetcher ?? { fetch: globalThis.fetch.bind(globalThis) };
  const path = { stackId: config.stackId, tenantId: config.tenantId };

  const request = async (
    route: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const token = await config.getToken();
    if (token.length === 0) throw new TypeError("CAS token must not be empty");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetcher.fetch(`${baseUrl}${route}`, { ...init, headers });
  };

  const requireOk = (response: Response, operation: string): Response => {
    if (!response.ok) {
      throw new CasClientError(response.status, response.statusText, operation);
    }
    return response;
  };

  const client: TenantCasClient = {
    node(hash) {
      const key = { ...path, hash };

      const loadMetadata = async (): Promise<CasNodeMetadata> => {
        const response = requireOk(
          await request(casRoutes.readMetadata({ ...path, hash })),
          "metadata",
        );
        const body = await response.json() as { metadata: CasNodeMetadata };
        return body.metadata;
      };

      const loadContent = async (range?: CasNodeRange): Promise<ReadableStream<Uint8Array>> => {
        if (range !== undefined) validateRange(range);
        if (range?.length === 0) {
          return new ReadableStream({ start: controller => controller.close() });
        }
        const headers = range === undefined
          ? undefined
          : { Range: `bytes=${range.offset}-${range.length === undefined ? "" : range.offset + range.length - 1}` };
        const response = requireOk(
          await request(casRoutes.readContent({ ...path, hash }), { headers }),
          "read",
        );
        if (response.body === null) {
          throw new CasClientError(502, "Missing response body", "read");
        }
        return response.body;
      };

      return Object.freeze({
        metadata: () => config.cache?.metadata(key, loadMetadata) ?? loadMetadata(),
        read: (range?: CasNodeRange) => config.cache?.read(key, range, () => loadContent(range)) ?? loadContent(range),
      });
    },

    async leaseNode(hash, source?: CasNodeSource, options: CasLeaseOptions = {}) {
      const headers = new Headers();
      if (options.durationMs !== undefined) {
        headers.set("X-CAS-Lease-Duration", String(options.durationMs));
      }
      if (source !== undefined) {
        headers.set("Content-Type", CanonicalNodeContentType);
        headers.set("Content-Length", String(source.contentLength));
      }
      const init: RequestInit = {
        method: "POST",
        headers,
        body: source?.body as BodyInit | undefined,
        signal: options.signal,
      };
      if (source !== undefined) {
        (init as RequestInit & { duplex?: "half" }).duplex = "half";
      }
      const response = requireOk(
        await request(casRoutes.lease({ ...path, hash }), init),
        "lease",
      );
      return response.json();
    },

    async updateRootRefs(update: CasRootRefUpdate): Promise<CasRootRefsResult> {
      const response = requireOk(
        await request(casRoutes.updateRootRefs(path), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        }),
        "updateRootRefs",
      );
      return response.json() as Promise<CasRootRefsResult>;
    },

    async usage(signal?: AbortSignal): Promise<CasUsage> {
      const response = requireOk(
        await request(casRoutes.usage(path), { signal }),
        "usage",
      );
      return response.json() as Promise<CasUsage>;
    },

    async gc(options: CasGcOptions = {}): Promise<CasGcResult> {
      const response = requireOk(
        await request(casRoutes.gc(path), {
          method: "POST",
          headers: options.maxNodes === undefined ? undefined : { "Content-Type": "application/json" },
          body: options.maxNodes === undefined ? undefined : JSON.stringify({ maxNodes: options.maxNodes }),
          signal: options.signal,
        }),
        "gc",
      );
      return response.json() as Promise<CasGcResult>;
    },
  };

  return Object.freeze(client);
}