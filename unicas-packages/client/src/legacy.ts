import { hashToHex, parseNodeBytes } from "@unicas/server-common";
import { casRoutes } from "@unicas/protocol-legacy";
import type {
  CasGcResult,
  CasLeaseResult,
  CasNodeMetadata,
  CasRootRefUpdate,
  CasUsage,
} from "@unicas/protocol";
import { CasClientError } from "./errors.js";
import type { LegacyTenantCasClientConfig } from "./legacy-types.js";
import type {
  CasGcOptions,
  CasLeaseOptions,
  CasNodeRange,
  CasNodeSource,
  CasRootRefsResult,
  TenantCasClient,
} from "./types.js";

export function createLegacyTenantCasClient(config: LegacyTenantCasClientConfig): TenantCasClient {
  const baseUrl = "baseUrl" in config ? config.baseUrl.replace(/\/$/, "") : "https://cas.internal";
  const fetcher = "fetcher" in config ? config.fetcher : { fetch: globalThis.fetch.bind(globalThis) };

  const request = async (route: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if ("accessKey" in config) {
      headers.set("X-Internal-Token", config.accessKey);
      headers.set("X-Tenant-Id", config.tenantId);
    } else if (config.getToken !== undefined) {
      const token = await config.getToken();
      if (token.length === 0) throw new TypeError("CAS token must not be empty");
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetcher.fetch(`${baseUrl}${route}`, { ...init, headers });
  };

  const requireOk = (response: Response, operation: string): Response => {
    if (!response.ok) throw new CasClientError(response.status, response.statusText, operation);
    return response;
  };

  const client: TenantCasClient = {
    node(hash) {
      const key = { stackId: `legacy:${baseUrl}`, tenantId: config.tenantId, hash };
      const loadMetadata = async (): Promise<CasNodeMetadata> => {
        const response = requireOk(await request(casRoutes.readMetadata({ tenantId: config.tenantId, hash })), "metadata");
        return (await response.json() as { metadata: CasNodeMetadata }).metadata;
      };
      const loadContent = async (range?: CasNodeRange): Promise<ReadableStream<Uint8Array>> => {
        validateRange(range);
        if (range?.length === 0) return emptyStream();
        const headers = range === undefined
          ? undefined
          : { Range: `bytes=${range.offset}-${range.length === undefined ? "" : range.offset + range.length - 1}` };
        const response = requireOk(
          await request(casRoutes.readContent({ tenantId: config.tenantId, hash }), { headers }),
          "read",
        );
        if (response.body === null) throw new CasClientError(502, "Missing response body", "read");
        return response.body;
      };
      const cache = "cache" in config ? config.cache : undefined;
      return Object.freeze({
        metadata: () => cache?.metadata(key, loadMetadata) ?? loadMetadata(),
        read: (range?: CasNodeRange) => cache?.read(key, range, () => loadContent(range)) ?? loadContent(range),
      });
    },

    async leaseNode(hash, source?: CasNodeSource, options: CasLeaseOptions = {}): Promise<CasLeaseResult> {
      const headers = new Headers();
      if (options.durationMs !== undefined) headers.set("X-CAS-Lease-Duration", String(options.durationMs));
      if (source === undefined) {
        const response = requireOk(
          await request(casRoutes.leaseExisting({ tenantId: config.tenantId, hash }), {
            method: "POST",
            headers,
            signal: options.signal,
          }),
          "lease",
        );
        return response.json() as Promise<CasLeaseResult>;
      }

      const canonical = new Uint8Array(await new Response(source.body).arrayBuffer());
      if (canonical.length !== source.contentLength) {
        throw new Error(`Canonical node size mismatch: expected ${source.contentLength}, got ${canonical.length}`);
      }
      const parsed = parseNodeBytes(canonical);
      headers.set("Content-Type", parsed.contentType);
      headers.set("Content-Length", String(parsed.content.length));
      if (parsed.childHashes.length > 0) {
        headers.set("X-CAS-Refs", parsed.childHashes.map(hashToHex).join(","));
      }
      const response = requireOk(
        await request(casRoutes.leaseNode({ tenantId: config.tenantId, hash }), {
          method: "POST",
          headers,
          body: parsed.content as BufferSource,
          signal: options.signal,
        }),
        "lease",
      );
      return response.json() as Promise<CasLeaseResult>;
    },

    async updateRootRefs(update: CasRootRefUpdate): Promise<CasRootRefsResult> {
      const route = "accessKey" in config
        ? "/_internal/root-refs"
        : casRoutes.rootRefs({ tenantId: config.tenantId });
      const response = requireOk(await request(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }), "updateRootRefs");
      return response.json() as Promise<CasRootRefsResult>;
    },

    async usage(signal?: AbortSignal): Promise<CasUsage> {
      const response = requireOk(await request(casRoutes.usage({ tenantId: config.tenantId }), { signal }), "usage");
      return response.json() as Promise<CasUsage>;
    },

    async gc(options: CasGcOptions = {}): Promise<CasGcResult> {
      const response = requireOk(await request(casRoutes.gc({ tenantId: config.tenantId }), {
        method: "POST",
        headers: options.maxNodes === undefined ? undefined : { "Content-Type": "application/json" },
        body: options.maxNodes === undefined ? undefined : JSON.stringify({ maxNodes: options.maxNodes }),
        signal: options.signal,
      }), "gc");
      return response.json() as Promise<CasGcResult>;
    },
  };

  return Object.freeze(client);
}

function validateRange(range: CasNodeRange | undefined): void {
  if (range === undefined) return;
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
    throw new TypeError("CAS node range offset must be a non-negative safe integer");
  }
  if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0)) {
    throw new TypeError("CAS node range length must be a non-negative safe integer");
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => controller.close() });
}