import { expect, test } from "vitest";
import { isProtectedAdminWebUiPath, isTenantWebUiPath, serveAdminWebUi, serveTenantWebUi } from "../src/static-assets.js";

test("serves the embedded Admin shell and immutable hashed assets", async () => {
  const shell = serveAdminWebUi(new Request("https://portal.test/admin/"));
  expect(shell?.status).toBe(200);
  expect(shell?.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(shell?.headers.get("cache-control")).toBe("no-store");
  const html = await shell!.text();
  expect(html).toContain("<title>UniDocs 管理</title>");
  const login = serveAdminWebUi(new Request("https://portal.test/admin/login"));
  expect(login?.status).toBe(200);
  expect(await login!.text()).toBe(html);
  for (const route of ["/admin/document-types", "/admin/document-types/markdown", "/admin/administrators", "/admin/audit"]) {
    expect(isProtectedAdminWebUiPath(route)).toBe(true);
    expect(await serveAdminWebUi(new Request(`https://portal.test${route}`))!.text()).toBe(html);
  }
  for (const route of ["/admin/api/v1/audit-events", "/admin/auth/session", "/admin/document-types/one/two", "/admin/unknown"]) {
    expect(isProtectedAdminWebUiPath(route)).toBe(false);
    expect(serveAdminWebUi(new Request(`https://portal.test${route}`))).toBeNull();
  }
  const assetPath = html.match(/src="(\/admin\/assets\/[^"]+\.js)"/)?.[1];
  expect(assetPath).toBeTruthy();
  const asset = serveAdminWebUi(new Request(`https://portal.test${assetPath}`));
  expect(asset?.status).toBe(200);
  expect(asset?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const head = serveAdminWebUi(new Request(`https://portal.test${assetPath}`, { method: "HEAD" }));
  expect(head?.status).toBe(200);
  expect(await head!.text()).toBe("");
});

test("serves the embedded tenant shell on its three real paths, and its hashed assets", async () => {
  const shell = serveTenantWebUi(new Request("https://portal.test/portal/"));
  expect(shell?.status).toBe(200);
  expect(shell?.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(shell?.headers.get("cache-control")).toBe("no-store");
  const html = await shell!.text();
  expect(html).toContain("<title>UniDocs · 我的作品</title>");
  for (const route of ["/portal", "/portal/index.html"]) {
    expect(isTenantWebUiPath(route)).toBe(true);
    expect(await serveTenantWebUi(new Request(`https://portal.test${route}`))!.text()).toBe(html);
  }
  const assetPath = html.match(/src="(\/portal\/assets\/[^"]+\.js)"/)?.[1];
  expect(assetPath).toBeTruthy();
  const asset = serveTenantWebUi(new Request(`https://portal.test${assetPath}`));
  expect(asset?.status).toBe(200);
  expect(asset?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const head = serveTenantWebUi(new Request(`https://portal.test${assetPath}`, { method: "HEAD" }));
  expect(head?.status).toBe(200);
  expect(await head!.text()).toBe("");
});

// The tenant UI is hash-routed, so `/portal/d/doc-1` is not a location the app
// ever produces. Serving the shell there would invent path routes the router
// cannot read; declining lets the BFF answer 404, which is the truth.
test("declines every path that is not the tenant shell or one of its assets", () => {
  for (const route of ["/admin/", "/portal/d/doc-1", "/portal/api/v1/documents", "/portalx", "/portal-other/", "/"]) {
    expect(isTenantWebUiPath(route), route).toBe(false);
    expect(serveTenantWebUi(new Request(`https://portal.test${route}`)), route).toBeNull();
  }
});

// A hashed bundle that is missing must say so. Falling back to the shell would
// answer a script request with HTML and turn a bad deploy into a blank page.
test("a missing hashed asset is a 404, not the shell", async () => {
  const missing = serveTenantWebUi(new Request("https://portal.test/portal/assets/nope-00000000.js"));
  expect(missing?.status).toBe(404);
  expect(await missing!.text()).toBe("Tenant WebUI asset not found");
});

test("writes are refused before any asset lookup happens", () => {
  const post = serveTenantWebUi(new Request("https://portal.test/portal/", { method: "POST" }));
  expect(post?.status).toBe(405);
  expect(post?.headers.get("allow")).toBe("GET, HEAD");
});

// Served ahead of the BFF (see worker.ts), so the headers the BFF appends to
// every admin response never reach these — they are set here or nowhere.
test("carries its own security headers, since the BFF never sees these responses", () => {
  const shell = serveTenantWebUi(new Request("https://portal.test/portal/"));
  expect(shell?.headers.get("referrer-policy")).toBe("no-referrer");
  expect(shell?.headers.get("x-content-type-options")).toBe("nosniff");
  const csp = shell!.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  // The relaxations over the admin policy, pinned so they cannot widen
  // silently: markers position themselves by writing element.style, and
  // mock-base.css @imports a Noto Sans SC face from Google.
  expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
  // Scripts are never relaxed — every bundle is same-origin.
  expect(csp).not.toContain("script-src");
  expect(csp).not.toContain("unsafe-eval");
});
