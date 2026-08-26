import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";

/**
 * Where `migrations/*.sql` lives relative to THIS module. Correct whenever
 * this module runs from its own real location on disk — `src/migrate.ts`
 * (typecheck/test, run via vitest) or `dist/migrate.js` (a plain `tsc`
 * build), both one directory below the package root, so `../migrations`
 * resolves to `packages/azure-sdk/migrations` either way — and *incorrect*
 * once this module is inlined into someone else's esbuild bundle: bundling
 * rewrites `import.meta.url` to point at the bundle's own output file, which
 * generally does not sit at that same one-level-below-package-root depth
 * (see `packages/azure-sdk/src/migrate-cli.ts`, whose bundle output happens
 * to land at the right depth by construction, versus e.g.
 * `azure-markdown/dist/main.js`, which would not).
 *
 * Exported so a caller that DOES need to run from a different location (a
 * bundle, a different working directory, ...) can compute and pass the real
 * directory itself instead of relying on this default.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies every `migrationsDir/*.sql` file that hasn't already been recorded
 * in the `schema_migrations` bookkeeping table, in filename order. Each
 * pending migration runs (SQL + bookkeeping insert) inside a single
 * transaction, so a failure rolls back that migration cleanly and leaves
 * already-applied migrations untouched.
 *
 * Idempotent: running this twice in a row is a no-op the second time.
 *
 * `migrationsDir` defaults to `MIGRATIONS_DIR` (this module's own real
 * `migrations/` directory) — pass it explicitly only when the default would
 * be wrong for how this code is currently running, e.g. from inside an
 * esbuild bundle. See the doc on `MIGRATIONS_DIR` above.
 */
export interface RunMigrationsOptions {
  readonly through?: string;
}

export async function runMigrations(
  pool: Pool,
  migrationsDir: string = MIGRATIONS_DIR,
  options: RunMigrationsOptions = {},
): Promise<void> {
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

  const pending = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => options.through === undefined || file <= options.through)
    .filter((file) => !applied.has(file));

  for (const file of pending) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
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
