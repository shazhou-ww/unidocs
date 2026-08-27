#!/usr/bin/env node
/**
 * Sign a CAS issuer-key possession challenge with an operator-held private
 * key. The CAS control plane issues a one-time challenge (BFF route
 * `/admin/issuer/possession-challenge`); this script produces the compact JWS
 * `possessionProof` plus the **public** JWK to submit to
 * `POST /admin/stacks/{stackId}/issuer/keys` — i.e. exactly the two fields the
 * admin console's "Add an issuer key" form asks for.
 *
 * Usage:
 *   node scripts/cas-possession-sign.mjs <challenge> <private-key-pem-file> [algorithm]
 *
 *   algorithm: ES256 (default) | RS256 | EdDSA
 *
 * The private key never leaves the operator's machine and never reaches CAS —
 * which is why `publicJwk` below is derived by stripping private material
 * rather than by exporting the private key as-is.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CompactSign, exportJWK, importPKCS8 } from "jose";

const SUPPORTED_ALGORITHMS = ["ES256", "RS256", "EdDSA"];

/**
 * Private JWK members, per RFC 7518. Mirrors `PRIVATE_JWK_FIELDS` in
 * `unicas-packages/control-plane/src/possession.ts` — the control plane
 * rejects a JWK carrying any of them, and it is right to.
 */
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];

/** Drop every private member, leaving the public half of the key pair. */
export function toPublicJwk(jwk) {
  const publicJwk = { ...jwk };
  for (const field of PRIVATE_JWK_FIELDS) delete publicJwk[field];
  return publicJwk;
}

/**
 * The challenge is signed as a **raw payload**, not as JWT claims: the control
 * plane's `verifyPossessionProof()` compares the decoded JWS payload bytes
 * against the challenge string verbatim. A `SignJWT` would wrap it in JSON
 * claims and never match.
 */
export async function signPossessionChallenge({
  challenge,
  privateKeyPem,
  algorithm = "ES256",
}) {
  if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
  // `extractable: true` is required: jose 6 imports non-extractable by
  // default, and exportJWK() then throws "non-extractable CryptoKey".
  const privateKey = await importPKCS8(privateKeyPem, algorithm, { extractable: true });
  const publicJwk = toPublicJwk(await exportJWK(privateKey));
  const possessionProof = await new CompactSign(new TextEncoder().encode(challenge))
    .setProtectedHeader({ alg: algorithm })
    .sign(privateKey);
  return { algorithm, publicJwk, possessionProof };
}

async function main() {
  const [challenge, keyFile, algorithm = "ES256"] = process.argv.slice(2);
  if (!challenge || !keyFile) {
    console.error(
      "Usage: node scripts/cas-possession-sign.mjs <challenge> <private-key-pem-file> [ES256|RS256|EdDSA]",
    );
    process.exit(2);
  }
  const result = await signPossessionChallenge({
    challenge,
    privateKeyPem: await readFile(keyFile, "utf8"),
    algorithm,
  });
  console.log(JSON.stringify(
    {
      ...result,
      note: "Paste publicJwk and possessionProof into the CAS admin console 'Add an issuer key' form.",
    },
    null,
    2,
  ));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
