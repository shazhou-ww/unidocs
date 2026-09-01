import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
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
  await db.batch([
    db.prepare("INSERT INTO cas_stack_issuer (stack_id, issuer, audience, capability_max_lifetime_seconds) VALUES ('cas_s', 'https://issuer.example', 'unidocs-cas', 300)"),
    db.prepare("INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state) VALUES ('cas_s', 'k1', 'ES256', '{\"kty\":\"EC\"}', 'active')"),
    db.prepare("INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state) VALUES ('cas_s', 'k2', 'ES256', '{\"kty\":\"EC\"}', 'retiring')"),
    db.prepare("INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state) VALUES ('cas_s', 'k3', 'ES256', '{\"kty\":\"EC\"}', 'revoked')"),
  ]);
  return new AuthorityRepository(db);
}

describe("AuthorityRepository (read-only)", () => {
  test("resolves a registered issuer to its stack authority and keys", async () => {
    const repository = await createRepository();
    const authority = await repository.resolveIssuer("https://issuer.example");
    expect(authority).toMatchObject({
      stackId: "cas_s",
      issuer: "https://issuer.example",
      audience: "unidocs-cas",
      capabilityMaxLifetimeSeconds: 300,
    });
    expect(authority!.keys.map((key) => key.kid)).toEqual(["k1", "k2", "k3"]);
    expect(authority!.keys[0]).toMatchObject({ kid: "k1", algorithm: "ES256", state: "active" });
    expect(authority!.keys[2]!.state).toBe("revoked");
  });

  test("unknown issuers resolve to null (fail closed)", async () => {
    const repository = await createRepository();
    expect(await repository.resolveIssuer("https://unknown.example")).toBeNull();
    expect(await repository.resolveIssuer("")).toBeNull();
  });

  test("prefers active OAuth issuer snapshots and fails closed without keys", async () => {
    const repository = await createRepository();
    await db!.batch([
      db!.prepare("INSERT INTO cas_stack_oauth_issuers (stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, status, jwks_digest, capability_max_lifetime_seconds) VALUES ('cas_oauth', 'https://oauth.example', 'cas', 'https://oauth.example/.well-known/oauth-authorization-server', 'oauth', 'https://oauth.example/authorize', 'https://oauth.example/token', 'https://oauth.example/jwks', 'active', 'digest', 600)"),
      db!.prepare("INSERT INTO cas_stack_oauth_issuer_keys (stack_id, kid, algorithm, public_jwk, jwks_digest, activated_at) VALUES ('cas_oauth', 'oauth-k1', 'ES256', '{\"kty\":\"EC\"}', 'digest', 1)"),
      db!.prepare("INSERT INTO cas_stack_oauth_issuers (stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, status, jwks_digest, capability_max_lifetime_seconds) VALUES ('cas_empty', 'https://empty.example', 'cas', 'https://empty.example/.well-known/oauth-authorization-server', 'oauth', 'https://empty.example/authorize', 'https://empty.example/token', 'https://empty.example/jwks', 'active', 'digest', 600)"),
    ]);
    expect(await repository.resolveIssuer("https://oauth.example")).toMatchObject({
      stackId: "cas_oauth",
      keys: [{ kid: "oauth-k1", state: "active" }],
    });
    expect(await repository.resolveIssuer("https://empty.example")).toBeNull();
  });

  test("suppresses every legacy authority for a stack after OAuth activation", async () => {
    const repository = await createRepository();
    await db!.batch([
      db!.prepare("INSERT INTO cas_stack_oauth_issuers (stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, status, jwks_digest, capability_max_lifetime_seconds) VALUES ('cas_s', 'https://oauth.example', 'cas', 'https://oauth.example/.well-known/oauth-authorization-server', 'oauth', 'https://oauth.example/authorize', 'https://oauth.example/token', 'https://oauth.example/jwks', 'active', 'digest', 600)"),
      db!.prepare("INSERT INTO cas_stack_oauth_issuer_keys (stack_id, kid, algorithm, public_jwk, jwks_digest, activated_at) VALUES ('cas_s', 'oauth-k1', 'ES256', '{\"kty\":\"EC\"}', 'digest', 1)"),
    ]);
    expect(await repository.resolveIssuer("https://issuer.example")).toBeNull();
    expect(await repository.resolveIssuer("https://oauth.example")).toMatchObject({ stackId: "cas_s" });
  });
});