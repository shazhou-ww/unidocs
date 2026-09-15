/**
 * 真后端的 transport。本轮写出来并做单元测试，但尚无服务可连。
 */
import type { TenantApiError } from "@unidocs/protocol-tenant-portal";
import type { PlatformRequest, PlatformResponse, PlatformTransport } from "./transport.js";

function isApiError(value: unknown): value is TenantApiError {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const shape = error as Record<string, unknown>;
  return typeof shape.code === "string"
    && typeof shape.message === "string"
    && typeof shape.requestId === "string";
}

function transportFailure(message: string): PlatformResponse {
  return {
    ok: false,
    error: { error: { code: "transport_failure", message, requestId: "" } },
  };
}

export function createHttpTransport(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * 环境无关的包不读 document.cookie——由调用方（webui）注入一个读 cookie 的函数。
   * 只在 POST 上发这个头，GET 不发；调用方没给、或给了但返回 null，都不发。
   */
  csrfToken?: () => string | null;
}): PlatformTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    const url = new URL(baseUrl + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const wantsBytes = request.accept === "cbor";
    const headers = new Headers({ accept: wantsBytes ? "application/cbor" : "application/json" });
    if (request.idempotencyKey !== undefined) {
      headers.set("idempotency-key", request.idempotencyKey);
    }
    if (request.body !== undefined) headers.set("content-type", "application/json");
    if (request.method === "POST") {
      const token = options.csrfToken?.() ?? null;
      if (token !== null) headers.set("x-csrf-token", token);
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: request.method,
        headers,
        credentials: "include",
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (cause) {
      return transportFailure(cause instanceof Error ? cause.message : "network error");
    }

    // 成功且调用方要的是字节（目前只有 snapshot：canonical SValue CBOR），整段读成 bytes，
    // 不当 JSON 解析。失败响应无论 accept 是什么都还是 JSON 形状的 TenantApiError。
    if (wantsBytes && response.ok) {
      let buffer: ArrayBuffer;
      try {
        buffer = await response.arrayBuffer();
      } catch (cause) {
        return transportFailure(cause instanceof Error ? cause.message : "response body could not be read");
      }
      return { ok: true, bytes: new Uint8Array(buffer) };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return response.ok
        ? transportFailure("response was not JSON")
        : transportFailure(`HTTP ${response.status}`);
    }

    if (response.ok) return { ok: true, data: payload };
    return isApiError(payload) ? { ok: false, error: payload } : transportFailure(`HTTP ${response.status}`);
  };
}
