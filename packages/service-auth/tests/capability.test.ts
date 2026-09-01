import {
  SignJWT,
  base64url,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  generateSecret,
} from "jose";
import type { CryptoKey, JSONWebKeySet, JWK, JWTPayload } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityIssuer,
  CapabilityTokenType,
  CapabilityVerifier,
  JoseCapabilitySigner,
  MaximumCapabilityLifetimeSeconds,
  casManagePermission,
  casReadPermission,
  casWritePermission,
  extractBearerCapability,
  requireCapabilityPermission,
  requireCapabilitySession,
  requireCapabilityTenant,
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "../src/index.js";
import type {
  CapabilityPermissionKind,
  IssueCapabilityInput,
} from "../src/index.js";

const NOW = 1_787_616_000;
const ISSUER = "unidocs-gateway:test";
const DOC_AUDIENCE = "unidocs-doc:docx";
const CAS_AUDIENCE = "unidocs-cas";

let privateKeyA: CryptoKey;
let privateKeyB: CryptoKey;
let publicJwkA: JWK;
let publicJwkB: JWK;

beforeAll(async () => {
  const pairA = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
  const pairB = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
  privateKeyA = pairA.privateKey;
  privateKeyB = pairB.privateKey;
  publicJwkA = withKeyMetadata(await exportJWK(pairA.publicKey), "key-a");
  publicJwkB = withKeyMetadata(await exportJWK(pairB.publicKey), "key-b");
});

