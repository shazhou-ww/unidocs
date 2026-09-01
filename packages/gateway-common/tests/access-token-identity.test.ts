import { describe, expect, test } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityIssuer,
  JoseCapabilitySigner,
  casManagePermission,
  casReadPermission,
  createPkcs8CapabilityIssuer,
} from "@unidocs/service-auth";
import {
  createDataPlaneIdentityResolver,
  createOAuthAccessTokenIdentityResolver,
} from "../src/access-token-identity.js";
import type { GatewayIdentityResolver } from "../src/identity.js";

const ISSUER = "https://gateway.test/oauth/unidocs-cloudflare";
const AUDIENCE = "https://cas.test/stacks/stack-1";
const TENANT = "tenant-1";

async function ecPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pair, pkcs8, publicJwk };
}

async function fixture() {
  const { pkcs8, publicJwk } = await ecPair();
  const signer = await createPkcs8CapabilityIssuer({
    issuer: ISSUER,
    kid: "stack-key-1",
    privateKeyPkcs8: pkcs8,
  });
  const resolver = createOAuthAccessTokenIdentityResolver({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: { keys: [{ ...publicJwk, kid: "stack-key-1", alg: CapabilityAlgorithm, use: "sig" }] },
    maximumLifetimeSeconds: 1800,
    clockSkewSeconds: 30,
  });
  return { signer, resolver };
}

function request(tenantId: string, authorization?: string): Request {
  return new Request(`https://gateway.test/tenants/${tenantId}/docs/docx/`, {
    headers: authorization ? { Authorization: authorization } : undefined,
  });
}

describe("data-plane access-token identity", () => {
  test("resolves a valid access token to the signed tenant identity", async () => {
    const { signer, resolver } = await fixture();
    const token = await signer.issue({
      subject: "user-1",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casReadPermission(TENANT), casManagePermission(TENANT)],
    });
    const identity = await resolver.resolve(request(TENANT, `Bearer ${token}`), TENANT);
    expect(identity).toEqual({ userId: "user-1", tenantId: TENANT, canManageTenant: true });
  });

  test("derives canManageTenant from the cas:manage permission only", async () => {
    const { signer, resolver } = await fixture();
    const token = await signer.issue({
      subject: "user-1",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casReadPermission(TENANT)],
    });
    const identity = await resolver.resolve(request(TENANT, `Bearer ${token}`), TENANT);
    expect(identity).toEqual({ userId: "user-1", tenantId: TENANT, canManageTenant: false });
  });

  test("fails closed on a missing, malformed, or foreign-tenant token", async () => {
    const { signer, resolver } = await fixture();
    expect(await resolver.resolve(request(TENANT), TENANT)).toBeNull();
    expect(await resolver.resolve(request(TENANT, "Bearer not-a-jwt"), TENANT)).toBeNull();
    expect(await resolver.resolve(request(TENANT, "Basic abc"), TENANT)).toBeNull();

    const foreign = await signer.issue({
      subject: "user-1",
      audience: AUDIENCE,
      tenantId: "tenant-2",
      permissions: [casReadPermission("tenant-2")],
    });
    expect(await resolver.resolve(request(TENANT, `Bearer ${foreign}`), TENANT)).toBeNull();
  });

  test("rejects tokens from another issuer, audience, or signing key", async () => {
    const { signer, resolver } = await fixture();

    const attacker = await ecPair();
    const attackerIssuer = new CapabilityIssuer({
      issuer: "https://attacker.test",
      signer: new JoseCapabilitySigner(attacker.pair.privateKey, "other-key"),
    });
    const wrongIssuer = await attackerIssuer.issue({
      subject: "user-1",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casReadPermission(TENANT)],
    });
    expect(await resolver.resolve(request(TENANT, `Bearer ${wrongIssuer}`), TENANT)).toBeNull();

    const wrongAudience = await signer.issue({
      subject: "user-1",
      audience: "https://other-audience.test",
      tenantId: TENANT,
      permissions: [casReadPermission(TENANT)],
    });
    expect(await resolver.resolve(request(TENANT, `Bearer ${wrongAudience}`), TENANT)).toBeNull();

    const otherStack = await ecPair();
    const otherStackResolver = createOAuthAccessTokenIdentityResolver({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: {
        keys: [{ ...otherStack.publicJwk, kid: "stack-key-1", alg: CapabilityAlgorithm, use: "sig" }],
      },
    });
    const sameIssuerDifferentKey = await signer.issue({
      subject: "user-1",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casReadPermission(TENANT)],
    });
    expect(await otherStackResolver.resolve(request(TENANT, `Bearer ${sameIssuerDifferentKey}`), TENANT))
      .toBeNull();
  });

  test("path identity applies only without a token and only when opted in", async () => {
    const { signer } = await fixture();
    const { publicJwk } = await ecPair();
    const composite = createDataPlaneIdentityResolver({
      accessToken: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: { keys: [{ ...publicJwk, kid: "other-key", alg: CapabilityAlgorithm, use: "sig" }] },
      },
      allowPathIdentity: true,
    });
    // Without a token the development path identity is accepted.
    const pathIdentity = await composite.resolve(request(TENANT), TENANT);
    expect(pathIdentity).toEqual({ userId: `local:${TENANT}`, tenantId: TENANT, canManageTenant: true });
    // A presented token is never downgraded to path identity: it is signed by
    // a key the resolver does not trust, so the request fails closed.
    const token = await signer.issue({
      subject: "user-1",
      audience: AUDIENCE,
      tenantId: TENANT,
      permissions: [casReadPermission(TENANT)],
    });
    expect(await composite.resolve(request(TENANT, `Bearer ${token}`), TENANT)).toBeNull();

    const locked = createDataPlaneIdentityResolver({ accessToken: undefined, allowPathIdentity: false });
    expect(await locked.resolve(request(TENANT), TENANT)).toBeNull();
    expect(await locked.resolve(request(TENANT, `Bearer ${token}`), TENANT)).toBeNull();
  });
});

function pem(bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}
