/**
 * `scripts/cas-possession-sign.mjs` 的往返测试。
 *
 * 断言直接打在控制面的真实校验器上（`validatePublicJwk` /
 * `verifyPossessionProof`），而不是复述脚本自己的逻辑 —— 这个脚本存在的
 * 唯一意义就是产出那两个函数会接受的东西。
 *
 * 挡住的两个真实缺陷：
 *   1. `importPKCS8()` 在 jose 6 默认返回不可导出的 CryptoKey，
 *      `exportJWK()` 直接抛 "non-extractable CryptoKey" —— 脚本跑不起来。
 *   2. `exportJWK(privateKey)` 给的是**私钥** JWK（含 d）。脚本原本把它
 *      当 publicJwk 打出来并让人粘进控制台，等于把私钥发给服务端，
 *      possession proof 的全部意义当场归零。
 */
import { generateKeyPair, exportPKCS8 } from "jose";
import { describe, expect, test } from "vitest";
import {
  validatePublicJwk,
  verifyPossessionProof,
} from "../../../unicas-packages/control-plane/src/possession.ts";
import {
  signPossessionChallenge,
} from "../../../scripts/cas-possession-sign.mjs";

const CHALLENGE = [
  "cas-possession-v1",
  "nonce-abc123",
  "cas_EM1_egj6I-ea",
  "az-rotate-1",
  "ES256",
].join("\n");

async function es256Pem() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  return exportPKCS8(pair.privateKey);
}

describe("cas-possession-sign", () => {
  test("产出的 publicJwk 被控制面接受", async () => {
    const result = await signPossessionChallenge({
      challenge: CHALLENGE,
      privateKeyPem: await es256Pem(),
    });
    expect(validatePublicJwk(result.publicJwk, "ES256")).toBeNull();
  });

  test("publicJwk 不含任何私钥材料", async () => {
    const result = await signPossessionChallenge({
      challenge: CHALLENGE,
      privateKeyPem: await es256Pem(),
    });
    for (const field of ["d", "p", "q", "dp", "dq", "qi", "k", "oth"]) {
      expect(result.publicJwk).not.toHaveProperty(field);
    }
    expect(result.publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  test("possession proof 能被控制面验过", async () => {
    const result = await signPossessionChallenge({
      challenge: CHALLENGE,
      privateKeyPem: await es256Pem(),
    });
    await expect(verifyPossessionProof({
      challenge: CHALLENGE,
      algorithm: "ES256",
      publicJwk: result.publicJwk,
      possessionProof: result.possessionProof,
    })).resolves.toBe(true);
  });

  test("签的是挑战串本身:换一个挑战串就验不过", async () => {
    const result = await signPossessionChallenge({
      challenge: CHALLENGE,
      privateKeyPem: await es256Pem(),
    });
    await expect(verifyPossessionProof({
      challenge: CHALLENGE.replace("nonce-abc123", "nonce-other"),
      algorithm: "ES256",
      publicJwk: result.publicJwk,
      possessionProof: result.possessionProof,
    })).resolves.toBe(false);
  });

  test("别人的公钥验不过:证明它真的绑定私钥", async () => {
    const result = await signPossessionChallenge({
      challenge: CHALLENGE,
      privateKeyPem: await es256Pem(),
    });
    const stranger = await signPossessionChallenge({
      challenge: CHALLENGE,
      privateKeyPem: await es256Pem(),
    });
    await expect(verifyPossessionProof({
      challenge: CHALLENGE,
      algorithm: "ES256",
      publicJwk: stranger.publicJwk,
      possessionProof: result.possessionProof,
    })).resolves.toBe(false);
  });
});
