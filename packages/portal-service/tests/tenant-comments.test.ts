import { expect, test, vi } from "vitest";
import { createTenantThreadService, TENANT_LIMITS, type TenantContext, type TenantThreadRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const locationSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1" } as const;
const location = { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 120, end: 180 } };
const content = { text: "Still too long", richContent: null, attachments: [] };
const comment = { commentIdx: 3, baseVersionIdx: 7, content, location: null, authorId: "user-1", createdAt: "2026-09-11T00:00:00.000Z" };
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

test("appends a comment to an existing thread and returns the stored record", async () => {
  const { repository, service } = setup();
  const record = await service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location: null }, "retry-1");
  expect(record).toEqual(comment);
  const [command] = vi.mocked(repository.appendComment).mock.calls[0];
  expect(command).toMatchObject({ documentId: "doc-1", threadId: "th-1", key: "retry-1" });
});

test("the fingerprint distinguishes the same body appended to different threads", async () => {
  const { repository, service } = setup();
  await service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location: null }, "retry-1");
  await service.appendComment(context, "tenant-a", "doc-1", "th-2", { baseVersionIdx: 7, content, location: null }, "retry-1");
  const [first] = vi.mocked(repository.appendComment).mock.calls[0];
  const [second] = vi.mocked(repository.appendComment).mock.calls[1];
  expect(first.fingerprint).not.toBe(second.fingerprint);
});

test("the fingerprint is stable across retries of the same append and shaped like a hash", async () => {
  const { repository, service } = setup();
  await service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location: null }, "retry-1");
  await service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location: null }, "retry-2");
  const [first] = vi.mocked(repository.appendComment).mock.calls[0];
  const [second] = vi.mocked(repository.appendComment).mock.calls[1];
  expect(first.fingerprint).toBe(second.fingerprint);
  expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("appending checks the anchor, so a comment cannot name a version that does not exist", async () => {
  const { repository, service } = setup({ loadCommentAnchor: vi.fn(async () => null) });
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 99, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "not_found" });
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("there is no edit, delete or withdraw operation on the service surface", () => {
  const { service } = setup();
  expect(Object.keys(service).sort()).toEqual(["appendComment", "create", "get", "list"]);
});

test("reads both message sequences of a thread", async () => {
  const { service } = setup();
  await expect(service.get(context, "tenant-a", "doc-1", "th-1")).resolves.toEqual(thread);
  const missing = setup({ get: vi.fn(async () => null) });
  await expect(missing.service.get(context, "tenant-a", "doc-1", "th-9")).rejects.toMatchObject({ code: "not_found" });
});

test("passes the derived open filter and version filter through untouched", async () => {
  const { repository, service } = setup();
  await service.list(context, "tenant-a", "doc-1", { open: true, versionIdx: 5, limit: 10 });
  expect(repository.list).toHaveBeenCalledWith(context, "doc-1", { limit: 10, open: true, versionIdx: 5 });
  await service.list(context, "tenant-a", "doc-1", {});
  expect(repository.list).toHaveBeenLastCalledWith(context, "doc-1", {});
});

test.each([{ open: "true" }, { versionIdx: -1 }, { limit: 0 }])("rejects an unusable thread filter %#", async query => {
  const { repository, service } = setup();
  await expect(service.list(context, "tenant-a", "doc-1", query as never)).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.list).not.toHaveBeenCalled();
});

test("a mismatched path tenant is forbidden before the anchor is checked or the comment is stored", async () => {
  const { repository, service } = setup();
  await expect(service.appendComment(context, "tenant-b", "doc-1", "th-1", { baseVersionIdx: 7, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "forbidden" });
  expect(repository.loadCommentAnchor).not.toHaveBeenCalled();
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("a malformed thread id is rejected before the anchor is checked or the comment is stored", async () => {
  const { repository, service } = setup();
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th 1", { baseVersionIdx: 7, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.loadCommentAnchor).not.toHaveBeenCalled();
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("a malformed document id is rejected before the anchor is checked or the comment is stored", async () => {
  const { repository, service } = setup();
  await expect(service.appendComment(context, "tenant-a", "doc 1", "th-1", { baseVersionIdx: 7, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.loadCommentAnchor).not.toHaveBeenCalled();
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("appending requires an idempotency key before the anchor is checked or the comment is stored", async () => {
  const { repository, service } = setup();
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location: null }, "")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.loadCommentAnchor).not.toHaveBeenCalled();
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("appending rejects an unexpected body field before the anchor is checked or the comment is stored", async () => {
  const { repository, service } = setup();
  const body = { baseVersionIdx: 7, content, location: null, threadId: "th-1" };
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th-1", body, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.loadCommentAnchor).not.toHaveBeenCalled();
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test.each([
  { text: "a".repeat(TENANT_LIMITS.messageText + 1), richContent: null, attachments: [] },
  { text: "ok", richContent: null, attachments: Array.from({ length: TENANT_LIMITS.attachments + 1 }, () => ({ blobHash: "b3:9f2c", size: 1, contentType: "image/webp" })) },
])("appending rejects a message beyond its bounds %# before the comment is stored", async oversized => {
  const { repository, service } = setup();
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content: oversized, location: null }, "retry-1")).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("an appended comment's location must name the same contract revision as the version it anchors to", async () => {
  const { repository, service } = setup();
  const mismatched = { ...location, documentContractIdx: 1 };
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location: mismatched }, "retry-1")).rejects.toMatchObject({ code: "location_contract_violation" });
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("an appended comment's location must pass that revision's location schema", async () => {
  const validateLocation = vi.fn(() => false);
  const { repository, service } = setup({}, validateLocation);
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location }, "retry-1")).rejects.toMatchObject({ code: "location_contract_violation" });
  expect(validateLocation).toHaveBeenCalledWith(location, locationSchema);
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("a mismatched path tenant is forbidden before a thread read is attempted", async () => {
  const { repository, service } = setup();
  await expect(service.get(context, "tenant-b", "doc-1", "th-1")).rejects.toMatchObject({ code: "forbidden" });
  expect(repository.get).not.toHaveBeenCalled();
});

test("a malformed document id is rejected before a thread listing is attempted", async () => {
  const { repository, service } = setup();
  await expect(service.list(context, "tenant-a", "doc 1", {})).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.list).not.toHaveBeenCalled();
});

test("a mismatched path tenant is forbidden before a thread listing is attempted", async () => {
  const { repository, service } = setup();
  await expect(service.list(context, "tenant-b", "doc-1", {})).rejects.toMatchObject({ code: "forbidden" });
  expect(repository.list).not.toHaveBeenCalled();
});
