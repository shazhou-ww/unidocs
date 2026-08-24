/**
 * Standalone migration entry point: `pnpm --filter @unidocs/azure-sdk run
 * migrate`. Reads `DATABASE_URL` (the only variable it needs — this script
 * never touches Blob Storage) from the environment, applies pending
 * migrations, and exits.
 *
 * Why this exists: before it did, the only way to apply migrations without
 * hand-writing a one-off script was `vitest run tests/migrate.test.ts` —
 * fine for that suite's own purposes, wrong as a general "start the
 * containers, migrate once, now run the real services" step, because this
 * package's `vitest.config.ts` globalSetup unconditionally `docker compose
 * down`s when the run finishes (see `tests/containers.ts`), taking whatever
 * else was using those containers down with it.
 *
 * Run via `pnpm run migrate` (see `scripts/bundle-migrate-cli.mjs` for why
 * this needs bundling rather than a plain `tsc` + `node dist/migrate-cli.js`
 * — same reasoning as `packages/azure-markdown`'s `scripts/bundle.mjs`),
 * not imported by anything else.
 */
import { createPool } from "./pool.js";
import { runMigrations } from "./migrate.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const pool = createPool({ databaseUrl });
  pool.on("error", (err) => {
    console.error("azure-sdk migrate-cli: pg pool error", err);
  });

  try {
    await runMigrations(pool);
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migrate-cli failed:", err);
  process.exit(1);
});
