import { expect, test, vi } from "vitest";
import { signOperatorWebhook } from "@unidocs/service-auth";
import { markdownOperatorWebhook } from "../src/operator-webhook.js";

const keyBytes = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const keyHex = Array.from(keyBytes, byte => byte.toString(16).padStart(2, "0")).join("");
const now = new Date("2026-09-14T12:00:00.000Z");
const env = { MARKDOWN_OPERATOR_HMAC_KEY: keyHex, MARKDOWN_OPERATOR_DOCUMENT_TYPE: "dt-markdown" };
const url = "https://markdown.test/tenants/t-local/documents/doc-1";

function event(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "unidocs-operator-webhook/v1", eventId: "evt-1", reason: "current_version.moved", tenantId: "t-local", documentId: "doc-1",
    documentType: "dt-markdown", currentVersionIdx: 0, newComments: [], occurredAt: now.toISOString(), ...overrides,
  };
}

async function signed(body: string, target = url, key = keyBytes): Promise<Request> {
  const { timestamp, signature } = await signOperatorWebhook(new TextEncoder().encode(body), key, now);
  return new Request(target, {
    method: "POST",
    headers: { "content-type": "application/json", "x-unidocs-webhook-timestamp": timestamp, "x-unidocs-webhook-signature": signature },
    body,
  });
}

function context() {
  const scheduled: Promise<unknown>[] = [];
  return { scheduled, ctx: { waitUntil: vi.fn((promise: Promise<unknown>) => { scheduled.push(promise); }), passThroughOnException: () => {} } as unknown as ExecutionContext };
}

test("answers a correctly signed event at once and schedules the work", async () => {
  const { scheduled, ctx } = context();
  const response = await markdownOperatorWebhook(await signed(JSON.stringify(event())), env, ctx, () => now);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ accepted: true, eventId: "evt-1" });
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]).toBeInstanceOf(Promise);
  await scheduled[0];
});

test("verifies the signature over the raw bytes, not a re-serialization", async () => {
  const { scheduled, ctx } = context();
  const response = await markdownOperatorWebhook(await signed(`  ${JSON.stringify(event(), null, 2)}\n`), env, ctx, () => now);
  expect(response?.status).toBe(200);
  expect(scheduled).toHaveLength(1);
  await scheduled[0];
});

test("rejects a bad signature with 401 and schedules nothing", async () => {
  const { scheduled, ctx } = context();
  const response = await markdownOperatorWebhook(await signed(JSON.stringify(event()), url, new Uint8Array(32).fill(9)), env, ctx, () => now);
  expect(response?.status).toBe(401);
  expect(await response?.json()).toEqual({ error: "operator_webhook_rejected" });
  expect(scheduled).toHaveLength(0);
});

test("rejects a signed event for another document type or another path with 400", async () => {
  const { scheduled, ctx } = context();
  const otherType = await markdownOperatorWebhook(await signed(JSON.stringify(event({ documentType: "dt-other" }))), env, ctx, () => now);
  expect(otherType?.status).toBe(400);
  const otherPath = await markdownOperatorWebhook(await signed(JSON.stringify(event()), "https://markdown.test/tenants/t-local/documents/doc-2"), env, ctx, () => now);
  expect(otherPath?.status).toBe(400);
  const malformed = await markdownOperatorWebhook(await signed(JSON.stringify(event({ reason: "unknown" }))), env, ctx, () => now);
  expect(malformed?.status).toBe(400);
  expect(scheduled).toHaveLength(0);
});

test("rejects an unreadable body with 400 before looking at the signature", async () => {
  const { scheduled, ctx } = context();
  const response = await markdownOperatorWebhook(new Request(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), env, ctx, () => now);
  expect(response?.status).toBe(400);
  const oversized = await markdownOperatorWebhook(await signed(JSON.stringify(event({ eventId: "e".repeat(70_000) }))), env, ctx, () => now);
  expect(oversized?.status).toBe(400);
  expect(scheduled).toHaveLength(0);
});

test("answers other methods with 405, missing configuration with 503, and ignores other paths", async () => {
  const { ctx } = context();
  const get = await markdownOperatorWebhook(new Request(url), env, ctx, () => now);
  expect(get?.status).toBe(405);
  expect(get?.headers.get("allow")).toBe("POST");
  expect((await markdownOperatorWebhook(await signed(JSON.stringify(event())), {}, ctx, () => now))?.status).toBe(503);
  expect(await markdownOperatorWebhook(new Request("https://markdown.test/tenants/t-local/sessions/s/query"), env, ctx, () => now)).toBeNull();
});

test("the scheduled work reads through the platform binding with the agent token", async () => {
  const requests: Request[] = [];
  const PLATFORM_SERVICE = { fetch: async (request: Request) => { requests.push(request); return new Response("{}", { status: 503 }); } } as unknown as Fetcher;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { scheduled, ctx } = context();
    const response = await markdownOperatorWebhook(await signed(JSON.stringify(event({ reason: "document.created", currentVersionIdx: null }))),
      { ...env, PLATFORM_SERVICE, PLATFORM_ORIGIN: "https://portal.test", PLATFORM_AGENT_TOKEN: "agent-token" }, ctx, () => now);
    expect(response?.status).toBe(200);
    await scheduled[0];
    expect(requests.map(request => request.url)).toEqual(["https://portal.test/api/v1/tenants/t-local/documents/doc-1"]);
    expect(requests[0].headers.get("authorization")).toBe("Bearer agent-token");
    expect(log.mock.calls.map(call => JSON.parse(String(call[0])).event)).toContain("markdown_operator_event_failed");
  } finally {
    log.mockRestore();
  }
});

test("without the Platform and Operator CAS bindings (the deployed v0 config) a signed event is accepted and its work fails in scope, logged", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { scheduled, ctx } = context();
    // Only the Plan 3 bindings: wrangler.toml deploys no PLATFORM_* or OPERATOR_CAS_*.
    const response = await markdownOperatorWebhook(await signed(JSON.stringify(event({ reason: "document.created", currentVersionIdx: null }))), env, ctx, () => now);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ accepted: true, eventId: "evt-1" });
    await expect(scheduled[0]).resolves.toBeUndefined();
    expect(log.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
      { event: "markdown_operator_event_failed", eventId: "evt-1", name: "TypeError", message: "Platform bindings are not configured" },
    ]);
  } finally {
    log.mockRestore();
  }
});
