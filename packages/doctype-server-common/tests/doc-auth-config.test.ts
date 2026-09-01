import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, test } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityIssuer,
  JoseCapabilitySigner,
  casReadPermission,
  sessionReadPermission,
} from "@unidocs/service-auth";
import {
  DocAuthConfigCache,
  resolveDocAuthConfig,
} from "../src/doc-auth-config.js";

describe("Doc auth configuration", () => {
  test("requires complete capability configuration", async () => {
    await expect(resolveDocAuthConfig("markdown", {}))
      .rejects.toThrow("CAPABILITY_ISSUER");
  });

  test("builds exact Doc and CAS verifiers from public JWKS", async () => {
    const docPair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const casPair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const docPublicJwk = await exportJWK(docPair.publicKey);
    const casPublicJwk = await exportJWK(casPair.publicKey);
    const config = await resolveDocAuthConfig("markdown", {
      CAPABILITY_ALGORITHM: "ES256",
      CAPABILITY_TTL_SECONDS: "120",
      CAPABILITY_MAX_LIFETIME_SECONDS: "300",
      CAPABILITY_CLOCK_SKEW_SECONDS: "30",
      CAPABILITY_ISSUER: "unidocs-gateway:test",
      DOC_CAPABILITY_AUDIENCE: "unidocs-doc:markdown",
      CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
      CAPABILITY_TRUSTED_JWKS: JSON.stringify({
        keys: [{ ...docPublicJwk, kid: "doc-key", alg: CapabilityAlgorithm }],
      }),
      CAS_STACK_ISSUER: "unicas-stack:test",
      CAS_STACK_TRUSTED_JWKS: JSON.stringify({
        keys: [{ ...casPublicJwk, kid: "cas-key", alg: CapabilityAlgorithm }],
      }),
    });
    const docIssuer = new CapabilityIssuer({
      issuer: "unidocs-gateway:test",
      signer: new JoseCapabilitySigner(docPair.privateKey, "doc-key"),
    });
    const casIssuer = new CapabilityIssuer({
      issuer: "unicas-stack:test",
      signer: new JoseCapabilitySigner(casPair.privateKey, "cas-key"),
    });
    const docToken = await docIssuer.issue({
      subject: "gateway",
      audience: "unidocs-doc:markdown",
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions: [sessionReadPermission("tenant-1", "session-1")],
    });
    const casToken = await casIssuer.issue({
      subject: "doc:markdown",
      audience: "unidocs-cas",
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions: [casReadPermission("tenant-1")],
    });

    await expect(config.docCapabilityVerifier.verify(docToken)).resolves.toBeDefined();
    await expect(config.casCapabilityVerifier.verify(casToken)).resolves.toBeDefined();
  });

  test("discovers the stack issuer JWKS via CAS_STACK_JWKS_URI", async () => {
    const casPair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const casPublicJwk = await exportJWK(casPair.publicKey);
    const issuer = "https://gateway.test/oauth/unidocs-cloudflare";
    const originalFetch = globalThis.fetch;
    const metadataCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      metadataCalls.push(url);
      if (url === "https://gateway.test/.well-known/oauth-authorization-server/oauth/unidocs-cloudflare") {
        return new Response(JSON.stringify({
          issuer,
          jwks_uri: "https://gateway.test/oauth/unidocs-cloudflare/jwks",
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "https://gateway.test/oauth/unidocs-cloudflare/jwks") {
        return new Response(JSON.stringify({
          keys: [{ ...casPublicJwk, kid: "cas-key", alg: CapabilityAlgorithm, use: "sig" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected discovery fetch: ${url}`);
    }) as typeof fetch;

    try {
      const config = await resolveDocAuthConfig("markdown", {
        CAPABILITY_ALGORITHM: "ES256",
        CAPABILITY_TTL_SECONDS: "120",
        CAPABILITY_MAX_LIFETIME_SECONDS: "300",
        CAPABILITY_CLOCK_SKEW_SECONDS: "30",
        CAPABILITY_ISSUER: "unidocs-gateway:test",
        DOC_CAPABILITY_AUDIENCE: "unidocs-doc:markdown",
        CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
        CAPABILITY_TRUSTED_JWKS: JSON.stringify({
          keys: [{ ...casPublicJwk, kid: "doc-key", alg: CapabilityAlgorithm }],
        }),
        CAS_STACK_ISSUER: issuer,
        CAS_STACK_JWKS_URI: "discover",
        // No CAS_STACK_TRUSTED_JWKS: discovery supplies the stack keys.
      });

      const casIssuer = new CapabilityIssuer({
        issuer,
        signer: new JoseCapabilitySigner(casPair.privateKey, "cas-key"),
      });
      const casToken = await casIssuer.issue({
        subject: "doc:markdown",
        audience: "unidocs-cas",
        tenantId: "tenant-1",
        sessionId: "session-1",
        permissions: [casReadPermission("tenant-1")],
      });
      await expect(config.casCapabilityVerifier.verify(casToken)).resolves.toBeDefined();
      expect(metadataCalls).toContain(
        "https://gateway.test/.well-known/oauth-authorization-server/oauth/unidocs-cloudflare",
      );
      expect(metadataCalls).toContain("https://gateway.test/oauth/unidocs-cloudflare/jwks");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("caches one immutable verifier configuration", async () => {
    const pair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const bindings = {
      CAPABILITY_ALGORITHM: "ES256",
      CAPABILITY_TTL_SECONDS: "120",
      CAPABILITY_MAX_LIFETIME_SECONDS: "300",
      CAPABILITY_CLOCK_SKEW_SECONDS: "30",
      CAPABILITY_ISSUER: "unidocs-gateway:test",
      DOC_CAPABILITY_AUDIENCE: "unidocs-doc:markdown",
      CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
      CAPABILITY_TRUSTED_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: "key-1", alg: CapabilityAlgorithm }] }),
      CAS_STACK_ISSUER: "unicas-stack:test",
      CAS_STACK_TRUSTED_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: "key-1", alg: CapabilityAlgorithm }] }),
    };
    const cache = new DocAuthConfigCache("markdown");
    const first = await cache.get(bindings);
    const second = await cache.get({ ...bindings, CAPABILITY_ISSUER: "ignored" });
    expect(second).toBe(first);
  });
});
