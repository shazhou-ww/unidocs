import { expect, test, vi } from "vitest";
import { createDocumentTypeService, resourceEtag, type AdminContext, type DocumentTypeRepository } from "../src/index.js";

const context: AdminContext = { memberId: "admin", transport: "session", identity: { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1000, loginConfirmation: "authorization-code-v1" } };
function setup() {
  const repository: DocumentTypeRepository = { create: vi.fn(async command => ({ documentType: command.registration.documentType, etag: command.registration.etag })), get: vi.fn(async () => null), list: vi.fn(async () => ({ items: [], nextCursor: null })) };
  return { repository, service: createDocumentTypeService(repository, { now: () => new Date("2026-09-10T00:00:00.000Z"), id: () => "00000000-0000-4000-8000-000000000000" }) };
}

test("creates an incomplete disabled draft with canonical ETag and a nonsecret audit", async () => {
  const { repository, service } = setup();
  const result = await service.create(context, { internalName: "Markdown" }, "request-key", "request-id");
  expect(result.documentType).toBe("dt-00000000-0000-4000-8000-000000000000");
  const [command] = vi.mocked(repository.create).mock.calls[0];
  expect(command.registration).toMatchObject({ internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null });
  expect(result.etag).toBe(await resourceEtag(command.registration));
  expect(command.audit).toMatchObject({ actorId: "admin", action: "document_type.registered", resourceId: result.documentType, requestId: "request-id", reason: null });
  expect(JSON.stringify(command.audit)).not.toContain(context.identity.email);
});

test.each([{}, { internalName: "" }, { internalName: "   " }, { internalName: "a".repeat(257) }, { internalName: 123 }])("rejects invalid draft input %# before persistence", async body => {
  const { repository, service } = setup();
  await expect(service.create(context, body, "key", "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test.each(["", "space key", "a".repeat(129), "non-ascii-\u00e9"])("rejects unbounded or invalid idempotency key %s", async key => {
  const { service } = setup();
  await expect(service.create(context, { internalName: "Markdown" }, key, "request")).rejects.toMatchObject({ code: "invalid_request" });
});

test("get reports invalid identifiers and missing types", async () => {
  const { service } = setup();
  await expect(service.get(context, "../invalid")).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.get(context, "missing")).rejects.toMatchObject({ code: "not_found" });
});