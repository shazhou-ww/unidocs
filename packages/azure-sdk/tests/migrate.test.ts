import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../src/index.js";
import { importLegacySessionIdentities, runMigrations } from "../src/index.js";
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
  it("is idempotent and produces only the session storage tables", async () => {
    await runMigrations(pool);
    // Running again must be a no-op, not an error — this is the idempotency guarantee.
    await runMigrations(pool);

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tableNames = rows.map((row) => row.table_name).sort();

    expect(tableNames).toContain("deltas");
    expect(tableNames).toContain("doc_snapshots");
    expect(tableNames).toContain("doc_sessions");

    const { rows: migrationRows } = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name"
    );
    expect(migrationRows.map((row) => row.name)).toEqual([
      "0001_init.sql",
      "0002_session_identity.sql",
      "0003_tenant_doc_session_keys.sql",
      "0004_agent_sessions.sql",
      "0005_font_registry.sql",
    ]);
  }, 120_000);

  it("imports operator-supplied identities only when every legacy row is covered", async () => {
    await pool.query(
      "DROP TABLE IF EXISTS doc_snapshots, deltas, doc_sessions, schema_migrations CASCADE",
    );
    await runMigrations(pool, undefined, { through: "0002_session_identity.sql" });
    await pool.query(
      `INSERT INTO deltas
        (doc_type, session_id, version, timestamp, description, operations)
       VALUES ('markdown', 'legacy-session', 1, 1, 'legacy', '[]'::jsonb)`,
    );

    await expect(importLegacySessionIdentities(pool, []))
      .rejects.toThrow(/does not cover persisted sessions/);
    await expect(importLegacySessionIdentities(pool, [{
      sessionId: "legacy-session",
      tenantId: "tenant-7",
      docType: "markdown",
    }])).resolves.toBe(1);
    await runMigrations(pool);
    const { rows } = await pool.query(
      "SELECT tenant_id, doc_type FROM doc_sessions WHERE session_id = 'legacy-session'",
    );
    expect(rows).toEqual([{ tenant_id: "tenant-7", doc_type: "markdown" }]);

    await pool.query(
      "TRUNCATE TABLE doc_sessions, deltas, doc_snapshots CASCADE",
    );
  }, 120_000);
});
