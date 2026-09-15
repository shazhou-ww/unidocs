import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { CommentRecord } from "@unidocs/protocol-tenant-portal";
import { TenantOperationError } from "@unidocs/portal-service";
import { D1TenantThreadRepository } from "../../src/tenant/thread-repository.js";
import { encodeCursor } from "../../src/tenant/cursor.js";
import { databaseDouble } from "./d1-double.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const context = { tenantId: "t-local", principalId: "user-1", transport: "session" as const };

/** Same fixture shape as catalog-repository.test.ts's `contractRow`. */
const contractRow = {
  documentType: "markdown",
  documentContractIdx: 0,
  formatVersion: 1,
  snapshot: {
    contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1",
    schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" },
    schemaHash: "sha256:snapshot",
  },
  location: {
    contentType: "application/vnd.unidocs.markdown.location+json;version=1",
    schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
    schemaHash: "sha256:location",
  },
  contractHash: "sha256:contract",
  createdAt: "2026-09-11T00:00:00.000Z",
};

describe("D1TenantThreadRepository.loadCommentAnchor", () => {
  it("returns the version's documentContractIdx and that revision's location schema", async () => {
    const database = databaseDouble([
      { document_contract_idx: 0, record_json: JSON.stringify(contractRow) },
    ]);
    const repository = new D1TenantThreadRepository(database);
    const anchor = await repository.loadCommentAnchor(context, "doc-1", 3);
    expect(anchor).toEqual({ documentContractIdx: 0, locationSchema: contractRow.location.schema });
  });

  it("returns null when the version does not exist, so the service reports not_found", async () => {
    const database = databaseDouble({ firsts: [null] });
    const repository = new D1TenantThreadRepository(database);
    await expect(repository.loadCommentAnchor(context, "doc-1", 99)).resolves.toBeNull();
  });

  it("binds tenant, document and version into the lookup", async () => {
    const database = databaseDouble([
      { document_contract_idx: 0, record_json: JSON.stringify(contractRow) },
    ]);
    const repository = new D1TenantThreadRepository(database);
    await repository.loadCommentAnchor({ ...context, tenantId: "t-other" }, "doc-1", 3);
    expect(database.statements[0]?.args).toContain("t-other");
    expect(database.statements[0]?.args).toContain("doc-1");
    expect(database.statements[0]?.args).toContain(3);
  });
});

/**
 * These tests exercise `list`'s mechanics (paging, ThreadRef projection, which
 * filters get bound) against the shared SQL-blind double: it never evaluates a
 * WHERE clause, so it cannot prove the open derivation is correct - only that
 * the repository asks the database the right question. That is still worth
 * pinning down, because it is a different failure mode than the derivation
 * itself being wrong (see the "open derivation (real D1)" block below, which
 * proves the derivation with an actual SQLite engine).
 */
