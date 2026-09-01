/**
 * Provision the deployed CAS middleware: schema + first stack registration.
 *
 * Generates the two stack issuer keypairs (unidocs-cloudflare,
 * unidocs-azure), writes the private keys under `.wrangler/cas-deploy/`
 * (gitignored — NEVER commit), and emits two SQL files:
 *   - cas-control-seed.sql : CAS_CONTROL_DB schema + stack/issuer/key/refDomain rows
 *   - cas-tenant-schema.sql: tenant D1 stack-scoped schema
 *
 * Apply with:
 *   pnpm exec wrangler d1 execute unidocs-cas-control --remote --file cas-control-seed.sql
 *   pnpm exec wrangler d1 execute unidocs-cas-db      --remote --file cas-tenant-schema.sql
 *
 * Bootstrap note: initial stack registration is seeded directly because no
 * operator exists yet; key rotation and further memberships go through the
 * admin console's possession-proof flow afterwards.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { CONTROL_SCHEMA_MIGRATIONS } from "../unicas-packages/service-cloudflare/dist/control-schema.js";
import { STACK_TENANT_SCHEMA_MIGRATIONS } from "../unicas-packages/service-cloudflare/dist/schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, ".wrangler", "cas-deploy");

const now = Date.now();
const stacks = [
  {
    stackId: "unidocs-cloudflare",
    displayName: "UniDocs Cloudflare",
    issuer: "https://unicas.shazhou.work/cas/issuer/cloudflare",
    audience: "unidocs-cas-cloudflare",
    kid: "cf-rotate-1",
    refDomains: ["doc", "asset"],
  },
  {
    stackId: "unidocs-azure",
    displayName: "UniDocs Azure",
    issuer: "https://unicas.shazhou.work/cas/issuer/azure",
    audience: "unidocs-cas-azure",
    kid: "az-rotate-1",
    refDomains: ["doc", "asset"],
  },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const stackRows = [];
  const issuerRows = [];
  const keyRows = [];
  const keyPaths = [];

  for (const stack of stacks) {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privatePkcs8 = await exportPKCS8(privateKey);
    const keyPath = join(OUT_DIR, `${stack.stackId}.pkcs8.pem`);
    await writeFile(keyPath, privatePkcs8);
    keyPaths.push(`${stack.stackId} -> ${keyPath}`);

    stackRows.push(
      `INSERT OR IGNORE INTO cas_stacks (stack_id, display_name, status, created_at, revision) VALUES ('${stack.stackId}', '${stack.displayName}', 'active', ${now}, 1);`,
    );
    issuerRows.push(
      `INSERT OR IGNORE INTO cas_stack_issuer (stack_id, issuer, audience, status, revision) VALUES ('${stack.stackId}', '${stack.issuer}', '${stack.audience}', 'active', 1);`,
    );
    keyRows.push(
      `INSERT OR IGNORE INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state, revision) VALUES ('${stack.stackId}', '${stack.kid}', 'ES256', '${JSON.stringify(publicJwk)}', 'active', 1);`,
    );
    console.log(`stack ${stack.stackId}: issuer=${stack.issuer} audience=${stack.audience} kid=${stack.kid}`);
  }

  const controlSql = [
    ...CONTROL_SCHEMA_MIGRATIONS.map((sql) => `${sql};`),
    ...stackRows,
    ...issuerRows,
    ...keyRows,
  ].join("\n");
  await writeFile(join(OUT_DIR, "cas-control-seed.sql"), controlSql);

  const tenantSql = STACK_TENANT_SCHEMA_MIGRATIONS.map((sql) => `${sql};`).join("\n");
  await writeFile(join(OUT_DIR, "cas-tenant-schema.sql"), tenantSql);

  console.log("\nprivate keys:");
  for (const line of keyPaths) console.log(`  ${line}`);
  console.log(`\nSQL files written to ${OUT_DIR}`);
  console.log("  apply: wrangler d1 execute unidocs-cas-control --remote --file cas-control-seed.sql");
  console.log("  apply: wrangler d1 execute unidocs-cas-db      --remote --file cas-tenant-schema.sql");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
