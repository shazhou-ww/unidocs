/**
 * Registry-side JWKS assembly.
 *
 * The tenant verifier (Task 4) consumes a stack's public keys from
 * CAS_CONTROL_DB. This helper derives the stack JWKS from registry rows only —
 * never from caller input. `active` and `retiring` keys are included so
 * overlapping rotation keeps verifying for the maximum JWT lifetime; `revoked`
 * keys are excluded. The 30s isolate cache / 60s revocation bound on the
 * tenant side is Task 4.
 */

import type { JSONWebKeySet } from "jose";
import type { CasStackIssuerKey } from "@unidocs/protocol-cas-admin";

/** Private JWK material must never reach a served JWKS. */
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"] as const;

export function buildStackJwks(
  keys: readonly CasStackIssuerKey[],
): JSONWebKeySet {
  const eligible = keys.filter(
    (key) => key.state === "active" || key.state === "retiring",
  );
  return {
    keys: eligible.map((key) => {
      const publicJwk = { ...key.publicJwk };
      for (const field of PRIVATE_JWK_FIELDS) {
        delete publicJwk[field];
      }
      return {
        ...publicJwk,
        kid: key.kid,
        alg: key.algorithm,
        use: "sig",
      };
    }),
  };
}
