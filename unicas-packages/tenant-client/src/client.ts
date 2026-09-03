import { CanonicalNodeContentType } from "@unicas/codec";
import {
  CasUploadIdHeader,
  CasUploadLengthHeader,
  casRoutes,
} from "@unicas/tenant-protocol";
import type {
  CasGcResult,
  CasLeaseOperationResult,
  CasLeaseResult,
  CasNodeMetadata,
  CasRootRefUpdate,
  CasUsage,
} from "@unicas/tenant-protocol";
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
  const uploadFetcher = config.uploadFetcher ?? fetcher;
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

  const requireOk = async (response: Response, operation: string): Promise<Response> => {
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null;
      const detail = typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string" ? body.error : undefined;
      throw new CasClientError(response.status, response.statusText, operation, detail);
    }
    return response;
  };

  const client: TenantCasClient = {
    readMetadata(hash, options: { readonly signal?: AbortSignal } = {}) {
      const key = { ...path, hash };
      const loadMetadata = async (): Promise<CasNodeMetadata> => {
        const response = await requireOk(
          await request(casRoutes.readMetadata({ ...path, hash }), { signal: options.signal }),
          "metadata",
        );
        const body = await response.json() as { metadata: CasNodeMetadata };
        return body.metadata;
      };
      return config.cache?.metadata(key, loadMetadata) ?? loadMetadata();
    },

    readContent(hash, range?: CasNodeRange, options: { readonly signal?: AbortSignal } = {}) {
      const key = { ...path, hash };
      const loadContent = async (): Promise<ReadableStream<Uint8Array>> => {
        if (range !== undefined) validateRange(range);
        if (range?.length === 0) {
          return new ReadableStream({ start: controller => controller.close() });
        }
        const headers = range === undefined
          ? undefined
          : { Range: `bytes=${range.offset}-${range.length === undefined ? "" : range.offset + range.length - 1}` };
        const response = await requireOk(
          await request(casRoutes.readContent({ ...path, hash }), { headers, signal: options.signal }),
          "read",
        );
        if (response.body === null) {
          throw new CasClientError(502, "Missing response body", "read");
        }
        return response.body;
      };
      return config.cache?.read(key, range, loadContent) ?? loadContent();
    },

    async leaseNode(hash, source?: CasNodeSource, options: CasLeaseOptions = {}) {
      if (source !== undefined && config.uploadMode === "direct") {
        const prepareHeaders = new Headers({
          [CasUploadLengthHeader]: String(source.contentLength),
        });
        if (options.durationMs !== undefined) {
          prepareHeaders.set("X-CAS-Lease-Duration", String(options.durationMs));
        }
        const preparedResponse = await requireOk(
          await request(casRoutes.lease({ ...path, hash }), {
            method: "POST",
            headers: prepareHeaders,
            signal: options.signal,
          }),
          "prepareUpload",
        );
        const prepared = await preparedResponse.json() as CasLeaseOperationResult;
        if (prepared.ready) return prepared;

        const uploadInit: RequestInit = {
          method: prepared.upload.method,
          headers: prepared.upload.headers,
          body: source.body as BodyInit,
          signal: options.signal,
        };
        (uploadInit as RequestInit & { duplex?: "half" }).duplex = "half";
        const uploadResponse = await uploadFetcher.fetch(prepared.upload.url, uploadInit);
        await uploadResponse.body?.cancel("Direct CAS upload response consumed").catch(() => undefined);
        if (!uploadResponse.ok && uploadResponse.status !== 412) {
          throw new CasClientError(
            uploadResponse.status,
            uploadResponse.statusText,
            "upload",
          );
        }

        const finalizeHeaders = new Headers({ [CasUploadIdHeader]: prepared.uploadId });
        if (options.durationMs !== undefined) {
          finalizeHeaders.set("X-CAS-Lease-Duration", String(options.durationMs));
        }
        const finalized = await requireOk(
          await request(casRoutes.lease({ ...path, hash }), {
            method: "POST",
            headers: finalizeHeaders,
            signal: options.signal,
          }),
          "finalizeUpload",
        );
        return finalized.json() as Promise<CasLeaseResult>;
      }
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
      const response = await requireOk(
        await request(casRoutes.lease({ ...path, hash }), init),
        "lease",
      );
      return response.json();
    },

    async updateRootRefs(update: CasRootRefUpdate): Promise<CasRootRefsResult> {
      const response = await requireOk(
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
      const response = await requireOk(
        await request(casRoutes.usage(path), { signal }),
        "usage",
      );
      return response.json() as Promise<CasUsage>;
    },

    async gc(options: CasGcOptions = {}): Promise<CasGcResult> {
      const response = await requireOk(
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