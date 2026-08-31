import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CryptoKey } from "jose";
import { describe, expect, test } from "vitest";
import { casReadPermission } from "@unicas/tenant-protocol";
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

async function issue(privateKey: CryptoKey, now: number): Promise<string> {
  const nowSeconds = Math.floor(now / 1000);
  return new SignJWT({
    tenantId: TENANT,
    permissions: [casReadPermission(TENANT)],
  })
    .setProtectedHeader({ alg: "ES256", kid: "key-1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("doc-service:markdown")
    .setJti("request-1")
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(nowSeconds + 300)
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
      operation: "gc",
      stackId: STACK,
      tenantId: TENANT,
    })).rejects.toMatchObject({ status: 403 });
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

  test("exposes the protocol permission matrix", () => {
    expect(permissionFor(ROUTE)).toBe(casReadPermission(TENANT));
    expect(permissionFor({ operation: "readMetadata", stackId: STACK, tenantId: TENANT, hash: "a" }))
      .toBe(casReadPermission(TENANT));
  });
});
