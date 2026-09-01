import { describe, expect, test } from "vitest";
import {
  MemoryGatewayOAuthAuthorizationCodeStore,
  MemoryGatewayOAuthAuthorizationTransactionStore,
  MemoryGatewayOAuthClientStore,
  MemoryGatewayOAuthRefreshTokenStore,
  MemoryGatewayOAuthTenantMembershipStore,
  type GatewayOAuthStoredRefreshToken,
} from "../src/index.js";

const refreshToken: GatewayOAuthStoredRefreshToken = {
  tokenHash: "hash-1",
  familyId: "family-1",
  generation: 0,
  clientId: "client-1",
  principalId: "user-1",
  tenantId: "tenant-1",
  scopes: ["cas:read"],
  permissions: ["tenants:tenant-1:cas:read" as never],
  createdAt: 1_000,
  expiresAt: 2_000,
};

describe("Gateway OAuth memory adapters", () => {
  test("client, transaction, and code stores implement put-if-absent and atomic take", async () => {
    const clients = new MemoryGatewayOAuthClientStore();
    const client = {
      clientId: "client-1",
      redirectUris: ["https://app.example/callback"],
      clientName: null,
      createdAt: 1,
    } as const;
    await expect(clients.putIfAbsent(client)).resolves.toBe(true);
    await expect(clients.putIfAbsent(client)).resolves.toBe(false);
    await expect(clients.find("client-1")).resolves.toBe(client);

    const transactions = new MemoryGatewayOAuthAuthorizationTransactionStore();
    const transaction = {
      transactionId: "transaction-1",
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      tenantId: "tenant-1",
      principalId: "user-1",
      requestedScopes: ["cas:read"],
      state: null,
      codeChallenge: "A".repeat(43),
      createdAt: 1,
      expiresAt: 2,
    } as const;
    await expect(transactions.putIfAbsent(transaction)).resolves.toBe(true);
    await expect(transactions.take("transaction-1")).resolves.toBe(transaction);
    await expect(transactions.take("transaction-1")).resolves.toBeNull();

    const codes = new MemoryGatewayOAuthAuthorizationCodeStore();
    const code = {
      codeHash: "code-hash",
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read"],
      permissions: refreshToken.permissions,
      codeChallenge: "A".repeat(43),
      createdAt: 1,
      expiresAt: 2,
    } as const;
    await expect(codes.putIfAbsent(code)).resolves.toBe(true);
    await expect(codes.take("code-hash")).resolves.toBe(code);
    await expect(codes.take("code-hash")).resolves.toBeNull();
  });

  test("refresh rotation detects replay and revokes every active family member", async () => {
    const store = new MemoryGatewayOAuthRefreshTokenStore();
    await expect(store.putInitial(refreshToken)).resolves.toBe(true);
    const first = await store.rotate({ currentHash: "hash-1", nextHash: "hash-2", now: 1_100 });
    expect(first).toMatchObject({
      status: "rotated",
      token: { tokenHash: "hash-2", familyId: "family-1", generation: 1 },
    });
    await expect(store.rotate({ currentHash: "hash-1", nextHash: "hash-3", now: 1_200 }))
      .resolves.toEqual({ status: "replayed" });
    await expect(store.rotate({ currentHash: "hash-2", nextHash: "hash-4", now: 1_300 }))
      .resolves.toEqual({ status: "invalid" });
  });

  test("refresh revocation is client-bound, family-wide, and idempotent", async () => {
    const store = new MemoryGatewayOAuthRefreshTokenStore();
    await store.putInitial(refreshToken);
    await store.rotate({ currentHash: "hash-1", nextHash: "hash-2", now: 1_100 });
    await store.revoke("hash-1", "other-client");
    await expect(store.rotate({ currentHash: "hash-2", nextHash: "hash-3", now: 1_200 }))
      .resolves.toMatchObject({ status: "rotated" });
    await store.revoke("hash-2", "client-1");
    await store.revoke("hash-2", "client-1");
    await expect(store.rotate({ currentHash: "hash-3", nextHash: "hash-4", now: 1_300 }))
      .resolves.toEqual({ status: "invalid" });
  });

  test("membership lookup is scoped by both principal and tenant", async () => {
    const memberships = new MemoryGatewayOAuthTenantMembershipStore([{
      principalId: "user-1",
      membership: { tenantId: "tenant-1", scopes: ["cas:read"] },
    }]);
    await expect(memberships.find("user-1", "tenant-1"))
      .resolves.toEqual({ tenantId: "tenant-1", scopes: ["cas:read"] });
    await expect(memberships.find("user-2", "tenant-1")).resolves.toBeNull();
    await expect(memberships.find("user-1", "tenant-2")).resolves.toBeNull();
  });
});
