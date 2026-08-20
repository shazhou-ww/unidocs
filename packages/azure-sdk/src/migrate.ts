import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";

// This module lives at either `src/migrate.ts` (typecheck/test, run via tsx/vitest)
// or `dist/migrate.js` (published build) — both sit one directory below the package
// root, so `../migrations` resolves to `packages/azure-sdk/migrations` either way.
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies every `migrations/*.sql` file that hasn't already been recorded in the
 * `schema_migrations` bookkeeping table, in filename order. Each pending migration
 * runs (SQL + bookkeeping insert) inside a single transaction, so a failure rolls
 * back that migration cleanly and leaves already-applied migrations untouched.
 *
 * Idempotent: running this twice in a row is a no-op the second time.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at BIGINT
    )`
  );

  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  const applied = new Set(rows.map((row) => row.name));

  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !applied.has(file));

  for (const file of pending) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)",
        [file, Date.now()]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
