import { describe, expect, test, vi } from "vitest";
import { createOperatorService, type OperatorRepository } from "../src/index.js";

const context = { memberId: "adm_1", identity: { issuer: "issuer", subject: "subject", email: "admin@example.com", authenticatedAt: 1 }, transport: "bearer" as const };
const validation = { validationId: "validation-1", documentType: "markdown", baseUrl: "https://operator.test", expectedConfigEtag: '"operator-v1"',
  descriptor: { protocol: "unidocs-operator/v1" as const, declaredOperatorId: "markdown-primary", displayName: "Markdown Operator", supportedDocumentTypes: ["markdown"], supportedDocumentContracts: { markdown: [0] } },
  validatedAt: "2026-09-11T12:00:00.000Z", expiresAt: "2026-09-11T12:15:00.000Z" };

function fixture() {
  const records = new Map<string, any>();
  const repository: OperatorRepository = {
    create: vi.fn(async command => {
      const record = await command.buildRecord(validation);
      records.set(record.operatorId, record);
      return { operatorId: record.operatorId, etag: record.etag };
    }),
    updateMetadata: vi.fn(async command => {
      const record = await command.buildRecord(records.get(command.operatorId));
      records.set(record.operatorId, record);
      return { operatorId: record.operatorId, etag: record.etag };
    }),
    get: vi.fn(async (_context, id) => records.get(id) ?? null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  return { records, repository, service: createOperatorService(repository, { now: () => new Date("2026-09-11T12:01:00.987Z"), id: () => "operator-1" }) };
}

describe("Operator service", () => {
  test("creates a persistent Operator from immutable validation fields", async () => {
    const { records, service } = fixture();
    const result = await service.create(context, { validationId: "validation-1", name: "Primary", description: "Candidate" }, "key-1", "request-1");
    expect(records.get(result.operatorId)).toMatchObject({ operatorId: "op_operator-1", documentType: "markdown", name: "Primary", description: "Candidate",
      baseUrl: validation.baseUrl, descriptor: validation.descriptor, validatedAt: validation.validatedAt, etag: result.etag });
  });

  test("updates metadata without changing validated identity", async () => {
    const { records, service } = fixture();
    const created = await service.create(context, { validationId: "validation-1", name: "Old", description: "" }, "key-1", "request-1");
    const before = records.get(created.operatorId);
    const updated = await service.updateMetadata(context, created.operatorId, { name: "New", description: "Notes" }, "key-2", before.etag, "request-2");
    expect(records.get(created.operatorId)).toMatchObject({ name: "New", description: "Notes", baseUrl: before.baseUrl, descriptor: before.descriptor, validatedAt: before.validatedAt });
    expect(updated.etag).not.toBe(before.etag);
  });
});