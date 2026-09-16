import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

/**
 * The tenant data plane on a real portal worker: session issue, cookie
 * authentication, CSRF, the tenant API adapter over real D1, and logout, all
 * reached over the worker's own socket. The unit tests prove each handler in
 * isolation; only a real boot proves `worker.ts` actually routes to them, ahead
 * of the admin BFF, with the bindings `startLocalRuntime` supplies.
 *
 * The steps share one runtime and one database and run in order: each one
 * depends on the state the previous one left behind.
 */

// Distinct from portal-local-runtime.test.mjs's block and from `pnpm dev portal`.
const PORTS = { gateway: 19287, markdown: 19288, admin: 19292, mockOidc: 19293, edge: 19294, portal: 19295, portalBundles: 19296 };
const ORIGIN = `http://127.0.0.1:${PORTS.portal}`;
const SESSION_COOKIE = "__Host-unidocs_tenant";
const CSRF_COOKIE = "__Host-unidocs_tenant_csrf";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function cookieValue(response, name) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const index = pair.indexOf("=");
    if (pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return null;
}

function expectTenantHeaders(response, step) {
  expect(response.headers.get("cache-control"), step).toBe("no-store");
  expect(response.headers.get("x-request-id"), step).toMatch(/\S/);
  expect(response.headers.get("x-content-type-options"), step).toBe("nosniff");
  expect(response.headers.get("referrer-policy"), step).toBe("no-referrer");
  expect(response.headers.get("content-security-policy"), step).toBe("default-src 'none'; frame-ancestors 'none'");
}

