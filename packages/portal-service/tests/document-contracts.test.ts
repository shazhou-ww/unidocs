import { expect, test, vi } from "vitest";
import { createDocumentContractService, resourceEtag, type AdminContext, type DocumentContractRepository } from "../src/index.js";

const context: AdminContext = { memberId: "admin", transport: "session", identity: { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: null, loginConfirmedAt: 1000, loginConfirmation: "authorization-code-v1" } };
const schema = { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" } as const;

function setup() {
  const repository: DocumentContractRepository = {
    append: vi.fn(async command => ({ documentContractIdx: 0, contractHash: command.contractHash })),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  return { repository, service: createDocumentContractService(repository, { now: () => new Date("2026-09-11T00:00:00.500Z"), id: () => "audit-1" }) };
}

test("builds canonical paired contract hashes and the updated registration representation", async () => {
  const { repository, service } = setup();
  const body = { formatVersion: 1 as const, snapshot: { schema }, location: { schema }, reason: "Initial paired schemas" };
  const result = await service.append(context, "markdown", body, "append-key", "request-1");
  const [command] = vi.mocked(repository.append).mock.calls[0];
  expect(result).toEqual({ documentContractIdx: 0, contractHash: command.contractHash });
  expect(command).toMatchObject({ documentType: "markdown", key: "append-key", occurredAt: "2026-09-11T00:00:00.000Z", snapshotSchemaHash: expect.stringMatching(/^sha256:/), locationSchemaHash: expect.stringMatching(/^sha256:/), contractHash: expect.stringMatching(/^sha256:/) });
  const current = { documentType: "markdown", internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, etag: '"sha256-old"', updatedAt: "2026-09-10T00:00:00.000Z" };
  const record = { documentType: "markdown", documentContractIdx: 0, formatVersion: 1 as const, snapshot: { contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1", schema, schemaHash: command.snapshotSchemaHash }, location: { contentType: "application/vnd.unidocs.markdown.location+json;version=1", schema, schemaHash: command.locationSchemaHash }, contractHash: command.contractHash, createdAt: command.occurredAt };
  const updated = await command.buildRegistration(current, record);
  expect(updated).toMatchObject({ latestDocumentContract: record, updatedAt: command.occurredAt });
  expect(updated.etag).toBe(await resourceEtag({ ...current, latestDocumentContract: record, updatedAt: command.occurredAt, etag: undefined }));
});

test.each([{}, { formatVersion: 1, snapshot: { schema }, location: { schema }, reason: "" }, { formatVersion: 1, snapshot: { schema: {} }, location: { schema }, reason: "reason" }])("rejects invalid append body %#", async body => {
  const { repository, service } = setup();
  await expect(service.append(context, "markdown", body, "key", "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.append).not.toHaveBeenCalled();
});

test("validates list and get inputs before persistence", async () => {
  const { repository, service } = setup();
  await expect(service.get(context, "markdown", -1)).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.get(context, "markdown", 0)).rejects.toMatchObject({ code: "not_found" });
  await expect(service.list(context, "../invalid", {})).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.list).not.toHaveBeenCalled();
});