import { describe, expect, test, vi } from "vitest";
import {
  generateOidcNonce,
  generateOidcState,
  generatePkceVerifier,
  OidcClient,
  s256Challenge,
} from "../src/index.js";

describe("shared control OIDC", () => {
  test("implements the RFC 7636 S256 example", async () => {
    await expect(s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("generates verifier, state, and nonce values", () => {
    expect(generatePkceVerifier()).toMatch(/^[A-Za-z0-9._~-]{43}$/);
    expect(generateOidcState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(generateOidcNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("rejects discovery from a different issuer", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      issuer: "https://attacker.example",
      authorization_endpoint: "https://attacker.example/authorize",
      token_endpoint: "https://attacker.example/token",
      jwks_uri: "https://attacker.example/jwks",
    }));
    const client = new OidcClient({
      issuer: "https://accounts.example",
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://control.example/callback",
    }, { fetchImpl });

    await expect(client.discovery()).rejects.toThrow("issuer does not match");
  });
});