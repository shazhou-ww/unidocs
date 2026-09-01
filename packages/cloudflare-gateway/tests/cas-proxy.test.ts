import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker";

const hash = "a".repeat(64);

async function env(fetchImpl?: (request: Request) => Promise<Response>) {
  const casFetch = vi.fn(fetchImpl ?? (async () => new Response("ok")));
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    GATEWAY_DB: {},
    DOC_SERVICES_JSON: "{}",
    CAPABILITY_PRIVATE_KEY_PKCS8: privateKey,
    CAPABILITY_KEY_ID: "doc-key",
    CAPABILITY_ISSUER: "https://gateway.test",
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "300",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
    CAS_STACK_ID: "stack-1",
    CAS_STACK_ISSUER: "https://stack.test",
    GATEWAY_OAUTH_ISSUER: "https://stack.test",
    CAS_STACK_KEY_ID: "cas-key",
    CAS_STACK_PRIVATE_KEY_PKCS8: privateKey,
    CAS_REF_DOMAIN: "doc",
    INSECURE_PATH_IDENTITY: "true",
    CAS_SERVICE: { fetch: casFetch },
    casFetch,
  };
}

describe("Gateway CAS proxy", () => {
  it("publishes OAuth authorization-server metadata and the CAS public key", async () => {
    const bindings = await env();
    const metadata = await worker.fetch(
      new Request("https://gw/.well-known/oauth-authorization-server"),
      bindings as never,
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      issuer: "https://stack.test",
      authorization_endpoint: "https://stack.test/authorize",
      token_endpoint: "https://stack.test/token",
      jwks_uri: "https://stack.test/jwks",
      code_challenge_methods_supported: ["S256"],
    });

    const jwks = await worker.fetch(new Request("https://gw/jwks"), bindings as never);
    const body = await jwks.json() as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      kid: "cas-key",
      alg: "ES256",
      use: "sig",
      kty: "EC",
      crv: "P-256",
    });
    expect(body.keys[0]).not.toHaveProperty("d");
    expect(bindings.casFetch).not.toHaveBeenCalled();
  });

  it("forwards allowlisted public CAS routes with a capability", async () => {
    const bindings = await env();
    const res = await worker.fetch(
      new Request(`https://gw/tenants/alice/cas/nodes/${hash}/content`),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    expect(bindings.casFetch).toHaveBeenCalledTimes(1);
    const forwarded = bindings.casFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe(`/stacks/stack-1/tenants/alice/cas/nodes/${hash}/content`);
    expect(forwarded.headers.get("Authorization")).toMatch(/^Bearer /);
    expect(forwarded.headers.get("X-Internal-Token")).toBeNull();
    expect(forwarded.headers.get("X-Tenant-Id")).toBeNull();
    expect(forwarded.headers.get("X-User-Id")).toBeNull();
  });

  // 真部署里踩到的:CAS 代理不设 Accept-Encoding,于是运行时的 fetch 默认发
  // "gzip, deflate, br",上游用 brotli 压缩响应,undici 收到后**透明解压
  // body**、却把 `content-encoding: br` 头留在 Response 上。网关原样返回,
  // 客户端照头去解压明文 → TypeError: terminated。doc 路径早就设了
  // identity(gateway-handler.ts 的 `headers.set("Accept-Encoding", "identity")`),
  // CAS 路径漏了。
  it("asks the CAS service for an unencoded response", async () => {
    const bindings = await env();
    await worker.fetch(
      new Request(`https://gw/tenants/alice/cas/nodes/${hash}/content`),
      bindings as never,
    );
    const forwarded = bindings.casFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("Accept-Encoding")).toBe("identity");
  });

  it("does not proxy root-refs", async () => {
    const bindings = await env();
    const res = await worker.fetch(
      new Request("https://gw/tenants/alice/cas/root-refs", { method: "POST" }),
      bindings as never,
    );
    expect(res.status).toBe(404);
    expect(bindings.casFetch).not.toHaveBeenCalled();
  });

  it("proxies tenant GC for an authorized tenant administrator", async () => {
    const bindings = await env();
    const res = await worker.fetch(
      new Request("https://gw/tenants/alice/cas/gc", { method: "POST" }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    const forwarded = bindings.casFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe("/stacks/stack-1/tenants/alice/cas/gc");
  });
});

function pem(bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}
