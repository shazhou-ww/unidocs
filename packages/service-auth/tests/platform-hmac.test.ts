import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CasAuthorizationHeader, PlatformDelegationHeader, PlatformHmacHeaders,
  importPlatformHmacKey, signPlatformRequest, verifyPlatformRequest,
} from "../src/platform-hmac.js";
import type { PlatformHmacKey, PlatformNonceStore } from "../src/platform-hmac.js";
import { DoctypeProtocol, HmacAlgorithm, SValueContentType } from "@unidocs/protocol-doctype";

const target = { origin: "https://editor.example", paths: ["/v1/editor/init", "/v1/editor/snapshot"] };
const rawKey = new Uint8Array(32).fill(0x42);
const key: PlatformHmacKey = {
  keyId: "editor-key-1", platformId: "platform", environment: "test", serviceId: "markdown",
  role: "editor", key: await importPlatformHmacKey(rawKey),
};
const bytes = new TextEncoder().encode("raw signed bytes");

function nonceStore() {
  const claimed = new Set<string>();
  return { claim: vi.fn(async (scope: string, nonce: string, _retainUntil: number) => {
    const identity = JSON.stringify([scope, nonce]);
    if (claimed.has(identity)) return false;
    claimed.add(identity);
    return true;
  }) } satisfies PlatformNonceStore;
}

function sign(overrides: Partial<Parameters<typeof signPlatformRequest>[0]> = {}) {
  return signPlatformRequest({ url: `${target.origin}/v1/editor/init`, target, key, body: bytes, now: () => 1000, ...overrides });
}

function verify(request: Request, overrides: Partial<Parameters<typeof verifyPlatformRequest>[1]> = {}) {
  return verifyPlatformRequest(request, { target, keys: [key], nonces: nonceStore(), now: () => 1000, ...overrides });
}

async function modified(request: Request, mutate: (headers: Headers) => void, body?: Uint8Array) {
  const headers = new Headers(request.headers);
  mutate(headers);
  return new Request(request.url, { method: "POST", headers, body: body ?? await request.arrayBuffer() });
}

