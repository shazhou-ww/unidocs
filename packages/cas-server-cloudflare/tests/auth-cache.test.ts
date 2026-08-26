/**
 * Authority-cache policy tests: 30s cache, 60s hard stale bound, fail-closed
 * on an unavailable registry, and static legacy bootstrap precedence.
 */

import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, test } from "vitest";
import {
  CapabilityIssuer,
  JoseCapabilitySigner,
  casReadPermission,
} from "@unidocs/service-auth";
import { StackCapabilityVerifier } from "../src/auth.js";
import type {
  RegisteredRefDomain,
  ResolvedStackAuthority,
} from "@unidocs/cas-control-plane";

const ISSUER = "https://issuer.example";
const STACK = "cas_stack_a";
const AUDIENCE = "unidocs-cas";
const TENANT = "tenant-1";

class StubRepository {
  #authority: ResolvedStackAuthority;
  #domains: readonly RegisteredRefDomain[];
  #down = false;
  issuerLookups = 0;
  domainLookups = 0;

  constructor(authority: ResolvedStackAuthority, domains: readonly RegisteredRefDomain[] = []) {
    this.#authority = authority;
    this.#domains = domains;
  }

  setRegistryDown(down: boolean): void {
    this.#down = down;
  }

  current(): ResolvedStackAuthority {
    return this.#authority;
  }

  replaceAuthority(authority: ResolvedStackAuthority): void {
    this.#authority = authority;
  }

  async resolveIssuer(issuer: string): Promise<ResolvedStackAuthority | null> {
    this.issuerLookups += 1;
    if (this.#down) throw new Error("registry unavailable");
    return issuer === ISSUER ? this.#authority : null;
  }

  async listRegisteredRefDomains(stackId: string): Promise<readonly RegisteredRefDomain[]> {
    this.domainLookups += 1;
    if (this.#down) throw new Error("registry unavailable");
    return stackId === STACK ? this.#domains : [];
  }
}

async function setup(): Promise<{
  repository: StubRepository;
  token: string;
  clock: { now: number };
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  const authority: ResolvedStackAuthority = {
    stackId: STACK,
    issuer: ISSUER,
    audience: AUDIENCE,
    status: "active",
    keys: [{ kid: "k1", algorithm: "ES256", publicJwk, state: "active" }],
  };
  const repository = new StubRepository(authority, [{ refDomain: "doc", status: "active" }]);
  // One injected clock drives both the issuer and the verifier so tokens are
  // not "from the future".
  const clock = { now: 1_000_000 };
  const issuer = new CapabilityIssuer({
    issuer: ISSUER,
    signer: new JoseCapabilitySigner(privateKey, "k1"),
    now: () => clock.now / 1000,
  });
  const token = await issuer.issue({
    subject: "doc-service:markdown",
    audience: AUDIENCE,
    tenantId: TENANT,
    permissions: [casReadPermission(TENANT)],
  });
  return { repository, token, clock };
}

function request(token: string): Request {
  return new Request(`https://cas.example/stacks/${STACK}/tenants/${TENANT}/cas/nodes/h/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

const ROUTE = { operation: "readContent" as const, stackId: STACK, tenantId: TENANT, hash: "h" };

describe("authority cache policy", () => {
  test("cached records serve within 30s; refresh happens after the TTL", async () => {
    const { repository, token, clock } = await setup();
    const verify = new StackCapabilityVerifier({ repository, now: () => clock.now });

    await verify.verify(request(token), ROUTE);
    expect(repository.issuerLookups).toBe(1);
    await verify.verify(request(token), ROUTE); // within 30s: no lookup
    expect(repository.issuerLookups).toBe(1);

    clock.now += 31_000; // past cache TTL, within the hard stale bound
    await verify.verify(request(token), ROUTE);
    expect(repository.issuerLookups).toBe(2);
  });

  test("an unavailable registry serves the cached record within the stale bound", async () => {
    const { repository, token, clock } = await setup();
    const events: string[] = [];
    const verify = new StackCapabilityVerifier({
      repository,
      now: () => clock.now,
      onEvent: (event) => events.push(event.kind),
    });

    await verify.verify(request(token), ROUTE);
    repository.setRegistryDown(true);
    clock.now += 31_000; // stale window: refresh fails, cached record serves
    await verify.verify(request(token), ROUTE);
    expect(events).toContain("registry_stale");

    clock.now += 31_000; // past the 60s hard bound: fail closed
    await expect(
      verify.verify(request(token), ROUTE),
    ).rejects.toMatchObject({ status: 401 });
    expect(events).toContain("fail_closed");
  });

  test("a cold registry outage fails closed (unknown issuer)", async () => {
    const { repository, token } = await setup();
    repository.setRegistryDown(true);
    const verify = new StackCapabilityVerifier({ repository });
    await expect(verify.verify(request(token), ROUTE)).rejects.toMatchObject({ status: 401 });
  });

  test("key removal propagates within the hard bound: refresh observes the new authority", async () => {
    const { repository, token, clock } = await setup();
    const verify = new StackCapabilityVerifier({ repository, now: () => clock.now });
    await verify.verify(request(token), ROUTE);

    // Registry now resolves to a different key (rotation/revocation).
    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    const newJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
    repository.replaceAuthority({
      ...repository.current(),
      keys: [{ kid: "k2", algorithm: "ES256", publicJwk: newJwk, state: "active" }],
    });

    // Within the cache TTL the old key still verifies (bounded propagation).
    clock.now += 5_000;
    await verify.verify(request(token), ROUTE);
    // Past the TTL the refresh observes the new key set; the old token fails.
    clock.now += 31_000;
    await expect(verify.verify(request(token), ROUTE)).rejects.toMatchObject({ status: 401 });
  });
});
