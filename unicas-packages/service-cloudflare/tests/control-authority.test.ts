import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { AuthorityRepository } from "../src/control-authority.js";
import { migrateControlSchema } from "../src/control-schema.js";

let miniflare: Miniflare | undefined;
let db: D1Database | undefined;

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
  db = undefined;
});

async function createRepository(): Promise<AuthorityRepository> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "control-authority-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "control-authority-test-db" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "control-authority-test");
  await migrateControlSchema(db);
  return new AuthorityRepository(db);
}

function oauthIssuerInserts(rows: Array<{
  stackId: string;
  issuer: string;
}>): D1PreparedStatement[] {
  return rows.map(({ stackId, issuer }) =>
    db!.prepare(
      "INSERT INTO cas_stack_oauth_issuers (stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, status, jwks_digest, capability_max_lifetime_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'digest', ?)",
    ).bind(
      stackId,
      issuer,
      "https://cas.example/stacks/" + stackId,
      "https://oauth.example/.well-known/oauth-authorization-server",
      "oauth",
      "https://oauth.example/authorize",
      "https://oauth.example/token",
      "https://oauth.example/jwks",
      600,
    ));
}

describe("AuthorityRepository (read-only)", () => {
  test("resolves an active OAuth issuer to its stack authority and discovered JWKS URI", async () => {
    const repository = await createRepository();
    await db!.batch(oauthIssuerInserts([{ stackId: "cas_s", issuer: "https://issuer.example" }]));
    const authority = await repository.resolveIssuer("https://issuer.example");
    expect(authority).toMatchObject({
      stackId: "cas_s",
      issuer: "https://issuer.example",
      audience: "https://cas.example/stacks/cas_s",
      jwksUri: "https://oauth.example/jwks",
      capabilityMaxLifetimeSeconds: 600,
    });
  });

  test("unknown issuers resolve to null (fail closed)", async () => {
    const repository = await createRepository();
    expect(await repository.resolveIssuer("https://unknown.example")).toBeNull();
    expect(await repository.resolveIssuer("")).toBeNull();
  });

  test("the legacy active issuer key snapshot table is removed", async () => {
    const repository = await createRepository();
    expect(repository).toBeDefined();
    expect(await db!.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cas_stack_oauth_issuer_keys'",
    ).first()).toBeNull();
  });

  test("a pending issuer is never an authority", async () => {
    const repository = await createRepository();
    await db!.prepare(
      "INSERT INTO cas_stack_oauth_issuers (stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, status, jwks_digest, capability_max_lifetime_seconds) VALUES ('cas_pending', 'https://pending.example', 'cas', 'https://pending.example/.well-known/oauth-authorization-server', 'oauth', 'https://pending.example/authorize', 'https://pending.example/token', 'https://pending.example/jwks', 'pending', 'digest', 600)",
    ).run();
    expect(await repository.resolveIssuer("https://pending.example")).toBeNull();
  });
});
