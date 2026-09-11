import { expect, test, vi } from "vitest";
import worker from "../src/worker.js";

test("Worker fails closed before touching D1 when Google credentials are absent", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => { });
  try {
    const env = {
      get BUNDLES(): never { throw new Error("Bundle storage must not be touched"); },
      get DB(): never { throw new Error("Database must not be touched"); },
      PORTAL_ORIGIN: "https://unidocs.shazhou.work",
      BUNDLE_ORIGIN: "https://bundles.shazhou.work",
      GATEWAY_OIDC_ISSUER: "https://accounts.google.com",
      GATEWAY_OIDC_CLIENT_ID: "",
      GATEWAY_OIDC_CLIENT_SECRET: "sensitive-fixture-secret",
      PORTAL_BOOTSTRAP_EMAIL: "",
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