/**
 * Vitest `globalSetup` for this package: bring the `docker-compose.azure.yml`
 * stack up ONCE for the whole run, and tear it down once at the end.
 *
 * Both test files here need Postgres, and one of them needs Azurite too. When
 * each file did its own `up`/`down` in `beforeAll`/`afterAll`, correctness
 * depended on the files never overlapping — one file's `docker compose down`
 * would pull the database out from under the other — and that in turn depended
 * on a `--fileParallelism=false` flag living in the `test` script. Anyone
 * following CLAUDE.md's documented way to run a single test
 * (`pnpm --filter <pkg> exec vitest run tests/x.test.ts`) bypasses the script
 * and the flag with it. Container lifecycle belongs to the run, not to a file,
 * so it lives here; `vitest.config.ts` keeps `fileParallelism: false` as well,
 * but now only as defence in depth over the shared database, not as the thing
 * holding the containers together.
 *
 * Side benefit: the stack starts once instead of twice, so `initdb` no longer
 * runs a second time in the middle of the suite.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BlobServiceClient } from "@azure/storage-blob";
import { createPool } from "../src/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const COMPOSE_FILE = path.resolve(__dirname, "../../../docker-compose.azure.yml");

export const DATABASE_URL = "postgres://unidocs:unidocs@localhost:5433/unidocs";
// Azurite's well-known emulator account, resolved by the SDK to
// http://127.0.0.1:10000/devstoreaccount1.
export const BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";

/**
 * Poll with a real query: a container that has just been created accepts TCP on
 * the mapped port before `initdb` has finished, and both connection-refused and
 * "the database system is starting up" surface as a throw. Startup time varies
 * with machine load, so this is a poll rather than a fixed sleep.
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

/** Same idea for Azurite: the blob endpoint accepts TCP before it serves the API. */
async function waitForAzurite(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const svc = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await svc.getContainerClient("readiness-probe").createIfNotExists();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`azurite did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

export async function setup(): Promise<void> {
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d`, { stdio: "inherit" });
  await waitForPostgres(60_000);
  await waitForAzurite(60_000);
}

export async function teardown(): Promise<void> {
  execSync(`docker compose -f "${COMPOSE_FILE}" down`, { stdio: "inherit" });
}
