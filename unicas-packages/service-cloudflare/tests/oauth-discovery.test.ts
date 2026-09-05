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

  test("fails closed without an explicit origin allowlist", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const port = new CloudflareOAuthDiscoveryPort({ allowedOrigins: [], fetcher });
    await expect(port.inspectIssuer({ issuer: ISSUER })).rejects.toThrow("disabled until allowed origins");
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
});
