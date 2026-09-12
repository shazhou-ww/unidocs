import { expect, test, vi } from "vitest";
import { ADMIN_MCP_BODY_MAX_BYTES, ADMIN_MCP_OAUTH_BODY_MAX_BYTES, ADMIN_MCP_PATHS, dispatchAdminMcp } from "../src/mcp/dispatcher.js";

const publicOrigin = "https://unidocs.shazhou.work";
const cookies = "__Host-unidocs_admin=admin-secret; __Host-unidocs_admin_csrf=csrf-secret; __Host-unidocs_admin_mcp_oauth=oauth-state; __Host-unidocs_admin_mcp_consent=consent-state; other=unrelated";

test.each(ADMIN_MCP_PATHS)("disabled surface returns secure 404 without downstream access: %s", async path => {
  const handler = vi.fn(async () => new Response("unexpected"));
  const response = await dispatchAdminMcp(new Request(publicOrigin + path, { headers: { cookie: cookies } }), { publicOrigin, enabled: false, handler });
  expect(response?.status).toBe(404);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(response?.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(handler).not.toHaveBeenCalled();
});

test.each(["/admin/", "/oauth/unidocs-cloudflare/token", "/oauth/admin-mcp/unknown", "/mcp/", "/mcp-other", "/.well-known/oauth-protected-resource", "/oauth/admin-mcp/token/", "/oauth/admin-mcp/%74oken"])("does not take over other paths: %s", async path => {
  expect(await dispatchAdminMcp(new Request(publicOrigin + path), { publicOrigin, enabled: true })).toBeNull();
});

test.each(ADMIN_MCP_PATHS)("strips cross-surface credentials in both directions: %s", async path => {
  const browser = path.endsWith("/authorize") || path.endsWith("/callback");
  const handler = vi.fn(async (request: Request) => {
    expect(request.headers.get("Cookie")).toBe(browser ? "__Host-unidocs_admin_mcp_oauth=oauth-state; __Host-unidocs_admin_mcp_consent=consent-state" : null);
    expect(request.headers.get("X-CSRF-Token")).toBeNull();
    const headers = new Headers({ "Cache-Control": "public", "Content-Security-Policy": "script-src *" });
    headers.append("Set-Cookie", "__Host-unidocs_admin=forbidden; Secure; Path=/");
    headers.append("Set-Cookie", "__Host-unidocs_admin_mcp_oauth=next; Secure; Path=/");
    return new Response("ok", { headers });
  });
  const response = await dispatchAdminMcp(new Request(publicOrigin + path, { headers: { cookie: cookies, "x-csrf-token": "csrf-secret" } }), { enabled: true, publicOrigin, handler });
  expect(response?.status).toBe(200);
  expect(response?.headers.getSetCookie()).toEqual(browser ? ["__Host-unidocs_admin_mcp_oauth=next; Secure; Path=/"] : []);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  if (browser) expect(response?.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
});

test("browser consent POST requires same origin while Google callback GET can navigate cross-site", async () => {
  const handler = vi.fn(async () => new Response("ok"));
  for (const origin of [undefined, "null", "https://other.example"]) {
    const headers = origin ? { origin } : undefined;
    expect((await dispatchAdminMcp(new Request(publicOrigin + "/oauth/admin-mcp/authorize", { method: "POST", headers }), { enabled: true, publicOrigin, handler }))?.status).toBe(403);
  }
  expect(handler).not.toHaveBeenCalled();
  expect((await dispatchAdminMcp(new Request(publicOrigin + "/oauth/admin-mcp/authorize", { method: "POST", headers: { origin: publicOrigin } }), { enabled: true, publicOrigin, handler }))?.status).toBe(200);
  expect((await dispatchAdminMcp(new Request(publicOrigin + "/oauth/admin-mcp/google/callback?code=private", { headers: { "sec-fetch-site": "cross-site" } }), { enabled: true, publicOrigin, handler }))?.status).toBe(200);
});

test("rejects foreign origins, wrong hosts and duplicate OAuth cookies", async () => {
  const handler = vi.fn(async () => new Response("ok"));
  const options = { enabled: true, publicOrigin, handler };
  expect((await dispatchAdminMcp(new Request("https://bundles.shazhou.work/mcp"), options))?.status).toBe(404);
  expect((await dispatchAdminMcp(new Request(publicOrigin + "/mcp", { headers: { origin: "https://other.example" } }), options))?.status).toBe(403);
  expect((await dispatchAdminMcp(new Request(publicOrigin + "/oauth/admin-mcp/authorize", { headers: { cookie: "__Host-unidocs_admin_mcp_oauth=one; __Host-unidocs_admin_mcp_oauth=two" } }), options))?.status).toBe(400);
  expect(handler).not.toHaveBeenCalled();
});

test("bounds actual streamed bytes and cancels an oversized OAuth body", async () => {
  const cancel = vi.fn();
  const handler = vi.fn(async () => new Response("unexpected"));
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(ADMIN_MCP_OAUTH_BODY_MAX_BYTES + 1)); }, cancel }, { highWaterMark: 0 });
  const request = new Request(publicOrigin + "/oauth/admin-mcp/register", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  expect((await dispatchAdminMcp(request, { enabled: true, publicOrigin, handler }))?.status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
  expect(handler).not.toHaveBeenCalled();
});

test.each(["/mcp", "/oauth/admin-mcp/token"])("accepts exact request ceiling and rejects one extra byte: %s", async path => {
  const limit = path === "/mcp" ? ADMIN_MCP_BODY_MAX_BYTES : ADMIN_MCP_OAUTH_BODY_MAX_BYTES;
  const handler = vi.fn(async (request: Request) => {
    expect((await request.arrayBuffer()).byteLength).toBe(limit);
    return new Response("ok");
  });
  for (const extra of [0, 1]) {
    const request = new Request(publicOrigin + path, { method: "POST", body: new Uint8Array(limit + extra) });
    expect((await dispatchAdminMcp(request, { enabled: true, publicOrigin, handler }))?.status).toBe(extra ? 413 : 200);
  }
  expect(handler).toHaveBeenCalledOnce();
});

test("fails closed without a provider and sanitizes thrown errors", async () => {
  const request = new Request(publicOrigin + "/mcp");
  expect((await dispatchAdminMcp(request, { enabled: true, publicOrigin }))?.status).toBe(503);
  const response = await dispatchAdminMcp(request, { enabled: true, publicOrigin, handler: async () => { throw new Error("private-token"); } });
  expect(response?.status).toBe(503);
  expect(await response?.text()).toBe("");
});