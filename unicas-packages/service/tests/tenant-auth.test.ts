import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CryptoKey } from "jose";
import { describe, expect, test } from "vitest";
import {
  casManagePermission,
  casReadPermission,
  casWritePermission,
  type CapabilityPermission,
  type CasRoute,
} from "@unicas/tenant-protocol";
import {
  StackCapabilityVerifier,
  permissionFor,
  type ResolvedStackAuthority,
  type StackAuthorityResolver,
} from "../src/index.js";

const ISSUER = "https://issuer.example";
const AUDIENCE = "unicas-cas";
const STACK = "cas_stack_a";
const TENANT = "tenant-1";
const ROUTE = {
  operation: "readContent" as const,
  stackId: STACK,
  tenantId: TENANT,
  hash: "a".repeat(64),
};

class StubAuthorityResolver implements StackAuthorityResolver {
  authority: ResolvedStackAuthority | null;
  unavailable = false;
  lookups = 0;

  constructor(authority: ResolvedStackAuthority) {
    this.authority = authority;
  }

  async resolveIssuer(issuer: string): Promise<ResolvedStackAuthority | null> {
    this.lookups += 1;
    if (this.unavailable) throw new Error("registry unavailable");
    return issuer === ISSUER ? this.authority : null;
  }
}

async function fixture(): Promise<{
  clock: { now: number };
  privateKey: CryptoKey;
  resolver: StubAuthorityResolver;
  token: string;
}> {
  const clock = { now: 1_700_000_000_000 };
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const authority: ResolvedStackAuthority = {
    stackId: STACK,
    issuer: ISSUER,
    audience: AUDIENCE,
    capabilityMaxLifetimeSeconds: 28_800,
    keys: [{
      kid: "key-1",
      algorithm: "ES256",
      publicJwk: await exportJWK(publicKey),
      state: "active",
    }],
  };
  const resolver = new StubAuthorityResolver(authority);
  return {
    clock,
    privateKey,
    resolver,
    token: await issue(privateKey, clock.now),
  };
}

