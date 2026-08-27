import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker";

const hash = "a".repeat(64);

function env(fetchImpl?: (request: Request) => Promise<Response>) {
  const casFetch = vi.fn(fetchImpl ?? (async () => new Response("ok")));
  return {
    GATEWAY_DB: {},
    DOC_SERVICES_JSON: "{}",
    INTERNAL_AUTH_MODE: "legacy",
    CAS_ACCESS_KEY: "cas-key",
    INSECURE_PATH_IDENTITY: "true",
    CAS_SERVICE: { fetch: casFetch },
    casFetch,
  };
}

describe("Gateway CAS proxy", () => {
  it("forwards allowlisted public CAS routes with internal headers", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request(`https://gw/tenants/alice/cas/nodes/${hash}`, { method: "POST" }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    expect(bindings.casFetch).toHaveBeenCalledTimes(1);
    const forwarded = bindings.casFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe(`/tenants/alice/cas/nodes/${hash}`);
    expect(forwarded.headers.get("X-Internal-Token")).toBe("cas-key");
    expect(forwarded.headers.get("X-Tenant-Id")).toBe("alice");
    expect(forwarded.headers.get("X-User-Id")).toBeNull();
  });

  // 真部署里踩到的:CAS 代理不设 Accept-Encoding,于是运行时的 fetch 默认发
  // "gzip, deflate, br",上游用 brotli 压缩响应,undici 收到后**透明解压
  // body**、却把 `content-encoding: br` 头留在 Response 上。网关原样返回,
  // 客户端照头去解压明文 → TypeError: terminated。doc 路径早就设了
  // identity(gateway-handler.ts 的 `headers.set("Accept-Encoding", "identity")`),
  // CAS 路径漏了。
  it("asks the CAS service for an unencoded response", async () => {
    const bindings = env();
    await worker.fetch(
      new Request(`https://gw/tenants/alice/cas/nodes/${hash}`, { method: "POST" }),
      bindings as never,
    );
    const forwarded = bindings.casFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("Accept-Encoding")).toBe("identity");
  });

  it("does not proxy root-refs", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request("https://gw/tenants/alice/cas/root-refs", { method: "POST" }),
      bindings as never,
    );
    expect(res.status).toBe(404);
    expect(bindings.casFetch).not.toHaveBeenCalled();
  });

  it("proxies tenant GC for an authorized tenant administrator", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request("https://gw/tenants/alice/cas/gc", { method: "POST" }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    const forwarded = bindings.casFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe("/tenants/alice/cas/gc");
  });
});
