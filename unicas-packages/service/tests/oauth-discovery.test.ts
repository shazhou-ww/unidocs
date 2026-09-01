import { describe, expect, test } from "vitest";
import {
  canonicalizeOAuthIssuer,
  oauthDiscoveryCandidates,
  parseOAuthMetadata,
} from "../src/index.js";

describe("Stack OAuth discovery", () => {
  test("trims but otherwise preserves a valid issuer identifier", () => {
    expect(canonicalizeOAuthIssuer(" https://AUTH.example:443/tenant/ "))
      .toBe("https://AUTH.example:443/tenant/");
    expect(canonicalizeOAuthIssuer("https://auth.example/"))
      .toBe("https://auth.example/");
  });

  test.each([
    "http://auth.example/tenant",
    "https://user:password@auth.example/tenant",
    "https://auth.example/tenant?mode=test",
    "https://auth.example/tenant#fragment",
    "not-a-url",
  ])("rejects an invalid issuer: %s", (issuer) => {
    expect(() => canonicalizeOAuthIssuer(issuer)).toThrow();
  });

  test("derives RFC 8414 and OIDC locations for a path-bearing issuer", () => {
    expect(oauthDiscoveryCandidates("https://auth.example/tenant-a")).toEqual([
      {
        type: "oauth",
        url: "https://auth.example/.well-known/oauth-authorization-server/tenant-a",
      },
      {
        type: "oidc",
        url: "https://auth.example/tenant-a/.well-known/openid-configuration",
      },
    ]);
  });

  test("derives root issuer discovery locations without a duplicate slash", () => {
    expect(oauthDiscoveryCandidates("https://auth.example")).toEqual([
      {
        type: "oauth",
        url: "https://auth.example/.well-known/oauth-authorization-server",
      },
      {
        type: "oidc",
        url: "https://auth.example/.well-known/openid-configuration",
      },
    ]);
  });

  test("validates and projects untrusted authorization-server metadata", () => {
    const candidate = oauthDiscoveryCandidates("https://auth.example/tenant-a")[0]!;
    expect(parseOAuthMetadata({
      issuer: "https://auth.example/tenant-a",
      authorization_endpoint: "https://auth.example/tenant-a/authorize",
      token_endpoint: "https://auth.example/tenant-a/token",
      jwks_uri: "https://auth.example/tenant-a/jwks",
      registration_endpoint: "https://auth.example/tenant-a/register",
      scopes_supported: ["cas:read", "cas:read", "cas:write"],
      code_challenge_methods_supported: ["S256"],
    }, "https://auth.example/tenant-a", candidate)).toEqual({
      issuer: "https://auth.example/tenant-a",
      metadataUrl: candidate.url,
      metadataType: "oauth",
      authorizationEndpoint: "https://auth.example/tenant-a/authorize",
      tokenEndpoint: "https://auth.example/tenant-a/token",
      jwksUri: "https://auth.example/tenant-a/jwks",
      registrationEndpoint: "https://auth.example/tenant-a/register",
      scopesSupported: ["cas:read", "cas:write"],
      codeChallengeMethodsSupported: ["S256"],
    });
  });

  test("requires exact issuer pinning and PKCE S256", () => {
    const candidate = oauthDiscoveryCandidates("https://auth.example/tenant-a")[0]!;
    const metadata = {
      issuer: "https://auth.example/tenant-b",
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token",
      jwks_uri: "https://auth.example/jwks",
      code_challenge_methods_supported: ["plain"],
    };
    expect(() => parseOAuthMetadata(metadata, "https://auth.example/tenant-a", candidate))
      .toThrow("metadata issuer must exactly match");
    expect(() => parseOAuthMetadata(
      { ...metadata, issuer: "https://auth.example/tenant-a" },
      "https://auth.example/tenant-a",
      candidate,
    )).toThrow("PKCE S256");
  });

  test("rejects non-HTTPS discovered endpoints", () => {
    const candidate = oauthDiscoveryCandidates("https://auth.example")[0]!;
    expect(() => parseOAuthMetadata({
      issuer: "https://auth.example",
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token",
      jwks_uri: "http://keys.example/jwks",
      code_challenge_methods_supported: ["S256"],
    }, "https://auth.example", candidate)).toThrow("jwks_uri must be an HTTPS URL");
  });
});
