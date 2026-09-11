import { describe, expect, test } from "vitest";
import { createOperatorProbeRequest, signOperatorProbeReceipt, verifyOperatorProbeReceipt } from "../src/index.js";

const keyBytes = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const otherKeyBytes = new TextEncoder().encode("abcdef0123456789abcdef0123456789");
const now = new Date("2026-09-11T12:00:00.000Z");

describe("Operator signed probe", () => {
  test("accepts a receipt bound to the one-time challenge and expected target", async () => {
    const request = await createOperatorProbeRequest({
      challenge: new Uint8Array(32).fill(7),
      declaredOperatorId: "markdown-primary",
      documentType: "markdown",
      configEtag: '"operator-v1"',
      issuedAt: now,
      ttlSeconds: 60,
      keyBytes,
    });
    const receipt = {
      protocol: "unidocs-operator-probe-receipt/v1" as const,
      challenge: request.body.challenge,
      declaredOperatorId: request.body.declaredOperatorId,
      documentType: request.body.documentType,
      configEtag: request.body.configEtag,
      issuedAt: request.body.issuedAt,
      expiresAt: request.body.expiresAt,
    };
    const signature = await signOperatorProbeReceipt(receipt, keyBytes);
    expect(await verifyOperatorProbeReceipt(receipt, signature, request.body, keyBytes, new Date("2026-09-11T12:00:30.000Z"))).toEqual(receipt);
  });

  test.each(["challenge", "operator", "documentType", "etag"] as const)("rejects a receipt with a mismatched %s", async field => {
    const request = await createOperatorProbeRequest({
      challenge: new Uint8Array(32).fill(7), declaredOperatorId: "markdown-primary", documentType: "markdown",
      configEtag: '"operator-v1"', issuedAt: now, ttlSeconds: 60, keyBytes,
    });
    const receipt = {
      protocol: "unidocs-operator-probe-receipt/v1" as const,
      challenge: field === "challenge" ? "other" : request.body.challenge,
      declaredOperatorId: field === "operator" ? "other" : request.body.declaredOperatorId,
      documentType: field === "documentType" ? "psd" : request.body.documentType,
      configEtag: field === "etag" ? '"operator-v2"' : request.body.configEtag,
      issuedAt: request.body.issuedAt,
      expiresAt: request.body.expiresAt,
    };
    const signature = await signOperatorProbeReceipt(receipt, keyBytes);
    await expect(verifyOperatorProbeReceipt(receipt, signature, request.body, keyBytes, now)).rejects.toMatchObject({ name: "OperatorProbeError" });
  });

  test("rejects a wrong key, tampered signature, and expired receipt", async () => {
    const request = await createOperatorProbeRequest({
      challenge: new Uint8Array(32).fill(7), declaredOperatorId: "markdown-primary", documentType: "markdown",
      configEtag: null, issuedAt: now, ttlSeconds: 60, keyBytes,
    });
    const receipt = {
      protocol: "unidocs-operator-probe-receipt/v1" as const, challenge: request.body.challenge,
      declaredOperatorId: request.body.declaredOperatorId, documentType: request.body.documentType,
      configEtag: request.body.configEtag, issuedAt: request.body.issuedAt, expiresAt: request.body.expiresAt,
    };
    const signature = await signOperatorProbeReceipt(receipt, keyBytes);
    await expect(verifyOperatorProbeReceipt(receipt, signature, request.body, otherKeyBytes, now)).rejects.toMatchObject({ name: "OperatorProbeError" });
    await expect(verifyOperatorProbeReceipt(receipt, `${signature.slice(0, -1)}A`, request.body, keyBytes, now)).rejects.toMatchObject({ name: "OperatorProbeError" });
    await expect(verifyOperatorProbeReceipt(receipt, signature, request.body, keyBytes, new Date("2026-09-11T12:01:01.000Z"))).rejects.toMatchObject({ name: "OperatorProbeError" });
  });
});