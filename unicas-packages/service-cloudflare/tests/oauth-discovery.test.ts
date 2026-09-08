import { describe, expect, test, vi } from "vitest";
import { CloudflareOAuthDiscoveryPort } from "../src/oauth-discovery.js";

const ISSUER = "https://auth.example/tenant-a";
const OAUTH_METADATA = "https://auth.example/.well-known/oauth-authorization-server/tenant-a";
const OIDC_METADATA = "https://auth.example/tenant-a/.well-known/openid-configuration";
const JWKS = "https://keys.example/tenant-a/jwks";

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: "https://auth.example/tenant-a/authorize",
    token_endpoint: "https://auth.example/tenant-a/token",
    jwks_uri: JWKS,
    registration_endpoint: "https://auth.example/tenant-a/register",
    scopes_supported: ["cas:read", "cas:write"],
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

const jwks = {
  keys: [{
    kid: "key-1",
    alg: "ES256",
    use: "sig",
    kty: "EC",
    crv: "P-256",
    x: "x",
    y: "y",
  }],
};

describe("Cloudflare Stack OAuth discovery", () => {
  test("discovers metadata and JWKS only from allowlisted origins", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === OAUTH_METADATA) return json(metadata());
      if (url === JWKS) return json(jwks);
      return new Response("not found", { status: 404 });
    });
    const port = new CloudflareOAuthDiscoveryPort({
      allowedOrigins: ["https://auth.example", "https://keys.example"],
      fetcher,
    });

    await expect(port.inspectIssuer({ issuer: ISSUER })).resolves.toMatchObject({
      metadata: { issuer: ISSUER, metadataType: "oauth", metadataUrl: OAUTH_METADATA, jwksUri: JWKS },
      keys: [{ kid: "key-1", algorithm: "ES256" }],
      metadataDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      jwksDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([OAUTH_METADATA, JWKS]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  test("falls back from unavailable RFC 8414 metadata to OIDC discovery", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === OAUTH_METADATA) return new Response("not found", { status: 404 });
      if (url === OIDC_METADATA) return json(metadata());
      if (url === JWKS) return json(jwks);
      return new Response("not found", { status: 404 });
    });
    const port = new CloudflareOAuthDiscoveryPort({
      allowedOrigins: ["https://auth.example", "https://keys.example"],
      fetcher,
    });
    await expect(port.inspectIssuer({ issuer: ISSUER })).resolves.toMatchObject({
      metadata: { metadataType: "oidc", metadataUrl: OIDC_METADATA },
    });
  });

  test("discovers independent public issuer and JWKS origins without a platform allowlist", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input) === JWKS ? json(jwks) : json(metadata()));
    const port = new CloudflareOAuthDiscoveryPort({ fetcher });
    await expect(port.inspectIssuer({ issuer: ISSUER })).resolves.toMatchObject({ metadata: { issuer: ISSUER, jwksUri: JWKS } });
    await expect(port.fetchJwks(JWKS, {}).then((response) => response.json())).resolves.toEqual(jwks);
  });

  test("an explicitly empty origin restriction denies all requests", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const port = new CloudflareOAuthDiscoveryPort({ allowedOrigins: [], fetcher });
    await expect(port.inspectIssuer({ issuer: ISSUER })).rejects.toThrow("empty origin allowlist");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://metadata.google.internal",
    "https://auth.example:8443",
  ])("rejects unsafe allowlisted origins: %s", (origin) => {
    expect(() => new CloudflareOAuthDiscoveryPort({ allowedOrigins: [origin] })).toThrow();
  });

  test.each([
    "http://auth.example", "https://localhost.", "https://foo.local", "https://metadata.google.internal",
    "https://router.home.arpa", "https://intranet", "https://127.1", "https://2130706433",
    "https://0x7f000001", "https://10.0.0.1", "https://169.254.169.254", "https://[::ffff:127.0.0.1]",
    "https://auth.example:8443", "https://user:password@auth.example", "https://auth.example/jwks#fragment",
  ])("public mode rejects unsafe targets before fetching: %s", async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    const port = new CloudflareOAuthDiscoveryPort({ fetcher });
    await expect(port.fetchJwks(url, {})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("rejects a JWKS origin that was not allowlisted", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input) === JWKS ? json(jwks) : json(metadata()));
    const port = new CloudflareOAuthDiscoveryPort({
      allowedOrigins: ["https://auth.example"],
      fetcher,
    });
    await expect(port.inspectIssuer({ issuer: ISSUER })).rejects.toThrow("jwks_uri origin is not allowlisted");
    expect(fetcher.mock.calls.some(([input]) => String(input) === JWKS)).toBe(false);
  });

  test("fetches runtime JWKS only through the discovery allowlist", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(jwks));
    const port = new CloudflareOAuthDiscoveryPort({
      allowedOrigins: ["https://keys.example"],
      fetcher,
    });
    const options = {
      headers: new Headers({ Accept: "application/json" }),
      method: "GET" as const,
      redirect: "manual" as const,
      signal: new AbortController().signal,
    };

    await expect(port.fetchJwks(JWKS, options).then((response) => response.json()))
      .resolves.toEqual(jwks);
    await expect(port.fetchJwks("https://other.example/jwks", options))
      .rejects.toThrow("jwks_uri origin is not allowlisted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("rejects redirects and oversized responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { Location: "https://localhost/jwks" } }));
    const runtime = new CloudflareOAuthDiscoveryPort({ allowedOrigins: ["https://keys.example"], fetcher });
    await expect(runtime.fetchJwks(JWKS, { redirect: "follow", headers: { Authorization: "must-not-forward" } })).rejects.toThrow("redirects are not allowed");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual", headers: { Accept: "application/json" } });
    const redirecting = new CloudflareOAuthDiscoveryPort({
      allowedOrigins: ["https://auth.example"],
      fetcher: async () => new Response(null, { status: 302, headers: { Location: OIDC_METADATA } }),
    });
    await expect(redirecting.inspectIssuer({ issuer: ISSUER })).rejects.toThrow("redirects are not allowed");

    const oversized = new CloudflareOAuthDiscoveryPort({
      allowedOrigins: ["https://auth.example"],
      fetcher: async () => new Response(null, {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Length": String(128 * 1024 + 1) },
      }),
    });
    await expect(oversized.inspectIssuer({ issuer: ISSUER })).rejects.toThrow("response is too large");
  });

  test("pins the metadata issuer exactly", async () => {
    const port = new CloudflareOAuthDiscoveryPort({
      allowedOrigins: ["https://auth.example", "https://keys.example"],
      fetcher: async () => json(metadata({ issuer: "https://auth.example/tenant-b" })),
    });
    await expect(port.inspectIssuer({ issuer: ISSUER })).rejects.toThrow("issuer must exactly match");
  });

  test("runtime JWKS enforces its own timeout and honors caller cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>((_input, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    }));
    const port = new CloudflareOAuthDiscoveryPort({ fetcher, timeoutMs: 5 });
    await expect(port.fetchJwks(JWKS, {})).rejects.toThrow();
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    const controller = new AbortController();
    const pending = port.fetchJwks(JWKS, { signal: controller.signal });
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow("caller cancelled");
    await expect(port.fetchJwks(JWKS, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("cancels rejected and streaming oversized bodies", async () => {
    const cancel = vi.fn();
    const port = new CloudflareOAuthDiscoveryPort({
      fetcher: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
        cancel,
      }), { headers: { "Content-Type": "application/json" } }),
    });
    await expect(port.fetchJwks(JWKS, {})).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
