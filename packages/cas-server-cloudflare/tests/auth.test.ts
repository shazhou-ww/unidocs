/**
 * Stack authorization tests for the canonical CAS server.
 *
 * Seeds a CAS_CONTROL_DB (miniflare D1) directly with issuer/key/refDomain
 * rows, issues stack-authority capabilities with service-auth, and exercises
 * `StackCapabilityVerifier` plus the worker end-to-end. The registry write
 * path (ControlPlaneService) is covered by cas-control-plane's own suite;
 * here we test the read-only authority behavior.
 */

import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { migrateControlSchema } from "@unidocs/cas-control-plane";
import { AuthorityRepository } from "@unidocs/cas-control-plane";
import {
  CapabilityIssuer,
  JoseCapabilitySigner,
  casGcTriggerPermission,
  casReadPermission,
  casUsageReadPermission,
  casWritePermission,
} from "@unidocs/service-auth";
import type { CapabilityPermission } from "@unidocs/service-auth";
import { StackCapabilityVerifier } from "../src/auth.js";
import type { StackAuthEvent, VerifiedStackCall } from "../src/auth.js";
import worker from "../src/worker.js";
import type { Env } from "../src/worker.js";

let miniflare: Miniflare | undefined;
let db: D1Database | undefined;

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
  db = undefined;
});

interface StackFixture {
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly privateKey: CryptoKey;
  readonly kid: string;
  readonly issuer_: CapabilityIssuer;
}

async function seedStack(
  stack: {
    readonly stackId: string;
    readonly issuer: string;
    readonly audience: string;
    readonly kid: string;
    readonly domains: readonly { refDomain: string; status: string }[];
  },
): Promise<StackFixture> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  await db!.batch([
    db!.prepare("INSERT INTO cas_stack_issuer (stack_id, issuer, audience, status, revision) VALUES (?, ?, ?, 'active', 1)")
      .bind(stack.stackId, stack.issuer, stack.audience),
    db!.prepare("INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state, revision) VALUES (?, ?, 'ES256', ?, 'active', 1)")
      .bind(stack.stackId, stack.kid, JSON.stringify(publicJwk)),
    ...stack.domains.map((domain) =>
      db!.prepare("INSERT INTO cas_stack_ref_domains (stack_id, ref_domain, status, revision) VALUES (?, ?, ?, 1)")
        .bind(stack.stackId, domain.refDomain, domain.status)),
  ]);
  return {
    stackId: stack.stackId,
    issuer: stack.issuer,
    audience: stack.audience,
    privateKey,
    kid: stack.kid,
    issuer_: new CapabilityIssuer({
      issuer: stack.issuer,
      signer: new JoseCapabilitySigner(privateKey, stack.kid),
    }),
  };
}

async function createSeededDb(): Promise<{ db: D1Database; stacks: Record<string, StackFixture> }> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "cas-server-auth-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "cas-server-auth-test-db" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "cas-server-auth-test");
  await migrateControlSchema(db);

  const stackA = await seedStack({
    stackId: "cas_stack_a",
    issuer: "https://issuer-a.example",
    audience: "unidocs-cas-a",
    kid: "key-a",
    domains: [
      { refDomain: "doc", status: "active" },
      { refDomain: "asset", status: "active" },
      { refDomain: "legacy:doc", status: "retired" },
    ],
  });
  const stackB = await seedStack({
    stackId: "cas_stack_b",
    issuer: "https://issuer-b.example",
    audience: "unidocs-cas-b",
    kid: "key-b",
    domains: [{ refDomain: "doc", status: "active" }],
  });
  return { db, stacks: { a: stackA, b: stackB } };
}

async function issue(
  stack: StackFixture,
  input: {
    tenantId: string;
    permissions: readonly CapabilityPermission[];
    refDomain?: string;
    subject?: string;
  },
): Promise<string> {
  return stack.issuer_.issue({
    subject: input.subject ?? "doc-service:markdown",
    audience: stack.audience,
    tenantId: input.tenantId,
    permissions: input.permissions,
    ...(input.refDomain === undefined ? {} : { refDomain: input.refDomain }),
  });
}

function verifier(
  options: {
    repository?: AuthorityRepository;
    now?: () => number;
    events?: StackAuthEvent[];
  } = {},
): StackCapabilityVerifier {
  const events = options.events ?? [];
  return new StackCapabilityVerifier({
    repository: options.repository ?? new AuthorityRepository(db!),
    now: options.now,
    onEvent: (event) => events.push(event),
  });
}

