import { describe, expect, test } from "vitest";
import {
  canonicalizeGatewayOAuthIssuer,
  gatewayOAuthMetadataPath,
  gatewayOpenIdConfigurationPath,
  renderGatewayOAuthMetadata,
} from "../src/index.js";

describe("Gateway OAuth metadata", () => {
  test("derives RFC 8414 locations for root and path-bearing issuers", () => {
    expect(gatewayOAuthMetadataPath("https://gateway.example"))
      .toBe("/.well-known/oauth-authorization-server");
    expect(gatewayOAuthMetadataPath("https://gateway.example/oauth"))
      .toBe("/.well-known/oauth-authorization-server/oauth");
    expect(gatewayOpenIdConfigurationPath("https://gateway.example/oauth"))
      .toBe("/oauth/.well-known/openid-configuration");
  });

  test("renders exact issuer metadata for code, refresh, and mandatory PKCE S256", () => {
    expect(renderGatewayOAuthMetadata({ issuer: "https://gateway.example/oauth/" }))
      .toEqual({
        issuer: "https://gateway.example/oauth/",
        authorization_endpoint: "https://gateway.example/oauth/authorize",
        token_endpoint: "https://gateway.example/oauth/token",
        jwks_uri: "https://gateway.example/oauth/jwks",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["cas:read", "cas:write", "cas:manage"],
      });
  });

  test.each([
    "http://gateway.example/oauth",
    "https://user@gateway.example/oauth",
    "https://gateway.example/oauth?tenant=one",
    "https://gateway.example/oauth#fragment",
    "not a URL",
  ])("rejects unsafe issuer %s", issuer => {
    expect(() => canonicalizeGatewayOAuthIssuer(issuer)).toThrow(TypeError);
  });

  test("requires endpoints to stay on the issuer origin", () => {
    expect(() => renderGatewayOAuthMetadata({
      issuer: "https://gateway.example/oauth",
      tokenEndpoint: "https://attacker.example/token",
    })).toThrow("token endpoint must use the issuer origin");
  });
});