describe("capability issuance and verification", () => {
  test("issues and verifies a session capability with fixed headers and claims", async () => {
    const token = await issuer(privateKeyA, "key-a").issue(docInput());
    const capability = await docVerifier().verify(token);

    expect(capability.protectedHeader).toEqual({
      alg: CapabilityAlgorithm,
      kid: "key-a",
      typ: CapabilityTokenType,
    });
    expect(capability.claims).toMatchObject({
      ver: 1,
      iss: ISSUER,
      sub: "gateway",
      aud: DOC_AUDIENCE,
      iat: NOW,
      nbf: NOW - 5,
      exp: NOW + 120,
      jti: "jti-1",
      tenantId: "tenant-1",
      sessionId: "session-1",
      permissions: [sessionReadPermission("tenant-1", "session-1")],
    });
  });

  test("accepts every configured key ID during rotation overlap", async () => {
    const verifier = docVerifier({ keys: [publicJwkA, publicJwkB] });
    const tokenA = await issuer(privateKeyA, "key-a").issue(docInput({ jti: "a" }));
    const tokenB = await issuer(privateKeyB, "key-b").issue(docInput({ jti: "b" }));

    await expect(verifier.verify(tokenA)).resolves.toMatchObject({
      protectedHeader: { kid: "key-a" },
    });
    await expect(verifier.verify(tokenB)).resolves.toMatchObject({
      protectedHeader: { kid: "key-b" },
    });
  });

  test("rejects a retired key after it is removed from immutable JWKS", async () => {
    const retiredToken = await issuer(privateKeyA, "key-a").issue(docInput({ jti: "retired" }));
    const activeToken = await issuer(privateKeyB, "key-b").issue(docInput({ jti: "active" }));
    const verifier = docVerifier({ keys: [publicJwkB] });

    await expectInvalid(verifier.verify(retiredToken));
    await expect(verifier.verify(activeToken)).resolves.toMatchObject({
      protectedHeader: { kid: "key-b" },
    });
  });

  test("issues tenant-scoped CAS capabilities without a session claim", async () => {
    const token = await issuer(privateKeyA, "key-a").issue({
      subject: "gateway",
      audience: CAS_AUDIENCE,
      tenantId: "tenant-1",
      permissions: [casManagePermission("tenant-1")],
    });
    const capability = await casVerifier(["cas:manage"]).verify(token);
    expect(capability.claims.sessionId).toBeUndefined();
  });

  test("rejects tampered protected header, payload, and signature", async () => {
    const token = await issuer(privateKeyA, "key-a").issue(docInput());
    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);

    await expectInvalid(docVerifier().verify(replacePart(
      token,
      0,
      base64url.encode(JSON.stringify({ ...header, typ: "tampered" })),
    )));
    await expectInvalid(docVerifier().verify(replacePart(
      token,
      1,
      base64url.encode(JSON.stringify({ ...payload, tenantId: "other" })),
    )));
    const signature = base64url.decode(token.split(".")[2]);
    signature[0] ^= 1;
    await expectInvalid(docVerifier().verify(replacePart(token, 2, base64url.encode(signature))));
  });

  test.each([
    ["wrong typ", { typ: "JWT" }, {}],
    ["wrong issuer", {}, { iss: "other" }],
    ["wrong audience", {}, { aud: "other" }],
    ["wrong version", {}, { ver: 2 }],
    ["unknown key ID", { kid: "unknown" }, {}],
    ["unsupported protected header", { cty: "JWT" }, {}],
    ["multiple audiences", {}, { aud: [DOC_AUDIENCE, CAS_AUDIENCE] }],
    ["unsupported claim", {}, { userId: "user-1" }],
  ])("rejects %s", async (_name, header, payload) => {
    await expectInvalid(docVerifier().verify(await signRaw({
      header,
      payload,
    })));
  });

  test("rejects an algorithm selected by the token", async () => {
    const secret = await generateSecret("HS256");
    const token = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "HS256", kid: "key-a", typ: CapabilityTokenType })
      .sign(secret);
    await expectInvalid(docVerifier().verify(token));
  });

  test("rejects a signature made by another key under a trusted key ID", async () => {
    await expectInvalid(docVerifier().verify(await signRaw({ key: privateKeyB })));
  });

  test.each([
    ["ver"],
    ["iss"],
    ["sub"],
    ["aud"],
    ["iat"],
    ["nbf"],
    ["exp"],
    ["jti"],
    ["tenantId"],
    ["permissions"],
  ])("rejects a missing %s claim", async (claim) => {
    await expectInvalid(docVerifier().verify(await signRaw({
      payload: { [claim]: undefined },
    })));
  });

  test.each([
    ["sub", 3],
    ["iat", "now"],
    ["nbf", "now"],
    ["exp", "later"],
    ["jti", 3],
    ["tenantId", 3],
    ["sessionId", 3],
    ["permissions", "permission"],
    ["permissions", [3]],
  ])("rejects a wrongly typed %s claim", async (claim, value) => {
    await expectInvalid(docVerifier().verify(await signRaw({
      payload: { [claim]: value },
    })));
  });

  test("rejects duplicate semantic permission entries", async () => {
    const permission = sessionReadPermission("tenant-1", "session-1");
    await expectInvalid(docVerifier().verify(await signRaw({
      payload: { permissions: [permission, permission] },
    })));
  });

  test("enforces expiration, not-before, issued-at, and maximum lifetime", async () => {
    await expectInvalid(docVerifier().verify(await signRaw({
      payload: { iat: NOW - 151, nbf: NOW - 151, exp: NOW - 31 },
    })));
    await expectInvalid(docVerifier().verify(await signRaw({
      payload: { nbf: NOW + 31 },
    })));
    await expectInvalid(docVerifier().verify(await signRaw({
      payload: { iat: NOW + 31, nbf: NOW, exp: NOW + 151 },
    })));
    await expectInvalid(docVerifier().verify(await signRaw({
      payload: { exp: NOW + 301 },
    })));
  });

  test("accepts clock-skew and maximum-lifetime boundaries", async () => {
    await expect(docVerifier().verify(await signRaw({
      payload: { iat: NOW - 149, nbf: NOW - 149, exp: NOW - 29 },
    }))).resolves.toBeDefined();
    await expect(docVerifier().verify(await signRaw({
      payload: { nbf: NOW + 30 },
    }))).resolves.toBeDefined();
    await expect(docVerifier().verify(await signRaw({
      payload: { exp: NOW + 300 },
    }))).resolves.toBeDefined();
  });
});

