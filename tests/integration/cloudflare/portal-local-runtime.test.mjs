import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

/**
 * The portal half of `startLocalRuntime({ services })`. Everything here is
 * observed from a real Miniflare boot, because that is the only place the
 * pieces meet: `resolvePorts`/`bundleTargets`/`buildWorkers` are threaded in
 * runtime.mjs, the `node:*` external branch lives in `bundleWorker`, and the
 * D1 schema is applied by `migrateServiceDb` after `mf.ready`. Each of those
 * can be deleted without any unit test noticing.
 */

const PORTS = { gateway: 19187, admin: 19192, mockOidc: 19193, edge: 19194, portal: 19195 };
const BOOTSTRAP_EMAIL = "portal-bootstrap@example.test";

/** Every table the portal's two committed migrations declare. */
const PORTAL_TABLES = [
  "portal_admin_audit",
  "portal_administrators",
  "portal_auth_audit",
  "portal_bootstrap",
  "portal_document_types",
  "portal_idempotency_receipts",
  "portal_login_transactions",
  "portal_mutation_guard",
  "portal_session_families",
  "portal_sessions",
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let persistPath;
let previousBootstrapEmail;

beforeAll(async () => {
  // runtime.mjs keys its bundle directory by the gateway port, and never
  // cleans it. Drop this run's directory so a stale portal.js from an earlier
  // run cannot stand in for one `bundleTargets` failed to declare.
  await rm(join(ROOT, ".wrangler", "local-bundles", String(PORTS.gateway)), { recursive: true, force: true });
  persistPath = await mkdtemp(join(tmpdir(), "unidocs-portal-runtime-"));
  previousBootstrapEmail = process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL;
  process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL = BOOTSTRAP_EMAIL;
});

afterAll(() => {
  if (previousBootstrapEmail === undefined) delete process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL;
  else process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL = previousBootstrapEmail;
});

async function tableNames(db) {
  const result = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  return (result.results ?? []).map(row => row.name);
}

describe("a fresh portal database", () => {
  let runtime;
  let db;

  beforeAll(async () => {
    runtime = await startLocalRuntime({
      docTypes: [],
      services: ["portal"],
      ports: PORTS,
      persistPath,
    });
    db = await runtime.mf.getD1Database("DB", "unidocs-portal");
  }, 180_000);

  afterAll(async () => {
    await runtime?.dispose();
  });

  // Drops `services` from the `resolvePorts` call in runtime.mjs and this is
  // undefined — the brief's stated deliverable.
  test("exposes the portal's own URL", () => {
    expect(runtime.urls.portal).toBe(`http://127.0.0.1:${PORTS.portal}`);
  });

  // This is the assertion finding 1 was missing. `db.exec()` splits on
  // newlines, so every multi-line CREATE TABLE in the portal's migrations
  // threw `incomplete input` and no table was ever created.
  test("has every table its committed migrations declare", async () => {
    const names = await tableNames(db);
    for (const table of PORTAL_TABLES) expect(names).toContain(table);
  });

  test("applied both migration files, in filename order", async () => {
    const ledger = await db.prepare(
      "SELECT name FROM _unidocs_service_migrations ORDER BY name",
    ).all();
    expect((ledger.results ?? []).map(row => row.name)).toEqual([
      "0001_admin_auth.sql",
      "0002_document_types.sql",
    ]);
    // 0002 ALTERs a table 0001 creates, so these columns only exist if the
    // files ran in order and every statement inside them was applied.
    const columns = await db.prepare("PRAGMA table_info(portal_admin_audit)").all();
    const columnNames = (columns.results ?? []).map(column => column.name);
    expect(columnNames).toContain("document_type");
    expect(columnNames).toContain("reason");
    expect(columnNames).toContain("details_json");
  });

  // Reaches the worker over its own socket: without `unsafeDirectSockets`
  // nothing listens here, and without the portal's bundle target there is no
  // script to serve. A 5xx would mean the placeholder Google credentials were
  // dropped — worker.ts answers `portal_unavailable` when the config is
  // incomplete, not a redirect.
  test("serves a sign-in redirect on its own port", async () => {
    const response = await fetch(`${runtime.urls.portal}/admin/auth/login`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location") ?? "").toMatch(/^https:\/\/accounts\.google\.com\//);
    await response.body?.cancel();
  });

  // The bindings runtime.mjs threads in, read back off the running worker.
  test("binds the origin and the bootstrap email the runtime supplied", async () => {
    const bindings = await runtime.mf.getBindings("unidocs-portal");
    expect(bindings.PORTAL_ORIGIN).toBe(`http://127.0.0.1:${PORTS.portal}`);
    expect(bindings.PORTAL_BOOTSTRAP_EMAIL).toBe(BOOTSTRAP_EMAIL);
    expect(bindings.GATEWAY_OIDC_ISSUER).toBe("https://accounts.google.com");
    expect(bindings.GATEWAY_OIDC_CLIENT_ID).not.toBe("");
    expect(bindings.GATEWAY_OIDC_CLIENT_SECRET).not.toBe("");
  });
});

describe("a second boot on the same portal database", () => {
  // Without the ledger's skip-if-already-applied branch this throws
  // "table portal_administrators already exists" and the whole boot rejects.
  test("skips the migrations it already applied", async () => {
    const runtime = await startLocalRuntime({
      docTypes: [],
      services: ["portal"],
      ports: PORTS,
      persistPath,
    });
    try {
      const db = await runtime.mf.getD1Database("DB", "unidocs-portal");
      const ledger = await db.prepare(
        "SELECT name, applied_at FROM _unidocs_service_migrations ORDER BY name",
      ).all();
      expect((ledger.results ?? []).map(row => row.name)).toEqual([
        "0001_admin_auth.sql",
        "0002_document_types.sql",
      ]);
      const names = await tableNames(db);
      for (const table of PORTAL_TABLES) expect(names).toContain(table);
    } finally {
      await runtime.dispose();
    }
  }, 180_000);
});
