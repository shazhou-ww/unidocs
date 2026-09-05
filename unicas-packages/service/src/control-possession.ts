/**
 * Compact-JWS proof helpers for the Stack OAuth issuer activation challenge.
 *
 * The Stack operator signs the server-issued inspection challenge with a
 * private key whose public JWK is advertised by the discovered issuer JWKS.
 * The service verifies the compact JWS with that public JWK using the
 * declared algorithm.
 */

import { compactVerify, decodeProtectedHeader } from "jose";
import type { JWK } from "jose";
import { isSupportedKeyAlgorithm } from "./control-validation.js";
import type { SupportedKeyAlgorithm } from "./control-validation.js";

export async function verifyCompactJwsProof(input: {
  readonly challenge: string;
  readonly algorithm: SupportedKeyAlgorithm;
  readonly publicJwk: Record<string, unknown>;
  readonly proof: string;
}): Promise<boolean> {
  try {
    const { payload, protectedHeader } = await compactVerify(
      input.proof,
      input.publicJwk as JWK,
      { algorithms: [input.algorithm] },
    );
    return protectedHeader.kid === input.publicJwk.kid
      && new TextDecoder().decode(payload) === input.challenge;
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

export function extractJwsProtectedHeader(jws: string): { readonly kid: string; readonly alg: string } | null {
  try {
    const header = decodeProtectedHeader(jws);
    return typeof header.kid === "string" && header.kid.length > 0 && typeof header.alg === "string"
      ? { kid: header.kid, alg: header.alg }
      : null;
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
