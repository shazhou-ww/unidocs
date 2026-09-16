import { expect, test, vi } from "vitest";
import {
  createTenantMemberService, normalizeAdministratorEmail, normalizeGoogleEmail, resourceEtag, schemaHash,
  type AdminContext, type TenantMemberRepository,
} from "../src/index.js";

const context: AdminContext = {
  memberId: "admin-1", transport: "session",
  identity: { issuer: "https://accounts.google.com", subject: "subject", email: "owner@example.com", authenticatedAt: null, loginConfirmedAt: 1000, loginConfirmation: "authorization-code-v1" },
};
const ETAG = `"sha256-${"a".repeat(43)}"`;

function setup() {
  const repository: TenantMemberRepository = {
    add: vi.fn(async command => ({ memberId: command.member.memberId, principalId: command.member.principalId, etag: command.member.etag })),
    remove: vi.fn(async () => undefined),
    revokeSessions: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const ids = ["member-1", "principal-1", "audit-1"];
  return { repository, service: createTenantMemberService(repository, { now: () => new Date("2026-09-15T00:00:00.400Z"), id: () => ids.shift()! }) };
}

test("normalizeGoogleEmail is the rule administrators already use", () => {
  expect(normalizeGoogleEmail("  Member@Example.COM ")).toBe("member@example.com");
  expect(normalizeAdministratorEmail("  Member@Example.COM ")).toBe(normalizeGoogleEmail("  Member@Example.COM "));
});

test("adds a normalized, unbound member with a fresh user principal, canonical ETag and audit", async () => {
  const { repository, service } = setup();
  const result = await service.add(context, { tenantId: "t1", email: " Member@Example.com" }, "add-key", "request-1");
  const [command] = vi.mocked(repository.add).mock.calls[0];
  const representation = { memberId: "member-1", tenantId: "t1", principalId: "user:principal-1", email: "member@example.com", bound: false, addedBy: "admin-1", addedAt: "2026-09-15T00:00:00.000Z" };
  expect(command.member).toEqual({ ...representation, etag: await resourceEtag(representation) });
  expect(result).toEqual({ memberId: "member-1", principalId: "user:principal-1", etag: command.member.etag });
  expect(command.fingerprint).toBe(await schemaHash({ operation: "addTenantMember", body: { tenantId: "t1", email: "member@example.com" } }));
  expect(command.audit).toMatchObject({ auditEventId: "audit-1", action: "tenant_member.added", resourceType: "tenant_member", resourceId: "member-1", requestId: "request-1", documentType: null, reason: null });
  expect(JSON.stringify(command.audit)).not.toContain("member@example.com");
});

test.each([
  {}, { email: "a@example.com" }, { tenantId: "t1" }, { tenantId: "t1", email: "invalid" }, { tenantId: "", email: "a@example.com" },
  { tenantId: "t 1", email: "a@example.com" }, { tenantId: "t1", email: "a@example.com", extra: true }, [], null,
])("rejects invalid add input %#", async body => {
  const { repository, service } = setup();
  await expect(service.add(context, body, "key", "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.add).not.toHaveBeenCalled();
});

test("rejects a malformed idempotency key before touching the repository", async () => {
  const { repository, service } = setup();
  await expect(service.add(context, { tenantId: "t1", email: "a@example.com" }, "", "request")).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.revokeSessions(context, "member-1", "k".repeat(129), "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.add).not.toHaveBeenCalled();
  expect(repository.revokeSessions).not.toHaveBeenCalled();
});

test("removes under an ETag with a fingerprint over the member and ETag", async () => {
  const { repository, service } = setup();
  await service.remove(context, "member-1", "remove-key", ETAG, "request-2");
  const [command] = vi.mocked(repository.remove).mock.calls[0];
  expect(command).toMatchObject({ memberId: "member-1", key: "remove-key", expectedEtag: ETAG });
  expect(command.fingerprint).toBe(await schemaHash({ operation: "removeTenantMember", memberId: "member-1", expectedEtag: ETAG }));
  expect(command.audit).toMatchObject({ action: "tenant_member.removed", resourceType: "tenant_member", resourceId: "member-1" });
  await expect(service.remove(context, "member-1", "remove-key", "W/\"weak\"", "request-3")).rejects.toMatchObject({ code: "invalid_request" });
});

test("revokes sessions with its own fingerprint and audit action", async () => {
  const { repository, service } = setup();
  await service.revokeSessions(context, "member-1", "revoke-key", "request-4");
  const [command] = vi.mocked(repository.revokeSessions).mock.calls[0];
  expect(command.fingerprint).toBe(await schemaHash({ operation: "revokeTenantMemberSessions", memberId: "member-1" }));
  expect(command.audit).toMatchObject({ action: "tenant_member.sessions_revoked", resourceType: "tenant_member", resourceId: "member-1" });
});

test("validates the list query, including the tenant filter", async () => {
  const { repository, service } = setup();
  await service.list(context, { tenantId: "t1", limit: 10 });
  expect(repository.list).toHaveBeenCalledWith(context, { tenantId: "t1", limit: 10 });
  await expect(service.list(context, { limit: 0 })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.list(context, { tenantId: "" })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.list(context, { unknown: 1 })).rejects.toMatchObject({ code: "invalid_request" });
});
