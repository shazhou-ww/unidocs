import { expect, test, vi } from "vitest";
import { createDocumentTypeService, resourceEtag, type AdminContext, type DocumentTypeRepository } from "../src/index.js";

const context: AdminContext = { memberId: "admin", transport: "session", identity: { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1000, loginConfirmation: "authorization-code-v1" } };
function setup() {
  const repository: DocumentTypeRepository = {
    create: vi.fn(async command => ({ documentType: command.registration.documentType, etag: command.registration.etag })),
    update: vi.fn(async command => ({ documentType: command.registration.documentType, etag: command.registration.etag })),
    replayUpdate: vi.fn(async () => null),
    get: vi.fn(async () => null), list: vi.fn(async () => ({ items: [], nextCursor: null })),
    resolveTypeCardBundle: vi.fn(async () => null), resolveViewBundle: vi.fn(async () => null), resolveOperator: vi.fn(async () => null), listDocumentContractIdxs: vi.fn(async () => []),
  };
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

test.each(["", "tab\tkey", "a".repeat(129), "non-ascii-\u00e9"])("rejects unbounded or invalid idempotency key %s", async key => {
  const { service } = setup();
  await expect(service.create(context, { internalName: "Markdown" }, key, "request")).rejects.toMatchObject({ code: "invalid_request" });
});

test("get reports invalid identifiers and missing types", async () => {
  const { service } = setup();
  await expect(service.get(context, "../invalid")).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.get(context, "missing")).rejects.toMatchObject({ code: "not_found" });
});

test("updates a draft name under its complete registration ETag and emits a scoped audit", async () => {
  const { repository, service } = setup();
  const representation = { documentType: "markdown", internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, updatedAt: "2026-09-09T00:00:00.000Z" };
  const current = { ...representation, etag: await resourceEtag(representation) };
  vi.mocked(repository.get).mockResolvedValue(current);
  const result = await service.update(context, "markdown", { internalName: "Markdown documents", reason: "Clarify label" }, "update-key", current.etag, "request-update");
  const [command] = vi.mocked(repository.update).mock.calls[0];
  expect(result).toEqual({ documentType: "markdown", etag: command.registration.etag });
  expect(command).toMatchObject({ expectedEtag: current.etag, registration: { internalName: "Markdown documents", enabled: false } });
  expect(command.registration.etag).not.toBe(current.etag);
  expect(command.audits).toMatchObject([{ action: "document_type.internal_name_changed", reason: "Clarify label", requestId: "request-update" }]);
});

test("leaves the final precondition check to persistence and rejects incomplete enablement", async () => {
  const { repository, service } = setup();
  const representation = { documentType: "markdown", internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, updatedAt: "2026-09-09T00:00:00.000Z" };
  const current = { ...representation, etag: await resourceEtag(representation) };
  vi.mocked(repository.get).mockResolvedValue(current);
  await service.update(context, "markdown", { internalName: "New" }, "key", '"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"', "request");
  expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ expectedEtag: '"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"' }));
  vi.mocked(repository.update).mockClear();
  await expect(service.update(context, "markdown", { enabled: true }, "key", current.etag, "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.update).not.toHaveBeenCalled();
});

test("enables only when the selected View and Operator share an existing contract revision", async () => {
  const { repository, service } = setup();
  const contract = {
    documentType: "markdown", documentContractIdx: 0, formatVersion: 1 as const,
    snapshot: { contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1", schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" as const }, schemaHash: "sha256:snapshot" },
    location: { contentType: "application/vnd.unidocs.markdown.location+json;version=1", schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" as const }, schemaHash: "sha256:location" }, contractHash: "sha256:contract", createdAt: "2026-09-09T00:00:00.000Z"
  };
  const candidateEtag = `"sha256-${"A".repeat(43)}"`;
  const card = { typeCardBundleId: `tb_${"a".repeat(64)}`, bundleUrl: "https://bundles.test/type-card/", name: "Card", description: "", manifest: { protocol: "unidocs-type-card/v1" as const, documentType: "markdown", locales: { en: { name: "Markdown", description: "", sampleThumbnailAlt: "Sample" } }, icon: { kind: "svg" as const, path: "icon.svg" }, sampleThumbnail: "sample.png" }, size: 1, uploadedAt: contract.createdAt, etag: candidateEtag };
  const view = { viewBundleId: `vb_${"b".repeat(64)}`, bundleUrl: "https://bundles.test/view/", name: "View", description: "", manifest: { protocol: "unidocs-view-bundle/v1" as const, documentType: "markdown", entrypoints: { interactive: "view.html", thumbnail: "thumbnail.html" }, supportedDocumentContractIdxs: [0] }, size: 1, uploadedAt: contract.createdAt, etag: candidateEtag };
  const operator = { operatorId: "op_one", documentType: "markdown", name: "Operator", description: "", baseUrl: "https://operator.test", descriptor: { protocol: "unidocs-operator/v1" as const, declaredOperatorId: "markdown-primary", displayName: "Markdown Operator", supportedDocumentTypes: ["markdown"], supportedDocumentContracts: { markdown: [0] } }, validatedAt: contract.createdAt, etag: candidateEtag };
  const representation = { documentType: "markdown", internalName: "Markdown", enabled: false, latestDocumentContract: contract, typeCardBundle: card, viewBundle: view, builtinOperator: operator, updatedAt: contract.createdAt };
  const current = { ...representation, etag: await resourceEtag(representation) };
  vi.mocked(repository.get).mockResolvedValue(current);
  vi.mocked(repository.listDocumentContractIdxs).mockResolvedValue([0]);
  await expect(service.update(context, "markdown", { enabled: true }, "enable", current.etag, "request-enable")).resolves.toMatchObject({ documentType: "markdown" });
  vi.mocked(repository.resolveOperator).mockResolvedValue({ ...operator, descriptor: { ...operator.descriptor, supportedDocumentContracts: { markdown: [1] } } });
  await expect(service.update(context, "markdown", { builtinOperatorId: "op_one", enabled: true }, "incompatible", current.etag, "request-incompatible")).rejects.toMatchObject({ code: "invalid_request" });
});

test("preserves printable ASCII idempotency keys verbatim", async () => {
  const { service, repository } = setup();
  await service.create(context, { internalName: "Markdown" }, " intent with spaces ", "request");
  expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ key: " intent with spaces " }));
});