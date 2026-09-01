import { describe, expect, test, vi } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import {
  PgGatewayOAuthAuthorizationCodeStore,
  PgGatewayOAuthAuthorizationTransactionStore,
  PgGatewayOAuthClientStore,
  PgGatewayOAuthRefreshTokenStore,
  PgGatewayOAuthTenantMembershipStore,
} from "../src/oauth-pg.js";

function result(rows = [], rowCount = rows.length): QueryResult<any> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

describe("Azure Gateway OAuth PostgreSQL adapters", () => {
  test("maps clients, memberships, and one-time RETURNING rows", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(result([{
        client_id: "client-1",
        redirect_uris_json: ["https://app.example/callback"],
        client_name: "App",
        created_at: "1000",
      }]))
      .mockResolvedValueOnce(result([{
        tenant_id: "tenant-1",
        scopes_json: ["cas:read"],
        ref_domain: "documents",
      }]))
      .mockResolvedValueOnce(result([{
        transaction_id: "transaction-1",
        client_id: "client-1",
        redirect_uri: "https://app.example/callback",
        tenant_id: "tenant-1",
        principal_id: "user-1",
        requested_scopes_json: ["cas:read"],
        state: null,
        code_challenge: "A".repeat(43),
        created_at: "1000",
        expires_at: "1600",
      }]))
      .mockResolvedValueOnce(result([{
        code_hash: "code-hash",
        client_id: "client-1",
        redirect_uri: "https://app.example/callback",
        principal_id: "user-1",
        tenant_id: "tenant-1",
        scopes_json: ["cas:read"],
        permissions_json: ["tenants:tenant-1:cas:read"],
        code_challenge: "A".repeat(43),
        ref_domain: null,
        created_at: "1000",
        expires_at: "1060",
      }]))
      .mockResolvedValueOnce(result([], 0));
    const db = { query };

    await expect(new PgGatewayOAuthClientStore(db).find("client-1")).resolves.toEqual({
      clientId: "client-1",
      redirectUris: ["https://app.example/callback"],
      clientName: "App",
      createdAt: 1_000,
    });
    await expect(new PgGatewayOAuthTenantMembershipStore(db).find("user-1", "tenant-1"))
      .resolves.toEqual({ tenantId: "tenant-1", scopes: ["cas:read"], refDomain: "documents" });
    await expect(new PgGatewayOAuthAuthorizationTransactionStore(db, () => 1_010)
      .take("transaction-1")).resolves.toMatchObject({ transactionId: "transaction-1" });
    const codes = new PgGatewayOAuthAuthorizationCodeStore(db, () => 1_020);
    await expect(codes.take("code-hash")).resolves.toMatchObject({ codeHash: "code-hash" });
    await expect(codes.take("code-hash")).resolves.toBeNull();
    expect(query.mock.calls[2][0]).toContain("consumed_at IS NULL");
    expect(query.mock.calls[2][0]).toContain("RETURNING");
  });

  test("rotates a refresh token under row locks and commits its successor", async () => {
    const statements: string[] = [];
    const client = scriptedClient(async sql => {
      statements.push(sql);
      if (sql.includes("SELECT tokens.*")) return result([refreshRow({ consumed_at: null })]);
      if (sql.includes("INSERT INTO gateway_oauth_refresh_tokens")) {
        return result([refreshRow({ token_hash: "next", generation: 1, created_at: "1100" })]);
      }
      return result([], 1);
    });
    const store = new PgGatewayOAuthRefreshTokenStore(poolFor(client));
    await expect(store.rotate({ currentHash: "current", nextHash: "next", now: 1_100 }))
      .resolves.toMatchObject({ status: "rotated", token: { tokenHash: "next", generation: 1 } });
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(statements.some(sql => sql.includes("FOR UPDATE OF tokens, families"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  test("replay revokes the refresh family in the same transaction", async () => {
    const statements: string[] = [];
    const client = scriptedClient(async sql => {
      statements.push(sql);
      if (sql.includes("SELECT tokens.*")) return result([refreshRow({ consumed_at: "1050" })]);
      return result([], 1);
    });
    const store = new PgGatewayOAuthRefreshTokenStore(poolFor(client));
    await expect(store.rotate({ currentHash: "used", nextHash: "next", now: 1_100 }))
      .resolves.toEqual({ status: "replayed" });
    expect(statements.some(sql => sql.includes("replayed_at"))).toBe(true);
    expect(statements.some(sql => sql.includes("COALESCE(consumed_at"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
  });
});

function refreshRow(overrides = {}) {
  return {
    token_hash: "current",
    family_id: "family-1",
    generation: 0,
    client_id: "client-1",
    principal_id: "user-1",
    tenant_id: "tenant-1",
    scopes_json: ["cas:read"],
    permissions_json: ["tenants:tenant-1:cas:read"],
    ref_domain: null,
    created_at: "1000",
    expires_at: "2000",
    consumed_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function scriptedClient(run: (sql: string, values?: readonly unknown[]) => Promise<QueryResult<any>>) {
  return {
    query: vi.fn(run),
    release: vi.fn(),
  } as unknown as PoolClient & { release: ReturnType<typeof vi.fn> };
}

function poolFor(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
    query: vi.fn(),
  } as unknown as Pool;
}
