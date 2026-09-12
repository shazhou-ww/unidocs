import { expect, test, vi } from "vitest";
import { createAuditEventService, type AdminContext, type AuditEventRepository } from "../src/index.js";

const context: AdminContext = {
  memberId: "admin", transport: "session",
  identity: { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1000, loginConfirmation: "authorization-code-v1" },
};

function setup() {
  const repository: AuditEventRepository = { list: vi.fn(async () => ({ items: [], nextCursor: null })) };
  return { repository, service: createAuditEventService(repository) };
}

test("passes validated audit filters to persistence", async () => {
  const { repository, service } = setup();
  const query = { actorId: "admin", action: "administrator.added" as const, resourceType: "administrator" as const,
    occurredFrom: "2026-09-10T00:00:00.000Z", occurredTo: "2026-09-11T00:00:00.000Z", limit: 50 };
  await expect(service.list(context, query)).resolves.toEqual({ items: [], nextCursor: null });
  expect(repository.list).toHaveBeenCalledWith(context, query);
});

test.each([
  { limit: 0 },
  { limit: 101 },
  { action: "unknown" },
  { resourceType: "unknown" },
  { documentType: "../invalid" },
  { actorId: "a".repeat(257) },
  { callerChannel: "unknown" },
  { toolName: "x".repeat(129) },
  { toolName: "invalid tool" },
  { cursor: "a".repeat(2049) },
  { occurredFrom: "2026-09-12T00:00:00.000Z", occurredTo: "2026-09-11T00:00:00.000Z" },
])("rejects invalid audit query %#", async query => {
  const { repository, service } = setup();
  await expect(service.list(context, query)).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.list).not.toHaveBeenCalled();
});