function authRequest(token: string, path: string, method = "GET"): Request {
  return new Request(`https://cas.example${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function expectRejected(
  promise: Promise<VerifiedStackCall>,
  status: 401 | 403,
  messagePart?: string,
): Promise<void> {
  try {
    await promise;
    expect.fail("expected verification to reject");
  } catch (error) {
    expect((error as { status?: number }).status).toBe(status);
    if (messagePart) expect((error as Error).message).toContain(messagePart);
  }
}

describe("stack authorization (Task 4)", () => {
  test("permission matrix: each operation requires its exact permission", async () => {
    const { stacks } = await createSeededDb();
    const verify = verifier();
    const stack = stacks.a!;
    const tenant = "tenant-1";

    // readContent / readMetadata -> cas:read
    const readToken = await issue(stack, { tenantId: tenant, permissions: [casReadPermission(tenant)] });
    await verify.verify(authRequest(readToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/${"a".repeat(64)}/content`), { operation: "readContent", stackId: stack.stackId, tenantId: tenant, hash: "a".repeat(64) });
    await verify.verify(authRequest(readToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/${"a".repeat(64)}/metadata`), { operation: "readMetadata", stackId: stack.stackId, tenantId: tenant, hash: "a".repeat(64) });

    // lease -> cas:write
    const writeToken = await issue(stack, { tenantId: tenant, permissions: [casWritePermission(tenant)] });
    await verify.verify(authRequest(writeToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/${"a".repeat(64)}`, "POST"), { operation: "leaseNode", stackId: stack.stackId, tenantId: tenant, hash: "a".repeat(64) });
    await verify.verify(authRequest(writeToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/${"a".repeat(64)}/lease`, "POST"), { operation: "leaseExisting", stackId: stack.stackId, tenantId: tenant, hash: "a".repeat(64) });

    // usage / gc -> the tenant-only permissions
    const usageToken = await issue(stack, { tenantId: tenant, permissions: [casUsageReadPermission(tenant)] });
    await verify.verify(authRequest(usageToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/usage`), { operation: "usage", stackId: stack.stackId, tenantId: tenant });
    const gcToken = await issue(stack, { tenantId: tenant, permissions: [casGcTriggerPermission(tenant)] });
    await verify.verify(authRequest(gcToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/gc`, "POST"), { operation: "gc", stackId: stack.stackId, tenantId: tenant });

    // updateRootRefs -> cas:write + registered active refDomain
    const refsToken = await issue(stack, { tenantId: tenant, permissions: [casWritePermission(tenant)], refDomain: "doc" });
    await verify.verify(authRequest(refsToken, `/stacks/${stack.stackId}/tenants/${tenant}/root-refs`, "POST"), { operation: "updateRootRefs", stackId: stack.stackId, tenantId: tenant });

    // Wrong permission on each shape is rejected.
    await expectRejected(verify.verify(authRequest(readToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/gc`, "POST"), { operation: "gc", stackId: stack.stackId, tenantId: tenant }), 403, "requires");
    await expectRejected(verify.verify(authRequest(usageToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/${"a".repeat(64)}/content`), { operation: "readContent", stackId: stack.stackId, tenantId: tenant, hash: "a".repeat(64) }), 403);
    await expectRejected(verify.verify(authRequest(writeToken, `/stacks/${stack.stackId}/tenants/${tenant}/root-refs`, "POST"), { operation: "updateRootRefs", stackId: stack.stackId, tenantId: tenant }), 403, "refDomain");
  });

  test("unknown issuer, wrong audience, and wrong key fail closed", async () => {
    const { stacks } = await createSeededDb();
    const verify = verifier();
    const stack = stacks.a!;
    const tenant = "tenant-1";

    // Unknown issuer.
    const unknownIssuer = await issue({ ...stack, issuer: "https://unknown.example", issuer_: new CapabilityIssuer({ issuer: "https://unknown.example", signer: new JoseCapabilitySigner(stack.privateKey, stack.kid) }) }, { tenantId: tenant, permissions: [casReadPermission(tenant)] });
    await expectRejected(verify.verify(authRequest(unknownIssuer, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/h/content`), 401), 401);

    // Wrong audience.
    const wrongAud = await issue({ ...stack, audience: "wrong-aud", issuer_: new CapabilityIssuer({ issuer: stack.issuer, signer: new JoseCapabilitySigner(stack.privateKey, stack.kid) }) }, { tenantId: tenant, permissions: [casReadPermission(tenant)] });
    await expectRejected(verify.verify(authRequest(wrongAud, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/h/content`), 401), 401);

    // Token signed by a key the registry does not know (different kid/key).
    const rogue = await generateKeyPair("ES256");
    const rogueIssuer = new CapabilityIssuer({ issuer: stack.issuer, signer: new JoseCapabilitySigner(rogue.privateKey, "rogue-kid") });
    const rogueToken = await rogueIssuer.issue({ subject: "s", audience: stack.audience, tenantId: tenant, permissions: [casReadPermission(tenant)] });
    await expectRejected(verify.verify(authRequest(rogueToken, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/h/content`), 401), 401);
  });

  test("path stack and tenant must equal the verified claims", async () => {
    const { stacks } = await createSeededDb();
    const verify = verifier();
    const tenant = "tenant-1";
    const tokenA = await issue(stacks.a!, { tenantId: tenant, permissions: [casReadPermission(tenant)] });

    await expectRejected(verify.verify(authRequest(tokenA, `/stacks/${stacks.b!.stackId}/tenants/${tenant}/cas/nodes/h/content`), 403, "stack"), 403);
    await expectRejected(verify.verify(authRequest(tokenA, `/stacks/${stacks.a!.stackId}/tenants/other-tenant/cas/nodes/h/content`), 403, "tenant"), 403);
  });

  test("two trusted stacks may use the same textual tenantId without cross-authorization", async () => {
    const { stacks } = await createSeededDb();
    const verify = verifier();
    const sharedTenant = "shared-tenant";
    const tokenA = await issue(stacks.a!, { tenantId: sharedTenant, permissions: [casReadPermission(sharedTenant)] });
    const tokenB = await issue(stacks.b!, { tenantId: sharedTenant, permissions: [casReadPermission(sharedTenant)] });

    const callA = await verify.verify(authRequest(tokenA, `/stacks/${stacks.a!.stackId}/tenants/${sharedTenant}/cas/nodes/h/content`), { operation: "readContent", stackId: stacks.a!.stackId, tenantId: sharedTenant, hash: "h" });
    expect(callA.stackId).toBe(stacks.a!.stackId);
    const callB = await verify.verify(authRequest(tokenB, `/stacks/${stacks.b!.stackId}/tenants/${sharedTenant}/cas/nodes/h/content`), { operation: "readContent", stackId: stacks.b!.stackId, tenantId: sharedTenant, hash: "h" });
    expect(callB.stackId).toBe(stacks.b!.stackId);
    // Cross-stack paths are rejected even with the same tenantId.
    await expectRejected(verify.verify(authRequest(tokenA, `/stacks/${stacks.b!.stackId}/tenants/${sharedTenant}/cas/nodes/h/content`), 403), 403);
    await expectRejected(verify.verify(authRequest(tokenB, `/stacks/${stacks.a!.stackId}/tenants/${sharedTenant}/cas/nodes/h/content`), 403), 403);
  });

  test("confused deputy: write capabilities cannot read audit or attribute other domains", async () => {
    const { stacks } = await createSeededDb();
    const verify = verifier();
    const stack = stacks.a!;
    const tenant = "tenant-1";

    // A Root Refs writer can write its own registered domain...
    const writer = await issue(stack, { tenantId: tenant, permissions: [casWritePermission(tenant)], refDomain: "doc" });
    const call = await verify.verify(authRequest(writer, `/stacks/${stack.stackId}/tenants/${tenant}/root-refs`, "POST"), { operation: "updateRootRefs", stackId: stack.stackId, tenantId: tenant });
    expect(call.refDomain).toBe("doc");

    // ...but cannot use the write capability for a different domain: the
    // domain comes ONLY from the verified token, never from the request.
    const forged = new Request(`https://cas.example/stacks/${stack.stackId}/tenants/${tenant}/root-refs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${writer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requestId: "r", changes: {}, refDomain: "asset" }),
    });
    const call2 = await verify.verify(forged, { operation: "updateRootRefs", stackId: stack.stackId, tenantId: tenant });
    expect(call2.refDomain).toBe("doc"); // token wins; body is ignored

    // The writer cannot attribute to a reserved or unregistered domain: a
    // reserved domain is rejected at issuance, a retired domain at verify.
    await expect(issue(stack, { tenantId: tenant, permissions: [casWritePermission(tenant)], refDomain: "_legacy" }))
      .rejects.toThrow(/refDomain/);
    const retiredToken = await issue(stack, { tenantId: tenant, permissions: [casWritePermission(tenant)], refDomain: "legacy:doc" });
    await expectRejected(verify.verify(authRequest(retiredToken, `/stacks/${stack.stackId}/tenants/${tenant}/root-refs`, "POST"), 403, "not registered"), 403);

    // A writer cannot read audit or usage: it lacks those permissions.
    await expectRejected(verify.verify(authRequest(writer, `/stacks/${stack.stackId}/tenants/${tenant}/cas/usage`), 403), 403);
    await expectRejected(verify.verify(authRequest(writer, `/stacks/${stack.stackId}/tenants/${tenant}/cas/gc`, "POST"), 403), 403);

    // A usage capability cannot write root refs.
    const usageToken = await issue(stack, { tenantId: tenant, permissions: [casUsageReadPermission(tenant)] });
    await expectRejected(verify.verify(authRequest(usageToken, `/stacks/${stack.stackId}/tenants/${tenant}/root-refs`, "POST"), 403), 403);
  });

  test("sub is an opaque audit identity; no prefix semantics", async () => {
    const { stacks } = await createSeededDb();
    const verify = verifier();
    const stack = stacks.a!;
    const tenant = "tenant-1";
    for (const subject of ["gateway", "doc:markdown", "arbitrary-service", "user-123"]) {
      const token = await issue(stack, { tenantId: tenant, permissions: [casReadPermission(tenant)], subject });
      const call = await verify.verify(authRequest(token, `/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/h/content`), { operation: "readContent", stackId: stack.stackId, tenantId: tenant, hash: "h" });
      expect(call.subject).toBe(subject);
    }
  });

  test("OIDC session cookies never authenticate tenant routes", async () => {
    const { stacks } = await createSeededDb();
    const verify = verifier();
    const stack = stacks.a!;
    const request = new Request(`https://cas.example/stacks/${stack.stackId}/tenants/t/cas/usage`, {
      headers: { Cookie: "cas_admin_session=abc", Origin: "https://cas.example" },
    });
    await expectRejected(verify.verify(request, { operation: "usage", stackId: stack.stackId, tenantId: "t" }), 401, "token");
  });

  test("static legacy stack bootstrap verifies when the registry lacks the issuer", async () => {
    const { db: seededDb } = await createSeededDb();
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = (await exportJWK(publicKey)) as Record<string, unknown>;
    const verify = verifier({
      repository: new AuthorityRepository(seededDb),
      now: () => Date.now(),
    });
    const staticVerifier = new StackCapabilityVerifier({
      repository: new AuthorityRepository(seededDb),
      staticLegacyStack: {
        stackId: "cas_legacy_stack",
        issuer: "https://legacy-issuer.example",
        audience: "unidocs-cas",
        algorithm: "ES256",
        jwks: { keys: [{ ...jwk, kid: "legacy-kid", alg: "ES256", use: "sig" }] },
      },
    });
    const legacyIssuer = new CapabilityIssuer({
      issuer: "https://legacy-issuer.example",
      signer: new JoseCapabilitySigner(privateKey, "legacy-kid"),
    });
    const token = await legacyIssuer.issue({
      subject: "legacy-service",
      audience: "unidocs-cas",
      tenantId: "legacy-tenant",
      permissions: [casReadPermission("legacy-tenant")],
    });
    const call = await staticVerifier.verify(
      authRequest(token, "/stacks/cas_legacy_stack/tenants/legacy-tenant/cas/nodes/h/content"),
      { operation: "readContent", stackId: "cas_legacy_stack", tenantId: "legacy-tenant", hash: "h" },
    );
    expect(call.stackId).toBe("cas_legacy_stack");
    // The registry-only verifier (no static config) rejects the same token.
    await expectRejected(verify.verify(
      authRequest(token, "/stacks/cas_legacy_stack/tenants/legacy-tenant/cas/nodes/h/content"),
      401,
    ), 401);
  });

  test("worker end-to-end: authorized requests reach dispatch; failures are 401/403", async () => {
    const { db: controlDb, stacks } = await createSeededDb();
    const env = { CAS_CONTROL_DB: controlDb, CAS_DB: controlDb, CAS_R2: {}, CAS_DO: {} } as Env;
    const stack = stacks.a!;
    const tenant = "tenant-1";

    const readToken = await issue(stack, { tenantId: tenant, permissions: [casReadPermission(tenant)] });
    const authorized = await worker.fetch(
      new Request(`https://cas.example/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/${"a".repeat(64)}/content`, {
        headers: { Authorization: `Bearer ${readToken}` },
      }),
      env,
    );
    expect(authorized.status).toBe(501); // authorization complete; dispatch is Task 5/6
    const body = await authorized.json();
    expect(body).toMatchObject({ stackId: stack.stackId, tenantId: tenant });

    // A token from the other stack hitting this path → 403.
    const tokenB = await issue(stacks.b!, { tenantId: tenant, permissions: [casReadPermission(tenant)] });
    const wrongStack = await worker.fetch(
      new Request(`https://cas.example/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/${"a".repeat(64)}/content`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      }),
      env,
    );
    expect(wrongStack.status).toBe(403);

    // No token → 401; /admin is never a tenant route → 404.
    const noToken = await worker.fetch(
      new Request(`https://cas.example/stacks/${stack.stackId}/tenants/${tenant}/cas/nodes/${"a".repeat(64)}/content`),
      env,
    );
    expect(noToken.status).toBe(401);
    const admin = await worker.fetch(new Request("https://cas.example/admin/me"), env);
    expect(admin.status).toBe(404);
  });
});
