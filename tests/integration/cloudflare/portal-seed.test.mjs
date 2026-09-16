import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { seedPortalCatalog } from "../../../stacks/unidocs-cloudflare/local/portal-seed.mjs";

/**
 * The dev seed against a real portal worker, a real markdown Operator worker
 * and the real admin API: the only thing it writes directly is a seed
 * administrator session. Everything else — the draft, its contract, both
 * bundles, the Operator validation and the enable — has to get through the
 * same handlers an administrator's browser does, so an empty database ends up
 * with a markdown type tenants can actually create documents of.
 *
 * Two runtimes, each with its own database: one seeds from empty and then
 * again, the other resumes a seed that was cut off halfway.
 */

// Distinct from every other portal test block and from `pnpm dev portal`.
const PORTS = { gateway: 19487, markdown: 19488, admin: 19492, mockOidc: 19493, edge: 19494, portal: 19495, portalBundles: 19496 };
const RESUME_PORTS = { gateway: 19587, markdown: 19588, admin: 19592, mockOidc: 19593, edge: 19594, portal: 19595, portalBundles: 19596 };
const BOOTSTRAP_EMAIL = "portal-seed-owner@example.test";
const SEED_EMAIL = "seed@unidocs.local";
const LOCAL_TENANT_ID = "t-local";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function boot(ports, label) {
  // runtime.mjs keys its bundle directory by the gateway port and never cleans it.
  await rm(join(ROOT, ".wrangler", "local-bundles", String(ports.gateway)), { recursive: true, force: true });
  const persistPath = await mkdtemp(join(tmpdir(), `unidocs-portal-seed-${label}-`));
  const runtime = await startLocalRuntime({ docTypes: [], services: ["portal"], ports, persistPath, tenantDevSession: true });
  // The environment override is cleared above, but a developer's own
  // packages/cloudflare-portal/.dev.vars may still bind one, and the seed
  // rightly invites whatever is bound. Expected rows account for it, so the
  // assertions stay exact on a machine without one.
  const bound = (await runtime.mf.getBindings("unidocs-portal")).PORTAL_BOOTSTRAP_EMAIL;
  const fileBootstrapEmail = typeof bound === "string" && bound.trim() ? bound.trim().toLowerCase() : null;
  return { runtime, persistPath, fileBootstrapEmail };
}

const byEmail = (left, right) => (left.email < right.email ? -1 : left.email > right.email ? 1 : 0);

/** Always a fresh handle: the seed reconfigures Miniflare, which poisons old ones. */
async function count(runtime, table, where = "") {
  const db = await runtime.mf.getD1Database("DB", "unidocs-portal");
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).first("count");
}

async function tenantDocumentTypes(runtime) {
  const origin = runtime.urls.portal;
  const session = await fetch(`${origin}/portal/auth/session`);
  expect(session.status, "tenant session").toBe(200);
  const cookies = session.headers.getSetCookie().map(header => header.split(";")[0]);
  const response = await fetch(`${origin}/api/v1/tenants/t-local/document-types`, { headers: { cookie: cookies.join("; ") } });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text);
}

// An unrelated UNIDOCS_PORTAL_BOOTSTRAP_EMAIL in the developer's shell would
// otherwise add an invitation to the "empty database" rows below.
let previousBootstrapEmail;
beforeAll(() => {
  previousBootstrapEmail = process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL;
  delete process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL;
});
afterAll(() => {
  if (previousBootstrapEmail === undefined) delete process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL;
  else process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL = previousBootstrapEmail;
});

