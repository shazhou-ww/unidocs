import { expect, test } from "vitest";
import { createOperatorProbeRequest, verifyOperatorProbeReceipt } from "@unidocs/service-auth";
import { markdownOperatorEndpoint } from "../src/operator-endpoint.js";

const keyBytes = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const keyHex = Array.from(keyBytes, byte => byte.toString(16).padStart(2, "0")).join("");
const now = new Date("2026-09-11T12:00:00.000Z");
const env = { MARKDOWN_OPERATOR_HMAC_KEY: keyHex, MARKDOWN_OPERATOR_DOCUMENT_TYPE: "dt-markdown" };

test("serves the fixed Markdown Operator descriptor with a strong config ETag", async () => {
  const response = await markdownOperatorEndpoint(new Request("https://markdown.test/.well-known/unidocs-operator"), env, () => now);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("etag")).toMatch(/^"sha256-[A-Za-z0-9_-]{43}"$/);
  expect(await response?.json()).toEqual({
    protocol: "unidocs-operator/v1", declaredOperatorId: "markdown-primary", displayName: "Markdown Operator",
    supportedDocumentTypes: ["dt-markdown"], supportedDocumentContracts: { "dt-markdown": [0] },
  });
});

test("verifies the Portal challenge and returns a signed bound receipt", async () => {
  const discovery = await markdownOperatorEndpoint(new Request("https://markdown.test/.well-known/unidocs-operator"), env, () => now);
  const probe = await createOperatorProbeRequest({ challenge: new Uint8Array(32).fill(7), declaredOperatorId: "markdown-primary", documentType: "dt-markdown",
    configEtag: discovery!.headers.get("etag"), issuedAt: now, ttlSeconds: 60, keyBytes });
  const response = await markdownOperatorEndpoint(new Request("https://markdown.test/operator/probe", {
    method: "POST", headers: { "content-type": "application/json", "x-unidocs-probe-signature": probe.signature }, body: JSON.stringify(probe.body),
  }), env, () => now);
  expect(response?.status).toBe(200);
  const receipt = await response?.json();
  expect(await verifyOperatorProbeReceipt(receipt, response!.headers.get("x-unidocs-probe-signature")!, probe.body, keyBytes, now)).toEqual(receipt);
  expect(response?.headers.get("cache-control")).toBe("no-store, no-transform");
});

test("fails closed for missing configuration, bad signatures, and ambiguous JSON", async () => {
  expect((await markdownOperatorEndpoint(new Request("https://markdown.test/.well-known/unidocs-operator"), {}, () => now))?.status).toBe(503);
  const body = '{"protocol":"unidocs-operator-probe-request/v1","protocol":"other"}';
  const response = await markdownOperatorEndpoint(new Request("https://markdown.test/operator/probe", {
    method: "POST", headers: { "content-type": "application/json", "x-unidocs-probe-signature": "a".repeat(43) }, body,
  }), env, () => now);
  expect(response?.status).toBe(401);
  expect(await response?.json()).toEqual({ error: "operator_probe_rejected" });
});