import {
  exportPKCS8,
  exportJWK,
  generateKeyPair,
} from "jose";
import { describe, expect, test } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityVerifier,
  casReadPermission,
  createPkcs8CapabilityIssuer,
  derivePkcs8CapabilityPublicJwk,
  parseCapabilityRuntimePolicy,
} from "../src/index.js";

describe("PKCS8 capability issuer", () => {
  test("imports one ES256 private key for issuance", async () => {
    const pair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const issuer = await createPkcs8CapabilityIssuer({
      issuer: "unidocs-gateway:test",
      kid: "key-1",
      privateKeyPkcs8: await exportPKCS8(pair.privateKey),
      now: () => 1000,
      generateJti: () => "jti-1",
    });
    const publicJwk = await exportJWK(pair.publicKey);
    const verifier = new CapabilityVerifier({
      issuer: "unidocs-gateway:test",
      audience: "unidocs-cas",
      algorithm: CapabilityAlgorithm,
      jwks: { keys: [{ ...publicJwk, kid: "key-1", alg: CapabilityAlgorithm }] },
      allowedPermissionKinds: ["cas:read"],
      now: () => 1000,
    });

    const token = await issuer.issue({
      subject: "gateway",
      audience: "unidocs-cas",
      tenantId: "tenant-1",
      permissions: [casReadPermission("tenant-1")],
    });
    await expect(verifier.verify(token)).resolves.toMatchObject({
      protectedHeader: { kid: "key-1" },
      claims: { jti: "jti-1" },
    });
  });

  test("rejects absent private key material", async () => {
    await expect(createPkcs8CapabilityIssuer({
      issuer: "unidocs-gateway:test",
      kid: "key-1",
      privateKeyPkcs8: "",
    })).rejects.toThrow("private key is required");
  });

  test("derives only the public members of an ES256 capability key", async () => {
    const pair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const publicJwk = await derivePkcs8CapabilityPublicJwk(
      await exportPKCS8(pair.privateKey),
    );
    expect(publicJwk).toEqual(await exportJWK(pair.publicKey));
    expect(publicJwk).not.toHaveProperty("d");
  });

  test("requires the complete fixed runtime policy", () => {
    expect(parseCapabilityRuntimePolicy({
      CAPABILITY_ALGORITHM: "ES256",
      CAPABILITY_TTL_SECONDS: "120",
      CAPABILITY_MAX_LIFETIME_SECONDS: "300",
      CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    })).toEqual({
      algorithm: "ES256",
      defaultLifetimeSeconds: 120,
      maximumLifetimeSeconds: 300,
      clockSkewSeconds: 30,
    });
    expect(() => parseCapabilityRuntimePolicy({})).toThrow("CAPABILITY_ALGORITHM");
    expect(() => parseCapabilityRuntimePolicy({
      CAPABILITY_ALGORITHM: "RS256",
      CAPABILITY_TTL_SECONDS: "120",
      CAPABILITY_MAX_LIFETIME_SECONDS: "300",
      CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    })).toThrow("must be ES256");
    expect(() => parseCapabilityRuntimePolicy({
      CAPABILITY_ALGORITHM: "ES256",
      CAPABILITY_TTL_SECONDS: "301",
      CAPABILITY_MAX_LIFETIME_SECONDS: "300",
      CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    })).toThrow("CAPABILITY_TTL_SECONDS");
  });
});