import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorWebhookRequestSchema } from "@unidocs/protocol-platform";
import { OperatorWebhookSignatureHeader, OperatorWebhookTimestampHeader, verifyOperatorWebhook } from "@unidocs/service-auth";
import { createMarkdownOperatorValidationTarget, MARKDOWN_OPERATOR_BASE_URL } from "../../src/operator-validation-target.js";
import { createOperatorDispatcher } from "../../src/tenant/operator-dispatch.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const KEY_HEX = "0123456789abcdef".repeat(4);
const KEY = Uint8Array.from(KEY_HEX.match(/../g)!, pair => Number.parseInt(pair, 16));
const NOW = new Date("2026-09-14T12:00:00.000Z");

let real: RealD1;
let service: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>> };
let requests: { request: Request; body: Uint8Array }[];
let logged: { error: ReturnType<typeof vi.spyOn>; log: ReturnType<typeof vi.spyOn> };

beforeEach(async () => {
  real = await startRealD1();
  requests = [];
  // Records the request and, by default, accepts it by echoing its eventId.
  service = {
    fetch: vi.fn(async (request: Request) => {
      const body = new Uint8Array(await request.arrayBuffer());
      requests.push({ request, body });
      const { eventId } = JSON.parse(new TextDecoder().decode(body)) as { eventId: string };
      return Response.json({ accepted: true, eventId });
    }),
  };
  logged = {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await real.dispose();
});

function events(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

function dispatcher(overrides: { target?: () => ReturnType<typeof createMarkdownOperatorValidationTarget> } = {}) {
  let ids = 0;
  return createOperatorDispatcher({
    database: real.db,
    target: overrides.target ?? (() => createMarkdownOperatorValidationTarget(service as unknown as Fetcher, KEY_HEX)),
    now: () => NOW,
    id: () => `evt-${++ids}`,
  });
}

async function seedType(registration: Record<string, unknown>) {
  await real.db.prepare(
    "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES ('markdown', 'markdown', 1, ?, '2026-09-14T00:00:00.000Z')",
  ).bind(JSON.stringify(registration)).run();
}

const withOperator = { documentType: "markdown", builtinOperator: { operatorId: "op-1", baseUrl: MARKDOWN_OPERATOR_BASE_URL } };

async function seedDocument(documentId: string, currentVersionIdx: number | null = null) {
  await real.db.prepare(
    "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t-local', ?, 'Doc', 'markdown', ?, 0)",
  ).bind(documentId, currentVersionIdx).run();
}

async function seedThread(documentId: string, threadId: string, commentCount: number) {
  await real.db.prepare("INSERT INTO portal_threads (tenant_id, document_id, thread_id, created_at) VALUES ('t-local', ?, ?, 0)").bind(documentId, threadId).run();
  for (let commentIdx = 0; commentIdx < commentCount; commentIdx += 1) {
    await real.db.prepare(
      `INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
       VALUES ('t-local', ?, ?, ?, 0, '{"text":"c","richContent":null,"attachments":[]}', NULL, 'user-1', 0)`,
    ).bind(documentId, threadId, commentIdx).run();
  }
}

async function seedReply(documentId: string, threadId: string, replyIdx: number, respondThrough: number) {
  await real.db.prepare(
    `INSERT INTO portal_replies (tenant_id, document_id, thread_id, reply_idx, respond_through_comment_idx, content_json, result_locations_json, author_agent_id, submission_id, created_at)
     VALUES ('t-local', ?, ?, ?, ?, '{"text":"r","richContent":null,"attachments":[]}', '[]', 'agent:markdown-primary', ?, 0)`,
  ).bind(documentId, threadId, replyIdx, respondThrough, `sub-${replyIdx}`).run();
}

function sentPayload(index = 0) {
  return OperatorWebhookRequestSchema.parse(JSON.parse(new TextDecoder().decode(requests[index].body)));
}

describe("operator webhook dispatch", () => {
  it("posts a signed document.created event to the type's builtin Operator", async () => {
    await seedType(withOperator);
    await seedDocument("doc-1");

    await expect(dispatcher()({ kind: "document.created", tenantId: "t-local", documentId: "doc-1" })).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    const { request, body } = requests[0];
    expect(request.url).toBe(`${MARKDOWN_OPERATOR_BASE_URL}/tenants/t-local/documents/doc-1`);
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(sentPayload()).toEqual({
      protocol: "unidocs-operator-webhook/v1", eventId: "evt-1", reason: "document.created",
      tenantId: "t-local", documentId: "doc-1", documentType: "markdown",
      currentVersionIdx: null, newComments: [], occurredAt: "2026-09-14T12:00:00.000Z",
    });
    const headers = { timestamp: request.headers.get(OperatorWebhookTimestampHeader), signature: request.headers.get(OperatorWebhookSignatureHeader) };
    expect(await verifyOperatorWebhook(body, headers, KEY, NOW)).toBe(true);
    expect(await verifyOperatorWebhook(body, headers, new Uint8Array(32).fill(9), NOW)).toBe(false);
    expect(events(logged.error)).toEqual([]);
  });

  it("percent-encodes the tenant and document segments of the webhook path", async () => {
    await seedType(withOperator);
    await seedDocument("doc/1 x");
    await dispatcher()({ kind: "document.created", tenantId: "t-local", documentId: "doc/1 x" });
    expect(events(logged.error)).toEqual([]);
    expect(requests[0].request.url).toBe(`${MARKDOWN_OPERATOR_BASE_URL}/tenants/t-local/documents/doc%2F1%20x`);
  });

  it("carries the current pointer on current_version.moved", async () => {
    await seedType(withOperator);
    await seedDocument("doc-1", 3);
    await dispatcher()({ kind: "current_version.moved", tenantId: "t-local", documentId: "doc-1" });
    expect(sentPayload()).toMatchObject({ reason: "current_version.moved", currentVersionIdx: 3, newComments: [] });
  });

  it("derives the thread's acknowledged watermark for comment.appended", async () => {
    await seedType(withOperator);
    await seedDocument("doc-1", 0);
    await seedThread("doc-1", "th-1", 3);
    await seedReply("doc-1", "th-1", 0, 0);
    await seedReply("doc-1", "th-1", 1, 1);
    await seedThread("doc-1", "th-2", 1);

    const dispatch = dispatcher();
    await dispatch({ kind: "comment.appended", tenantId: "t-local", documentId: "doc-1", threadId: "th-1", commentIdx: 2 });
    await dispatch({ kind: "comment.appended", tenantId: "t-local", documentId: "doc-1", threadId: "th-2", commentIdx: 0 });

    expect(events(logged.error)).toEqual([]);
    expect(sentPayload(0)).toMatchObject({
      eventId: "evt-1", reason: "comment.appended", currentVersionIdx: 0,
      newComments: [{ threadId: "th-1", commentIdx: 2, acknowledgedCommentIdx: 1 }],
    });
    expect(sentPayload(1).newComments).toEqual([{ threadId: "th-2", commentIdx: 0, acknowledgedCommentIdx: null }]);
  });

  it("logs a failure and does not throw when the Operator acknowledges a different eventId", async () => {
    await seedType(withOperator);
    await seedDocument("doc-1");
    service.fetch.mockImplementation(async () => Response.json({ accepted: true, eventId: "evt-other" }));

    await expect(dispatcher()({ kind: "document.created", tenantId: "t-local", documentId: "doc-1" })).resolves.toBeUndefined();

    expect(service.fetch).toHaveBeenCalledTimes(1);
    const failures = events(logged.error);
    expect(failures).toEqual([{
      event: "portal_operator_webhook_failed", eventId: "evt-1", documentId: "doc-1", name: expect.any(String), message: expect.any(String),
    }]);
  });

  it.each([
    ["a non-200 answer", async () => new Response("no", { status: 500 })],
    ["a body that is not the response schema", async () => Response.json({ accepted: false, eventId: "evt-1" })],
    ["a transport failure", async () => { throw new Error("upstream-secret"); }],
  ])("logs a failure and does not throw on %s", async (_label, answer) => {
    await seedType(withOperator);
    await seedDocument("doc-1");
    service.fetch.mockImplementation(answer);
    await expect(dispatcher()({ kind: "document.created", tenantId: "t-local", documentId: "doc-1" })).resolves.toBeUndefined();
    expect(events(logged.error).map(line => line.event)).toEqual(["portal_operator_webhook_failed"]);
    expect(JSON.stringify(logged.error.mock.calls)).not.toContain("upstream-secret");
  });

  it("logs a failure and does not throw when the Operator target cannot be built", async () => {
    await seedType(withOperator);
    await seedDocument("doc-1");
    const target = vi.fn(() => { throw new TypeError("Markdown Operator validation is not configured"); });
    await expect(dispatcher({ target })({ kind: "document.created", tenantId: "t-local", documentId: "doc-1" })).resolves.toBeUndefined();
    expect(events(logged.error)).toEqual([expect.objectContaining({ event: "portal_operator_webhook_failed", documentId: "doc-1", name: "TypeError" })]);
  });

  it("logs a failure when no key is configured for the Operator's baseUrl", async () => {
    await seedType({ ...withOperator, builtinOperator: { operatorId: "op-1", baseUrl: "https://elsewhere.example" } });
    await seedDocument("doc-1");
    await dispatcher()({ kind: "document.created", tenantId: "t-local", documentId: "doc-1" });
    expect(service.fetch).not.toHaveBeenCalled();
    expect(events(logged.error).map(line => line.event)).toEqual(["portal_operator_webhook_failed"]);
  });

  it("sends nothing and logs a skip when the type has no builtin Operator", async () => {
    await seedType({ documentType: "markdown" });
    await seedDocument("doc-1");
    const target = vi.fn(() => createMarkdownOperatorValidationTarget(service as unknown as Fetcher, KEY_HEX));

    await expect(dispatcher({ target })({ kind: "document.created", tenantId: "t-local", documentId: "doc-1" })).resolves.toBeUndefined();

    expect(service.fetch).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
    expect(events(logged.log)).toEqual([expect.objectContaining({ event: "portal_operator_webhook_skipped", documentId: "doc-1" })]);
    expect(events(logged.error)).toEqual([]);
  });

  it("logs a failure and does not throw when the document is missing", async () => {
    await seedType(withOperator);
    await dispatcher()({ kind: "document.created", tenantId: "t-local", documentId: "doc-missing" });
    expect(service.fetch).not.toHaveBeenCalled();
    expect(events(logged.error).map(line => line.event)).toEqual(["portal_operator_webhook_failed"]);
  });
});