describe("the tenant data plane on a real portal worker", () => {
  let runtime;
  let persistPath;
  let token;
  let csrf;
  let documentId;

  const withCookie = (headers = {}) => ({ cookie: `${SESSION_COOKIE}=${token}`, ...headers });
  const writeHeaders = (headers = {}) => withCookie({
    origin: ORIGIN, "content-type": "application/json", "idempotency-key": "create-doc-1", ...headers,
  });
  const createBody = JSON.stringify({ documentType: "markdown", name: "Tenant API e2e" });

  beforeAll(async () => {
    // Same reason as portal-local-runtime.test.mjs: runtime.mjs keys its bundle
    // directory by the gateway port and never cleans it.
    await rm(join(ROOT, ".wrangler", "local-bundles", String(PORTS.gateway)), { recursive: true, force: true });
    persistPath = await mkdtemp(join(tmpdir(), "unidocs-portal-tenant-api-"));
    runtime = await startLocalRuntime({ docTypes: [], services: ["portal"], ports: PORTS, persistPath, tenantDevSession: true });
  }, 180_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (persistPath) await rm(persistPath, { recursive: true, force: true });
  });

  test("binds the origin the requests below claim", async () => {
    const bindings = await runtime.mf.getBindings("unidocs-portal");
    expect(bindings.PORTAL_ORIGIN).toBe(ORIGIN);
    expect(runtime.urls.portal).toBe(ORIGIN);
  });

  test("1. GET /portal/auth/session issues the local session", async () => {
    const response = await fetch(`${ORIGIN}/portal/auth/session`);
    expect(response.status, "step 1 status").toBe(200);
    expect(await response.json(), "step 1 body").toEqual({ tenantId: "t-local", principalId: "user-local" });
    expect(response.headers.getSetCookie(), "step 1 cookies").toHaveLength(2);
    expectTenantHeaders(response, "step 1 headers");
    token = cookieValue(response, SESSION_COOKIE);
    csrf = cookieValue(response, CSRF_COOKIE);
    expect(token, "step 1 session token").toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrf, "step 1 csrf token").toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("2. GET documents without a cookie is 401", async () => {
    const response = await fetch(`${ORIGIN}/api/v1/tenants/t-local/documents`);
    expect(response.status, "step 2 status").toBe(401);
    expect((await response.json()).error.code, "step 2 code").toBe("unauthorized");
    expectTenantHeaders(response, "step 2 headers");
  });

  test("3. GET documents with the cookie is an empty page", async () => {
    const response = await fetch(`${ORIGIN}/api/v1/tenants/t-local/documents`, { headers: withCookie() });
    expect(response.status, "step 3 status").toBe(200);
    expect(await response.json(), "step 3 body").toEqual({ items: [], nextCursor: null });
    expectTenantHeaders(response, "step 3 headers");
  });

  test("4. POST documents without x-csrf-token is 403", async () => {
    const response = await fetch(`${ORIGIN}/api/v1/tenants/t-local/documents`, {
      method: "POST", headers: writeHeaders(), body: createBody,
    });
    expect(response.status, "step 4 status").toBe(403);
    expect((await response.json()).error.code, "step 4 code").toBe("forbidden");
    expectTenantHeaders(response, "step 4 headers");
  });

  test("5. POST documents with the csrf token, markdown not enabled, is 409", async () => {
    const response = await fetch(`${ORIGIN}/api/v1/tenants/t-local/documents`, {
      method: "POST", headers: writeHeaders({ "x-csrf-token": csrf }), body: createBody,
    });
    expect(response.status, "step 5 status").toBe(409);
    expect((await response.json()).error.code, "step 5 code").toBe("document_type_disabled");
  });

  test("6. POST documents once markdown is enabled is 201", async () => {
    const db = await runtime.mf.getD1Database("DB", "unidocs-portal");
    await db.prepare(
      "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, 1, ?, ?)",
    ).bind("markdown", "markdown", "{}", new Date().toISOString()).run();
    const response = await fetch(`${ORIGIN}/api/v1/tenants/t-local/documents`, {
      method: "POST", headers: writeHeaders({ "x-csrf-token": csrf }), body: createBody,
    });
    expect(response.status, "step 6 status").toBe(201);
    const body = await response.json();
    expect(body.currentVersionIdx, "step 6 currentVersionIdx").toBeNull();
    expect(body.documentType, "step 6 documentType").toBe("markdown");
    documentId = body.documentId;
    expect(documentId, "step 6 documentId").toBeTruthy();
    expectTenantHeaders(response, "step 6 headers");
  });

  test("7. GET documents lists exactly the created document", async () => {
    const response = await fetch(`${ORIGIN}/api/v1/tenants/t-local/documents`, { headers: withCookie() });
    expect(response.status, "step 7 status").toBe(200);
    const body = await response.json();
    expect(body.items, "step 7 items").toHaveLength(1);
    expect(body.items[0].documentId, "step 7 documentId").toBe(documentId);
  });

  test("8. GET another tenant's documents is 403", async () => {
    const response = await fetch(`${ORIGIN}/api/v1/tenants/t-other/documents`, { headers: withCookie() });
    expect(response.status, "step 8 status").toBe(403);
    expect((await response.json()).error.code, "step 8 code").toBe("forbidden");
  });

  // The snapshot route is the only one that needs CAS. With no version there
  // is nothing to read, so a 503 here would mean CAS was built (and failed)
  // before the route ever looked for the version.
  test("9. GET a snapshot of a version-less document is 404, not a CAS 503", async () => {
    const response = await fetch(`${ORIGIN}/api/v1/tenants/t-local/documents/${documentId}/versions/0/snapshot`, { headers: withCookie() });
    expect(response.status, "step 9 status").toBe(404);
    expect((await response.json()).error.code, "step 9 code").toBe("not_found");
    expectTenantHeaders(response, "step 9 headers");
  });

  test("10. the admin BFF still answers /admin/auth/session", async () => {
    const response = await fetch(`${ORIGIN}/admin/auth/session`);
    expect(response.status, "step 10 status").toBe(401);
    await response.body?.cancel();
  });

  test("11. POST /portal/auth/logout revokes the session", async () => {
    const response = await fetch(`${ORIGIN}/portal/auth/logout`, {
      method: "POST", headers: withCookie({ origin: ORIGIN, "x-csrf-token": csrf }),
    });
    expect(response.status, "step 11 status").toBe(204);
    expectTenantHeaders(response, "step 11 headers");
    const after = await fetch(`${ORIGIN}/api/v1/tenants/t-local/documents`, { headers: withCookie() });
    expect(after.status, "step 11 revoked session").toBe(401);
    await after.body?.cancel();
  });
});