describe("capability authorization", () => {
  test("rejects permission families not accepted by the service", async () => {
    const token = await issuer(privateKeyA, "key-a").issue(docInput({
      permissions: [casReadPermission("tenant-1")],
    }));
    await expect(docVerifier().verify(token)).rejects.toMatchObject({
      status: 403,
      code: "insufficient_permission",
    });
  });

  test("does not imply permissions and enforces tenant/session resources", async () => {
    const token = await issuer(privateKeyA, "key-a").issue(docInput());
    const capability = await docVerifier().verify(token);
    expect(() => requireCapabilityPermission(
      capability,
      sessionReadPermission("tenant-1", "session-1"),
    )).not.toThrow();
    expect(() => requireCapabilityPermission(
      capability,
      sessionWritePermission("tenant-1", "session-1"),
    )).toThrow(CapabilityAuthorizationError);
    expect(() => requireCapabilityTenant(capability, "tenant-2"))
      .toThrow(CapabilityAuthorizationError);
    expect(() => requireCapabilitySession(capability, "session-2"))
      .toThrow(CapabilityAuthorizationError);
  });

  test("admin does not imply CAS read or write", async () => {
    const token = await issuer(privateKeyA, "key-a").issue({
      subject: "gateway",
      audience: CAS_AUDIENCE,
      tenantId: "tenant-1",
      permissions: [casManagePermission("tenant-1")],
    });
    const capability = await casVerifier(["cas:manage"]).verify(token);
    expect(() => requireCapabilityPermission(capability, casReadPermission("tenant-1")))
      .toThrow(CapabilityAuthorizationError);
    expect(() => requireCapabilityPermission(capability, casWritePermission("tenant-1")))
      .toThrow(CapabilityAuthorizationError);
  });

  test("extracts only a single Bearer credential", () => {
    expect(extractBearerCapability("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(() => extractBearerCapability(null)).toThrow(CapabilityAuthenticationError);
    expect(() => extractBearerCapability("Basic abc")).toThrow(CapabilityAuthenticationError);
    expect(() => extractBearerCapability("Bearer one two")).toThrow(CapabilityAuthenticationError);
  });
});

describe("capability configuration and issuance guards", () => {
  test("rejects private, empty, or duplicate verifier keys", async () => {
    const privateJwk = withKeyMetadata(await exportJWK(privateKeyA), "private");
    expect(() => docVerifier({ keys: [] })).toThrow("at least one public key");
    expect(() => docVerifier({ keys: [privateJwk] })).toThrow("must not contain private keys");
    expect(() => docVerifier({ keys: [publicJwkA, publicJwkA] })).toThrow("must be unique");
  });

  test("rejects verifier lifetime and skew beyond fixed limits", () => {
    expect(() => docVerifier(undefined, {
      maximumLifetimeSeconds: MaximumCapabilityLifetimeSeconds + 1,
    })).toThrow(`1 to ${MaximumCapabilityLifetimeSeconds}`);
    expect(() => docVerifier(undefined, { clockSkewSeconds: 31 }))
      .toThrow("0 to 30");
  });

  test("issuer rejects duplicate, mismatched, and overlong authority", async () => {
    const capabilityIssuer = issuer(privateKeyA, "key-a");
    const read = sessionReadPermission("tenant-1", "session-1");
    await expect(capabilityIssuer.issue(docInput({ permissions: [read, read] })))
      .rejects.toThrow("duplicates");
    await expect(capabilityIssuer.issue(docInput({
      permissions: [sessionReadPermission("tenant-2", "session-1")],
    }))).rejects.toThrow("tenant");
    await expect(capabilityIssuer.issue(docInput({
      lifetimeSeconds: MaximumCapabilityLifetimeSeconds + 1,
    }))).rejects.toThrow(`1 to ${MaximumCapabilityLifetimeSeconds}`);
    await expect(capabilityIssuer.issue(docInput({ permissions: [] })))
      .rejects.toThrow("must not be empty");
  });

  test("issuer rejects session-scoped CAS administration", async () => {
    await expect(issuer(privateKeyA, "key-a").issue(docInput({
      audience: CAS_AUDIENCE,
      permissions: [casManagePermission("tenant-1")],
    }))).rejects.toThrow("cannot contain cas:manage");
  });

  test("issuer rejects a custom signer without a key ID", () => {
    expect(() => new CapabilityIssuer({
      issuer: ISSUER,
      signer: {
        algorithm: CapabilityAlgorithm,
        kid: "",
        sign: async () => "token",
      },
    })).toThrow("Signing key ID must not be empty");
  });
});

function issuer(key: CryptoKey, kid: string): CapabilityIssuer {
  return new CapabilityIssuer({
    issuer: ISSUER,
    signer: new JoseCapabilitySigner(key, kid),
    now: () => NOW,
    generateJti: () => "jti-1",
  });
}

function docInput(overrides: Partial<IssueCapabilityInput> = {}): IssueCapabilityInput {
  return {
    subject: "gateway",
    audience: DOC_AUDIENCE,
    tenantId: "tenant-1",
    sessionId: "session-1",
    permissions: [sessionReadPermission("tenant-1", "session-1")],
    ...overrides,
  };
}

function docVerifier(
  jwks: JSONWebKeySet = { keys: [publicJwkA] },
  overrides: Partial<ConstructorParameters<typeof CapabilityVerifier>[0]> = {},
): CapabilityVerifier {
  return new CapabilityVerifier({
    issuer: ISSUER,
    audience: DOC_AUDIENCE,
    algorithm: CapabilityAlgorithm,
    jwks,
    allowedPermissionKinds: ["sessions:create", "sessions:read", "sessions:write"],
    allowedSubjects: ["gateway"],
    clockSkewSeconds: 30,
    maximumLifetimeSeconds: 300,
    now: () => NOW,
    ...overrides,
  });
}

function casVerifier(
  allowedPermissionKinds: readonly CapabilityPermissionKind[],
): CapabilityVerifier {
  return new CapabilityVerifier({
    issuer: ISSUER,
    audience: CAS_AUDIENCE,
    algorithm: CapabilityAlgorithm,
    jwks: { keys: [publicJwkA] },
    allowedPermissionKinds,
    now: () => NOW,
  });
}

function baseClaims(): JWTPayload {
  return {
    ver: 1,
    iss: ISSUER,
    sub: "gateway",
    aud: DOC_AUDIENCE,
    iat: NOW,
    nbf: NOW - 5,
    exp: NOW + 120,
    jti: "raw-jti",
    tenantId: "tenant-1",
    sessionId: "session-1",
    permissions: [sessionReadPermission("tenant-1", "session-1")],
  };
}

async function signRaw(options: {
  readonly key?: CryptoKey;
  readonly header?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
} = {}): Promise<string> {
  return new SignJWT({ ...baseClaims(), ...options.payload } as JWTPayload)
    .setProtectedHeader({
      alg: CapabilityAlgorithm,
      kid: "key-a",
      typ: CapabilityTokenType,
      ...options.header,
    })
    .sign(options.key ?? privateKeyA);
}

function withKeyMetadata(jwk: JWK, kid: string): JWK {
  return { ...jwk, kid, alg: CapabilityAlgorithm, use: "sig" };
}

function replacePart(token: string, index: number, value: string): string {
  const parts = token.split(".");
  parts[index] = value;
  return parts.join(".");
}

async function expectInvalid(result: Promise<unknown>): Promise<void> {
  await expect(result).rejects.toMatchObject({
    status: 401,
    code: "invalid_token",
  });
}