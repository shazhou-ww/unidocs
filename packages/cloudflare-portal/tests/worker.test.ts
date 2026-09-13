import { expect, test, vi } from "vitest";
import worker from "../src/worker.js";
import { ADMIN_MCP_PATHS } from "../src/mcp/dispatcher.js";

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
  };
  const response = await worker.fetch(new Request("https://unidocs.shazhou.work" + path), env);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  env.MCP_ENABLED = "true";
  expect((await worker.fetch(new Request("https://unidocs.shazhou.work" + path), env)).status).toBe(503);
});