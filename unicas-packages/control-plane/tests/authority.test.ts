import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { migrateControlSchema, AuthorityRepository } from "../src/index.js";

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
      name: "authority-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "authority-test-db" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "authority-test");
  await migrateControlSchema(db);
  await db.batch([
    db.prepare("INSERT INTO cas_stack_issuer (stack_id, issuer, audience, revision) VALUES ('cas_s', 'https://issuer.example', 'unidocs-cas', 1)"),
    db.prepare("INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state, revision) VALUES ('cas_s', 'k1', 'ES256', '{\"kty\":\"EC\"}', 'active', 1)"),
    db.prepare("INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state, revision) VALUES ('cas_s', 'k2', 'ES256', '{\"kty\":\"EC\"}', 'retiring', 1)"),
    db.prepare("INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state, revision) VALUES ('cas_s', 'k3', 'ES256', '{\"kty\":\"EC\"}', 'revoked', 1)"),
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
});
