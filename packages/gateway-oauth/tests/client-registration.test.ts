import { describe, expect, test, vi } from "vitest";
import {
  GatewayOAuthProtocolError,
  gatewayOAuthRedirectUriMatches,
  registerGatewayOAuthClient,
  validateGatewayOAuthRedirectUri,
  type GatewayOAuthRegisteredClient,
} from "../src/index.js";

describe("Gateway OAuth dynamic client registration", () => {
  test("registers only public clients and never returns a client secret", async () => {
    const clients = new Map<string, GatewayOAuthRegisteredClient>();
    const response = await registerGatewayOAuthClient({
      redirect_uris: ["https://app.example/oauth/callback"],
      token_endpoint_auth_method: "none",
      client_name: "Example App",
    }, {
      clients: {
        find: async id => clients.get(id) ?? null,
        putIfAbsent: async client => {
          if (clients.has(client.clientId)) return false;
          clients.set(client.clientId, client);
          return true;
        },
      },
      clock: { now: () => 1_000 },
      random: { opaque: () => "client-id" },
    });

    expect(response).toEqual({
      client_id: "client-id",
      redirect_uris: ["https://app.example/oauth/callback"],
      token_endpoint_auth_method: "none",
      client_name: "Example App",
    });
    expect(response).not.toHaveProperty("client_secret");
    expect(clients.get("client-id")).toMatchObject({ createdAt: 1_000 });
  });

  test.each([
    "http://app.example/callback",
    "https://user@app.example/callback",
    "https://app.example/callback#fragment",
    "https://*.example/callback",
  ])("rejects unsafe redirect URI %s", redirectUri => {
    expect(() => validateGatewayOAuthRedirectUri(redirectUri)).toThrow(GatewayOAuthProtocolError);
  });

  test("allows RFC 8252 loopback redirects with a dynamic port only", () => {
    expect(validateGatewayOAuthRedirectUri("http://127.0.0.1:49152/callback"))
      .toBe("http://127.0.0.1:49152/callback");
    expect(gatewayOAuthRedirectUriMatches(
      "http://127.0.0.1:8000/callback?channel=cli",
      "http://127.0.0.1:49152/callback?channel=cli",
    )).toBe(true);
    expect(gatewayOAuthRedirectUriMatches(
      "http://127.0.0.1:8000/callback?channel=cli",
      "http://127.0.0.1:49152/other?channel=cli",
    )).toBe(false);
    expect(() => validateGatewayOAuthRedirectUri("http://localhost:49152/callback"))
      .toThrow("must use HTTPS");
  });

  test("rejects confidential authentication and duplicate redirects", async () => {
    const ports = {
      clients: { find: vi.fn(), putIfAbsent: vi.fn() },
      clock: { now: () => 1_000 },
    };
    await expect(registerGatewayOAuthClient({
      redirect_uris: ["https://app.example/callback"],
      token_endpoint_auth_method: "client_secret_basic",
    }, ports)).rejects.toMatchObject({ code: "invalid_client_metadata" });
    await expect(registerGatewayOAuthClient({
      redirect_uris: ["https://app.example/callback", "https://app.example/callback"],
    }, ports)).rejects.toThrow("must not contain duplicates");
  });
});
