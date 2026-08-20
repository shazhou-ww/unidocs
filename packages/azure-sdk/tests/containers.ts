/**
 * Vitest `globalSetup` for this package: bring up Postgres (via
 * `docker-compose.azure.yml`) and Azurite (spawned directly as a Node
 * process — see below) ONCE for the whole run, and tear both down once at
 * the end.
 *
 * Both test files here need Postgres, and one of them needs Azurite too. When
 * each file did its own `up`/`down` in `beforeAll`/`afterAll`, correctness
 * depended on the files never overlapping — one file's `docker compose down`
 * would pull the database out from under the other — and that in turn depended
 * on a `--fileParallelism=false` flag living in the `test` script. Anyone
 * following CLAUDE.md's documented way to run a single test
 * (`pnpm --filter <pkg> exec vitest run tests/x.test.ts`) bypasses the script
 * and the flag with it. Container/process lifecycle belongs to the run, not
 * to a file, so it lives here; `vitest.config.ts` keeps `fileParallelism:
 * false` as well, but now only as defence in depth over the shared database,
 * not as the thing holding the stack together.
 *
 * Side benefit: the stack starts once instead of twice, so `initdb` no longer
 * runs a second time in the middle of the suite.
 *
 * Azurite doesn't run in a container here. The `azurite` npm package ships
 * `azurite-blob` as a plain Node CLI (`node_modules/azurite/dist/src/blob/
 * main.js`, per `package.json#bin`) — there's no reason to pay for a 531 MB
 * image pull to run a program that's already just Node. It's spawned the
 * same way `scripts/azure-runtime.mjs` spawns the azure-gateway/azure-markdown
 * services: a plain child process, `--skipApiVersionCheck` carried over
 * unchanged from the old compose command, data in a fresh temp directory per
 * run (mirroring the clean-volume-per-`up` behaviour the container gave us
 * for free).
 */

import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobServiceClient } from "@azure/storage-blob";
import { createPool } from "../src/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const COMPOSE_FILE = path.resolve(__dirname, "../../../docker-compose.azure.yml");

export const DATABASE_URL = "postgres://unidocs:unidocs@localhost:5433/unidocs";
// Azurite's well-known emulator account, resolved by the SDK to
// http://127.0.0.1:10000/devstoreaccount1.
export const BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";

const AZURITE_HOST = "127.0.0.1";
const AZURITE_PORT = 10000;

/** Must match `docker-compose.azure.yml`'s `postgres` service image — used only to decide whether to print the one-time-download notice below. */
const POSTGRES_IMAGE = "postgres:18-alpine";

const require = createRequire(import.meta.url);

let azuriteProcess: ChildProcess | undefined;
let azuriteDataDir: string | undefined;

function dockerImageExistsLocally(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * `docker compose up -d` gives no sign it's pulling an image; on a cold
 * Docker daemon that silence reads as a hang. Print an explicit one-time
 * notice first so it's explicable instead.
 */
function announceFirstPullIfNeeded(): void {
  if (!dockerImageExistsLocally(POSTGRES_IMAGE)) {
    console.log(
      `azure-sdk tests: ${POSTGRES_IMAGE} isn't cached locally yet — pulling it now (~100 MB, one-time cost; cached for every run after this one)...`,
    );
  }
}

/**
 * Resolve `azurite-blob`'s real entry script via the `azurite` package's own
 * `package.json#bin` field, rather than shelling out to the
 * `node_modules/.bin/azurite-blob` shim (a POSIX shell script, not runnable
 * with `node` directly). Mirrors `scripts/azure-runtime.mjs`'s
 * `resolveAzuriteBlobEntry`.
 */
function resolveAzuriteBlobEntry(): string {
  const pkgJsonPath = require.resolve("azurite/package.json");
  const pkg = require(pkgJsonPath) as { bin: Record<string, string> };
  return join(dirname(pkgJsonPath), pkg.bin["azurite-blob"]);
}

async function startAzurite(): Promise<void> {
  azuriteDataDir = await mkdtemp(join(tmpdir(), "unidocs-azurite-sdk-"));
  const entry = resolveAzuriteBlobEntry();
  azuriteProcess = spawn(
    process.execPath,
    [
      entry,
      "--blobHost",
      AZURITE_HOST,
      "--blobPort",
      String(AZURITE_PORT),
      "--location",
      azuriteDataDir,
      "--skipApiVersionCheck",
    ],
    { stdio: "inherit" },
  );
}

/** SIGTERM, then SIGKILL if the process hasn't exited within `graceMs`; always cleans up the temp data directory. */
async function stopAzurite(graceMs = 5_000): Promise<void> {
  const child = azuriteProcess;
  azuriteProcess = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
  const dataDir = azuriteDataDir;
  azuriteDataDir = undefined;
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

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
  announceFirstPullIfNeeded();
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d`, { stdio: "inherit" });
  try {
    await startAzurite();
    await Promise.all([waitForPostgres(60_000), waitForAzurite(60_000)]);
  } catch (err) {
    // Don't leak the azurite-blob child process (or its temp data dir) if
    // either readiness poll above throws — this `catch` is the only thing
    // standing between a failed `setup()` and an orphaned process, since
    // `teardown()` is never called when `setup()` itself rejects.
    await stopAzurite();
    try {
      execSync(`docker compose -f "${COMPOSE_FILE}" down -v`, { stdio: "inherit" });
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw err;
  }
}

export async function teardown(): Promise<void> {
  await stopAzurite();
  // `-v` matches `scripts/azure-runtime.mjs`'s teardown: without it, every run
  // of this suite left behind a dangling anonymous volume (the compose file
  // does not name its Postgres volume), and a bare `down` also leaves no
  // guarantee that the next `up` sees a clean Postgres data directory.
  execSync(`docker compose -f "${COMPOSE_FILE}" down -v`, { stdio: "inherit" });
}
