/**
 * Issuer key proof of possession.
 *
 * The operator proves they hold the private key matching the submitted public
 * JWK by signing a server-issued one-time challenge. `possessionProof` is a
 * compact JWS whose payload is the UTF-8 challenge string; the service verifies
 * it with the submitted public JWK using the declared algorithm.
 *
 * The challenge string binds version, nonce, stack, kid, and algorithm:
 *
 *   cas-possession-v1\n{nonce}\n{stackId}\n{kid}\n{alg}
 *
 * ECDSA signatures must be raw r||s (P1363) — the form WebCrypto and jose
 * produce, matching `CompactSign` from jose.
 */

import { compactVerify } from "jose";
import type { JWK } from "jose";
import { isSupportedKeyAlgorithm } from "./control-validation.js";
import type { SupportedKeyAlgorithm } from "./control-validation.js";

export const POSSESSION_CHALLENGE_VERSION = "cas-possession-v1";

export interface PossessionChallengeInput {
  readonly nonce: string;
  readonly stackId: string;
  readonly kid: string;
  readonly algorithm: SupportedKeyAlgorithm;
}

export function buildPossessionChallenge(input: PossessionChallengeInput): string {
  return [
    POSSESSION_CHALLENGE_VERSION,
    input.nonce,
    input.stackId,
    input.kid,
    input.algorithm,
  ].join("\n");
}

/** Parse a signed challenge string back into its fields; null when malformed. */
export function parsePossessionChallenge(
  challenge: string,
): PossessionChallengeInput | null {
  const parts = challenge.split("\n");
  if (parts.length !== 5 || parts[0] !== POSSESSION_CHALLENGE_VERSION) return null;
  const [version, nonce, stackId, kid, algorithm] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!version || !nonce || !stackId || !kid || !isSupportedKeyAlgorithm(algorithm)) {
    return null;
  }
  return { nonce, stackId, kid, algorithm };
}

/**
 * Verify a possession proof against the exact challenge string.
 * Returns false for any malformed JWS, algorithm mismatch, or bad signature.
 */
export async function verifyPossessionProof(input: {
  readonly challenge: string;
  readonly algorithm: SupportedKeyAlgorithm;
  readonly publicJwk: Record<string, unknown>;
  readonly possessionProof: string;
}): Promise<boolean> {
  try {
    const { payload } = await compactVerify(
      input.possessionProof,
      input.publicJwk as JWK,
      { algorithms: [input.algorithm] },
    );
    return new TextDecoder().decode(payload) === input.challenge;
  } catch {
    return false;
  }
}

/** Decode the payload of a compact JWS (three dot-separated base64url parts). */
export function extractJwsPayload(jws: string): string | null {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts[0]!.length === 0 || parts[1]!.length === 0 || parts[2]!.length === 0) {
    return null;
  }
  try {
    const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Private JWK material that must never be accepted as a public key. */
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"] as const;

/** Required public fields per supported algorithm. */
const PUBLIC_JWK_FIELDS: Readonly<Record<SupportedKeyAlgorithm, readonly string[]>> = {
  ES256: ["kty", "crv", "x", "y"],
  RS256: ["kty", "n", "e"],
  EdDSA: ["kty", "crv", "x"],
};

export function validatePublicJwk(
  value: unknown,
  algorithm: string,
): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "publicJwk must be a JWK object";
  }
  if (!isSupportedKeyAlgorithm(algorithm)) {
    return "algorithm is not supported";
  }
  const jwk = value as Record<string, unknown>;
  for (const field of PRIVATE_JWK_FIELDS) {
    if (field in jwk) return `publicJwk must not contain private material (${field})`;
  }
  const required = PUBLIC_JWK_FIELDS[algorithm];
  for (const field of required) {
    if (typeof jwk[field] !== "string" || (jwk[field] as string).length === 0) {
      return `publicJwk is missing required field '${field}' for ${algorithm}`;
    }
  }
  if (algorithm === "ES256" && jwk.crv !== "P-256") {
    return "ES256 publicJwk must use crv P-256";
  }
  if (algorithm === "EdDSA" && jwk.crv !== "Ed25519") {
    return "EdDSA publicJwk must use crv Ed25519";
  }
  return null;
}
