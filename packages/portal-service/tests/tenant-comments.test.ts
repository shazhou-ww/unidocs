import { expect, test, vi } from "vitest";
import { createTenantThreadService, type TenantContext, type TenantThreadRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const locationSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1" } as const;
const content = { text: "Still too long", richContent: null, attachments: [] };
const comment = { commentIdx: 3, baseVersionIdx: 7, content, location: null, authorId: "user-1", createdAt: "2026-09-11T00:00:00.000Z" };
const thread = { threadId: "th-1", comments: [comment], replies: [] };

function setup(overrides: Partial<TenantThreadRepository> = {}) {
  const repository: TenantThreadRepository = {
    loadCommentAnchor: vi.fn(async () => ({ documentContractIdx: 0, locationSchema })),
    list: vi.fn(async () => ({ items: [{ threadId: "th-1" }], nextCursor: null })),
    create: vi.fn(async () => thread),
    get: vi.fn(async () => thread),
    appendComment: vi.fn(async () => comment),
    ...overrides,
  };
  return { repository, service: createTenantThreadService(repository, { validateLocation: () => true }) };
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
