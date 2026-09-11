import { expect, test, vi } from "vitest";
import { createTenantDocumentService, TENANT_LIMITS, type TenantContext, type TenantDocumentRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };

function setup(overrides: Partial<TenantDocumentRepository> = {}) {
  const repository: TenantDocumentRepository = {
    create: vi.fn(async command => command.document),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    moveCurrentVersion: vi.fn(async () => ({ documentId: "doc-1", name: "Notes", documentType: "markdown", currentVersionIdx: 3, createdAt: "2026-09-11T00:00:00.000Z" })),
    listAuditEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides,
  };
  return {
    repository,
    service: createTenantDocumentService(repository, { now: () => new Date("2026-09-11T00:00:00.000Z"), id: () => "00000000-0000-4000-8000-000000000000" }),
  };
}

test("creates an uninitialised document and audits its creation", async () => {
  const { repository, service } = setup();
  const document = await service.create(context, "tenant-a", { documentType: "markdown", name: "Notes" }, "retry-1", "request-1");
  expect(document).toMatchObject({ documentId: "doc-00000000-0000-4000-8000-000000000000", name: "Notes", documentType: "markdown", currentVersionIdx: null });
  const [command] = vi.mocked(repository.create).mock.calls[0];
  expect(command.key).toBe("retry-1");
  expect(command.audit).toMatchObject({ actorId: "user-1", action: "document.created", beforeVersionIdx: null, afterVersionIdx: null, reason: null, requestId: "request-1" });
});

test("the idempotency fingerprint covers the operation and the request body", async () => {
  const { repository, service } = setup();
  await service.create(context, "tenant-a", { documentType: "markdown", name: "Notes" }, "retry-1", "request-1");
  await service.create(context, "tenant-a", { documentType: "markdown", name: "Other" }, "retry-1", "request-2");
  const [first] = vi.mocked(repository.create).mock.calls[0];
  const [second] = vi.mocked(repository.create).mock.calls[1];
  expect(first.fingerprint).not.toBe(second.fingerprint);
});

test.each([
  {},
  { documentType: "markdown" },
  { documentType: "markdown", name: "" },
  { documentType: "markdown", name: "   " },
  { documentType: "markdown", name: "a".repeat(TENANT_LIMITS.documentName + 1) },
  { documentType: "PSD document", name: "Notes" },
  { documentType: "markdown", name: "Notes", currentVersionIdx: 0 },
])("rejects invalid creation input %# before persistence", async body => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", body, "retry-1", "request-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("a missing idempotency key is rejected, because a retry would create a second document", async () => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", { documentType: "markdown", name: "Notes" }, "", "request-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("reports a missing document as not found", async () => {
  const { service } = setup();
  await expect(service.get(context, "tenant-a", "doc-missing")).rejects.toMatchObject({ code: "not_found" });
});

test("filters the document list by document type only when one is supplied", async () => {
  const { repository, service } = setup();
  await service.list(context, "tenant-a", {});
  expect(repository.list).toHaveBeenCalledWith(context, {});
  await service.list(context, "tenant-a", { documentType: "markdown", limit: 5 });
  expect(repository.list).toHaveBeenLastCalledWith(context, { limit: 5, documentType: "markdown" });
  await expect(service.list(context, "tenant-a", { documentType: "PSD document" })).rejects.toMatchObject({ code: "invalid_request" });
});