describe("D1TenantThreadRepository.list (double: paging, projection, bound args)", () => {
  it("returns ThreadRef only - no comment or reply content leaks through", async () => {
    const database = databaseDouble([{ thread_id: "thread-1", created_at: 100 }]);
    const repository = new D1TenantThreadRepository(database);
    const page = await repository.list(context, "doc-1", {});
    expect(page.items).toEqual([{ threadId: "thread-1" }]);
    expect(Object.keys(page.items[0] ?? {})).toEqual(["threadId"]);
  });

  it("returns a null cursor when the page is not full", async () => {
    const database = databaseDouble([{ thread_id: "thread-1", created_at: 100 }]);
    const repository = new D1TenantThreadRepository(database);
    const page = await repository.list(context, "doc-1", { limit: 10 });
    expect(page.nextCursor).toBeNull();
  });

  it("returns a cursor and drops the probe row when a further page exists", async () => {
    const database = databaseDouble([
      { thread_id: "thread-2", created_at: 200 },
      { thread_id: "thread-1", created_at: 100 },
    ]);
    const repository = new D1TenantThreadRepository(database);
    const page = await repository.list(context, "doc-1", { limit: 1 });
    expect(page.items).toEqual([{ threadId: "thread-2" }]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("binds the decoded cursor into the query", async () => {
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list(context, "doc-1", { cursor: encodeCursor({ at: 5, id: "thread-5" }) });
    expect(database.statements[0]?.args).toContain(5);
    expect(database.statements[0]?.args).toContain("thread-5");
  });

  it("rejects a malformed cursor as invalid_request", async () => {
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await expect(repository.list(context, "doc-1", { cursor: "not-a-cursor!" })).rejects.toThrow();
  });

  it("binds the open filter as 1 when open=true is requested", async () => {
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list(context, "doc-1", { open: true });
    expect(database.statements[0]?.args).toContain(1);
  });

  it("binds the open filter as 0 when open=false is requested", async () => {
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list(context, "doc-1", { open: false });
    expect(database.statements[0]?.args).toContain(0);
  });

  it("binds a null open filter when open is not requested", async () => {
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list(context, "doc-1", {});
    expect(database.statements[0]?.args).toContain(null);
    // Every arg the repository binds for the *filters* must be null; the
    // limit bind (26) is unrelated, so exclude it before asserting there is
    // no stray 1/0 masquerading as the (absent) open filter.
    const nonLimitArgs = (database.statements[0]?.args ?? []).filter(arg => arg !== 26);
    expect(nonLimitArgs).not.toContain(1);
  });

  it("binds versionIdx into the anchoring EXISTS filter when given", async () => {
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list(context, "doc-1", { versionIdx: 7 });
    expect(database.statements[0]?.sql).toContain("base_version_idx = ?3");
    expect(database.statements[0]?.args).toContain(7);
  });

  it("does not filter by version when versionIdx is omitted", async () => {
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list(context, "doc-1", {});
    expect(database.statements[0]?.args).not.toContain(7);
  });

  it("translates the open derivation into two correlated MAX subqueries coalescing to -1", async () => {
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list(context, "doc-1", { open: true });
    const sql = database.statements[0]?.sql ?? "";
    expect(sql).toContain("COALESCE(MAX(c.comment_idx), -1)");
    expect(sql).toContain("COALESCE(MAX(r.respond_through_comment_idx), -1)");
    expect(sql).toContain("FROM portal_comments c");
    expect(sql).toContain("FROM portal_replies r");
  });

  it("scopes the query to tenant and document - the double cannot enforce this, only prove it asked", async () => {
    // The double answers from its canned queue regardless of WHERE clauses,
    // so this cannot prove isolation on its own; it proves the repository
    // bound the *other* tenant's id, not the fixture's. Real isolation is
    // proven by the "open derivation (real D1)" block below.
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list({ ...context, tenantId: "t-other" }, "doc-1", {});
    expect(database.statements[0]?.args).toContain("t-other");
    expect(database.statements[0]?.args).not.toContain("t-local");
  });

  it("uses a disjunction, not a row-value comparison, for the keyset predicate", async () => {
    // D1's SQLite does support `(a, b) < (c, d)` (verified separately against
    // a real D1 instance), but every other tenant repository in this package
    // already uses the disjunctive form for keyset paging - matching that
    // convention here keeps one style across the package.
    const database = databaseDouble([]);
    const repository = new D1TenantThreadRepository(database);
    await repository.list(context, "doc-1", { cursor: encodeCursor({ at: 5, id: "thread-5" }) });
    const sql = database.statements[0]?.sql ?? "";
    expect(sql).not.toMatch(/\([^)]*created_at[^)]*,\s*[^)]*thread_id[^)]*\)\s*<\s*\(/);
    expect(sql).toContain("t.created_at < ?5 OR (t.created_at = ?5 AND t.thread_id < ?6)");
  });
});

/**
 * The open derivation lives entirely inside SQL, and the shared double never
 * evaluates a WHERE clause - it just replays whatever rows a test seeds. A
 * test that seeds "the open thread" and asserts it comes back proves nothing:
 * it would pass identically even if `list` sent `SELECT 1` and ignored `open`
 * entirely. These boundary cases (7-9 in the brief) are exactly where a
 * stored `open` flag would silently disagree with the derived truth, so they
 * are proven here against a real SQLite engine (D1 running under Miniflare -
 * the same technique `cloudflare-gateway/tests/oauth-d1.test.ts` already uses
 * for this package family), not the double.
 */
