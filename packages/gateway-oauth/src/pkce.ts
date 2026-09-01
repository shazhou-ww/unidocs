import { systemGatewayOAuthHash } from "./crypto.js";
import type { GatewayOAuthHashPort } from "./ports.js";

const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function validateGatewayOAuthPkceVerifier(value: string): string {
  if (!PKCE_VERIFIER_PATTERN.test(value)) {
    throw new TypeError("PKCE code_verifier must contain 43 to 128 unreserved characters");
  }
  return value;
}

export function validateGatewayOAuthPkceS256Challenge(value: string): string {
  if (!PKCE_S256_CHALLENGE_PATTERN.test(value)) {
    throw new TypeError("PKCE S256 code_challenge must be a 43-character base64url digest");
  }
  return value;
}

export async function verifyGatewayOAuthPkceS256(
  verifier: string,
  expectedChallenge: string,
  hash: GatewayOAuthHashPort = systemGatewayOAuthHash,
): Promise<boolean> {
  validateGatewayOAuthPkceVerifier(verifier);
  validateGatewayOAuthPkceS256Challenge(expectedChallenge);
  const actual = await hash.sha256Base64Url(verifier);
  return timingSafeEqual(actual, expectedChallenge);
}

function timingSafeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
