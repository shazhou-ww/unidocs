import { describe, expect, it } from "vitest";
import { TenantOperationError } from "@unidocs/portal-service";
import { D1TenantDocumentRepository } from "../../src/tenant/document-repository.js";
import { databaseDouble } from "./d1-double.js";

const context = { tenantId: "t-local", principalId: "user-1", transport: "session" as const };

const document = {
  documentId: "doc-1",
  name: "Notes",
  documentType: "markdown",
  currentVersionIdx: null,
  createdAt: "2026-09-14T00:00:00.000Z",
};

const audit = {
  auditEventId: "evt-1",
  actorId: "user-1",
  action: "document.created" as const,
  beforeVersionIdx: null,
  afterVersionIdx: null,
  reason: null,
  requestId: "req-1",
  occurredAt: "2026-09-14T00:00:00.000Z",
};

/** created_at in epoch seconds, matching `document.createdAt` above. */
const CREATED_AT_SECONDS = Math.floor(Date.parse(document.createdAt) / 1000);

const row = (over: Record<string, unknown> = {}) => ({
  tenant_id: "t-local",
  document_id: "doc-1",
  name: "Notes",
  document_type: "markdown",
  current_version_idx: null,
  created_at: CREATED_AT_SECONDS,
  ...over,
});

describe("D1TenantDocumentRepository.create", () => {
  it("writes the document, its audit event and the receipt in one batch", async () => {
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantDocumentRepository(database);
    const created = await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit });
    expect(created).toEqual(document);
    expect(database.batchCalls).toHaveLength(1);
    expect(database.batchCalls[0]).toHaveLength(3);
  });

  it("replays an identical key without creating a second document", async () => {
    const database = databaseDouble({
      firsts: [{ fingerprint: "fp-1", response_json: JSON.stringify(document) }],
    });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }))
      .resolves.toEqual(document);
    expect(database.batchCalls).toHaveLength(0);
  });

  it("refuses the same key with a different body", async () => {
    const database = databaseDouble({
      firsts: [{ fingerprint: "other", response_json: JSON.stringify(document) }],
    });
    const repository = new D1TenantDocumentRepository(database);
    const error = await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }).catch(caught => caught);
    expect(error).toBeInstanceOf(TenantOperationError);
    expect(error).toMatchObject({ code: "idempotency_conflict" });
  });

  it("absorbs a concurrent duplicate by re-reading the receipt after a failed batch", async () => {
    const database = databaseDouble({
      firsts: [null, { fingerprint: "fp-1", response_json: JSON.stringify(document) }],
      batchThrows: new Error("UNIQUE constraint failed"),
    });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }))
      .resolves.toEqual(document);
    expect(database.batchCalls).toHaveLength(1);
  });

  it("propagates a batch failure that is not absorbed by a receipt", async () => {
    const database = databaseDouble({
      firsts: [null, null],
      batchThrows: new Error("disk I/O error"),
    });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }))
      .rejects.toThrow("disk I/O error");
  });
});

describe("D1TenantDocumentRepository.get", () => {
  it("returns the record when it exists", async () => {
    const database = databaseDouble({ firsts: [row()] });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.get(context, "doc-1")).resolves.toEqual(document);
  });

  it("returns null when it does not", async () => {
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.get(context, "missing")).resolves.toBeNull();
  });

  it("does not return another tenant's document with the same id", async () => {
    // The double is intentionally blind to WHERE clauses (it always answers from
    // its canned queue), so this test cannot rely on the double to enforce
    // isolation - it proves the repository *asked* for it: the tenant id from
    // context must be bound into the query, not just the document id.
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.get({ ...context, tenantId: "t-other" }, "doc-1");
    expect(database.statements[0]?.args).toContain("t-other");
    expect(database.statements[0]?.args).not.toContain("t-local");
  });

  it("scopes the lookup by tenant", async () => {
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.get(context, "doc-1");
    expect(database.statements[0]?.sql).toContain("tenant_id");
    expect(database.statements[0]?.args).toContain("t-local");
  });
});

describe("D1TenantDocumentRepository.list", () => {
  it("returns a null cursor when the page is not full", async () => {
    const database = databaseDouble({ rows: [row()] });
    const repository = new D1TenantDocumentRepository(database);
    const page = await repository.list(context, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("returns a cursor and drops the probe row when a further page exists", async () => {
    const database = databaseDouble({
      rows: [row({ document_id: "doc-2", created_at: 2 }), row({ document_id: "doc-1", created_at: 1 })],
    });
    const repository = new D1TenantDocumentRepository(database);
    const page = await repository.list(context, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.documentId).toBe("doc-2");
    expect(page.nextCursor).not.toBeNull();
  });

  it("binds the decoded cursor into the query", async () => {
    const database = databaseDouble({ rows: [] });
    const repository = new D1TenantDocumentRepository(database);
    const { encodeCursor } = await import("../../src/tenant/cursor.js");
    await repository.list(context, { cursor: encodeCursor({ at: 5, id: "doc-5" }) });
    // Proves the cursor was actually decoded and bound, not just accepted and
    // ignored: a paging test that passes without this would pass even if the
    // repository never consulted the cursor at all.
    expect(database.statements[0]?.args).toContain(5);
    expect(database.statements[0]?.args).toContain("doc-5");
  });

  it("filters by document type when asked", async () => {
    const database = databaseDouble({ rows: [] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.list(context, { documentType: "markdown" });
    expect(database.statements[0]?.sql).toContain("document_type");
    expect(database.statements[0]?.args).toContain("markdown");
  });

  it("does not filter by document type when it is omitted", async () => {
    const database = databaseDouble({ rows: [] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.list(context, {});
    expect(database.statements[0]?.args).not.toContain("markdown");
  });
});
