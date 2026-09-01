import { describe, expect, test } from "vitest";
import { renderAzureGatewayOAuthConsent } from "../src/oauth-consent.js";
import { createAzureGatewayOAuthIdentity } from "../src/oauth-identity.js";

describe("Azure Gateway OAuth identity and consent", () => {
  test("fails closed in production and permits only explicit local identity", async () => {
    await expect(createAzureGatewayOAuthIdentity({}).currentUser(
      new Request("https://gateway.example/authorize"),
    )).resolves.toBeNull();
    const local = createAzureGatewayOAuthIdentity({
      GATEWAY_OAUTH_LOCAL_IDENTITY: "unsafe-development-only",
      GATEWAY_OAUTH_LOCAL_PRINCIPAL: "user-1",
      GATEWAY_OAUTH_LOCAL_DISPLAY_NAME: "Local User",
    });
    await expect(local.currentUser(new Request("http://127.0.0.1:8787/authorize")))
      .resolves.toEqual({ principalId: "user-1", displayName: "Local User" });
    await expect(local.currentUser(new Request("https://gateway.example/authorize")))
      .resolves.toBeNull();
  });

  test("renders escaped, no-store consent without script capability", async () => {
    const response = renderAzureGatewayOAuthConsent({
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
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain("Alice &amp; Bob");
    expect(html).toContain("&lt;client&gt;");
    expect(html).not.toContain("<client>");
  });
});
