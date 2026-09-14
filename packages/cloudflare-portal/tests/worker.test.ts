import { expect, test, vi } from "vitest";
import worker from "../src/worker.js";
import { ADMIN_MCP_PATHS } from "../src/mcp/dispatcher.js";
import { hashSessionSecret } from "../src/auth.js";

test("Worker fails closed before touching D1 when Google credentials are absent", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => { });
  try {
    const env = {
      get BUNDLES(): never { throw new Error("Bundle storage must not be touched"); },
      get DB(): never { throw new Error("Database must not be touched"); },
      get ADMIN_MARKDOWN_SERVICE(): never { throw new Error("Operator service must not be touched"); },
      get MARKDOWN_OPERATOR_HMAC_KEY(): never { throw new Error("Operator key must not be touched"); },
      PORTAL_ORIGIN: "https://unidocs.shazhou.work",
      BUNDLE_ORIGIN: "https://bundles.shazhou.work",
      GATEWAY_OIDC_ISSUER: "https://accounts.google.com",
      GATEWAY_OIDC_CLIENT_ID: "",
      GATEWAY_OIDC_CLIENT_SECRET: "sensitive-fixture-secret",
      PORTAL_BOOTSTRAP_EMAIL: "",
      MCP_ENABLED: "false",
      MCP_PUBLIC_ORIGIN: "https://unidocs.shazhou.work",
      MCP_ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
      MCP_CONTENT_MUTATIONS_ENABLED: "false",
      MCP_PUBLISH_MUTATIONS_ENABLED: "false",
      MCP_SECURITY_MUTATIONS_ENABLED: "false",
      OAUTH_STATE_ENCRYPTION_KEY: "unused-disabled-fixture",
      get OAUTH_KV(): never { throw new Error("OAuth KV must not be touched"); },
      get CAS_ORIGIN(): never { throw new Error("CAS must not be touched"); },
      get CAS_STACK_ID(): never { throw new Error("CAS must not be touched"); },
      get CAS_ISSUER(): never { throw new Error("CAS must not be touched"); },
      get CAS_AUDIENCE(): never { throw new Error("CAS must not be touched"); },
      get CAS_REF_DOMAIN(): never { throw new Error("CAS must not be touched"); },
      get CAS_SIGNING_KID(): never { throw new Error("CAS must not be touched"); },
      get CAS_SIGNING_KEY(): never { throw new Error("CAS must not be touched"); },
    };
    const response = await worker.fetch(new Request("https://unidocs.shazhou.work/admin/auth/login?code=never-log-this"), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("Administrator service is unavailable");
    expect(body).not.toContain("sensitive-fixture-secret");
    expect(body).not.toContain("Database");
    expect(JSON.stringify(log.mock.calls)).not.toContain("never-log-this");
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-fixture-secret");
  } finally {
    log.mockRestore();
  }
});

test.each(ADMIN_MCP_PATHS)("Worker MCP kill switch runs before Google credentials or bindings: %s", async path => {
  const env: Env = {
    MCP_ENABLED: "false", MCP_PUBLIC_ORIGIN: "https://unidocs.shazhou.work",
    MCP_ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
    MCP_CONTENT_MUTATIONS_ENABLED: "false", MCP_PUBLISH_MUTATIONS_ENABLED: "false", MCP_SECURITY_MUTATIONS_ENABLED: "false",
    OAUTH_STATE_ENCRYPTION_KEY: "unused-disabled-fixture",
    get OAUTH_KV(): never { throw new Error("Unexpected OAuth KV access"); },
    get DB(): never { throw new Error("Unexpected D1 access"); },
    get BUNDLES(): never { throw new Error("Unexpected R2 access"); },
    get BUNDLE_ORIGIN(): never { throw new Error("Unexpected bundle dispatch"); },
    get PORTAL_ORIGIN(): never { throw new Error("Unexpected Admin configuration"); },
    get GATEWAY_OIDC_ISSUER(): never { throw new Error("Unexpected Google configuration"); },
    get GATEWAY_OIDC_CLIENT_ID(): never { throw new Error("Unexpected Google configuration"); },
    get GATEWAY_OIDC_CLIENT_SECRET(): never { throw new Error("Unexpected Google secret"); },
    get PORTAL_BOOTSTRAP_EMAIL(): never { throw new Error("Unexpected bootstrap"); },
    get MARKDOWN_OPERATOR_HMAC_KEY(): never { throw new Error("Unexpected Operator secret"); },
    get ADMIN_MARKDOWN_SERVICE(): never { throw new Error("Unexpected service binding"); },
    get CAS_ORIGIN(): never { throw new Error("Unexpected CAS access"); },
    get CAS_STACK_ID(): never { throw new Error("Unexpected CAS access"); },
    get CAS_ISSUER(): never { throw new Error("Unexpected CAS access"); },
    get CAS_AUDIENCE(): never { throw new Error("Unexpected CAS access"); },
    get CAS_REF_DOMAIN(): never { throw new Error("Unexpected CAS access"); },
    get CAS_SIGNING_KID(): never { throw new Error("Unexpected CAS access"); },
    get CAS_SIGNING_KEY(): never { throw new Error("Unexpected CAS access"); },
  };
  const response = await worker.fetch(new Request("https://unidocs.shazhou.work" + path), env);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  env.MCP_ENABLED = "true";
  expect((await worker.fetch(new Request("https://unidocs.shazhou.work" + path), env)).status).toBe(503);
});

