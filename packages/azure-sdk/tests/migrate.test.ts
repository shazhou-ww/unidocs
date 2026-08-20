import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createPool, runMigrations } from "../src/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const COMPOSE_FILE = path.resolve(__dirname, "../../../docker-compose.azure.yml");
const DATABASE_URL = "postgres://unidocs:unidocs@localhost:5433/unidocs";

let pool: Pool;

/**
 * The container has just been started (fresh, no volume) so `initdb` may still be
 * running when the port first accepts TCP connections. Poll with real `SELECT 1`
 * queries — connection-refused and "the database system is starting up" both throw
 * — rather than a fixed sleep, since container startup time varies by machine load.
 */
async function waitForPostgres(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const probe = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
    try {
      await probe.query("SELECT 1");
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await probe.end();
    }
  }
  throw new Error(`postgres did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

beforeAll(async () => {
  // Only the postgres service is needed for migration coverage; azurite is left
  // untouched here to avoid an unnecessary image pull.
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d postgres`, { stdio: "inherit" });
  await waitForPostgres(60_000);
  pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
}, 120_000);

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  execSync(`docker compose -f "${COMPOSE_FILE}" down`, { stdio: "inherit" });
}, 120_000);

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
    expect(migrationRows.map((row) => row.name)).toEqual(["0001_init.sql"]);
  }, 120_000);
});
