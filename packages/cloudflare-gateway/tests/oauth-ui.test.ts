import { describe, expect, test } from "vitest";
import { renderCloudflareGatewayOAuthConsent } from "../src/oauth-consent.js";
import { createCloudflareGatewayOAuthIdentity } from "../src/oauth-identity.js";

describe("Cloudflare Gateway OAuth identity and consent", () => {
  test("is fail closed unless the explicit development-only mode is enabled", async () => {
    const production = createCloudflareGatewayOAuthIdentity({});
    await expect(production.currentUser(new Request("https://gateway.example/authorize")))
      .resolves.toBeNull();

    const local = createCloudflareGatewayOAuthIdentity({
      GATEWAY_OAUTH_LOCAL_IDENTITY: "unsafe-development-only",
      GATEWAY_OAUTH_LOCAL_PRINCIPAL: "user-1",
      GATEWAY_OAUTH_LOCAL_DISPLAY_NAME: "Local User",
    });
    await expect(local.currentUser(new Request("http://127.0.0.1:8787/authorize")))
      .resolves.toEqual({ principalId: "user-1", displayName: "Local User" });
    await expect(local.currentUser(new Request("https://gateway.example/authorize")))
      .resolves.toBeNull();
  });

  test("rejects misspelled or incomplete development identity configuration", () => {
    expect(() => createCloudflareGatewayOAuthIdentity({
      GATEWAY_OAUTH_LOCAL_IDENTITY: "true",
      GATEWAY_OAUTH_LOCAL_PRINCIPAL: "user-1",
    })).toThrow("invalid value");
    expect(() => createCloudflareGatewayOAuthIdentity({
      GATEWAY_OAUTH_LOCAL_IDENTITY: "unsafe-development-only",
    })).toThrow("GATEWAY_OAUTH_LOCAL_PRINCIPAL");
  });

  test("renders a no-store, framed-off consent form with escaped untrusted labels", async () => {
    const response = renderCloudflareGatewayOAuthConsent({
      authorization: {
        transactionId: "transaction-1",
        clientId: "<client>",
        tenantId: "tenant-1",
        scopes: ["cas:read"],
        expiresAt: 1_600,
      },
      user: { principalId: "user-1", displayName: "Alice & Bob" },
      decisionEndpoint: "https://gateway.test/authorize/decision",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain("Alice &amp; Bob");
    expect(html).toContain("&lt;client&gt;");
    expect(html).not.toContain("<client>");
    expect(html).toContain('name="transaction_id" value="transaction-1"');
    expect(html).toContain('name="decision" value="approve"');
  });
});
