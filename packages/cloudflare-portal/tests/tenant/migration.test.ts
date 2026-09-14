import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL("../../migrations/0012_tenant.sql", import.meta.url));

describe("tenant migration", () => {
  it("creates every table the repositories need", async () => {
    const sql = await readFile(migration, "utf8");
    for (const table of [
      "portal_documents",
      "portal_versions",
      "portal_threads",
      "portal_comments",
      "portal_replies",
      "portal_document_audit",
      "portal_tenant_idempotency_receipts",
      "portal_tenant_sessions",
    ]) {
      expect(sql, table).toContain(`CREATE TABLE ${table} (`);
    }
  });

  it("does not store a thread's open state", async () => {
    const sql = await readFile(migration, "utf8");
    // open is derived from the two watermarks; a stored flag would be a second
    // source of truth the contract explicitly refuses.
    expect(sql).not.toMatch(/\bopen\b\s+INTEGER/i);
    expect(sql).not.toMatch(/\bresolved\b/i);
  });

  it("keeps tenant idempotency receipts off the administrator foreign key", async () => {
    const sql = await readFile(migration, "utf8");
    const receipts = sql.slice(sql.indexOf("CREATE TABLE portal_tenant_idempotency_receipts"));
    const table = receipts.slice(0, receipts.indexOf(");"));
    expect(table).not.toContain("portal_administrators");
  });

  it("validates every JSON column", async () => {
    const sql = await readFile(migration, "utf8");
    const jsonColumns = sql.match(/^\s*\w+_json TEXT NOT NULL(?! CHECK \(json_valid)/gm);
    expect(jsonColumns).toBeNull();
  });

  it("B2: indexes portal_comments on (tenant_id, document_id, base_version_idx) for thread-repository.ts's open filter", async () => {
    // thread-repository.ts's list() anchors open threads with a correlated
    // EXISTS on base_version_idx, which has no index of its own before this:
    // comment_idx is the trailing PK column (a seek), but base_version_idx
    // is not, so that EXISTS scanned every comment row for the document.
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain("CREATE INDEX portal_comment_version ON portal_comments(tenant_id, document_id, base_version_idx);");
  });
});
