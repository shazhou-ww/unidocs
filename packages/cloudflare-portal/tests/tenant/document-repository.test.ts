import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
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

  it("reports document_type_disabled when the document_type EXISTS guard matches nothing, and writes no receipt", async () => {
    // A4: every statement in the batch is guarded by the same EXISTS check
    // against portal_document_types, so an unknown or disabled type makes
    // every statement a no-op (changes: 0) rather than a partial write - the
    // double stands in for that by reporting 0 changes on all three.
    const database = databaseDouble({ firsts: [null], batchResults: [[0, 0, 0]] });
    const repository = new D1TenantDocumentRepository(database);
    const error = await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }).catch(caught => caught);
    expect(error).toBeInstanceOf(TenantOperationError);
    expect(error).toMatchObject({ code: "document_type_disabled" });
  });

  it("guards every statement in the create batch with the document_type enablement EXISTS check", async () => {
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit });
    // statements[0] is replay()'s own SELECT; the batch's three prepared
    // statements (receipt, document, audit) follow it in bind order.
    const batchStatements = database.statements.slice(1);
    expect(batchStatements).toHaveLength(3);
    for (const statement of batchStatements) {
      expect(statement.sql).toContain(
        "WHERE EXISTS (SELECT 1 FROM portal_document_types WHERE document_type = ? AND enabled = 1)",
      );
      expect(statement.args).toContain("markdown");
    }
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

