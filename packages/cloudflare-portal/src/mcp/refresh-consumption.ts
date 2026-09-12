import type { D1Database } from "@cloudflare/workers-types";

export async function consumeAdminMcpRefreshToken(database: D1Database, token: string, consumedAt: number, expiresAt: number): Promise<boolean> {
  return consumeCredential(database, "portal_mcp_refresh_consumptions", token, consumedAt, expiresAt);
}

export async function consumeAdminMcpAuthorizationCode(database: D1Database, code: string, consumedAt: number, expiresAt: number): Promise<boolean> {
  return consumeCredential(database, "portal_mcp_code_consumptions", code, consumedAt, expiresAt);
}

async function consumeCredential(database: D1Database, table: "portal_mcp_refresh_consumptions" | "portal_mcp_code_consumptions", token: string, consumedAt: number, expiresAt: number): Promise<boolean> {
  if (!token || !Number.isSafeInteger(consumedAt) || consumedAt < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= consumedAt) {
    throw new Error("Invalid credential consumption");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const result = await database.prepare(`INSERT INTO ${table} (token_hash, consumed_at, expires_at)
    VALUES (?, ?, ?) ON CONFLICT(token_hash) DO NOTHING`).bind(hash, consumedAt, expiresAt).run();
  if (!result.success) throw new Error("Credential consumption unavailable");
  return result.meta.changes === 1;
}