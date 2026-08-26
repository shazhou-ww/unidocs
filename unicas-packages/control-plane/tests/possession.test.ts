import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { describe, expect, test } from "vitest";
import {
  buildPossessionChallenge,
  parsePossessionChallenge,
  validatePublicJwk,
  verifyPossessionProof,
} from "../src/index.js";

async function es256Fixture() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  return {
    publicJwk: await exportJWK(publicKey),
    privateKey,
    sign: async (challenge: string) =>
      new CompactSign(new TextEncoder().encode(challenge))
        .setProtectedHeader({ alg: "ES256" })
        .sign(privateKey),
  };
}

describe("issuer key possession proof", () => {
  test("a correctly signed challenge verifies", async () => {
    const fixture = await es256Fixture();
    const challenge = buildPossessionChallenge({
      nonce: "nonce-1",
      stackId: "cas_stack",
      kid: "k1",
      algorithm: "ES256",
    });
    const proof = await fixture.sign(challenge);
    await expect(verifyPossessionProof({
      challenge,
      algorithm: "ES256",
      publicJwk: fixture.publicJwk,
      possessionProof: proof,
    })).resolves.toBe(true);
  });

  test("a signature from a different key fails", async () => {
    const fixture = await es256Fixture();
    const other = await es256Fixture();
    const challenge = buildPossessionChallenge({
      nonce: "nonce-1",
      stackId: "cas_stack",
      kid: "k1",
      algorithm: "ES256",
    });
    const proof = await fixture.sign(challenge);
    await expect(verifyPossessionProof({
      challenge,
      algorithm: "ES256",
      publicJwk: other.publicJwk,
      possessionProof: proof,
    })).resolves.toBe(false);
  });

  test("a signature over a different challenge string fails", async () => {
    const fixture = await es256Fixture();
    const challenge = buildPossessionChallenge({
      nonce: "nonce-1",
      stackId: "cas_stack",
      kid: "k1",
      algorithm: "ES256",
    });
    const other = buildPossessionChallenge({
      nonce: "nonce-2",
      stackId: "cas_stack",
      kid: "k1",
      algorithm: "ES256",
    });
    const proof = await fixture.sign(challenge);
    await expect(verifyPossessionProof({
      challenge: other,
      algorithm: "ES256",
      publicJwk: fixture.publicJwk,
      possessionProof: proof,
    })).resolves.toBe(false);
  });

  test("malformed proofs fail closed", async () => {
    const fixture = await es256Fixture();
    const challenge = buildPossessionChallenge({
      nonce: "nonce-1",
      stackId: "cas_stack",
      kid: "k1",
      algorithm: "ES256",
    });
    await expect(verifyPossessionProof({
      challenge,
      algorithm: "ES256",
      publicJwk: fixture.publicJwk,
      possessionProof: "not-a-jws",
    })).resolves.toBe(false);
    await expect(verifyPossessionProof({
      challenge,
      algorithm: "ES256",
      publicJwk: fixture.publicJwk,
      possessionProof: "a.b",
    })).resolves.toBe(false);
  });

  test("challenge strings parse back to their fields", () => {
    const challenge = buildPossessionChallenge({
      nonce: "n",
      stackId: "cas_s",
      kid: "k",
      algorithm: "EdDSA",
    });
    expect(parsePossessionChallenge(challenge)).toEqual({
      nonce: "n",
      stackId: "cas_s",
      kid: "k",
      algorithm: "EdDSA",
    });
    expect(parsePossessionChallenge("bogus")).toBeNull();
    expect(parsePossessionChallenge("cas-possession-v2\nn\ns\nk\nES256")).toBeNull();
    expect(parsePossessionChallenge("cas-possession-v1\nn\ns\nk\nHS256")).toBeNull();
  });

  test("public JWK validation rejects private material and enforces fields", () => {
    expect(validatePublicJwk({ kty: "EC", crv: "P-256", x: "a", y: "b" }, "ES256")).toBeNull();
    expect(validatePublicJwk({ kty: "EC", crv: "P-256", x: "a", y: "b", d: "secret" }, "ES256")).not.toBeNull();
    expect(validatePublicJwk({ kty: "EC", crv: "P-256", x: "a" }, "ES256")).not.toBeNull();
    expect(validatePublicJwk({ kty: "EC", crv: "P-384", x: "a", y: "b" }, "ES256")).not.toBeNull();
    expect(validatePublicJwk({ kty: "RSA", n: "a", e: "AQAB" }, "RS256")).toBeNull();
    expect(validatePublicJwk({ kty: "OKP", crv: "Ed25519", x: "a" }, "EdDSA")).toBeNull();
    expect(validatePublicJwk({ kty: "RSA", n: "a", e: "AQAB" }, "ES256")).not.toBeNull();
    expect(validatePublicJwk("jwk", "ES256")).not.toBeNull();
  });
});