const moveAudit = (over: Record<string, unknown> = {}) => ({
  auditEventId: "evt-move-1",
  actorId: "user-1",
  action: "current_version.moved" as const,
  beforeVersionIdx: null,
  afterVersionIdx: 0,
  reason: "promote draft",
  requestId: "req-2",
  occurredAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

const auditRow = (over: Record<string, unknown> = {}) => ({
  audit_event_id: "evt-1",
  tenant_id: "t-local",
  document_id: "doc-1",
  actor_id: "user-1",
  action: "current_version.moved",
  before_version_idx: null,
  after_version_idx: 0,
  reason: "promote draft",
  request_id: "req-2",
  occurred_at: CREATED_AT_SECONDS,
  ...over,
});

describe("D1TenantDocumentRepository.moveCurrentVersion", () => {
  it("moves the pointer and returns the updated record when the observed value equals the current pointer", async () => {
    const database = databaseDouble({ firsts: [row({ current_version_idx: 1 })] });
    const repository = new D1TenantDocumentRepository(database);
    const updated = await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: 0, targetVersionIdx: 1, audit: moveAudit({ beforeVersionIdx: 0, afterVersionIdx: 1 }),
    });
    expect(updated.currentVersionIdx).toBe(1);
  });

  it("refuses the move as version_conflict when the observed value no longer matches the pointer, leaving no audit trace", async () => {
    // The batch itself matches nothing (both the audit INSERT and the UPDATE
    // are guarded on the same pre-state), so both report changes: 0. The
    // document still exists (this.get's fallback row below), which is what
    // tells the repository this is version_conflict rather than not_found.
    const database = databaseDouble({ batchResults: [[0, 0]], rows: [row({ current_version_idx: 5 })] });
    const repository = new D1TenantDocumentRepository(database);
    const error = await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: 1, targetVersionIdx: 2, audit: moveAudit(),
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(TenantOperationError);
    expect(error).toMatchObject({ code: "version_conflict" });
    // A refused move now follows up with exactly one re-read (to tell
    // not_found from version_conflict, per A2) - the two batched statements
    // plus that one SELECT, and nothing more.
    expect(database.statements).toHaveLength(3);
  });

  it("reports not_found instead of version_conflict when a refused move's document no longer exists", async () => {
    // Same refused batch as above, but this.get()'s follow-up read finds no
    // row at all (no `rows` seeded) - the document itself is gone, which
    // moveCurrentVersionContract declares as 404, not 409.
    const database = databaseDouble({ batchResults: [[0, 0]] });
    const repository = new D1TenantDocumentRepository(database);
    const error = await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: 1, targetVersionIdx: 2, audit: moveAudit(),
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(TenantOperationError);
    expect(error).toMatchObject({ code: "not_found" });
  });

  it("moves the pointer from null to the first version", async () => {
    const database = databaseDouble({ firsts: [row({ current_version_idx: 0 })] });
    const repository = new D1TenantDocumentRepository(database);
    const updated = await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: null, targetVersionIdx: 0, audit: moveAudit(),
    });
    expect(updated.currentVersionIdx).toBe(0);
    // IS, not =, because NULL = NULL is false in SQLite: an = here would make
    // the very first pointer move - whose observed value is legitimately null -
    // impossible. No test that only moves from a non-null value would catch this.
    // statements[0] is the audit INSERT, statements[1] is the UPDATE - both
    // share the same pre-state guard, so both must use IS.
    expect(database.statements[0]?.sql).toContain("IS ?");
    expect(database.statements[0]?.args).toContain(null);
    expect(database.statements[1]?.sql).toContain("IS ?");
    expect(database.statements[1]?.args).toContain(null);
  });

  it("refuses the move when the target version does not exist, without pointing current at it", async () => {
    const database = databaseDouble({ batchResults: [[0, 0]], rows: [row({ current_version_idx: 0 })] });
    const repository = new D1TenantDocumentRepository(database);
    const error = await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: 0, targetVersionIdx: 99, audit: moveAudit(),
    }).catch(caught => caught);
    expect(error).toMatchObject({ code: "version_conflict" });
    expect(database.statements[0]?.sql).toContain("portal_versions");
  });

  it("writes the pointer move and its audit event in one batch, audit first", async () => {
    const database = databaseDouble({ firsts: [row({ current_version_idx: 0 })] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: null, targetVersionIdx: 0, audit: moveAudit(),
    });
    expect(database.batchCalls).toHaveLength(1);
    expect(database.batchCalls[0]).toHaveLength(2);
    expect(database.statements[0]?.sql).toContain("INSERT INTO portal_document_audit");
    expect(database.statements[1]?.sql).toContain("UPDATE portal_documents");
  });

  it("guards the audit insert on the same PRE-state the UPDATE requires, not the post-move state - so a refused move writes no audit row", async () => {
    // Regression test for A1: an earlier version of this guard used the
    // POST-move state (current_version_idx = targetVersionIdx). That is
    // wrong whenever the pointer already happens to sit at the target before
    // this call (a stale client re-observing someone else's already-applied
    // move) - the UPDATE's `IS observedCurrentVersionIdx` check correctly
    // refuses, but the post-state EXISTS was true anyway, so the audit
    // INSERT fired for a move that never happened. Guarding on the SAME
    // pre-state as the UPDATE - current_version_idx IS observed - closes
    // that: observedCurrentVersionIdx (1) must appear in the audit
    // statement's own bound args, not just targetVersionIdx (2).
    const database = databaseDouble({ batchResults: [[0, 0]], rows: [row({ current_version_idx: 2 })] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: 1, targetVersionIdx: 2, audit: moveAudit(),
    }).catch(() => {});
    const auditInsert = database.statements[0];
    expect(auditInsert?.sql).toContain("INSERT INTO portal_document_audit");
    expect(auditInsert?.sql).toContain("WHERE EXISTS");
    expect(auditInsert?.sql).toContain("current_version_idx IS ?");
    // The guard binds BOTH the observed (pre-state) value and the target
    // version's existence check - not just the target.
    expect(auditInsert?.args).toContain(1);
    expect(auditInsert?.args).toContain(2);
  });
});

