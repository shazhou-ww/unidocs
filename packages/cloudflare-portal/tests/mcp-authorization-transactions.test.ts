import { expect, test } from "vitest";
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createAdminMcpAuthorizationTransactions } from "../src/mcp/authorization-transactions.js";

const origin = "https://portal.example";
const now = 1_800_000_000;
const id = "i".repeat(43);
const oauthRequest: AuthRequest = {
  responseType: "code", clientId: "copilot-client", redirectUri: "https://vscode.dev/oauth/callback",
  scope: ["admin:read", "admin:content"], state: "private-client-state", codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256", resource: `${origin}/mcp`, issuer: origin,
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fixture() {
  const values = new Map<string, string>();
  const consumptions = new Set<string>();
  let clock = now;
  const storage = { put: async (key: string, value: string) => { values.set(key, value); }, get: async (key: string) => values.get(key) ?? null, delete: async (key: string) => { values.delete(key); } } as unknown as KVNamespace;
  const database = { prepare: () => ({ bind: (hash: string) => ({ run: async () => { const inserted = !consumptions.has(hash); consumptions.add(hash); return { success: true, meta: { changes: inserted ? 1 : 0 } }; } }) }) } as unknown as D1Database;
  const transactions = createAdminMcpAuthorizationTransactions({ database, storage, publicOrigin: origin, encryptionKey: base64Url(crypto.getRandomValues(new Uint8Array(32))), now: () => clock });
  return { values, transactions, advance: (seconds: number) => { clock += seconds; } };
}

test("encrypts OAuth request details and consumes a transaction once", async () => {
  const current = fixture();
  const pending = { kind: "session" as const, oauthRequest };
  await current.transactions.put(id, pending);
  const [[key, sealed]] = [...current.values.entries()];
  expect(key).toMatch(/^admin-mcp-authorization:[a-f0-9]{64}$/);
  expect(key).not.toContain(id);
  expect(sealed).not.toContain(oauthRequest.clientId);
  expect(sealed).not.toContain(oauthRequest.state);
  expect(await current.transactions.take(id)).toEqual(pending);
  expect(await current.transactions.take(id)).toBeNull();
});

test("wrong transaction IDs do not consume the stored authorization", async () => {
  const current = fixture();
  const pending = { kind: "session" as const, oauthRequest };
  await current.transactions.put(id, pending);
  expect(await current.transactions.take("x".repeat(43))).toBeNull();
  expect(await current.transactions.take(id)).toEqual(pending);
});

test("allows only one concurrent authorization consumer", async () => {
  const current = fixture();
  const pending = { kind: "session" as const, oauthRequest };
  await current.transactions.put(id, pending);
  const results = await Promise.all(Array.from({ length: 8 }, () => current.transactions.take(id)));
  expect(results.filter(Boolean)).toEqual([pending]);
});

test("rejects expired and structurally invalid authorization state", async () => {
  const expired = fixture();
  await expired.transactions.put(id, { kind: "session", oauthRequest });
  expired.advance(600);
  expect(await expired.transactions.take(id)).toBeNull();

  const invalid = fixture();
  await expect(invalid.transactions.put(id, { kind: "session", oauthRequest: { ...oauthRequest, resource: "https://attacker.example/mcp" } })).rejects.toThrow("Invalid MCP authorization transaction");
  await expect(invalid.transactions.put(id, { kind: "consent", oauthRequest, memberId: "member", identity: { issuer: "issuer", subject: "subject", email: "admin@example.com", authenticatedAt: now }, clientName: "client", csrfToken: "s".repeat(43), authorizedAt: now - 6 })).rejects.toThrow("Invalid MCP authorization transaction");
});