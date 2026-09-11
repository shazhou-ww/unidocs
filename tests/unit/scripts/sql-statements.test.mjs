import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { splitSqlStatements } from "../../../stacks/unidocs-cloudflare/local/sql-statements.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PORTAL_MIGRATIONS = join(ROOT, "packages", "cloudflare-portal", "migrations");

// The whole reason this module exists: D1's `exec()` splits on newlines, so a
// multi-line CREATE TABLE reaches SQLite as `CREATE TABLE portal_administrators (`
// and fails with "incomplete input". Every fixture here is deliberately
// multi-line — a one-statement-per-line fixture would pass against `exec` too
// and would pin nothing.
test("a multi-line CREATE TABLE survives as one statement", () => {
  const statements = splitSqlStatements(`
CREATE TABLE portal_administrators (
  member_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE UNIQUE INDEX portal_admin_active_email
  ON portal_administrators(email)
  WHERE active = 1;
`);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toBe(
    "CREATE TABLE portal_administrators (\n  member_id TEXT PRIMARY KEY,\n"
    + "  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))\n)",
  );
  expect(statements[1]).toBe(
    "CREATE UNIQUE INDEX portal_admin_active_email\n  ON portal_administrators(email)\n  WHERE active = 1",
  );
});

test("a semicolon inside a string literal does not split the statement", () => {
  const statements = splitSqlStatements(`
INSERT INTO notes (body)
VALUES ('one; two', 'it''s fine; really');
SELECT 1;
`);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("'one; two'");
  expect(statements[0]).toContain("'it''s fine; really'");
  expect(statements[1]).toBe("SELECT 1");
});

test("a semicolon inside a quoted identifier does not split the statement", () => {
  const statements = splitSqlStatements(`CREATE TABLE "odd;name" (
  "a;b" TEXT
);
SELECT 2;`);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain('"odd;name"');
});

test("a BEGIN...END trigger body keeps its inner semicolons", () => {
  const statements = splitSqlStatements(`
CREATE TRIGGER portal_touch AFTER UPDATE ON portal_administrators
BEGIN
  UPDATE portal_administrators SET updated_at = 1 WHERE member_id = NEW.member_id;
  INSERT INTO portal_admin_audit (action) VALUES (CASE WHEN NEW.active = 1 THEN 'on' ELSE 'off' END);
END;
CREATE INDEX portal_admin_active ON portal_administrators(active);
`);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("END");
  expect(statements[0].split(";")).toHaveLength(3);
  expect(statements[1]).toBe("CREATE INDEX portal_admin_active ON portal_administrators(active)");
});

test("comments are stripped and never become statements of their own", () => {
  const statements = splitSqlStatements(`
-- a leading note; with a semicolon
CREATE TABLE t ( /* inline; comment */ a TEXT );
-- a trailing note
`);
  expect(statements).toHaveLength(1);
  expect(statements[0]).not.toContain("note");
  expect(statements[0]).not.toContain("inline");
});

test("a trailing statement without a terminating semicolon is still returned", () => {
  expect(splitSqlStatements("SELECT 1;\nSELECT\n  2")).toEqual(["SELECT 1", "SELECT\n  2"]);
});

test("empty input and a file of only semicolons produce no statements", () => {
  expect(splitSqlStatements("")).toEqual([]);
  expect(splitSqlStatements("\n;;\n  ;\n")).toEqual([]);
});

// The committed portal migrations are the actual input `migrateServiceDb`
// feeds this function. They are multi-line, so `db.exec` threw on them.
test("the portal's committed migrations split into whole statements", async () => {
  const first = splitSqlStatements(await readFile(join(PORTAL_MIGRATIONS, "0001_admin_auth.sql"), "utf8"));
  expect(first).toHaveLength(14);
  expect(first[0]).toMatch(/^CREATE TABLE portal_administrators \(/);
  expect(first[0]).toMatch(/\)$/);
  expect(first[0]).toContain("CHECK ((issuer IS NULL) = (subject IS NULL))");

  const second = splitSqlStatements(await readFile(join(PORTAL_MIGRATIONS, "0002_document_types.sql"), "utf8"));
  expect(second).toHaveLength(5);
  expect(second.at(-1)).toBe(
    "ALTER TABLE portal_admin_audit ADD COLUMN details_json TEXT "
    + "CHECK (details_json IS NULL OR json_valid(details_json))",
  );

  for (const statement of [...first, ...second]) {
    expect(statement).not.toMatch(/;\s*$/);
    expect(statement.trim()).not.toBe("");
  }
});
