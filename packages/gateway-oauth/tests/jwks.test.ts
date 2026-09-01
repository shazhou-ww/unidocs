import { describe, expect, test } from "vitest";
import { CapabilityAlgorithm } from "@unidocs/service-auth";
import { renderGatewayOAuthJwks } from "../src/index.js";

const publicJwk = {
  kty: "EC",
  crv: "P-256",
  x: "x-coordinate",
  y: "y-coordinate",
} as const;

describe("Gateway OAuth JWKS", () => {
  test("publishes capability verification keys with stable JOSE metadata", () => {
    expect(renderGatewayOAuthJwks([{
      kid: "gateway-2026-09",
      algorithm: CapabilityAlgorithm,
      publicJwk,
    }])).toEqual({
      keys: [{
        ...publicJwk,
        kid: "gateway-2026-09",
        alg: "ES256",
        use: "sig",
      }],
    });
  });

  test("rejects empty and duplicate key sets", () => {
    expect(() => renderGatewayOAuthJwks([])).toThrow("must not be empty");
    expect(() => renderGatewayOAuthJwks([
      { kid: "same", algorithm: CapabilityAlgorithm, publicJwk },
      { kid: "same", algorithm: CapabilityAlgorithm, publicJwk },
    ])).toThrow("Duplicate OAuth signing key ID");
  });

  test.each(["d", "jku", "x5u"])("rejects forbidden public JWK member %s", member => {
    expect(() => renderGatewayOAuthJwks([{
      kid: "unsafe",
      algorithm: CapabilityAlgorithm,
      publicJwk: { ...publicJwk, [member]: "secret-or-remote" },
    }])).toThrow(`must not contain ${member}`);
  });
});
