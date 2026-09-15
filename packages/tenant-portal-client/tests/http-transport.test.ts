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

  it("非 2xx 且是 TenantApiError 形状时返回 ok:false", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: { code: "version_conflict", message: "moved", requestId: "req-1" } }),
    );
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    const result = await transport({ method: "GET", path: "/p" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("version_conflict");
  });

  it("非 2xx 且不是 TenantApiError 形状时合成一个，不抛裸异常", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    const result = await transport({ method: "GET", path: "/p" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("transport_failure");
      expect(result.error.error.requestId).toBe("");
    }
  });

  it("accept: cbor 时请求 application/cbor 且成功响应整体读成 bytes，不当 JSON 解析", async () => {
    const bytes = new Uint8Array([0xa1, 0x67, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74]); // 不是合法 JSON
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    const result = await transport({ method: "GET", path: "/p", accept: "cbor" });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("accept")).toBe("application/cbor");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("bytes" in result).toBe(true);
      if ("bytes" in result) expect([...result.bytes]).toEqual([...bytes]);
    }
  });

  it("accept: cbor 且非 2xx 时仍按 JSON 解析出 TenantApiError（错误响应不是 CBOR）", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { code: "not_found", message: "gone", requestId: "req-2" } }),
    );
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    const result = await transport({ method: "GET", path: "/p", accept: "cbor" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("not_found");
  });

  it("sends the CSRF token on a POST", async () => {
    const calls: Request[] = [];
    const transport = createHttpTransport({
      baseUrl: "https://example.test",
      fetchImpl: async (input, init) => { calls.push(new Request(input, init)); return Response.json({}, { status: 201 }); },
      csrfToken: () => "csrf-abc",
    });
    await transport({ method: "POST", path: "/api/v1/tenants/t1/documents", body: {}, idempotencyKey: "k" });
    expect(calls[0].headers.get("x-csrf-token")).toBe("csrf-abc");
  });

  it("does not send the CSRF token on a GET", async () => {
    const calls: Request[] = [];
    const transport = createHttpTransport({
      baseUrl: "https://example.test",
      fetchImpl: async (input, init) => { calls.push(new Request(input, init)); return Response.json({ items: [], nextCursor: null }); },
      csrfToken: () => "csrf-abc",
    });
    await transport({ method: "GET", path: "/api/v1/tenants/t1/documents" });
    expect(calls[0].headers.has("x-csrf-token")).toBe(false);
  });

  it("omits the header when no token is available", async () => {
    const calls: Request[] = [];
    const transport = createHttpTransport({
      baseUrl: "https://example.test",
      fetchImpl: async (input, init) => { calls.push(new Request(input, init)); return Response.json({}, { status: 201 }); },
      csrfToken: () => null,
    });
    await transport({ method: "POST", path: "/api/v1/tenants/t1/documents", body: {}, idempotencyKey: "k" });
    expect(calls[0].headers.has("x-csrf-token")).toBe(false);
  });
});