// The bug this guards: `pnpm dev portal` binds neither ADMIN_MARKDOWN_SERVICE
// nor MARKDOWN_OPERATOR_HMAC_KEY (there is no markdown worker running for a
// service binding to target), and the worker used to build the Markdown
// Operator validation target unconditionally on every request. That 503'd
// the whole portal -- tenant console and admin sign-in included -- even
// though neither touches operator validation. The fix must not even read
// these two bindings for a request that never reaches the operator
// validation endpoints.
function baseEnvWithoutOperatorConfig() {
  return {
    DB: {},
    BUNDLES: {},
    get ADMIN_MARKDOWN_SERVICE(): never { throw new Error("Operator service must not be touched"); },
    get MARKDOWN_OPERATOR_HMAC_KEY(): never { throw new Error("Operator key must not be touched"); },
    PORTAL_ORIGIN: "http://127.0.0.1:19195",
    BUNDLE_ORIGIN: "http://127.0.0.1:19196",
    GATEWAY_OIDC_ISSUER: "https://accounts.google.com",
    GATEWAY_OIDC_CLIENT_ID: "fixture-client-id",
    GATEWAY_OIDC_CLIENT_SECRET: "fixture-client-secret",
    PORTAL_BOOTSTRAP_EMAIL: "",
    MCP_ENABLED: "false",
    MCP_PUBLIC_ORIGIN: "http://127.0.0.1:19195",
    MCP_ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
    MCP_CONTENT_MUTATIONS_ENABLED: "false",
    MCP_PUBLISH_MUTATIONS_ENABLED: "false",
    MCP_SECURITY_MUTATIONS_ENABLED: "false",
    OAUTH_STATE_ENCRYPTION_KEY: "unused-disabled-fixture",
    OAUTH_KV: {},
  };
}

test("Worker serves a normal admin path without touching the Markdown Operator bindings", async () => {
  const env = baseEnvWithoutOperatorConfig() as unknown as Env;
  const response = await worker.fetch(new Request("http://127.0.0.1:19195/admin/login"), env);
  expect(response.status).not.toBe(503);
  expect(response.status).toBe(200);
});

test("Worker serves the tenant WebUI without touching the Markdown Operator bindings", async () => {
  const env = baseEnvWithoutOperatorConfig() as unknown as Env;
  const response = await worker.fetch(new Request("http://127.0.0.1:19195/portal/"), env);
  expect(response.status).not.toBe(503);
  expect(response.status).toBe(200);
});

test("Worker reports the Markdown Operator as deliberately unconfigured, not a whole-portal failure", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = "a".repeat(43);
  const sessionHash = await hashSessionSecret(token);
  const identity = { issuer: "https://accounts.google.com", subject: "subject-1", email: "admin@example.test", authenticatedAt: now };
  const sessionRow = {
    session_hash: sessionHash, csrf_hash: "unused-csrf-hash", identity_json: JSON.stringify(identity),
    created_at: now - 10, expires_at: now + 1_000, member_id: "member-1", issuer: identity.issuer, subject: identity.subject,
  };
  const memberRow = { member_id: "member-1", issuer: identity.issuer, subject: identity.subject, active: 1 };
  const fakeDb = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM portal_sessions")) return sessionRow;
              if (sql.includes("FROM portal_administrators WHERE member_id")) return memberRow;
              return null;
            },
          };
        },
      };
    },
  };
  const env = {
    DB: fakeDb, BUNDLES: {}, ADMIN_MARKDOWN_SERVICE: {}, MARKDOWN_OPERATOR_HMAC_KEY: "",
    PORTAL_ORIGIN: "http://127.0.0.1:19195", BUNDLE_ORIGIN: "http://127.0.0.1:19196",
    GATEWAY_OIDC_ISSUER: "https://accounts.google.com", GATEWAY_OIDC_CLIENT_ID: "fixture-client-id", GATEWAY_OIDC_CLIENT_SECRET: "fixture-client-secret",
    PORTAL_BOOTSTRAP_EMAIL: "", MCP_ENABLED: "false", MCP_PUBLIC_ORIGIN: "http://127.0.0.1:19195", MCP_ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
    MCP_CONTENT_MUTATIONS_ENABLED: "false", MCP_PUBLISH_MUTATIONS_ENABLED: "false", MCP_SECURITY_MUTATIONS_ENABLED: "false",
    OAUTH_STATE_ENCRYPTION_KEY: "unused-disabled-fixture", OAUTH_KV: {},
  } as unknown as Env;
  const response = await worker.fetch(new Request("http://127.0.0.1:19195/admin/api/v1/operator-validations", {
    headers: { Cookie: `__Host-unidocs_admin=${token}` },
  }), env);
  expect(response.status).toBe(503);
  const body = await response.json() as { error: { code: string } };
  expect(body.error.code).toBe("operator_not_configured");
});