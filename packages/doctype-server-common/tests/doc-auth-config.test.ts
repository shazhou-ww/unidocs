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
  test("requires an explicit mode and matching legacy credential", () => {
    expect(() => resolveDocAuthConfig("markdown", {}))
      .toThrow("mode must be explicit");
    expect(() => resolveDocAuthConfig("markdown", { INTERNAL_AUTH_MODE: "legacy" }))
      .toThrow("SERVICE_ACCESS_KEY");
    expect(resolveDocAuthConfig("markdown", {
      INTERNAL_AUTH_MODE: "legacy",
      SERVICE_ACCESS_KEY: "legacy-key",
    })).toEqual({ internalAuthMode: "legacy", accessKey: "legacy-key" });
  });

  test("builds exact Doc and CAS verifiers from public JWKS", async () => {
    const pair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const config = resolveDocAuthConfig("markdown", {
      INTERNAL_AUTH_MODE: "capability",
      CAPABILITY_ISSUER: "unidocs-gateway:test",
      DOC_CAPABILITY_AUDIENCE: "unidocs-doc:markdown",
      CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
      CAPABILITY_TRUSTED_JWKS: JSON.stringify({
        keys: [{ ...publicJwk, kid: "key-1", alg: CapabilityAlgorithm }],
      }),
    });
    const issuer = new CapabilityIssuer({
      issuer: "unidocs-gateway:test",
      signer: new JoseCapabilitySigner(pair.privateKey, "key-1"),
    });
    const docToken = await issuer.issue({
      subject: "gateway",
      audience: "unidocs-doc:markdown",
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions: [sessionReadPermission("tenant-1", "session-1")],
    });
    const casToken = await issuer.issue({
      subject: "doc:markdown",
      audience: "unidocs-cas",
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions: [casReadPermission("tenant-1")],
    });

    await expect(config.docCapabilityVerifier!.verify(docToken)).resolves.toBeDefined();
    await expect(config.casCapabilityVerifier!.verify(casToken)).resolves.toBeDefined();
  });

  test("caches one immutable verifier configuration", () => {
    const cache = new DocAuthConfigCache("markdown");
    const first = cache.get({
      INTERNAL_AUTH_MODE: "legacy",
      SERVICE_ACCESS_KEY: "first",
    });
    const second = cache.get({
      INTERNAL_AUTH_MODE: "legacy",
      SERVICE_ACCESS_KEY: "second",
    });
    expect(second).toBe(first);
    expect(second.accessKey).toBe("first");
  });
});