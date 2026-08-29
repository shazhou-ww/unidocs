import { exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, JWK } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityIssuer,
  CapabilityVerifier,
  JoseCapabilitySigner,
  casManagePermission,
  casReadPermission,
  casWritePermission,
  isReservedRefDomain,
  parseCapabilityPermission,
  validateRefDomainClaim,
} from "../src/index.js";

const NOW = 1_787_616_000;
const ISSUER = "https://tenant-issuer.example";
const AUDIENCE = "unidocs-cas";
const TENANT = "tenant-1";

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: CapabilityAlgorithm, use: "sig" };
});

function issuer(): CapabilityIssuer {
  return new CapabilityIssuer({
    issuer: ISSUER,
    signer: new JoseCapabilitySigner(privateKey, "k1"),
    now: () => NOW,
  });
}

function verifier(): CapabilityVerifier {
  return new CapabilityVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: CapabilityAlgorithm,
    jwks: { keys: [publicJwk] },
    allowedPermissionKinds: [
      "cas:read",
      "cas:write",
      "cas:manage",
    ],
    now: () => NOW,
  });
}

describe("stack-authority CAS claims (Task 4)", () => {
  test("refDomain formats and reserved namespace", () => {
    expect(validateRefDomainClaim("doc")).toBeNull();
    expect(validateRefDomainClaim("doc:markdown")).toBeNull();
    expect(validateRefDomainClaim("_legacy")).not.toBeNull();
    expect(validateRefDomainClaim("_reserved")).not.toBeNull();
    expect(validateRefDomainClaim("Doc")).not.toBeNull();
    expect(validateRefDomainClaim("")).not.toBeNull();
    expect(validateRefDomainClaim("a".repeat(65))).not.toBeNull();
    expect(validateRefDomainClaim(42)).not.toBeNull();
    expect(isReservedRefDomain("_legacy")).toBe(true);
    expect(isReservedRefDomain("doc")).toBe(false);
  });

  test("issuer signs a validated refDomain claim and the verifier preserves it", async () => {
    const token = await issuer().issue({
      subject: "doc-service:markdown",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casWritePermission(TENANT)],
      refDomain: "doc:markdown",
    });
    const capability = await verifier().verify(token);
    expect(capability.claims.refDomain).toBe("doc:markdown");
  });

  test("issuer refuses to sign a malformed or reserved refDomain", async () => {
    await expect(issuer().issue({
      subject: "s",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casWritePermission(TENANT)],
      refDomain: "Doc",
    })).rejects.toThrow(/refDomain/);
    await expect(issuer().issue({
      subject: "s",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casWritePermission(TENANT)],
      refDomain: "_legacy",
    })).rejects.toThrow(/refDomain/);
  });

  test("verifier rejects tokens with reserved or malformed refDomain claims", async () => {
    // Hand-forge tokens with bad refDomain claims (jose SignJWT).
    const { SignJWT } = await import("jose");
    const forge = (refDomain: unknown) =>
      new SignJWT({
        iss: ISSUER,
        sub: "doc-service",
        aud: AUDIENCE,
        iat: NOW,
        nbf: NOW,
        exp: NOW + 120,
        jti: "jti-forge",
        tenantId: TENANT,
        permissions: [`tenants:${TENANT}:cas:write`],
        refDomain,
      })
        .setProtectedHeader({ alg: CapabilityAlgorithm, kid: "k1", typ: "unidocs-cap+jwt" })
        .sign(privateKey);
    await expect(verifier().verify(await forge("_legacy"))).rejects.toThrow();
    await expect(verifier().verify(await forge("Bad Domain"))).rejects.toThrow();
    await expect(verifier().verify(await forge(42))).rejects.toThrow();
  });

  test("cas:manage is tenant-only and does not grant read or write", async () => {
    expect(parseCapabilityPermission(casManagePermission(TENANT))).toEqual({
      kind: "cas:manage",
      tenantId: TENANT,
    });
    await expect(issuer().issue({
      subject: "doc:docx",
      audience: AUDIENCE,
      tenantId: TENANT,
      sessionId: "s1",
      permissions: [casManagePermission(TENANT)],
    })).rejects.toThrow("Session-scoped capabilities cannot contain cas:manage");
    const token = await issuer().issue({
      subject: "gateway",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casManagePermission(TENANT)],
    });
    const capability = await verifier().verify(token);
    const { requireCapabilityPermission } = await import("../src/index.js");
    expect(() => requireCapabilityPermission(capability, casReadPermission(TENANT)))
      .toThrow(CapabilityAuthorizationError);
    expect(() => requireCapabilityPermission(capability, casWritePermission(TENANT)))
      .toThrow(CapabilityAuthorizationError);
  });
});
