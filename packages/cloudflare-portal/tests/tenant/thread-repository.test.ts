import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { D1TenantThreadRepository } from "../../src/tenant/thread-repository.js";
import { encodeCursor } from "../../src/tenant/cursor.js";
import { databaseDouble } from "./d1-double.js";

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
  let miniflare: Miniflare;
  let db: D1Database;

  /** D1's exec() runs one statement per line; the migration file is multi-line CREATE TABLEs. */
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
        name: "thread-repository-test",
        modules: true,
        script: "export default { fetch() { return new Response('ok'); } };",
        compatibilityDate: "2025-08-17",
        d1Databases: { DB: `thread-repository-${crypto.randomUUID()}` },
      }],
    }));
    await miniflare.ready;
    db = await miniflare.getD1Database("DB", "thread-repository-test") as unknown as D1Database;
    const migration = fileURLToPath(new URL("../../migrations/0012_tenant.sql", import.meta.url));
    await db.exec(collapseToOneStatementPerLine(await readFile(migration, "utf8")));
  });

  afterEach(async () => {
    await miniflare.dispose();
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
        name: "thread-repository-anchor-test",
        modules: true,
        script: "export default { fetch() { return new Response('ok'); } };",
        compatibilityDate: "2025-08-17",
        d1Databases: { DB: `thread-repository-anchor-${crypto.randomUUID()}` },
      }],
    }));
    await miniflare.ready;
    db = await miniflare.getD1Database("DB", "thread-repository-anchor-test") as unknown as D1Database;
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const files = (await readdir(migrationsDir)).filter(name => name.endsWith(".sql")).sort();
    for (const file of files) {
      await db.exec(collapseToOneStatementPerLine(await readFile(`${migrationsDir}/${file}`, "utf8")));
    }
  });

  afterEach(async () => {
    await miniflare.dispose();
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