describe("D1TenantThreadRepository.list - open derivation (real D1)", () => {
  let real: RealD1;
  let db: D1Database;

  beforeEach(async () => {
    real = await startRealD1();
    db = real.db;
  });

  afterEach(async () => {
    await real.dispose();
  });

  async function seedDocument(tenantId: string, documentId: string) {
    await db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(tenantId, documentId, "Doc", "markdown", null, 0).run();
  }

  async function seedThread(tenantId: string, documentId: string, threadId: string, createdAt: number) {
    await db.prepare(
      "INSERT INTO portal_threads (tenant_id, document_id, thread_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(tenantId, documentId, threadId, createdAt).run();
  }

  async function seedComment(tenantId: string, documentId: string, threadId: string, commentIdx: number, baseVersionIdx: number) {
    await db.prepare(
      `INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(tenantId, documentId, threadId, commentIdx, baseVersionIdx, JSON.stringify({ text: "hi", richContent: null, attachments: [] }), "user-1", commentIdx).run();
  }

  async function seedReply(tenantId: string, documentId: string, threadId: string, replyIdx: number, respondThrough: number) {
    await db.prepare(
      `INSERT INTO portal_replies (tenant_id, document_id, thread_id, reply_idx, respond_through_comment_idx, content_json, result_locations_json, author_agent_id, submission_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(tenantId, documentId, threadId, replyIdx, respondThrough, JSON.stringify({ text: "reply", richContent: null, attachments: [] }), JSON.stringify([]), "agent-1", "sub-1", replyIdx).run();
  }

  it("a thread with a comment and no reply is open (acknowledged watermark defaults to -1)", async () => {
    await seedDocument("t-local", "doc-1");
    await seedThread("t-local", "doc-1", "thread-1", 1);
    await seedComment("t-local", "doc-1", "thread-1", 0, 0);

    const repository = new D1TenantThreadRepository(db);
    const openPage = await repository.list(context, "doc-1", { open: true });
    const closedPage = await repository.list(context, "doc-1", { open: false });
    expect(openPage.items).toEqual([{ threadId: "thread-1" }]);
    expect(closedPage.items).toEqual([]);
  });

  it("a reply whose respond_through equals the latest comment_idx answers the thread", async () => {
    await seedDocument("t-local", "doc-1");
    await seedThread("t-local", "doc-1", "thread-1", 1);
    await seedComment("t-local", "doc-1", "thread-1", 0, 0);
    await seedReply("t-local", "doc-1", "thread-1", 0, 0);

    const repository = new D1TenantThreadRepository(db);
    const openPage = await repository.list(context, "doc-1", { open: true });
    const closedPage = await repository.list(context, "doc-1", { open: false });
    expect(openPage.items).toEqual([]);
    expect(closedPage.items).toEqual([{ threadId: "thread-1" }]);
  });

  it("appending a newer comment after the reply reopens the same thread", async () => {
    await seedDocument("t-local", "doc-1");
    await seedThread("t-local", "doc-1", "thread-1", 1);
    await seedComment("t-local", "doc-1", "thread-1", 0, 0);
    await seedReply("t-local", "doc-1", "thread-1", 0, 0);
    await seedComment("t-local", "doc-1", "thread-1", 1, 0);

    const repository = new D1TenantThreadRepository(db);
    const openPage = await repository.list(context, "doc-1", { open: true });
    const closedPage = await repository.list(context, "doc-1", { open: false });
    expect(openPage.items).toEqual([{ threadId: "thread-1" }]);
    expect(closedPage.items).toEqual([]);
  });

  it("only returns threads with a comment anchored to the requested versionIdx", async () => {
    await seedDocument("t-local", "doc-1");
    await seedThread("t-local", "doc-1", "thread-v0", 1);
    await seedComment("t-local", "doc-1", "thread-v0", 0, 0);
    await seedThread("t-local", "doc-1", "thread-v1", 2);
    await seedComment("t-local", "doc-1", "thread-v1", 0, 1);

    const repository = new D1TenantThreadRepository(db);
    const page = await repository.list(context, "doc-1", { versionIdx: 0 });
    expect(page.items).toEqual([{ threadId: "thread-v0" }]);
  });

  it("is not visible across tenants", async () => {
    await seedDocument("t-local", "doc-1");
    await seedThread("t-local", "doc-1", "thread-1", 1);
    await seedComment("t-local", "doc-1", "thread-1", 0, 0);

    const repository = new D1TenantThreadRepository(db);
    const otherTenantPage = await repository.list({ ...context, tenantId: "t-other" }, "doc-1", {});
    expect(otherTenantPage.items).toEqual([]);
  });

  it("orders by created_at desc, thread_id desc and pages with a real cursor", async () => {
    await seedDocument("t-local", "doc-1");
    await seedThread("t-local", "doc-1", "thread-a", 100);
    await seedComment("t-local", "doc-1", "thread-a", 0, 0);
    await seedThread("t-local", "doc-1", "thread-b", 200);
    await seedComment("t-local", "doc-1", "thread-b", 0, 0);

    const repository = new D1TenantThreadRepository(db);
    const first = await repository.list(context, "doc-1", { limit: 1 });
    expect(first.items).toEqual([{ threadId: "thread-b" }]);
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.list(context, "doc-1", { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toEqual([{ threadId: "thread-a" }]);
    expect(second.nextCursor).toBeNull();
  });
});

/**
 * `loadCommentAnchor`'s tests above use the double, which returns whatever
 * row a test seeds regardless of the three-table join's actual ON
 * conditions - a broken join (e.g. matching by document_contract_idx alone,
 * ignoring document_type) would pass them just the same. This block proves
 * the join itself against real D1, applying every migration up to 0012 so
 * `portal_document_types` and `portal_document_contracts` (from 0002/0003)
 * exist alongside the tenant tables.
 */
describe("D1TenantThreadRepository.loadCommentAnchor (real D1)", () => {
  let real: RealD1;
  let db: D1Database;

  beforeEach(async () => {
    real = await startRealD1();
    db = real.db;
  });

  afterEach(async () => {
    await real.dispose();
  });

  async function seedDocumentType(documentType: string) {
    await db.prepare(
      "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, 1, '{}', ?)",
    ).bind(documentType, documentType, "2026-09-11T00:00:00.000Z").run();
  }

  async function seedDocumentContract(documentType: string, documentContractIdx: number, locationSchema: Record<string, unknown>) {
    await db.prepare(
      `INSERT INTO portal_document_contracts (document_type, document_contract_idx, contract_hash, record_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      documentType, documentContractIdx, `hash-${documentType}-${documentContractIdx}`,
      JSON.stringify({ ...contractRow, documentType, documentContractIdx, location: { ...contractRow.location, schema: locationSchema } }),
      0,
    ).run();
  }

  async function seedDocument(tenantId: string, documentId: string, documentType: string) {
    await db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(tenantId, documentId, "Doc", documentType, null, 0).run();
  }

  async function seedVersion(tenantId: string, documentId: string, versionIdx: number, documentContractIdx: number) {
    await db.prepare(
      `INSERT INTO portal_versions
         (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id,
          addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, '[]', ?, 0, ?, ?)`,
    ).bind(
      tenantId, documentId, versionIdx, documentContractIdx, "agent-1", "sub-1",
      `hash-${documentId}-${versionIdx}`, "application/octet-stream", 0,
    ).run();
  }

  it("resolves the version's documentContractIdx and that revision's location schema through document_type", async () => {
    await seedDocumentType("markdown");
    const schema = { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object", title: "markdown-v0" };
    await seedDocumentContract("markdown", 0, schema);
    await seedDocument("t-local", "doc-1", "markdown");
    await seedVersion("t-local", "doc-1", 3, 0);

    const repository = new D1TenantThreadRepository(db);
    const anchor = await repository.loadCommentAnchor(context, "doc-1", 3);
    expect(anchor).toEqual({ documentContractIdx: 0, locationSchema: schema });
  });

  it("does not cross-join into another document type's contract with the same document_contract_idx", async () => {
    // doc-1 is "markdown" and its version fixes document_contract_idx 0, but no
    // "markdown" contract at that idx is seeded - only "other-type" has one.
    // A join that matched on document_contract_idx alone (dropping the
    // document_type correlation) would find that unrelated row and return its
    // schema instead of null; this is deterministic regardless of row order,
    // unlike asserting which of two matching rows "first()" happens to pick.
    await seedDocumentType("markdown");
    await seedDocumentType("other-type");
    const otherSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object", title: "other-schema" };
    await seedDocumentContract("other-type", 0, otherSchema);
    await seedDocument("t-local", "doc-1", "markdown");
    await seedVersion("t-local", "doc-1", 0, 0);

    const repository = new D1TenantThreadRepository(db);
    await expect(repository.loadCommentAnchor(context, "doc-1", 0)).resolves.toBeNull();
  });

  it("returns null when the version does not exist", async () => {
    await seedDocumentType("markdown");
    await seedDocumentContract("markdown", 0, { $schema: "https://schemas.unidocs.dev/svalue/v1" });
    await seedDocument("t-local", "doc-1", "markdown");

    const repository = new D1TenantThreadRepository(db);
    await expect(repository.loadCommentAnchor(context, "doc-1", 99)).resolves.toBeNull();
  });

  it("does not resolve another tenant's version for the same document id", async () => {
    await seedDocumentType("markdown");
    await seedDocumentContract("markdown", 0, { $schema: "https://schemas.unidocs.dev/svalue/v1" });
    await seedDocument("t-local", "doc-1", "markdown");
    await seedVersion("t-local", "doc-1", 0, 0);

    const repository = new D1TenantThreadRepository(db);
    await expect(repository.loadCommentAnchor({ ...context, tenantId: "t-other" }, "doc-1", 0)).resolves.toBeNull();
  });
});

/**
 * `create`, `get` and `appendComment` all live entirely in SQL - the
 * idempotency receipt shape, the append-only sequence ordering, and above all
 * the `comment_idx` allocation - so, matching the two blocks above, they are
 * proven here against real D1 running under Miniflare rather than the
 * SQL-blind double. The double cannot evaluate the `SELECT COALESCE(MAX(...),
 * -1) + 1` proposal read and the batched insert-with-explicit-index this task
 * exists to get right, so a double-only test of it would pass whether or not
 * the allocation is actually race-free.
 *
 * D1 enforces `FOREIGN KEY` constraints by default (confirmed against a real
 * D1 instance under Miniflare, and documented at
 * developers.cloudflare.com/d1/sql-api/foreign-keys/), which is what makes
 * appending to a nonexistent thread fail without any extra existence check.
 */
describe("D1TenantThreadRepository.create / get / appendComment (real D1)", () => {
  let real: RealD1;
  let db: D1Database;

  beforeEach(async () => {
    real = await startRealD1();
    db = real.db;
    await db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("t-local", "doc-1", "Doc", "markdown", null, 0).run();
  });

  afterEach(async () => {
    await real.dispose();
  });

  const messageContent = { text: "hi", richContent: null, attachments: [] };

  async function seedDocument(documentId: string) {
    await db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("t-local", documentId, "Doc", "markdown", null, 0).run();
  }

  function createCommand(overrides: { key?: string; fingerprint?: string; baseVersionIdx?: number; documentId?: string } = {}) {
    return {
      context, documentId: overrides.documentId ?? "doc-1",
      key: overrides.key ?? "key-create-1",
      fingerprint: overrides.fingerprint ?? "fp-create-1",
      request: { baseVersionIdx: overrides.baseVersionIdx ?? 0, content: messageContent, location: null },
    };
  }

  function appendCommand(threadId: string, overrides: { key?: string; fingerprint?: string; baseVersionIdx?: number } = {}) {
    return {
      context, documentId: "doc-1", threadId,
      key: overrides.key ?? "key-append-1",
      fingerprint: overrides.fingerprint ?? "fp-append-1",
      request: { baseVersionIdx: overrides.baseVersionIdx ?? 0, content: messageContent, location: null },
    };
  }

  it("creates a thread and its first comment (commentIdx 0), returning the complete ThreadDetail", async () => {
    const repository = new D1TenantThreadRepository(db);
    const detail = await repository.create(createCommand());
    expect(detail.threadId).toMatch(/^th-/);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]).toMatchObject({ commentIdx: 0, baseVersionIdx: 0, authorId: "user-1", content: messageContent, location: null });
    expect(detail.replies).toEqual([]);
  });

  it("replays the same key and fingerprint without creating a second thread", async () => {
    const repository = new D1TenantThreadRepository(db);
    const first = await repository.create(createCommand());
    const second = await repository.create(createCommand());
    expect(second).toEqual(first);

    const count = await db.prepare(
      "SELECT COUNT(*) as n FROM portal_threads WHERE tenant_id = ? AND document_id = ?",
    ).bind("t-local", "doc-1").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects the same key reused with a different fingerprint as idempotency_conflict", async () => {
    const repository = new D1TenantThreadRepository(db);
    await repository.create(createCommand({ key: "key-conflict", fingerprint: "fp-a" }));
    await expect(repository.create(createCommand({ key: "key-conflict", fingerprint: "fp-b" })))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    // Also confirm it is the tenant operation error type, not some other rejection shape.
    await expect(repository.create(createCommand({ key: "key-conflict", fingerprint: "fp-c" })))
      .rejects.toBeInstanceOf(TenantOperationError);
  });

  /**
   * The service's fingerprint (`schemaHash({ operation: "createThread", body })`
   * in `packages/portal-service/src/tenant/threads.ts`, which this repository
   * cannot change) does not include documentId, but the receipt primary key
   * is (tenant_id, actor_id, operation, key) - so before this fix, the same
   * key and body sent to two different documents replayed doc-a's thread for
   * doc-b's caller, who believed they had opened a new thread there.
   */
  it("does not replay one document's thread when the same key and body target another document", async () => {
    await seedDocument("doc-a");
    await seedDocument("doc-b");
    const repository = new D1TenantThreadRepository(db);
    const onA = await repository.create(createCommand({ documentId: "doc-a", key: "shared-key", fingerprint: "shared-fp" }));
    const onB = await repository.create(createCommand({ documentId: "doc-b", key: "shared-key", fingerprint: "shared-fp" }));
    expect(onB.threadId).not.toBe(onA.threadId);

    const rows = await db.prepare("SELECT document_id FROM portal_threads ORDER BY document_id").all<{ document_id: string }>();
    expect(rows.results.map(row => row.document_id)).toEqual(["doc-a", "doc-b"]);
  });

  it("still replays the same key and body on the same document", async () => {
    const repository = new D1TenantThreadRepository(db);
    const first = await repository.create(createCommand({ key: "same-doc-key", fingerprint: "same-doc-fp" }));
    const second = await repository.create(createCommand({ key: "same-doc-key", fingerprint: "same-doc-fp" }));
    expect(second.threadId).toBe(first.threadId);
  });

  it("get returns both append-only sequences, each ascending by index", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    await repository.appendComment(appendCommand(created.threadId, { key: "k2", fingerprint: "f2" }));
    await db.prepare(
      `INSERT INTO portal_replies (tenant_id, document_id, thread_id, reply_idx, respond_through_comment_idx, content_json, result_locations_json, author_agent_id, submission_id, created_at)
       VALUES (?, ?, ?, 0, 1, ?, '[]', 'agent-1', 'sub-1', 5)`,
    ).bind("t-local", "doc-1", created.threadId, JSON.stringify(messageContent)).run();

    const detail = await repository.get(context, "doc-1", created.threadId);
    expect(detail?.comments.map(c => c.commentIdx)).toEqual([0, 1]);
    expect(detail?.replies.map(r => r.replyIdx)).toEqual([0]);
    expect(detail?.replies[0]?.respondThroughCommentIdx).toBe(1);
  });

  it("returns null when the thread does not exist", async () => {
    const repository = new D1TenantThreadRepository(db);
    await expect(repository.get(context, "doc-1", "th-missing")).resolves.toBeNull();
  });

  it("is not visible across tenants", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    await expect(repository.get({ ...context, tenantId: "t-other" }, "doc-1", created.threadId)).resolves.toBeNull();
  });

  it("allocates the appended commentIdx as the current max plus one", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    const second = await repository.appendComment(appendCommand(created.threadId, { key: "k2", fingerprint: "f2" }));
    expect(second.commentIdx).toBe(1);
    const third = await repository.appendComment(appendCommand(created.threadId, { key: "k3", fingerprint: "f3" }));
    expect(third.commentIdx).toBe(2);
  });

  it("replays the same key and fingerprint without creating a second comment", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    const first = await repository.appendComment(appendCommand(created.threadId, { key: "k2", fingerprint: "f2" }));
    const second = await repository.appendComment(appendCommand(created.threadId, { key: "k2", fingerprint: "f2" }));
    expect(second).toEqual(first);

    const detail = await repository.get(context, "doc-1", created.threadId);
    expect(detail?.comments).toHaveLength(2);
  });

  it("fails to append to a thread that does not exist", async () => {
    const repository = new D1TenantThreadRepository(db);
    await expect(repository.appendComment(appendCommand("th-missing")))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(repository.appendComment(appendCommand("th-missing", { key: "k-missing-2", fingerprint: "f-missing-2" })))
      .rejects.toBeInstanceOf(TenantOperationError);
  });

  it("fails to append to another tenant's thread", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    await expect(repository.appendComment({
      ...appendCommand(created.threadId), context: { ...context, tenantId: "t-other" },
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("appending after the thread has been answered makes it open again", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    await db.prepare(
      `INSERT INTO portal_replies (tenant_id, document_id, thread_id, reply_idx, respond_through_comment_idx, content_json, result_locations_json, author_agent_id, submission_id, created_at)
       VALUES (?, ?, ?, 0, 0, ?, '[]', 'agent-1', 'sub-1', 5)`,
    ).bind("t-local", "doc-1", created.threadId, JSON.stringify(messageContent)).run();

    const closedPage = await repository.list(context, "doc-1", { open: false });
    expect(closedPage.items).toEqual([{ threadId: created.threadId }]);
    const closedOpenPage = await repository.list(context, "doc-1", { open: true });
    expect(closedOpenPage.items).toEqual([]);

    await repository.appendComment(appendCommand(created.threadId, { key: "k2", fingerprint: "f2" }));

    const openPage = await repository.list(context, "doc-1", { open: true });
    expect(openPage.items).toEqual([{ threadId: created.threadId }]);
    const nowClosedPage = await repository.list(context, "doc-1", { open: false });
    expect(nowClosedPage.items).toEqual([]);
  });

  it("allocates distinct sequential comment indices for concurrent appends, with no application-level lock", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repository.appendComment(appendCommand(created.threadId, { key: `k-concurrent-${i}`, fingerprint: `f-concurrent-${i}` }))),
    );
    const indices = results.map(r => r.commentIdx).sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4, 5]);
  });

  /**
   * Every other idempotency test above reuses a key sequentially, so the
   * initial `replay()` check always catches the duplicate before the batch
   * ever runs - the "re-read the receipt after a failed batch" branch (the
   * concurrent-duplicate path `document-repository.ts`'s `create` also has)
   * is never exercised by any of them. Firing genuinely concurrent `create`
   * calls with the same key is what forces two callers past the initial
   * check at once, so only this test can reach that branch.
   */
  it("creates exactly one thread when the same key and fingerprint race concurrently", async () => {
    const repository = new D1TenantThreadRepository(db);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.create(createCommand({ key: "key-race", fingerprint: "fp-race" }))),
    );
    const threadIds = new Set(results.map(r => r.threadId));
    expect(threadIds.size).toBe(1);

    const count = await db.prepare(
      "SELECT COUNT(*) as n FROM portal_threads WHERE tenant_id = ? AND document_id = ?",
    ).bind("t-local", "doc-1").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  /**
   * The comment insert and its receipt now share one atomic `batch`, so a
   * same-key race must leave exactly the winner's row behind - never an
   * orphan from a loser whose batch rolled back. This is the in-tree proof:
   * five concurrent `appendComment` calls with the identical key against a
   * thread that already has commentIdx 0 must land exactly one more comment
   * row (commentIdx 1), and every caller must observe that same index.
   */
  it("leaves no orphan comment when the same key races concurrently", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.appendComment(appendCommand(created.threadId, { key: "key-append-race", fingerprint: "fp-append-race" }))),
    );
    const indices = new Set(results.map(r => r.commentIdx));
    expect(indices).toEqual(new Set([1]));

    const count = await db.prepare(
      "SELECT COUNT(*) as n FROM portal_comments WHERE tenant_id = ? AND document_id = ? AND thread_id = ?",
    ).bind("t-local", "doc-1", created.threadId).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  /**
   * The sharper variant of the same bug: same key, *different* fingerprints,
   * racing concurrently. Before the comment and its receipt were batched
   * together, the loser could commit its own comment row and only then
   * discover the fingerprint mismatch while writing the receipt - meaning it
   * both persisted a write and reported idempotency_conflict to its caller,
   * the inverse of what an idempotency key promises. With the comment and
   * receipt sharing one atomic batch, the loser's comment insert rolls back
   * together with its failed receipt insert, so it contributes nothing.
   */
  it("rejects the losing fingerprint of a same-key race without persisting its write", async () => {
    const repository = new D1TenantThreadRepository(db);
    const created = await repository.create(createCommand());
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        repository.appendComment(appendCommand(created.threadId, { key: "key-fingerprint-race", fingerprint: `fp-race-${i}` }))),
    );

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<CommentRecord> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: "idempotency_conflict" });

    const count = await db.prepare(
      "SELECT COUNT(*) as n FROM portal_comments WHERE tenant_id = ? AND document_id = ? AND thread_id = ?",
    ).bind("t-local", "doc-1", created.threadId).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});

/**
 * The concurrency tests above exercise the real allocation and batch end to
 * end, but Miniflare's D1 simulation may simply serialize concurrent
 * `appendComment` calls without ever producing an actual primary-key
 * collision on an *independent* append - which would leave the retry branch
 * untested. This double pins that branch directly: the first `batch` attempt
 * is made to throw the exact error D1 raises for a `comment_idx`
 * primary-key collision (confirmed against real D1 in the probe referenced
 * in the task report), the receipt lookup on the retry path returns nothing
 * (an independent collision, not a same-key duplicate), and the test asserts
 * the repository retries with a freshly re-read index rather than surfacing
 * that error.
 */
describe("D1TenantThreadRepository.appendComment - retries a comment_idx collision", () => {
  it("retries the allocation once, and returns the index the second attempt won", async () => {
    let nextIdxReads = 0;
    let batchAttempts = 0;
    const fakeDatabase = {
      prepare(sql: string) {
        return {
          bind: (..._args: unknown[]) => ({
            first: async () => {
              if (!sql.includes("next_idx")) return null; // receipt lookup: no same-key duplicate exists
              nextIdxReads += 1;
              return { next_idx: nextIdxReads === 1 ? 4 : 5 };
            },
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 1 } }),
          }),
        };
      },
      batch: async () => {
        batchAttempts += 1;
        if (batchAttempts === 1) {
          throw new Error(
            "D1_ERROR: UNIQUE constraint failed: portal_comments.tenant_id, portal_comments.document_id, portal_comments.thread_id, portal_comments.comment_idx: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
          );
        }
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
      },
    } as unknown as D1Database;

    const repository = new D1TenantThreadRepository(fakeDatabase);
    const record = await repository.appendComment({
      context, documentId: "doc-1", threadId: "thread-1",
      key: "retry-key", fingerprint: "retry-fp",
      request: { baseVersionIdx: 0, content: { text: "hi", richContent: null, attachments: [] }, location: null },
    });
    expect(record.commentIdx).toBe(5);
    expect(batchAttempts).toBe(2);
    expect(nextIdxReads).toBe(2);
  });

  /**
   * When every attempt loses the index race - `MAX_COMMENT_IDX_ATTEMPTS`
   * collisions in a row, a contention scenario this double can force but a
   * sequential or even a five-way concurrent real-D1 test cannot - the
   * failure is transient contention, not a client error. Plan 3's error
   * mapper turns a bare `Error` into an opaque 500; `unavailable` is the
   * honest code, since it tells the client to retry rather than to give up.
   */
  it("throws unavailable once every retry attempt loses the index race", async () => {
    const fakeDatabase = {
      prepare(sql: string) {
        return {
          bind: (..._args: unknown[]) => ({
            first: async () => (sql.includes("next_idx") ? { next_idx: 1 } : null),
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 1 } }),
          }),
        };
      },
      batch: async () => {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: portal_comments.tenant_id, portal_comments.document_id, portal_comments.thread_id, portal_comments.comment_idx: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
        );
      },
    } as unknown as D1Database;

    const repository = new D1TenantThreadRepository(fakeDatabase);
    await expect(repository.appendComment({
      context, documentId: "doc-1", threadId: "thread-1",
      key: "exhaust-key", fingerprint: "exhaust-fp",
      request: { baseVersionIdx: 0, content: { text: "hi", richContent: null, attachments: [] }, location: null },
    })).rejects.toMatchObject({ code: "unavailable" });
  });
});
