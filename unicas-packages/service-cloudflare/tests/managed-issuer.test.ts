import { describe, expect, test } from "vitest";
import { exportPKCS8, generateKeyPair, importJWK, jwtVerify } from "jose";
import { CloudflareManagedIssuer } from "../src/managed-issuer.js";

async function fixture() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return new CloudflareManagedIssuer({
    publicOrigin: "https://cas.example",
    privateKeyPkcs8: await exportPKCS8(privateKey),
    keyId: "managed-test",
    now: () => 1_700_000_000_000,
  });
}

describe("CloudflareManagedIssuer", () => {
  test("provisions a distinct active issuer for each stack", async () => {
    const authority = await fixture();
    const first = await authority.provision("cas_first", 1000);
    const second = await authority.provision("cas_second", 1000);

    expect(first).toMatchObject({
      mode: "managed",
      status: "active",
      issuer: "https://cas.example/managed-issuers/cas_first",
      audience: "https://cas.example/stacks/cas_first",
      capabilityMaxLifetimeSeconds: 120,
    });
    expect(second.issuer).not.toBe(first.issuer);
    expect((await authority.jwks()).keys).toHaveLength(1);
  });

  test("issues verifiable capabilities with stable member-isolated tenants", async () => {
    const authority = await fixture();
    const stack = {
      stackId: "cas_first",
      displayName: "First",
      description: "",
      status: "active" as const,
      createdAt: 1000,
      revision: 1,
    };
    const issuer = await authority.provision(stack.stackId, 1000);
    const alice = await authority.issue({
      stack,
      issuer,
      identity: { identityIssuer: "https://accounts.google.com", subject: "alice" },
    });
    const aliceAgain = await authority.issue({
      stack,
      issuer,
      identity: { identityIssuer: "https://accounts.google.com", subject: "alice" },
    });
    const bob = await authority.issue({
      stack,
      issuer,
      identity: { identityIssuer: "https://accounts.google.com", subject: "bob" },
    });

    expect(alice.tenantId).toBe(aliceAgain.tenantId);
    expect(bob.tenantId).not.toBe(alice.tenantId);
    expect(alice.permissions).toEqual([
      `tenants:${alice.tenantId}:cas:read`,
      `tenants:${alice.tenantId}:cas:write`,
      `tenants:${alice.tenantId}:cas:manage`,
    ]);

    const jwks = await authority.jwks() as { keys: Array<Record<string, unknown>> };
    const publicKey = await importJWK(jwks.keys[0]!, "ES256");
    const verified = await jwtVerify(alice.accessToken, publicKey, {
      issuer: alice.issuer,
      audience: alice.audience,
      currentDate: new Date(1_700_000_000_000),
    });
    expect(verified.payload).toMatchObject({
      ver: 1,
      tenantId: alice.tenantId,
      refDomain: expect.stringMatching(/^playground:[0-9a-f]{16}$/),
    });
  });
});