import { expect, test, vi } from "vitest";
import { createTenantThreadService, TENANT_LIMITS, type TenantContext, type TenantThreadRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const locationSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1" } as const;
const location = { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 120, end: 180 } };
const content = { text: "Please shorten this", richContent: null, attachments: [] };
const comment = { commentIdx: 0, baseVersionIdx: 5, content, location, authorId: "user-1", createdAt: "2026-09-11T00:00:00.000Z" };
const thread = { threadId: "th-1", comments: [comment], replies: [] };

function setup(overrides: Partial<TenantThreadRepository> = {}, validateLocation = vi.fn(() => true)) {
  const repository: TenantThreadRepository = {
    loadCommentAnchor: vi.fn(async () => ({ documentContractIdx: 0, locationSchema })),
    list: vi.fn(async () => ({ items: [{ threadId: "th-1" }], nextCursor: null })),
    create: vi.fn(async () => thread),
    get: vi.fn(async () => thread),
    appendComment: vi.fn(async () => comment),
    ...overrides,
  };
  return { repository, validateLocation, service: createTenantThreadService(repository, { validateLocation }) };
}

test("anchors a new thread to an existing version and fingerprints the request", async () => {
  const { repository, service } = setup();
  await service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location }, "retry-1");
  expect(repository.loadCommentAnchor).toHaveBeenCalledWith(context, "doc-1", 5);
  const [command] = vi.mocked(repository.create).mock.calls[0];
  expect(command).toMatchObject({ documentId: "doc-1", key: "retry-1" });
  expect(command.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("a comment does not have to be based on current, so an older base version is accepted", async () => {
  const { repository, service } = setup();
  await service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 0, content, location: null }, "retry-1");
  expect(repository.loadCommentAnchor).toHaveBeenCalledWith(context, "doc-1", 0);
  expect(repository.create).toHaveBeenCalled();
});

test("reports an unknown base version as not found rather than inventing one", async () => {
  const { repository, service } = setup({ loadCommentAnchor: vi.fn(async () => null) });
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 99, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "not_found" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("a location must name the same contract revision as the version it anchors to", async () => {
  const { repository, service } = setup();
  const mismatched = { ...location, documentContractIdx: 1 };
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location: mismatched }, "retry-1")).rejects.toMatchObject({ code: "location_contract_violation" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("a location must pass that revision's location schema", async () => {
  const validateLocation = vi.fn(() => false);
  const { repository, service } = setup({}, validateLocation);
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location }, "retry-1")).rejects.toMatchObject({ code: "location_contract_violation" });
  expect(validateLocation).toHaveBeenCalledWith(location, locationSchema);
  expect(repository.create).not.toHaveBeenCalled();
});

test("a document-level thread carries no location and needs no schema check", async () => {
  const { validateLocation, service } = setup();
  await service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location: null }, "retry-1");
  expect(validateLocation).not.toHaveBeenCalled();
});

test("attachments cannot replace the body", async () => {
  const { repository, service } = setup();
  const empty = { text: null, richContent: null, attachments: [{ blobHash: "b3:9f2c", size: 12, contentType: "image/webp" }] };
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content: empty, location: null }, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test.each([
  { text: "a".repeat(TENANT_LIMITS.messageText + 1), richContent: null, attachments: [] },
  { text: "ok", richContent: null, attachments: Array.from({ length: TENANT_LIMITS.attachments + 1 }, () => ({ blobHash: "b3:9f2c", size: 1, contentType: "image/webp" })) },
])("rejects a message beyond its bounds %#", async oversized => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content: oversized, location: null }, "retry-1")).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("rejects a location payload larger than the bound", async () => {
  const { service } = setup();
  const huge = { ...location, payload: { note: "a".repeat(TENANT_LIMITS.locationPayloadBytes + 1) } };
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location: huge }, "retry-1")).rejects.toMatchObject({ code: "limit_exceeded" });
});

test.each([
  { content, location: null },
  { baseVersionIdx: -1, content, location: null },
  { baseVersionIdx: 5, location: null },
  { baseVersionIdx: 5, content, location: null, threadId: "th-1" },
])("rejects an unusable thread request %#", async body => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", "doc-1", body, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("thread creation requires an idempotency key", async () => {
  const { service } = setup();
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location: null }, "")).rejects.toMatchObject({ code: "invalid_request" });
});

test("a mismatched path tenant is forbidden before any storage call", async () => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-b", "doc-1", { baseVersionIdx: 5, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "forbidden" });
  expect(repository.loadCommentAnchor).not.toHaveBeenCalled();
});

test("a malformed document id is rejected before any storage call", async () => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", "doc 1", { baseVersionIdx: 5, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.loadCommentAnchor).not.toHaveBeenCalled();
});

test("a lone surrogate in a new thread's message text is rejected as invalid, not thrown as a bare error", async () => {
  const { repository, service } = setup();
  const surrogate = { text: "\uD800", richContent: null, attachments: [] };
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content: surrogate, location: null }, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("a lone surrogate in an appended comment's message text is rejected as invalid, not thrown as a bare error", async () => {
  const { repository, service } = setup();
  const surrogate = { text: "\uD800", richContent: null, attachments: [] };
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 5, content: surrogate, location: null }, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.appendComment).not.toHaveBeenCalled();
});
