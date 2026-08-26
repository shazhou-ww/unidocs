#!/usr/bin/env node
/**
 * Sign a CAS issuer-key possession challenge with an operator-held private
 * key. The CAS control plane issues a one-time challenge (BFF route
 * `/admin/issuer/possession-challenge`); this script produces the compact JWS
 * `possessionProof` and the public JWK to submit to
 * `POST /admin/stacks/{stackId}/issuer/keys`.
 *
 * Usage:
 *   node scripts/cas-possession-sign.mjs <challenge> <private-key-pem-file> [algorithm]
 *
 *   algorithm: ES256 (default) | RS256 | EdDSA
 *
 * The private key never leaves the operator's machine and never reaches CAS.
 */
import { readFile } from "node:fs/promises";
import { exportJWK, importPKCS8, SignJWT } from "jose";

const [challenge, keyFile, algorithm = "ES256"] = process.argv.slice(2);
if (!challenge || !keyFile) {
  console.error(
    "Usage: node scripts/cas-possession-sign.mjs <challenge> <private-key-pem-file> [ES256|RS256|EdDSA]",
  );
  process.exit(2);
}
if (!["ES256", "RS256", "EdDSA"].includes(algorithm)) {
  console.error(`Unsupported algorithm: ${algorithm}`);
  process.exit(2);
}

const pem = await readFile(keyFile, "utf8");
const privateKey = await importPKCS8(pem, algorithm);
const publicJwk = await exportJWK(privateKey);
const possessionProof = await new SignJWT()
  .setProtectedHeader({ alg: algorithm })
  .sign(privateKey);

// NOTE: the challenge is signed as a raw payload, not as JWT claims; the
// control plane verifies the JWS payload bytes equal the challenge string.
// Re-sign with the exact payload below.
import { CompactSign } from "jose";

const compact = await new CompactSign(new TextEncoder().encode(challenge))
  .setProtectedHeader({ alg: algorithm })
  .sign(privateKey);

console.log(JSON.stringify(
  {
    algorithm,
    publicJwk,
    possessionProof: compact,
    note: "Paste publicJwk and possessionProof into the CAS admin console 'Add an issuer key' form.",
  },
  null,
  2,
));
