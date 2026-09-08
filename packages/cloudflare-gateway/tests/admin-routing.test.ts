import { expect, it, vi } from "vitest";
import { routeAdmin } from "../src/admin-routing.js";

it("fails closed without opt-in and never routes tenant traffic into management", async () => {
  expect((await routeAdmin(new Request("https://app.test/admin/"), {}))!.status).toBe(404);
  expect(await routeAdmin(new Request("https://app.test/tenants/alice/docs/markdown/"), {})).toBeNull();
  expect(await routeAdmin(new Request("https://app.test/oauth/unidocs-cloudflare/login"), { GATEWAY_OIDC_REDIRECT_PATH: "/oauth/unidocs-cloudflare/login/callback" })).toBeNull();
});

it("routes shared Google login and management requests to one control object, without CORS", async () => {
  const fetch = vi.fn(async () => Response.json({ handled: true }));
  const idFromName = vi.fn(() => "control");
  const env = {
    UNIDOCS_ADMIN_ENABLED: "1", GATEWAY_PUBLIC_ORIGIN: "https://app.test", GATEWAY_OIDC_REDIRECT_PATH: "/oauth/unidocs-cloudflare/login/callback",
    UNIDOCS_ADMIN: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace
  };
  for (const path of ["/admin/api/v1/session", "/admin/auth/session", "/oauth/unidocs-cloudflare/login", "/oauth/unidocs-cloudflare/login/callback"]) {
    const request = new Request(`https://app.test${path}`);
    expect((await routeAdmin(request, env))!.status).toBe(200);
    expect(fetch).toHaveBeenLastCalledWith(request);
  }
  expect(idFromName).toHaveBeenCalledWith("unidocs-management-v1");
  expect((await routeAdmin(new Request("https://other.test/admin/api/v1/session"), env))!.status).toBe(403);
  expect((await routeAdmin(new Request("https://app.test/admin/_test/bootstrap"), env))!.status).toBe(404);
  const ui = (await routeAdmin(new Request("https://app.test/admin/"), env))!;
  expect(ui.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(ui.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(ui.headers.get("Cache-Control")).toBe("no-store");
});