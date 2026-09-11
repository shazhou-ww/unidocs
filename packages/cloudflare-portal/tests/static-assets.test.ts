import { expect, test } from "vitest";
import { isProtectedAdminWebUiPath, serveAdminWebUi } from "../src/static-assets.js";

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