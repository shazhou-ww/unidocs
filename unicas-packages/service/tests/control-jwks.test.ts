import { describe, expect, test } from "vitest";
import { buildStackJwks } from "../src/index.js";
import type { CasStackIssuerKey } from "@unicas/admin-protocol";

const STACK = "cas_stack_a";

function key(kid: string, state: CasStackIssuerKey["state"]): CasStackIssuerKey {
  return {
    stackId: STACK,
    kid,
    algorithm: "ES256",
    publicJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" },
    state,
    revision: 1,
  };
}

describe("buildStackJwks", () => {
  test("includes active and retiring keys with kid/alg/use", () => {
    const jwks = buildStackJwks([
      key("k1", "active"),
      key("k2", "retiring"),
    ]);
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys[0]).toMatchObject({ kid: "k1", alg: "ES256", use: "sig", kty: "EC" });
    expect(jwks.keys[1]).toMatchObject({ kid: "k2", alg: "ES256", use: "sig" });
  });

  test("excludes revoked keys so they stop verifying", () => {
    const jwks = buildStackJwks([
      key("k1", "active"),
      key("k2", "revoked"),
    ]);
    expect(jwks.keys.map((k) => k.kid)).toEqual(["k1"]);
  });

  test("never emits private material even if a key record carried it", () => {
    const poisoned: CasStackIssuerKey = {
      ...key("k1", "active"),
      publicJwk: { kty: "EC", crv: "P-256", x: "a", y: "b", d: "secret" },
    };
    const jwks = buildStackJwks([poisoned]);
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  test("an empty or all-revoked registry yields an empty JWKS (fail closed)", () => {
    expect(buildStackJwks([]).keys).toEqual([]);
    expect(buildStackJwks([key("k1", "revoked")]).keys).toEqual([]);
  });
});
