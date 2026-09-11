import { expect, test, vi } from "vitest";
import { createTenantVersionService, type TenantContext, type TenantVersionRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const version = {
  versionIdx: 7, parentVersionIdx: 6, documentContractIdx: 0, authorAgentId: "op-markdown",
  submissionId: "sub-1", addressedComments: [{ threadId: "th-2", commentIdx: 3, baseVersionIdx: 5 }],
  createdAt: "2026-09-11T00:00:00.000Z",
};
const body = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });

function setup(overrides: Partial<TenantVersionRepository> = {}) {
  const repository: TenantVersionRepository = {
    list: vi.fn(async () => ({ items: [version], nextCursor: null })),
    get: vi.fn(async () => version),
    readSnapshot: vi.fn(async () => ({ documentType: "markdown", body: body() })),
    ...overrides,
  };
  return { repository, service: createTenantVersionService(repository) };
}

test("version metadata carries both graphs and never the snapshot", async () => {
  const { service } = setup();
  const record = await service.get(context, "tenant-a", "doc-1", 7);
  expect(record).toMatchObject({ parentVersionIdx: 6, addressedComments: [{ threadId: "th-2", commentIdx: 3, baseVersionIdx: 5 }] });
  expect(record).not.toHaveProperty("snapshot");
});

test("derives the snapshot media type from the document type rather than trusting a stored string", async () => {
  const { service } = setup();
  const snapshot = await service.getSnapshot(context, "tenant-a", "doc-1", 7);
  expect(snapshot.contentType).toBe("application/vnd.unidocs.markdown.snapshot+cbor;version=1");
  expect(snapshot.body).toBeInstanceOf(ReadableStream);
});

test("rejects a document type the media type cannot be derived from, and cancels the dropped stream", async () => {
  const cancel = vi.fn();
  const undeliverable = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel });
  const { service } = setup({ readSnapshot: vi.fn(async () => ({ documentType: "PSD document", body: undeliverable })) });
  await expect(service.getSnapshot(context, "tenant-a", "doc-1", 7)).rejects.toMatchObject({ code: "content_unavailable" });
  expect(cancel).toHaveBeenCalledOnce();
});

test("reports missing versions and missing snapshot bytes distinctly", async () => {
  const missingVersion = setup({ get: vi.fn(async () => null) });
  await expect(missingVersion.service.get(context, "tenant-a", "doc-1", 7)).rejects.toMatchObject({ code: "not_found" });
  const missingSnapshot = setup({ readSnapshot: vi.fn(async () => null) });
  await expect(missingSnapshot.service.getSnapshot(context, "tenant-a", "doc-1", 7)).rejects.toMatchObject({ code: "not_found" });
});

test.each([-1, 1.5, "7"])("rejects a version index that is not zero-based %#", async versionIdx => {
  const { repository, service } = setup();
  await expect(service.get(context, "tenant-a", "doc-1", versionIdx as number)).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.get).not.toHaveBeenCalled();
});

test.each([-1, 1.5, "7"])("rejects a snapshot version index that is not zero-based %#", async versionIdx => {
  const { repository, service } = setup();
  await expect(service.getSnapshot(context, "tenant-a", "doc-1", versionIdx as number)).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.readSnapshot).not.toHaveBeenCalled();
});

test("pages version metadata and refuses another tenant's document", async () => {
  const { repository, service } = setup();
  await service.list(context, "tenant-a", "doc-1", { limit: 50 });
  expect(repository.list).toHaveBeenCalledWith(context, "doc-1", { limit: 50 });
  await expect(service.list(context, "tenant-b", "doc-1")).rejects.toMatchObject({ code: "forbidden" });
});

test("refuses another tenant's document when reading version metadata", async () => {
  const { repository, service } = setup();
  await expect(service.get(context, "tenant-b", "doc-1", 7)).rejects.toMatchObject({ code: "forbidden" });
  expect(repository.get).not.toHaveBeenCalled();
});

test("refuses another tenant's document when reading snapshot bytes", async () => {
  const { repository, service } = setup();
  await expect(service.getSnapshot(context, "tenant-b", "doc-1", 7)).rejects.toMatchObject({ code: "forbidden" });
  expect(repository.readSnapshot).not.toHaveBeenCalled();
});
