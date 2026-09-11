import { expect, test, vi } from "vitest";
import { createTenantDocumentService, TENANT_LIMITS, type TenantContext, type TenantDocumentRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const moved = { documentId: "doc-1", name: "Notes", documentType: "markdown", currentVersionIdx: 3, createdAt: "2026-09-11T00:00:00.000Z" };

function setup(overrides: Partial<TenantDocumentRepository> = {}) {
  const repository: TenantDocumentRepository = {
    create: vi.fn(async command => command.document),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    moveCurrentVersion: vi.fn(async () => moved),
    listAuditEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides,
  };
  return {
    repository,
    service: createTenantDocumentService(repository, { now: () => new Date("2026-09-11T00:00:00.000Z"), id: () => "00000000-0000-4000-8000-000000000000" }),
  };
}

test("carries the equality lock and both pointer positions into the audit event", async () => {
  const { repository, service } = setup();
  await service.moveCurrentVersion(context, "tenant-a", "doc-1", { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "Restore the reviewed draft" }, "request-1");
  const [command] = vi.mocked(repository.moveCurrentVersion).mock.calls[0];
  expect(command).toMatchObject({ documentId: "doc-1", observedCurrentVersionIdx: 7, targetVersionIdx: 3 });
  expect(command.audit).toMatchObject({
    actorId: "user-1", action: "current_version.moved", beforeVersionIdx: 7, afterVersionIdx: 3,
    reason: "Restore the reviewed draft", requestId: "request-1", occurredAt: "2026-09-11T00:00:00.000Z",
  });
});

test("accepts a null lock, which is how the very first pointer is set", async () => {
  const { repository, service } = setup();
  await service.moveCurrentVersion(context, "tenant-a", "doc-1", { observedCurrentVersionIdx: null, targetVersionIdx: 0, reason: "Adopt the initial snapshot" }, "request-1");
  const [command] = vi.mocked(repository.moveCurrentVersion).mock.calls[0];
  expect(command.observedCurrentVersionIdx).toBeNull();
  expect(command.audit.beforeVersionIdx).toBeNull();
});

test.each([
  { targetVersionIdx: 3, reason: "why" },
  { observedCurrentVersionIdx: 7, reason: "why" },
  { observedCurrentVersionIdx: 7, targetVersionIdx: 3 },
  { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "" },
  { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "a".repeat(TENANT_LIMITS.reason + 1) },
  { observedCurrentVersionIdx: 7, targetVersionIdx: -1, reason: "why" },
  { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "why", force: true },
])("rejects an unusable move request %# before the lock is attempted", async body => {
  const { repository, service } = setup();
  await expect(service.moveCurrentVersion(context, "tenant-a", "doc-1", body, "request-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.moveCurrentVersion).not.toHaveBeenCalled();
});

test("the move takes no idempotency key, because the equality lock already makes a retry safe", async () => {
  const { service } = setup();
  await expect(service.moveCurrentVersion(context, "tenant-a", "doc-1", { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "why" }, "request-1")).resolves.toEqual(moved);
});

test("surfaces the repository's lock failure unchanged", async () => {
  const { service } = setup({ moveCurrentVersion: vi.fn(async () => { throw Object.assign(new Error("stale"), { code: "version_conflict" }); }) });
  await expect(service.moveCurrentVersion(context, "tenant-a", "doc-1", { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "why" }, "request-1")).rejects.toMatchObject({ code: "version_conflict" });
});

test("pages document audit events and refuses another tenant's document", async () => {
  const { repository, service } = setup();
  await service.listAuditEvents(context, "tenant-a", "doc-1", { limit: 20 });
  expect(repository.listAuditEvents).toHaveBeenCalledWith(context, "doc-1", { limit: 20 });
  await expect(service.listAuditEvents(context, "tenant-b", "doc-1")).rejects.toMatchObject({ code: "forbidden" });
});
