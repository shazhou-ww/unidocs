import { expect, test, vi } from "vitest";

vi.mock("../src/web-assets.generated.js", () => ({
  WEB_ASSETS: { "/index.html": Buffer.from("<!doctype html><title>Gateway</title>").toString("base64") },
}));

import { webAssetResponse } from "../src/web-assets.js";

test.each([
  "/.well-known", "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server/oauth/azure",
  "/oauth", "/oauth/azure/.well-known/openid-configuration", "/oauth/azure/jwks",
  "/oauth/azure/authorize", "/oauth/azure/token", "/tenants", "/tenants/test/docs",
])("does not serve the SPA for protocol endpoint %s", (path) => {
  for (const method of ["GET", "HEAD"]) {
    expect(webAssetResponse(new Request(`https://gateway.example${path}`, { method }))).toBeNull();
  }
});

test("continues serving real UI routes", () => {
  for (const path of ["/", "/documents/example", "/oauth-settings"]) {
    expect(webAssetResponse(new Request(`https://gateway.example${path}`))?.headers.get("Content-Type")).toContain("text/html");
  }
});