import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  cleanupGatewayOAuthD1,
  D1GatewayOAuthAuditPort,
  D1GatewayOAuthAuthorizationCodeStore,
  D1GatewayOAuthAuthorizationTransactionStore,
  D1GatewayOAuthClientStore,
  D1GatewayOAuthRefreshTokenStore,
  D1GatewayOAuthTenantMembershipStore,
} from "../src/oauth-d1.js";

let miniflare: Miniflare;
let db: D1Database;

beforeEach(async () => {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "oauth-d1-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: `oauth-${crypto.randomUUID()}` },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "oauth-d1-test") as unknown as D1Database;
  const migration = fileURLToPath(new URL("../migrations/0006_gateway_oauth.sql", import.meta.url));
  await db.exec(await readFile(migration, "utf8"));
});

afterEach(async () => {
  await miniflare.dispose();
});

describe("Cloudflare Gateway OAuth D1 adapters", () => {
  test("stores clients and atomically consumes transactions and codes", async () => {
    const clients = new D1GatewayOAuthClientStore(db);
    const client = {
      clientId: "client-1",
      redirectUris: ["https://app.example/callback"],
      clientName: "App",
      createdAt: 1_000,
    } as const;
    await expect(clients.putIfAbsent(client)).resolves.toBe(true);
    await expect(clients.putIfAbsent(client)).resolves.toBe(false);
    await expect(clients.find("client-1")).resolves.toEqual(client);

    const transactions = new D1GatewayOAuthAuthorizationTransactionStore(db, () => 1_010);
    const transaction = {
      transactionId: "transaction-1",
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      tenantId: "tenant-1",
      principalId: "user-1",
      requestedScopes: ["cas:read"],
      state: "state-1",
      codeChallenge: "A".repeat(43),
      createdAt: 1_000,
      expiresAt: 1_600,
    } as const;
    await expect(transactions.putIfAbsent(transaction)).resolves.toBe(true);
    await expect(Promise.all([
      transactions.take("transaction-1"),
      transactions.take("transaction-1"),
    ])).resolves.toSatisfy(results => results.filter(Boolean).length === 1);

    const codes = new D1GatewayOAuthAuthorizationCodeStore(db, () => 1_020);
    const code = {
      codeHash: "code-hash",
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read"],
      permissions: ["tenants:tenant-1:cas:read" as never],
      codeChallenge: "A".repeat(43),
      refDomain: "documents",
      createdAt: 1_010,
      expiresAt: 1_070,
    } as const;
    await expect(codes.putIfAbsent(code)).resolves.toBe(true);
    await expect(codes.take("code-hash")).resolves.toEqual(code);
    await expect(codes.take("code-hash")).resolves.toBeNull();
  });

  test("atomically rotates refresh tokens and revokes the family on replay", async () => {
    const refresh = new D1GatewayOAuthRefreshTokenStore(db);
    const token = {
      tokenHash: "refresh-0",
      familyId: "family-1",
      generation: 0,
      clientId: "client-1",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read"],
      permissions: ["tenants:tenant-1:cas:read" as never],
      createdAt: 1_000,
      expiresAt: 2_000,
    } as const;
    await expect(refresh.putInitial(token)).resolves.toBe(true);
    await expect(refresh.putInitial(token)).resolves.toBe(false);
    await expect(refresh.rotate({
      currentHash: "refresh-0",
      nextHash: "refresh-1",
      now: 1_100,
    })).resolves.toMatchObject({
      status: "rotated",
      token: { tokenHash: "refresh-1", generation: 1 },
    });
    await expect(refresh.rotate({
      currentHash: "refresh-0",
      nextHash: "attacker-successor",
      now: 1_200,
    })).resolves.toEqual({ status: "replayed" });
    await expect(refresh.rotate({
      currentHash: "refresh-1",
      nextHash: "refresh-2",
      now: 1_300,
    })).resolves.toEqual({ status: "invalid" });
    await expect(db.prepare(
      "SELECT revoked_at, replayed_at FROM gateway_oauth_refresh_families WHERE family_id = ?",
    ).bind("family-1").first()).resolves.toMatchObject({
      revoked_at: 1_200,
      replayed_at: 1_200,
    });
  });

  test("revocation is client-bound, family-wide, and idempotent", async () => {
    const refresh = new D1GatewayOAuthRefreshTokenStore(db);
    await refresh.putInitial({
      tokenHash: "refresh-0",
      familyId: "family-1",
      generation: 0,
      clientId: "client-1",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read"],
      permissions: ["tenants:tenant-1:cas:read" as never],
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    await refresh.revoke("refresh-0", "wrong-client");
    await expect(refresh.rotate({ currentHash: "refresh-0", nextHash: "refresh-1", now: 1_100 }))
      .resolves.toMatchObject({ status: "rotated" });
    await refresh.revoke("refresh-0", "client-1");
    await refresh.revoke("refresh-0", "client-1");
    await expect(refresh.rotate({ currentHash: "refresh-1", nextHash: "refresh-2", now: 1_200 }))
      .resolves.toEqual({ status: "invalid" });
  });

  test("looks up authoritative memberships and persists token-free audit events", async () => {
    await db.prepare(
      `INSERT INTO gateway_oauth_tenant_memberships
       (principal_id, tenant_id, scopes_json, ref_domain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("user-1", "tenant-1", '["cas:read","cas:write"]', "documents", 1_000, 1_000).run();
    const memberships = new D1GatewayOAuthTenantMembershipStore(db);
    await expect(memberships.find("user-1", "tenant-1")).resolves.toEqual({
      tenantId: "tenant-1",
      scopes: ["cas:read", "cas:write"],
      refDomain: "documents",
    });
    await expect(memberships.find("user-2", "tenant-1")).resolves.toBeNull();

    const audit = new D1GatewayOAuthAuditPort(db, () => 1_100, () => "event-1");
    await audit.record({
      action: "token.issued",
      clientId: "client-1",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read"],
    });
    await expect(db.prepare(
      "SELECT * FROM gateway_oauth_audit_events WHERE event_id = ?",
    ).bind("event-1").first()).resolves.toMatchObject({
      action: "token.issued",
      client_id: "client-1",
      principal_id: "user-1",
      tenant_id: "tenant-1",
      scopes_json: '["cas:read"]',
      reason: null,
      created_at: 1_100,
    });
    const columns = await db.prepare("PRAGMA table_info(gateway_oauth_audit_events)")
      .all<{ name: string }>();
    expect(columns.results.map(column => column.name)).not.toEqual(expect.arrayContaining([
      "access_token", "refresh_token", "authorization_code", "code_verifier",
    ]));
  });

  test("cleans expired ephemeral state without deleting live families or memberships", async () => {
    const transactions = new D1GatewayOAuthAuthorizationTransactionStore(db);
    await transactions.putIfAbsent({
      transactionId: "expired-transaction",
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      tenantId: "tenant-1",
      principalId: "user-1",
      requestedScopes: ["cas:read"],
      state: null,
      codeChallenge: "A".repeat(43),
      createdAt: 100,
      expiresAt: 200,
    });
    await transactions.putIfAbsent({
      transactionId: "live-transaction",
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      tenantId: "tenant-1",
      principalId: "user-1",
      requestedScopes: ["cas:read"],
      state: null,
      codeChallenge: "A".repeat(43),
      createdAt: 99_900,
      expiresAt: 100_100,
    });
    const refresh = new D1GatewayOAuthRefreshTokenStore(db);
    await refresh.putInitial({
      tokenHash: "expired-refresh",
      familyId: "expired-family",
      generation: 0,
      clientId: "client-1",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read"],
      permissions: ["tenants:tenant-1:cas:read" as never],
      createdAt: 100,
      expiresAt: 200,
    });
    await refresh.putInitial({
      tokenHash: "live-refresh",
      familyId: "live-family",
      generation: 0,
      clientId: "client-1",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read"],
      permissions: ["tenants:tenant-1:cas:read" as never],
      createdAt: 99_900,
      expiresAt: 100_100,
    });
    await db.prepare(
      `INSERT INTO gateway_oauth_tenant_memberships
       (principal_id, tenant_id, scopes_json, ref_domain, created_at, updated_at)
       VALUES ('user-1', 'tenant-1', '["cas:read"]', NULL, 100, 100)`,
    ).run();
    await db.prepare(
      `INSERT INTO gateway_oauth_audit_events
       (event_id, action, client_id, principal_id, tenant_id, scopes_json, reason, created_at)
       VALUES ('old-event', 'token.issued', 'client-1', NULL, NULL, NULL, NULL, 100)`,
    ).run();

    await expect(cleanupGatewayOAuthD1(db, 100_000, 24 * 60 * 60)).resolves.toEqual({
      transactions: 1,
      codes: 0,
      refreshTokens: 1,
      refreshFamilies: 1,
      auditEvents: 1,
    });
    await expect(db.prepare(
      "SELECT transaction_id FROM gateway_oauth_authorization_transactions",
    ).all()).resolves.toMatchObject({ results: [{ transaction_id: "live-transaction" }] });
    await expect(db.prepare(
      "SELECT family_id FROM gateway_oauth_refresh_families",
    ).all()).resolves.toMatchObject({ results: [{ family_id: "live-family" }] });
    await expect(db.prepare(
      "SELECT tenant_id FROM gateway_oauth_tenant_memberships",
    ).all()).resolves.toMatchObject({ results: [{ tenant_id: "tenant-1" }] });
  });
});
