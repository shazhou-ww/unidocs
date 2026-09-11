import { describe, expect, it, vi } from "vitest";
import { createHttpTransport } from "../src/http-transport.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createHttpTransport", () => {
  it("把 query 里的 undefined 丢掉，其余序列化", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [] }));
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    await transport({
      method: "GET",
      path: "/api/v1/tenants/t1/documents",
      query: { documentType: "markdown", cursor: undefined, limit: 20 },
    });

    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://example.test/api/v1/tenants/t1/documents");
    expect(url.searchParams.get("documentType")).toBe("markdown");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("idempotencyKey 落到请求头", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    await transport({ method: "POST", path: "/p", body: { a: 1 }, idempotencyKey: "key-1" });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("idempotency-key")).toBe("key-1");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("非 2xx 且是 ApiError 形状时返回 ok:false", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: { code: "version_conflict", message: "moved", requestId: "req-1" } }),
    );
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    const result = await transport({ method: "GET", path: "/p" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("version_conflict");
  });

  it("非 2xx 且不是 ApiError 形状时合成一个，不抛裸异常", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    const result = await transport({ method: "GET", path: "/p" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("transport_failure");
      expect(result.error.error.requestId).toBe("");
    }
  });
});
