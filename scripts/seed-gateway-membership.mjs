/**
 * Seed a Gateway OAuth tenant membership (gateway_oauth_tenant_memberships)
 * for a user identified by their upstream OIDC subject (`sub`), which the
 * gateway logs as the `gateway_oauth_login` event on first login.
 *
 * Usage:
 *   node scripts/seed-gateway-membership.mjs <principalId> <tenantId> [scope,scope,...]
 *
 * Example:
 *   node scripts/seed-gateway-membership.mjs 114480311189012345678 alice cas:read,cas:write,cas:manage
 */
import { execFileSync } from "node:child_process";

const [principalId, tenantId, scopesCsv = "cas:read,cas:write,cas:manage"] = process.argv.slice(2);
if (!principalId || !tenantId) {
  console.error("Usage: node scripts/seed-gateway-membership.mjs <principalId> <tenantId> [scope,scope,...]");
  process.exit(1);
}
const scopes = scopesCsv.split(",").map((value) => value.trim()).filter(Boolean);
for (const scope of scopes) {
  if (!["cas:read", "cas:write", "cas:manage"].includes(scope)) {
    console.error(`Invalid scope: ${scope}`);
    process.exit(1);
  }
}

const now = Math.floor(Date.now() / 1000);
const sql = `INSERT INTO gateway_oauth_tenant_memberships (principal_id, tenant_id, scopes_json, ref_domain, created_at, updated_at)
VALUES ('${principalId}', '${tenantId}', '${JSON.stringify(scopes)}', 'doc', ${now}, ${now})
ON CONFLICT (principal_id, tenant_id) DO UPDATE SET
  scopes_json = excluded.scopes_json,
  ref_domain = excluded.ref_domain,
  updated_at = excluded.updated_at;`;

console.log(`Seeding membership: principal=${principalId} tenant=${tenantId} scopes=[${scopes.join(", ")}] refDomain=doc`);
execFileSync("pnpm", [
  "--filter", "@unidocs/cloudflare-gateway",
  "exec", "wrangler", "d1", "execute", "unidocs-snapshots", "--remote", "--command", sql,
], { stdio: "inherit", env: { ...process.env, CI: "true" }, shell: process.platform === "win32" });
console.log("Membership seeded.");
