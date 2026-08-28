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
  test("requires complete capability configuration", () => {
    expect(() => resolveDocAuthConfig("markdown", {}))
      .toThrow("CAPABILITY_ISSUER");
  });

  test("builds exact Doc and CAS verifiers from public JWKS", async () => {
    const docPair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const casPair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const docPublicJwk = await exportJWK(docPair.publicKey);
    const casPublicJwk = await exportJWK(casPair.publicKey);
    const config = resolveDocAuthConfig("markdown", {
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
    const first = cache.get(bindings);
    const second = cache.get({ ...bindings, CAPABILITY_ISSUER: "ignored" });
    expect(second).toBe(first);
  });
});