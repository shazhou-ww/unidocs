import { expect, test } from "vitest";
import { serveAdminWebUi } from "../src/static-assets.js";

test("serves the embedded Admin shell and immutable hashed assets", async () => {
  const shell = serveAdminWebUi(new Request("https://portal.test/admin/"));
  expect(shell?.status).toBe(200);
  expect(shell?.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(shell?.headers.get("cache-control")).toBe("no-store");
  const html = await shell!.text();
  expect(html).toContain("<title>UniDocs 管理</title>");
  const assetPath = html.match(/src="(\/admin\/assets\/[^"]+\.js)"/)?.[1];
  expect(assetPath).toBeTruthy();
  const asset = serveAdminWebUi(new Request(`https://portal.test${assetPath}`));
  expect(asset?.status).toBe(200);
  expect(asset?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const head = serveAdminWebUi(new Request(`https://portal.test${assetPath}`, { method: "HEAD" }));
  expect(head?.status).toBe(200);
  expect(await head!.text()).toBe("");
});