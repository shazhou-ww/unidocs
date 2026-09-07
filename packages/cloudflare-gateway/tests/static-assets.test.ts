import { describe, expect, it, vi } from "vitest";
import { serveGatewayWebUi } from "../src/static-assets.js";

vi.mock("../src/ui-assets.generated.js", () => ({ UI_ASSETS: {
  "/ui/index.html": "<html>studio</html>",
  "/ui/assets/studio-abc123.js": "export {};",
} }));

describe("Gateway UI cache policy", () => {
  it.each(["/", "/index.html", "/ui", "/ui/", "/ui/index.html", "/ui/callback"])("does not cache the HTML entry at %s", path => {
    const response = serveGatewayWebUi(new Request(`https://test${path}`))!;
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("retains immutable caching for content-addressed build assets", () => {
    const response = serveGatewayWebUi(new Request("https://test/ui/assets/studio-abc123.js"))!;
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(response.headers.get("Content-Type")).toContain("javascript");
  });

  it("does not intercept API or OAuth routes", () => {
    expect(serveGatewayWebUi(new Request("https://test/tenants/example/docs/psd/"))).toBeNull();
    expect(serveGatewayWebUi(new Request("https://test/oauth/unidocs-cloudflare/token"))).toBeNull();
  });
});