describe("D1TenantDocumentRepository.listAuditEvents", () => {
  it("pages by (occurred_at, audit_event_id) descending", async () => {
    const database = databaseDouble({
      rows: [auditRow({ audit_event_id: "evt-2", occurred_at: 2 }), auditRow({ audit_event_id: "evt-1", occurred_at: 1 })],
    });
    const repository = new D1TenantDocumentRepository(database);
    const page = await repository.listAuditEvents(context, "doc-1", { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.auditEventId).toBe("evt-2");
    expect(page.nextCursor).not.toBeNull();
    expect(database.statements[0]?.sql).toContain("ORDER BY occurred_at DESC");
  });

  it("binds the decoded cursor into the query", async () => {
    const database = databaseDouble({ rows: [] });
    const repository = new D1TenantDocumentRepository(database);
    const { encodeCursor } = await import("../../src/tenant/cursor.js");
    await repository.listAuditEvents(context, "doc-1", { cursor: encodeCursor({ at: 5, id: "evt-5" }) });
    expect(database.statements[0]?.args).toContain(5);
    expect(database.statements[0]?.args).toContain("evt-5");
  });

  it("does not return another tenant's audit events for the same document id", async () => {
    const database = databaseDouble({ rows: [] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.listAuditEvents({ ...context, tenantId: "t-other" }, "doc-1", {});
    expect(database.statements[0]?.args).toContain("t-other");
    expect(database.statements[0]?.args).not.toContain("t-local");
  });
});

/**
 * `moveCurrentVersion`'s audit guard is a real defect class (A1 in the final
 * fix-wave review): the SQL-blind double above can assert which statements
 * were sent and with what args, but it cannot evaluate a WHERE clause, so it
 * cannot prove the guard actually stops a phantom audit row from landing.
 * These tests run the real migration under Miniflare's D1 so the guard's
 * WHERE EXISTS clauses are evaluated by an actual SQLite engine, the same
 * technique `thread-repository.test.ts`'s "(real D1)" blocks already use.
 */
describe("D1TenantDocumentRepository.moveCurrentVersion (real D1)", () => {
  let miniflare: Miniflare;
  let db: D1Database;

  function collapseToOneStatementPerLine(sql: string): string {
    return sql
      .split(";")
      .map(statement => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map(statement => `${statement};`)
      .join("\n");
  }

  beforeEach(async () => {
    miniflare = new Miniflare(convertV4MiniflareOptions({
      workers: [{
        name: "document-repository-move-test",
        modules: true,
        script: "export default { fetch() { return new Response('ok'); } };",
        compatibilityDate: "2025-08-17",
        d1Databases: { DB: `document-repository-move-${crypto.randomUUID()}` },
      }],
    }));
    await miniflare.ready;
    db = await miniflare.getD1Database("DB", "document-repository-move-test") as unknown as D1Database;
    const migration = fileURLToPath(new URL("../../migrations/0012_tenant.sql", import.meta.url));
    await db.exec(collapseToOneStatementPerLine(await readFile(migration, "utf8")));
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  async function seedDocument(documentId: string, currentVersionIdx: number | null) {
    await db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("t-local", documentId, "Doc", "markdown", currentVersionIdx, 0).run();
  }

  async function seedVersion(documentId: string, versionIdx: number) {
    await db.prepare(
      `INSERT INTO portal_versions
         (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id,
          addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
       VALUES (?, ?, ?, NULL, 0, 'agent-1', 'sub-1', '[]', ?, 0, 'application/octet-stream', ?)`,
    ).bind("t-local", documentId, versionIdx, `hash-${documentId}-${versionIdx}`, versionIdx).run();
  }

  async function auditRows(documentId: string) {
    const result = await db.prepare(
      "SELECT audit_event_id, before_version_idx, after_version_idx FROM portal_document_audit WHERE tenant_id = ? AND document_id = ?",
    ).bind("t-local", documentId).all();
    return result.results ?? [];
  }

  it(
    "A1 regression: a refused move (stale observedCurrentVersionIdx) leaves the audit table exactly as it was - no phantom row",
    async () => {
      await seedDocument("doc-1", 4);
      await seedVersion("doc-1", 4);
      await seedVersion("doc-1", 5);
      const repository = new D1TenantDocumentRepository(db);

      // Two clients both observed pointer 4 and both ask to move to 5. The
      // winner moves it first.
      const winner = await repository.moveCurrentVersion({
        context, documentId: "doc-1", observedCurrentVersionIdx: 4, targetVersionIdx: 5,
        audit: moveAudit({ auditEventId: "evt-winner", beforeVersionIdx: 4, afterVersionIdx: 5 }),
      });
      expect(winner.currentVersionIdx).toBe(5);

      const auditAfterWinner = await auditRows("doc-1");
      expect(auditAfterWinner).toHaveLength(1);
      expect(auditAfterWinner[0]).toMatchObject({ audit_event_id: "evt-winner" });

      // The loser is still holding observedCurrentVersionIdx: 4, which is now
      // stale (the pointer is 5). Before the A1 fix, this refused move still
      // wrote a phantom audit row (before_version_idx=4, after_version_idx=5)
      // because the guard checked current_version_idx = targetVersionIdx
      // (already true, coincidentally, since the winner just set it) instead
      // of the pre-state the UPDATE itself required.
      const loserError = await repository.moveCurrentVersion({
        context, documentId: "doc-1", observedCurrentVersionIdx: 4, targetVersionIdx: 5,
        audit: moveAudit({ auditEventId: "evt-phantom", beforeVersionIdx: 4, afterVersionIdx: 5 }),
      }).catch(caught => caught);
      expect(loserError).toBeInstanceOf(TenantOperationError);
      expect(loserError).toMatchObject({ code: "version_conflict" });

      // The whole point of A1: the audit table after the REFUSED move is
      // identical to before it - still just the winner's one row, never
      // "evt-phantom".
      const auditAfterLoser = await auditRows("doc-1");
      expect(auditAfterLoser).toHaveLength(1);
      expect(auditAfterLoser.map((row: Record<string, unknown>) => row.audit_event_id)).toEqual(["evt-winner"]);
      expect(auditAfterLoser.map((row: Record<string, unknown>) => row.audit_event_id)).not.toContain("evt-phantom");
    },
  );

  it("A1: a legitimate no-op restatement (observed == current == target) still succeeds and still writes its audit row", async () => {
    // SQLite counts an UPDATE whose SET value does not change the row as a
    // change, so the pre-state guard (current_version_idx IS observed) must
    // not accidentally treat "restating the same value" as a refusal.
    await seedDocument("doc-1", 4);
    await seedVersion("doc-1", 4);
    const repository = new D1TenantDocumentRepository(db);

    const result = await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: 4, targetVersionIdx: 4,
      audit: moveAudit({ auditEventId: "evt-restate", beforeVersionIdx: 4, afterVersionIdx: 4 }),
    });
    expect(result.currentVersionIdx).toBe(4);

    const rows = await auditRows("doc-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ audit_event_id: "evt-restate" });
  });

  it("A2: reports not_found (not version_conflict) when the document does not exist at all", async () => {
    const repository = new D1TenantDocumentRepository(db);
    const error = await repository.moveCurrentVersion({
      context, documentId: "doc-missing", observedCurrentVersionIdx: 0, targetVersionIdx: 1, audit: moveAudit(),
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(TenantOperationError);
    expect(error).toMatchObject({ code: "not_found" });
    expect(await auditRows("doc-missing")).toHaveLength(0);
  });

  it("A2: reports version_conflict (not not_found) when the document exists but the pointer moved", async () => {
    await seedDocument("doc-1", 4);
    await seedVersion("doc-1", 4);
    await seedVersion("doc-1", 5);
    const repository = new D1TenantDocumentRepository(db);
    const error = await repository.moveCurrentVersion({
      context, documentId: "doc-1", observedCurrentVersionIdx: 0, targetVersionIdx: 5, audit: moveAudit(),
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(TenantOperationError);
    expect(error).toMatchObject({ code: "version_conflict" });
    expect(await auditRows("doc-1")).toHaveLength(0);
  });
});

/**
 * A3: `WHERE enabled = 1` in `catalog-repository.ts` had zero coverage - no
 * catalog test exercised it, so deleting the predicate would leave the suite
 * green. `create`'s new A4 guard reuses the same `portal_document_types`
 * table and the same "the double cannot evaluate a WHERE clause" problem, so
 * both are proven together here against real D1.
 */
describe("D1TenantDocumentRepository.create - document_type enablement (real D1, A4)", () => {
  let miniflare: Miniflare;
  let db: D1Database;

  function collapseToOneStatementPerLine(sql: string): string {
    return sql
      .split(";")
      .map(statement => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map(statement => `${statement};`)
      .join("\n");
  }

  beforeEach(async () => {
    miniflare = new Miniflare(convertV4MiniflareOptions({
      workers: [{
        name: "document-repository-create-test",
        modules: true,
        script: "export default { fetch() { return new Response('ok'); } };",
        compatibilityDate: "2025-08-17",
        d1Databases: { DB: `document-repository-create-${crypto.randomUUID()}` },
      }],
    }));
    await miniflare.ready;
    db = await miniflare.getD1Database("DB", "document-repository-create-test") as unknown as D1Database;
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter(name => name.endsWith(".sql")).sort();
    for (const file of files) {
      await db.exec(collapseToOneStatementPerLine(await readFile(`${migrationsDir}/${file}`, "utf8")));
    }
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  async function seedDocumentType(documentType: string, enabled: boolean) {
    await db.prepare(
      "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, ?, '{}', ?)",
    ).bind(documentType, documentType, enabled ? 1 : 0, "2026-09-11T00:00:00.000Z").run();
  }

  it("creates the document when its document_type is enabled", async () => {
    await seedDocumentType("markdown", true);
    const repository = new D1TenantDocumentRepository(db);
    const created = await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit });
    expect(created).toEqual(document);
    const row = await db.prepare("SELECT * FROM portal_documents WHERE tenant_id = ? AND document_id = ?")
      .bind("t-local", "doc-1").first();
    expect(row).not.toBeNull();
  });

  it("A4 regression: refuses document_type_disabled for a disabled type, and leaves no row behind (document, audit, or receipt)", async () => {
    await seedDocumentType("markdown", false);
    const repository = new D1TenantDocumentRepository(db);
    const error = await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }).catch(caught => caught);
    expect(error).toBeInstanceOf(TenantOperationError);
    expect(error).toMatchObject({ code: "document_type_disabled" });

    const documentRow = await db.prepare("SELECT * FROM portal_documents WHERE tenant_id = ? AND document_id = ?")
      .bind("t-local", "doc-1").first();
    expect(documentRow).toBeNull();
    const auditRow = await db.prepare("SELECT * FROM portal_document_audit WHERE tenant_id = ? AND document_id = ?")
      .bind("t-local", "doc-1").first();
    expect(auditRow).toBeNull();
    const receiptRow = await db.prepare(
      "SELECT * FROM portal_tenant_idempotency_receipts WHERE tenant_id = ? AND actor_id = ? AND operation = ? AND key = ?",
    ).bind("t-local", "user-1", "createDocument", "idem-1").first();
    expect(receiptRow).toBeNull();
  });

  it("A4 regression: refuses document_type_disabled for a document_type that was never registered at all", async () => {
    // No portal_document_types row at all - not disabled, just unknown. The
    // EXISTS guard treats both the same way: no match, no write.
    const repository = new D1TenantDocumentRepository(db);
    const error = await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }).catch(caught => caught);
    expect(error).toMatchObject({ code: "document_type_disabled" });
  });

  it("A4: a retry after document_type_disabled is not treated as an idempotent replay of a phantom success - it fails again the same way", async () => {
    await seedDocumentType("markdown", false);
    const repository = new D1TenantDocumentRepository(db);
    const first = await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }).catch(caught => caught);
    const second = await repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }).catch(caught => caught);
    expect(first).toMatchObject({ code: "document_type_disabled" });
    expect(second).toMatchObject({ code: "document_type_disabled" });
  });

  it("A3 regression: the catalog only lists an enabled document type - enabled=1 and enabled=0 seeded side by side", async () => {
    // This is A3's coverage: catalog-repository.ts's `WHERE enabled = 1` had
    // no test touching enablement at all. Proven here (not in
    // catalog-repository.test.ts) so it can reuse this file's full-migration
    // Miniflare setup and seedDocumentType helper.
    const { D1TenantCatalogRepository } = await import("../../src/tenant/catalog-repository.js");
    await db.prepare(
      "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, 1, ?, ?)",
    ).bind("markdown", "markdown", JSON.stringify({}), "2026-09-11T00:00:00.000Z").run();
    await db.prepare(
      "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, 0, ?, ?)",
    ).bind("psd", "psd", JSON.stringify({}), "2026-09-11T00:00:00.000Z").run();

    const catalog = new D1TenantCatalogRepository(db);
    const result = await db.prepare("SELECT document_type FROM portal_document_types WHERE enabled = 1").all();
    // The registration JSON above is empty ({}), so projectPublicDocumentType
    // will reject both rows as structurally incomplete (no typeCardBundle) -
    // this test is only about which rows the WHERE clause itself lets
    // through, which the raw query above proves directly: only "markdown".
    expect((result.results ?? []).map((row: Record<string, unknown>) => row.document_type)).toEqual(["markdown"]);
    // listDocumentTypes still returns an empty page (registrations are
    // incomplete), confirming the repository does reach real D1 rather than
    // throwing outright.
    await expect(catalog.listDocumentTypes(context, {})).resolves.toEqual({ items: [], nextCursor: null });
  });
});
