/**
 * 真后端的 transport。本轮写出来并做单元测试，但尚无服务可连。
 */
import type { ApiError } from "@unidocs/protocol-platform";
import type { PlatformRequest, PlatformResponse, PlatformTransport } from "./transport.js";

function isApiError(value: unknown): value is ApiError {
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
}): PlatformTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    const url = new URL(baseUrl + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({ accept: "application/json" });
    if (request.idempotencyKey !== undefined) {
      headers.set("idempotency-key", request.idempotencyKey);
    }
    if (request.body !== undefined) headers.set("content-type", "application/json");

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
