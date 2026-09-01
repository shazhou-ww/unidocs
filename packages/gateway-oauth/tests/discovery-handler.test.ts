import { describe, expect, test, vi } from "vitest";
import { CapabilityAlgorithm } from "@unidocs/service-auth";
import { createGatewayOAuthDiscoveryHandler } from "../src/index.js";

const publicSigningKeys = vi.fn(async () => [{
  kid: "key-1",
  algorithm: CapabilityAlgorithm,
  publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
}] as const);

const handler = createGatewayOAuthDiscoveryHandler({
  metadata: { issuer: "https://gateway.example/oauth" },
  signingKeys: { publicSigningKeys },
});

describe("Gateway OAuth discovery handler", () => {
  test("serves RFC 8414 metadata and public JWKS with CORS", async () => {
    const metadata = await handler(new Request(
      "https://gateway.example/.well-known/oauth-authorization-server/oauth",
    ));
    expect(metadata?.status).toBe(200);
    expect(metadata?.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await metadata?.json()).toMatchObject({
      issuer: "https://gateway.example/oauth",
      code_challenge_methods_supported: ["S256"],
    });

    const jwks = await handler(new Request("https://gateway.example/oauth/jwks"));
    expect(await jwks?.json()).toEqual({
      keys: [{
        kty: "EC",
        crv: "P-256",
        x: "x",
        y: "y",
        kid: "key-1",
        alg: "ES256",
        use: "sig",
      }],
    });
    expect(publicSigningKeys).toHaveBeenCalledOnce();
  });

  test("returns null for unrelated paths and 405 for non-GET discovery", async () => {
    await expect(handler(new Request("https://gateway.example/documents")))
      .resolves.toBeNull();
    const response = await handler(new Request(
      "https://gateway.example/.well-known/oauth-authorization-server/oauth",
      { method: "POST" },
    ));
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe("GET");
  });
});