describe("seeding an empty portal database", () => {
  let runtime;
  let persistPath;
  let fileBootstrapEmail;
  let documentType;
  const lines = [];

  beforeAll(async () => {
    ({ runtime, persistPath, fileBootstrapEmail } = await boot(PORTS, "empty"));
  }, 180_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (persistPath) await rm(persistPath, { recursive: true, force: true });
  });

  test("returns the markdown type, which tenants can now create with contract 0", async () => {
    const result = await seedPortalCatalog(runtime, { log: line => lines.push(line) });
    expect(result.documentType).toMatch(/^dt-[0-9a-f-]{36}$/);
    documentType = result.documentType;
    expect(lines.length, "the seed says what it did").toBeGreaterThan(0);

    const catalog = await tenantDocumentTypes(runtime);
    expect(catalog.items.map(item => item.documentType)).toEqual([documentType]);
    expect(catalog.items[0].availableDocumentContractIdxs).toEqual([0]);

    // The Operator was pointed at the same type before it was validated.
    const descriptor = await fetch(`${runtime.urls.markdown}/.well-known/unidocs-operator`);
    expect(descriptor.status).toBe(200);
    expect((await descriptor.json()).supportedDocumentTypes).toEqual([documentType]);
  }, 120_000);

  test("leaves exactly the seed administrator, bound, and never claims the bootstrap", async () => {
    const db = await runtime.mf.getD1Database("DB", "unidocs-portal");
    const { results } = await db.prepare("SELECT email, issuer, subject, active FROM portal_administrators ORDER BY email").all();
    expect(results).toEqual([
      { email: SEED_EMAIL, issuer: "https://accounts.google.com", subject: "local-portal-seed", active: 1 },
      ...(fileBootstrapEmail ? [{ email: fileBootstrapEmail, issuer: null, subject: null, active: 1 }] : []),
    ].sort(byEmail));
    // Claiming it would lock the real bootstrap email out of local sign-in for good.
    expect(await count(runtime, "portal_bootstrap")).toBe(0);

    const members = await db.prepare("SELECT email FROM portal_tenant_members WHERE added_by != 'dev-session'").all();
    expect(members.results).toEqual(fileBootstrapEmail ? [{ email: fileBootstrapEmail }] : []);
  });

  test("a second run returns the same type and adds no rows, and invites a configured bootstrap email", async () => {
    const before = {
      types: await count(runtime, "portal_document_types"),
      operators: await count(runtime, "portal_operators"),
      views: await count(runtime, "portal_view_bundles"),
      cards: await count(runtime, "portal_type_card_bundles"),
      contracts: await count(runtime, "portal_document_contracts"),
    };
    expect(before).toEqual({ types: 1, operators: 1, views: 1, cards: 1, contracts: 1 });

    // Read by the runtime whenever it rebuilds the Miniflare options, which the
    // seed does when it points the Operator at the type — so this run's portal
    // sees it, the way a developer's `.dev.vars` would be seen on a boot.
    process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL = BOOTSTRAP_EMAIL;
    try {
      expect(await seedPortalCatalog(runtime)).toEqual({ documentType });
      // Once more: an invitation that already exists is not a failure.
      expect(await seedPortalCatalog(runtime)).toEqual({ documentType });
    } finally {
      delete process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL;
    }

    expect({
      types: await count(runtime, "portal_document_types"),
      operators: await count(runtime, "portal_operators"),
      views: await count(runtime, "portal_view_bundles"),
      cards: await count(runtime, "portal_type_card_bundles"),
      contracts: await count(runtime, "portal_document_contracts"),
    }).toEqual(before);

    const db = await runtime.mf.getD1Database("DB", "unidocs-portal");
    const { results } = await db.prepare("SELECT email, subject FROM portal_administrators ORDER BY email").all();
    expect(results).toEqual([
      { email: BOOTSTRAP_EMAIL, subject: null },
      { email: SEED_EMAIL, subject: "local-portal-seed" },
      ...(fileBootstrapEmail ? [{ email: fileBootstrapEmail, subject: null }] : []),
    ].sort(byEmail));
    expect(await count(runtime, "portal_bootstrap")).toBe(0);

    // The same account can then sign in to the tenant console, as a member of
    // the local tenant, instead of relying on the dev session switch.
    const members = await db.prepare("SELECT tenant_id, email, subject, active FROM portal_tenant_members WHERE added_by != 'dev-session' ORDER BY email").all();
    expect(members.results).toEqual([
      { tenant_id: LOCAL_TENANT_ID, email: BOOTSTRAP_EMAIL, subject: null, active: 1 },
      ...(fileBootstrapEmail ? [{ tenant_id: LOCAL_TENANT_ID, email: fileBootstrapEmail, subject: null, active: 1 }] : []),
    ].sort(byEmail));

    const catalog = await tenantDocumentTypes(runtime);
    expect(catalog.items.map(item => item.documentType)).toEqual([documentType]);
  }, 180_000);
});

describe("resuming a seed that stopped halfway", () => {
  let runtime;
  let persistPath;
  let fileBootstrapEmail;

  beforeAll(async () => {
    ({ runtime, persistPath, fileBootstrapEmail } = await boot(RESUME_PORTS, "resume"));
  }, 180_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (persistPath) await rm(persistPath, { recursive: true, force: true });
  });

  test("continues the existing draft instead of registering a second type", async () => {
    // Cut off exactly where the Operator has to be pointed at the new type:
    // the draft, its contract and both bundles exist, nothing is selected.
    const interrupted = {
      ...runtime,
      async setMarkdownOperatorDocumentType() { throw new Error("simulated interruption"); },
    };
    await expect(seedPortalCatalog(interrupted)).rejects.toThrow(/simulated interruption/);

    const db = await runtime.mf.getD1Database("DB", "unidocs-portal");
    const draft = await db.prepare("SELECT document_type, enabled FROM portal_document_types").all();
    expect(draft.results).toHaveLength(1);
    expect(draft.results[0].enabled).toBe(0);
    expect({
      contracts: await count(runtime, "portal_document_contracts"),
      cards: await count(runtime, "portal_type_card_bundles"),
      views: await count(runtime, "portal_view_bundles"),
      operators: await count(runtime, "portal_operators"),
    }).toEqual({ contracts: 1, cards: 1, views: 1, operators: 0 });

    const { documentType } = await seedPortalCatalog(runtime);
    expect(documentType).toBe(draft.results[0].document_type);
    expect({
      types: await count(runtime, "portal_document_types"),
      enabled: await count(runtime, "portal_document_types", "WHERE enabled = 1"),
      contracts: await count(runtime, "portal_document_contracts"),
      cards: await count(runtime, "portal_type_card_bundles"),
      views: await count(runtime, "portal_view_bundles"),
      operators: await count(runtime, "portal_operators"),
    }).toEqual({ types: 1, enabled: 1, contracts: 1, cards: 1, views: 1, operators: 1 });
    // One seed administrator, reused rather than minted again.
    expect(await count(runtime, "portal_administrators", "WHERE subject IS NOT NULL")).toBe(1);
    expect(await count(runtime, "portal_administrators")).toBe(fileBootstrapEmail ? 2 : 1);

    const catalog = await tenantDocumentTypes(runtime);
    expect(catalog.items.map(item => item.documentType)).toEqual([documentType]);
    expect(catalog.items[0].availableDocumentContractIdxs).toEqual([0]);
  }, 180_000);
});