async function issue(
  privateKey: CryptoKey,
  now: number,
  options: {
    issuer?: string;
    audience?: string;
    kid?: string;
    tenantId?: string;
    permissions?: readonly CapabilityPermission[];
    subject?: string;
    lifetimeSeconds?: number;
    refDomain?: string;
  } = {},
): Promise<string> {
  const nowSeconds = Math.floor(now / 1000);
  return new SignJWT({
    tenantId: options.tenantId ?? TENANT,
    permissions: options.permissions ?? [casReadPermission(TENANT)],
    ...(options.refDomain === undefined ? {} : { refDomain: options.refDomain }),
  })
    .setProtectedHeader({ alg: "ES256", kid: options.kid ?? "key-1" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject(options.subject ?? "doc-service:markdown")
    .setJti("request-1")
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(nowSeconds + (options.lifetimeSeconds ?? 300))
    .sign(privateKey);
}

function request(token: string): Request {
  return new Request("https://cas.example/tenant", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("StackCapabilityVerifier", () => {
  test("verifies issuer, resource scope, and exact operation permission", async () => {
    const { clock, resolver, token } = await fixture();
    const actual = new StackCapabilityVerifier({
      repository: resolver,
      now: () => clock.now,
    });
    await expect(actual.verify(request(token), ROUTE)).resolves.toMatchObject({
      stackId: STACK,
      tenantId: TENANT,
      subject: "doc-service:markdown",
      kid: "key-1",
    });
    await expect(actual.verify(request(token), {
      ...ROUTE,
      stackId: "other-stack",
    })).rejects.toMatchObject({ status: 403 });
    await expect(actual.verify(request(token), {
      ...ROUTE,
      tenantId: "other-tenant",
    })).rejects.toMatchObject({ status: 403 });
    await expect(actual.verify(request(token), {
      operation: "gc",
      stackId: STACK,
      tenantId: TENANT,
    })).rejects.toMatchObject({ status: 403 });
  });

  test("enforces the exact permission for every tenant operation", async () => {
    const { clock, privateKey, resolver } = await fixture();
    const verifier = new StackCapabilityVerifier({ repository: resolver, now: () => clock.now });
    const hash = "b".repeat(64);
    const cases: Array<{
      route: CasRoute;
      permission: CapabilityPermission;
      refDomain?: string;
    }> = [
        { route: { operation: "readContent", stackId: STACK, tenantId: TENANT, hash }, permission: casReadPermission(TENANT) },
        { route: { operation: "readMetadata", stackId: STACK, tenantId: TENANT, hash }, permission: casReadPermission(TENANT) },
        { route: { operation: "lease", stackId: STACK, tenantId: TENANT, hash }, permission: casWritePermission(TENANT) },
        { route: { operation: "updateRootRefs", stackId: STACK, tenantId: TENANT }, permission: casWritePermission(TENANT), refDomain: "doc" },
        { route: { operation: "usage", stackId: STACK, tenantId: TENANT }, permission: casManagePermission(TENANT) },
        { route: { operation: "gc", stackId: STACK, tenantId: TENANT }, permission: casManagePermission(TENANT) },
      ];

    for (const entry of cases) {
      const accepted = await issue(privateKey, clock.now, {
        permissions: [entry.permission],
        refDomain: entry.refDomain,
      });
      await expect(verifier.verify(request(accepted), entry.route)).resolves.toBeDefined();

      const wrongPermission = entry.permission === casReadPermission(TENANT)
        ? casWritePermission(TENANT)
        : casReadPermission(TENANT);
      const rejected = await issue(privateKey, clock.now, {
        permissions: [wrongPermission],
        refDomain: entry.refDomain,
      });
      await expect(verifier.verify(request(rejected), entry.route)).rejects.toMatchObject({ status: 403 });
    }
  });

  test("enforces the stack lifetime cap and registered issuer, audience, and key", async () => {
    const { clock, privateKey, resolver } = await fixture();
    resolver.authority = { ...resolver.authority!, capabilityMaxLifetimeSeconds: 60 };
    const verifier = new StackCapabilityVerifier({ repository: resolver, now: () => clock.now });

    const overCap = await issue(privateKey, clock.now, { lifetimeSeconds: 61 });
    await expect(verifier.verify(request(overCap), ROUTE)).rejects.toMatchObject({ status: 401 });
    const withinCap = await issue(privateKey, clock.now, { lifetimeSeconds: 60 });
    await expect(verifier.verify(request(withinCap), ROUTE)).resolves.toBeDefined();

    const unknownIssuer = await issue(privateKey, clock.now, { issuer: "https://unknown.example" });
    await expect(verifier.verify(request(unknownIssuer), ROUTE)).rejects.toMatchObject({ status: 401 });
    const wrongAudience = await issue(privateKey, clock.now, { audience: "wrong-audience" });
    await expect(verifier.verify(request(wrongAudience), ROUTE)).rejects.toMatchObject({ status: 401 });

    const rogue = await generateKeyPair("ES256");
    const unknownKey = await issue(rogue.privateKey, clock.now, { kid: "rogue-key" });
    await expect(verifier.verify(request(unknownKey), ROUTE)).rejects.toMatchObject({ status: 401 });
  });

  test("takes Root Ref domain and opaque subject only from verified claims", async () => {
    const { clock, privateKey, resolver } = await fixture();
    const verifier = new StackCapabilityVerifier({ repository: resolver, now: () => clock.now });
    const route = { operation: "updateRootRefs" as const, stackId: STACK, tenantId: TENANT };

    const token = await issue(privateKey, clock.now, {
      permissions: [casWritePermission(TENANT)],
      refDomain: "new:doc",
      subject: "arbitrary-service",
    });
    const forgedRequest = new Request("https://cas.example/tenant", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-CAS-Ref-Domain": "attacker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refDomain: "attacker" }),
    });
    await expect(verifier.verify(forgedRequest, route)).resolves.toMatchObject({
      refDomain: "new:doc",
      subject: "arbitrary-service",
    });

    for (const refDomain of [undefined, "_legacy", "Invalid Domain"]) {
      const invalid = await issue(privateKey, clock.now, {
        permissions: [casWritePermission(TENANT)],
        ...(refDomain === undefined ? {} : { refDomain }),
      });
      await expect(verifier.verify(request(invalid), route)).rejects.toMatchObject({ status: 403 });
    }
  });

  test("does not treat an admin session cookie as tenant authentication", async () => {
    const { clock, resolver } = await fixture();
    const verifier = new StackCapabilityVerifier({ repository: resolver, now: () => clock.now });
    const cookieOnly = new Request("https://cas.example/tenant", {
      headers: { Cookie: "cas_admin_session=secret" },
    });
    await expect(verifier.verify(cookieOnly, ROUTE)).rejects.toMatchObject({ status: 401 });
  });

  test("uses a fresh cache entry without another registry lookup", async () => {
    const { clock, resolver, token } = await fixture();
    const verifier = new StackCapabilityVerifier({
      repository: resolver,
      now: () => clock.now,
    });
    await verifier.verify(request(token), ROUTE);
    await verifier.verify(request(token), ROUTE);
    expect(resolver.lookups).toBe(1);
  });

  test("serves stale authority only inside the hard stale bound", async () => {
    const { clock, resolver, token } = await fixture();
    const events: string[] = [];
    const verifier = new StackCapabilityVerifier({
      repository: resolver,
      now: () => clock.now,
      onEvent: (event) => events.push(event.kind),
    });
    await verifier.verify(request(token), ROUTE);

    resolver.unavailable = true;
    clock.now += 31_000;
    await expect(verifier.verify(request(token), ROUTE)).resolves.toBeDefined();
    expect(events).toContain("registry_stale");

    clock.now += 31_000;
    await expect(verifier.verify(request(token), ROUTE)).rejects.toMatchObject({ status: 401 });
    expect(events).toContain("fail_closed");
  });

  test("refreshes past the hard bound when the registry is reachable", async () => {
    const { clock, resolver, token } = await fixture();
    const verifier = new StackCapabilityVerifier({
      repository: resolver,
      now: () => clock.now,
    });
    await verifier.verify(request(token), ROUTE);
    clock.now += 90_000;
    await verifier.verify(request(token), ROUTE);
    expect(resolver.lookups).toBe(2);
  });

  test("fails closed on a cold registry outage", async () => {
    const { clock, resolver, token } = await fixture();
    resolver.unavailable = true;
    const verifier = new StackCapabilityVerifier({ repository: resolver, now: () => clock.now });
    await expect(verifier.verify(request(token), ROUTE)).rejects.toMatchObject({ status: 401 });
    expect(resolver.lookups).toBe(1);
  });

  test("observes key removal on the first refresh after the cache TTL", async () => {
    const { clock, resolver, token } = await fixture();
    const verifier = new StackCapabilityVerifier({ repository: resolver, now: () => clock.now });
    await verifier.verify(request(token), ROUTE);

    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    resolver.authority = {
      ...resolver.authority!,
      keys: [{
        kid: "key-2",
        algorithm: "ES256",
        publicJwk: await exportJWK(publicKey),
        state: "active",
      }],
    };
    clock.now += 5_000;
    await expect(verifier.verify(request(token), ROUTE)).resolves.toBeDefined();
    clock.now += 31_000;
    await expect(verifier.verify(request(token), ROUTE)).rejects.toMatchObject({ status: 401 });
  });

  test("exposes the protocol permission matrix", () => {
    expect(permissionFor(ROUTE)).toBe(casReadPermission(TENANT));
    expect(permissionFor({ operation: "readMetadata", stackId: STACK, tenantId: TENANT, hash: "a" }))
      .toBe(casReadPermission(TENANT));
  });
});
