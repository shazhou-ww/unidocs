/**
 * A real D1 database under Miniflare, with every migration applied through the
 * SAME statement splitter the local runtime uses.
 *
 * The test double in d1-double.ts never evaluates SQL, so it can prove what a
 * query asked for but not what SQLite answers. Anything whose correctness lives
 * in a WHERE clause, a join, a guard subquery or a constraint must be tested
 * here instead - that is how a phantom audit row slipped past the double.
 *
 * Migrations are split with stacks/unidocs-cloudflare/local/sql-statements.mjs
 * rather than a naive split on ";", so a migration that applies in tests is one
 * that applies in `pnpm dev portal`, and vice versa.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { splitSqlStatements } from "../../../../stacks/unidocs-cloudflare/local/sql-statements.mjs";

export interface RealD1 {
  readonly db: D1Database;
  /** Applies one migration file by name, for a test that starts from an earlier schema. */
  applyMigration(file: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface RealD1Options {
  /** Apply only migrations whose file name sorts at or before this one. */
  readonly through?: string;
}

const WORKER = "tenant-real-d1";
const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function startRealD1(options: RealD1Options = {}): Promise<RealD1> {
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: WORKER,
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: `tenant-real-d1-${crypto.randomUUID()}` },
    }],
  }));
  try {
    await miniflare.ready;
    const db = await miniflare.getD1Database("DB", WORKER) as unknown as D1Database;
    const applyMigration = async (file: string) => {
      const sql = await readFile(`${MIGRATIONS}${file}`, "utf8");
      for (const statement of splitSqlStatements(sql, file)) {
        await db.prepare(statement).run();
      }
    };
    const files = (await readdir(MIGRATIONS)).filter(file => file.endsWith(".sql")).sort()
      .filter(file => options.through === undefined || file <= options.through);
    for (const file of files) await applyMigration(file);
    return { db, applyMigration, dispose: () => miniflare.dispose() };
  } catch (error) {
    await miniflare.dispose();
    throw error;
  }
}
