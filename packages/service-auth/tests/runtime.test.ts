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
});