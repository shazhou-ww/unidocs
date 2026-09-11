import { expect, test, vi } from "vitest";
import { createAdministratorService, resourceEtag, type AdminContext, type AdministratorRepository } from "../src/index.js";

const context: AdminContext = {
  memberId: "admin-1", transport: "session",
  identity: { issuer: "https://accounts.google.com", subject: "subject", email: "owner@example.com", authenticatedAt: null, loginConfirmedAt: 1000, loginConfirmation: "authorization-code-v1" },
};

function setup() {
  const repository: AdministratorRepository = {
    add: vi.fn(async command => ({ adminId: command.member.adminId, etag: command.member.etag })),
    remove: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const ids = ["member-1", "audit-1"];
  return { repository, service: createAdministratorService(repository, { now: () => new Date("2026-09-11T00:00:00.000Z"), id: () => ids.shift()! }) };
}

test("adds a normalized unbound administrator with a canonical ETag and audit", async () => {
  const { repository, service } = setup();
  const result = await service.add(context, { email: "  YanJiaYiCeShi@gmail.com " }, "add-key", "request-1");
  const [command] = vi.mocked(repository.add).mock.calls[0];
  expect(result).toEqual({ adminId: "member-1", etag: command.member.etag });
  expect(command.member).toMatchObject({ adminId: "member-1", email: "yanjiayiceshi@gmail.com", bound: false, addedBy: "admin-1" });
  expect(command.member.etag).toBe(await resourceEtag({ adminId: "member-1", email: "yanjiayiceshi@gmail.com", bound: false, addedBy: "admin-1", addedAt: "2026-09-11T00:00:00.000Z" }));
  expect(command.audit).toMatchObject({ action: "administrator.added", actorId: "admin-1", resourceId: "member-1", requestId: "request-1" });
  expect(JSON.stringify(command.audit)).not.toContain("yanjiayiceshi@gmail.com");
});

test.each([{}, { email: "invalid" }, { email: 1 }, { email: "a@example.com", extra: true }])("rejects invalid add input %#", async body => {
  const { repository, service } = setup();
  await expect(service.add(context, body, "key", "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.add).not.toHaveBeenCalled();
});

test("rejects invalid pagination and reports missing members", async () => {
  const { service } = setup();
  await expect(service.list(context, { limit: 0 })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.get(context, "missing")).rejects.toMatchObject({ code: "not_found" });
});

test("builds an idempotent conditional administrator removal command", async () => {
  const { repository, service } = setup();
  const etag = '"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';
  await service.remove(context, "member-2", "remove-key", etag, "request-remove");
  const [command] = vi.mocked(repository.remove).mock.calls[0];
  expect(command).toMatchObject({ context, adminId: "member-2", key: "remove-key", expectedEtag: etag });
  expect(command.audit).toMatchObject({ action: "administrator.removed", actorId: "admin-1", resourceId: "member-2", requestId: "request-remove" });
  expect(command.fingerprint).toMatch(/^sha256:/);
});

test.each([
  ["", "key", '"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'],
  ["member", "space key", '"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'],
  ["member", "key", "invalid"],
])("rejects invalid removal preconditions %#", async (adminId, key, etag) => {
  const { repository, service } = setup();
  await expect(service.remove(context, adminId, key, etag, "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.remove).not.toHaveBeenCalled();
});