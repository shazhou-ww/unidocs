import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../src/index.js";
import { runMigrations } from "../src/index.js";
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

// The Postgres container is started once per run by `tests/containers.ts`
// (`globalSetup`), which also waits for it to accept queries — so this file
// only owns its pool.
let pool: Pool;

beforeAll(() => {
  pool = createPool({
    databaseUrl: DATABASE_URL,
    blobConnectionString: BLOB_CONNECTION_STRING,
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("runMigrations", () => {
  it("is idempotent and produces the deltas/doc_snapshots/docs tables", async () => {
    await runMigrations(pool);
    // Running again must be a no-op, not an error — this is the idempotency guarantee.
    await runMigrations(pool);

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tableNames = rows.map((row) => row.table_name).sort();

    expect(tableNames).toContain("deltas");
    expect(tableNames).toContain("doc_snapshots");
    expect(tableNames).toContain("docs");

    const { rows: migrationRows } = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations"
    );
    expect(migrationRows.map((row) => row.name)).toEqual(["0001_init.sql", "0002_doc_types.sql"]);
  }, 120_000);
});