describe("platform HMAC", () => {
  it("matches an independent canonical-byte HMAC calculation", async () => {
    const request = await sign({ casAuthorization: "Bearer cas-token" });
    const fields = [
      "unidocs-hmac/1", "unidocs-doctype/2-draft", "HMAC-SHA-256", "editor-key-1",
      "platform", "test", "markdown", "editor", "POST", "https://editor.example", "/v1/editor/init", "",
      SValueContentType, createHash("sha256").update(bytes).digest("hex"), "1000", "1060",
      request.headers.get("x-unidocs-nonce")!, createHash("sha256").update("Bearer cas-token").digest("hex"), "absent",
    ];
    const canonical = fields.map((field) => `${Buffer.byteLength(field)}:${field}`).join("");
    expect(request.headers.get("x-unidocs-signature"))
      .toBe(createHmac("sha256", rawKey).update(canonical).digest("hex"));
    expect(request.redirect).toBe("error");
    const nonces = nonceStore();
    const result = await verify(request, { nonces });
    expect(result.body).toEqual(bytes);
    expect(result.authentication).not.toHaveProperty("signature");
    expect(result.casAuthorization).toBe("Bearer cas-token");
    expect(nonces.claim).toHaveBeenCalledWith('["platform","test","markdown","editor"]', result.authentication.nonce, 1090);
  });

  it("accepts a fixed cross-implementation request vector", async () => {
    const headers = new Headers({ "content-type": SValueContentType });
    const metadata = { protocol: DoctypeProtocol, algorithm: HmacAlgorithm, ...key, issuedAt: "1000", expiresAt: "1060", nonce: "vector-nonce-0001", signature: "" };
    const fields = ["unidocs-hmac/1", DoctypeProtocol, HmacAlgorithm, key.keyId, key.platformId, key.environment,
      key.serviceId, key.role, "POST", target.origin, "/v1/editor/init", "", SValueContentType,
      createHash("sha256").update(bytes).digest("hex"), "1000", "1060", "vector-nonce-0001", "absent", "absent"];
    metadata.signature = createHmac("sha256", rawKey).update(fields.map((field) => `${Buffer.byteLength(field)}:${field}`).join("")).digest("hex");
    expect(metadata.signature).toBe("dbbabcd6dcbe0e9a56514098cfb894183d7c94825805ccff6213848f341cabd1");
    for (const [field, name] of Object.entries(PlatformHmacHeaders)) headers.set(name, String(metadata[field as keyof typeof metadata]));
    const request = new Request(`${target.origin}/v1/editor/init`, { method: "POST", headers, body: bytes });
    expect((await verify(request)).authentication.nonce).toBe("vector-nonce-0001");
  });

  it.each([
    ["x-unidocs-key-id", "unknown"], ["x-unidocs-platform-id", "other"], ["x-unidocs-environment", "prod"],
    ["x-unidocs-service-id", "operator"], ["x-unidocs-role", "operator"], ["x-unidocs-nonce", "altered"],
    ["x-unidocs-issued-at", "1001"], ["x-unidocs-expires-at", "1061"], ["x-unidocs-algorithm", "none"],
    ["x-unidocs-protocol", "other"], ["content-type", "application/json"], [CasAuthorizationHeader, "Bearer other"],
    ["authorization", "Bearer user-jwt"], ["cookie", "session=user"], ["x-unidocs-extra-auth", "secret"],
  ])("rejects tampered %s before nonce registration", async (header, value) => {
    const nonces = nonceStore();
    const request = await modified(await sign(), (headers) => headers.set(header, value));
    await expect(verify(request, { nonces })).rejects.toMatchObject({ code: "unauthorized" });
    expect(nonces.claim).not.toHaveBeenCalled();
  });

  it("rejects body tampering and missing signatures", async () => {
    const nonces = nonceStore();
    await expect(verify(await modified(await sign(), () => {}, new Uint8Array([0])), { nonces }))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(verify(await modified(await sign(), (headers) => headers.delete(PlatformHmacHeaders.signature)), { nonces }))
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(nonces.claim).not.toHaveBeenCalled();
  });

  it.each(["x-unidocs-key-id", "x-unidocs-issued-at", "x-unidocs-signature", CasAuthorizationHeader, "content-type"])
    ("rejects merged duplicate headers: %s", async (header) => {
      const request = await modified(await sign({ casAuthorization: "Bearer token" }), (headers) => headers.append(header, headers.get(header)!));
      await expect(verify(request)).rejects.toMatchObject({ code: "unauthorized" });
    });

  it.each(["http://editor.example/v1/editor/init", "https://other.example/v1/editor/init", "https://editor.example/v1/editor/init?a=1&a=2", "https://editor.example/v1/editor/init?", "https://editor.example/v1/editor/init#", "https://editor.example/v1/editor/%69nit", "https://editor.example/v1/editor/../editor/init"])
    ("refuses to sign noncanonical or non-allowlisted targets: %s", async (url) => {
      await expect(sign({ url })).rejects.toMatchObject({ code: "unauthorized" });
    });

  it("binds the path and method", async () => {
    const request = await sign();
    await expect(verify(new Request(`${target.origin}/v1/editor/snapshot`, { method: "POST", headers: request.headers, body: bytes })))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(verify(new Request(request.url, { method: "GET", headers: request.headers })))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects expired and excessively future timestamps", async () => {
    await expect(verify(await sign(), { now: () => 1090 })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verify(await sign(), { now: () => 969 })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(sign({ lifetimeSeconds: 301 })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(sign({ lifetimeSeconds: 0 })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects concurrent replay across verifier instances sharing the nonce store", async () => {
    const nonces = nonceStore();
    const request = await sign();
    const results = await Promise.allSettled([verify(request.clone(), { nonces }), verify(request.clone(), { nonces })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "replay_detected" } });
    await expect(verify(request, { nonces })).rejects.toMatchObject({ code: "replay_detected" });
  });

  it("fails closed when nonce storage is unavailable", async () => {
    await expect(verify(await sign(), { nonces: { claim: async () => { throw new Error("secret storage detail"); } } }))
      .rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
  });

  it("supports bounded key overlap and immediate key revocation", async () => {
    const next = { ...key, keyId: "editor-key-2", key: await importPlatformHmacKey(new Uint8Array(32).fill(0x43)) };
    await verify(await sign({ key: next }), { keys: [key, next] });
    await expect(verify(await sign(), { keys: [next] })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verify(await sign(), { keys: [key, key] })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("uses separate operator keys and binds callback delegation", async () => {
    const operator = { ...key, keyId: "operator-key", serviceId: "operator", role: "operator" as const,
      key: await importPlatformHmacKey(new Uint8Array(32).fill(0x44)) };
    const request = await sign({ key: operator, platformAuthorization: "Bearer task-only" });
    expect((await verify(request, { keys: [operator] })).platformAuthorization).toBe("Bearer task-only");
    const changed = await modified(await sign({ key: operator, platformAuthorization: "Bearer task-only" }),
      (headers) => headers.set(PlatformDelegationHeader, "Bearer other-task"));
    await expect(verify(changed, { keys: [operator] })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(sign({ platformAuthorization: "Bearer callback" })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects requests expiring while waiting for nonce storage", async () => {
    let now = 1000;
    await expect(verify(await sign(), { now: () => now, nonces: { claim: async () => {
      now = 1090;
      return true;
    } } })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("bounds streamed bodies before nonce registration", async () => {
    const nonces = nonceStore();
    await expect(verify(await sign(), { nonces, maxBodyBytes: 2 })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(nonces.claim).not.toHaveBeenCalled();
  });
});