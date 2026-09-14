import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signOperatorWebhook, verifyOperatorWebhook,
} from "../src/operator-webhook.js";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

const key = new Uint8Array(32).fill(0x11);
const otherKey = new Uint8Array(32).fill(0x22);
const body = new TextEncoder().encode('{"eventId":"evt-1"}');
const issuedAt = new Date(1_700_000_000_000);

describe("operator webhook signing", () => {
  it("round-trips sign -> verify", async () => {
    const { timestamp, signature } = await signOperatorWebhook(body, key, issuedAt);
    expect(timestamp).toBe("1700000000");
    expect(await verifyOperatorWebhook(body, { timestamp, signature }, key, issuedAt)).toBe(true);
  });

  it("rejects a body byte change", async () => {
    const { timestamp, signature } = await signOperatorWebhook(body, key, issuedAt);
    const tampered = new Uint8Array(body);
    tampered[0] = tampered[0] ^ 0xff;
    expect(await verifyOperatorWebhook(tampered, { timestamp, signature }, key, issuedAt)).toBe(false);
  });

  it("rejects a different key", async () => {
    const { timestamp, signature } = await signOperatorWebhook(body, key, issuedAt);
    expect(await verifyOperatorWebhook(body, { timestamp, signature }, otherKey, issuedAt)).toBe(false);
  });

  it("enforces the +-300 second window", async () => {
    const { timestamp, signature } = await signOperatorWebhook(body, key, issuedAt);
    const headers = { timestamp, signature };
    expect(await verifyOperatorWebhook(body, headers, key, new Date(issuedAt.getTime() + 301_000))).toBe(false);
    expect(await verifyOperatorWebhook(body, headers, key, new Date(issuedAt.getTime() + 300_000))).toBe(true);
    expect(await verifyOperatorWebhook(body, headers, key, new Date(issuedAt.getTime() - 301_000))).toBe(false);
  });

  it.each<string | null>(["12a", "", null])("rejects a malformed timestamp %j", async (timestamp) => {
    const { signature } = await signOperatorWebhook(body, key, issuedAt);
    expect(await verifyOperatorWebhook(body, { timestamp, signature }, key, issuedAt)).toBe(false);
  });

  it.each<string | null>([null, "short", "A".repeat(44)])("rejects a null or wrong-length signature %j", async (signature) => {
    const { timestamp } = await signOperatorWebhook(body, key, issuedAt);
    expect(await verifyOperatorWebhook(body, { timestamp, signature }, key, issuedAt)).toBe(false);
  });

  it("requires HMAC keys of at least 32 bytes", async () => {
    const shortKey = new Uint8Array(31).fill(0x11);
    await expect(signOperatorWebhook(body, shortKey, issuedAt)).rejects.toBeInstanceOf(TypeError);
    const { timestamp, signature } = await signOperatorWebhook(body, key, issuedAt);
    expect(await verifyOperatorWebhook(body, { timestamp, signature }, shortKey, issuedAt)).toBe(false);
  });

  it("signs a domain-separated string, not the bare timestamp+digest", async () => {
    const { timestamp, signature } = await signOperatorWebhook(body, key, issuedAt);
    const digest = base64Url(createHash("sha256").update(body).digest());
    const bareMessage = `${timestamp}\n${digest}`;
    const bareSignature = base64Url(createHmac("sha256", Buffer.from(key)).update(bareMessage).digest());
    expect(bareSignature).not.toBe(signature);
  });
});
