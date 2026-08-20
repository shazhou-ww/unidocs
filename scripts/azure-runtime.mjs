/**
 * Boots the Azure/Postgres/Blob backend the same way `local-runtime.mjs`
 * boots the Miniflare one, so `scripts/behavior-suite.mjs` can run the same
 * test bodies against either.
 *
 * Topology: `docker compose -f docker-compose.azure.yml up -d` (Postgres
 * only) + spawn `azurite-blob` as a plain `node` process (same technique as
 * the gateway/markdown services below — Azurite's npm package ships its
 * server as a Node CLI, so it doesn't need a container) -> poll Postgres AND
 * Azurite -> apply migrations via the package's own standalone entry point
 * (`pnpm --filter @unidocs/azure-sdk run migrate`, documented in
 * CLAUDE.md) -> esbuild-bundle `azure-gateway`/`azure-markdown` fresh from
 * source (same technique `local-runtime.mjs` uses for the Miniflare worker
 * bundles: `packages: "external"` + the shared `workspace-aliases.mjs`
 * table, so real npm deps like `pg` resolve normally through node_modules
 * and only `@unidocs/*` specifiers get pointed at their `.ts` source) ->
 * `spawn` each bundle as a plain `node` process -> poll each port -> return
 * `{ urls, storage, dispose }`.
 *
 * Bundling from source rather than reusing each package's own prebuilt
 * `dist/main.js` keeps this in sync with whatever is on disk right now,
 * mirroring how `local-runtime.mjs` never trusts a stale `.wrangler` bundle
 * either.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import pg from "pg";
import { BlobServiceClient } from "@azure/storage-blob";
import { INTERNAL_TOKEN } from "./doc-types.mjs";
import { resolveWorkspaceAliases } from "./workspace-aliases.mjs";

const { Pool } = pg;
const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(ROOT, "docker-compose.azure.yml");
const WORKSPACE_ALIASES = resolveWorkspaceAliases(ROOT);

/** Matches `packages/azure-sdk/tests/containers.ts` — same compose stack. */
export const DATABASE_URL = "postgres://unidocs:unidocs@localhost:5433/unidocs";
export const BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";

/** Blob container name `BlobCasStore` uses (`packages/azure-sdk/src/ports-blob.ts`). */
const CAS_CONTAINER = "cas";

const DEFAULT_PORTS = { gateway: 41787, markdown: 41788 };
const AZURITE_HOST = "127.0.0.1";
const AZURITE_PORT = 10000;

/** Must match `docker-compose.azure.yml`'s `postgres` service image — used only to decide whether to print the one-time-download notice below. */
const POSTGRES_IMAGE = "postgres:18-alpine";

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

function dockerImageExistsLocally(image) {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * `docker compose up -d` is silent about pulling an image (vitest also
 * swallows child-process stdout inside `beforeAll`, but this print happens
 * before that hook's stdio matters, and `run()` below is `stdio: "inherit"`
 * either way). Without this, a cold machine just sits there for the length
 * of the pull with no indication why — print an explicit one-time-download
 * notice first so the wait is explicable instead of looking hung.
 */
function announceFirstPullIfNeeded() {
  if (!dockerImageExistsLocally(POSTGRES_IMAGE)) {
    console.log(
      `azure-runtime: ${POSTGRES_IMAGE} isn't cached locally yet — pulling it now (~100 MB, one-time cost; cached for every run after this one)...`,
    );
  }
}

/**
 * Resolve `azurite-blob`'s real entry script instead of shelling out to the
 * `azurite-blob` bin shim (`node_modules/.bin/azurite-blob` is a POSIX shell
 * script). Reading the path straight out of the `azurite` package's own
 * `package.json#bin` field — the same thing the shim itself does — means
 * this keeps working across azurite versions without hard-coding an
 * internal `dist/...` path here.
 */
function resolveAzuriteBlobEntry() {
  const pkgJsonPath = require.resolve("azurite/package.json");
  const pkg = require(pkgJsonPath);
  return join(dirname(pkgJsonPath), pkg.bin["azurite-blob"]);
}

/**
 * Spawns `azurite-blob` the same way `spawnService()` spawns the
 * gateway/markdown bundles below — this repo already runs Node services as
 * child processes rather than containers, and Azurite's npm package is
 * nothing more than a Node CLI, so it gets the same treatment. Data goes to
 * a fresh temp directory every run (mirrors what the container gave us for
 * free: a clean volume each time `docker compose up` created one) and gets
 * removed on teardown.
 */
async function spawnAzurite() {
  const dataDir = await mkdtemp(join(tmpdir(), "unidocs-azurite-"));
  const entry = resolveAzuriteBlobEntry();
  const child = spawnService(
    entry,
    [
      "--blobHost",
      AZURITE_HOST,
      "--blobPort",
      String(AZURITE_PORT),
      "--location",
      dataDir,
      "--skipApiVersionCheck",
    ],
    {},
    "azurite",
  );
  return { child, dataDir };
}

async function bundleService(entry, outfile) {
  await mkdir(dirname(outfile), { recursive: true });
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    alias: WORKSPACE_ALIASES,
    logOverride: { "empty-import-meta": "silent" },
  });
}

/**
 * Poll with a real query, same rationale as `containers.ts`'s
 * `waitForPostgres`: a just-created container accepts TCP before `initdb`
 * has finished, so a fixed sleep is not reliable.
 */
async function waitForPostgres(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const probe = new Pool({ connectionString: DATABASE_URL });
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

/**
 * Same idea for Azurite: the blob endpoint accepts TCP before it serves the
 * API. Mirrors `packages/azure-sdk/tests/containers.ts`'s `waitForAzurite`
 * exactly (same probe container name, same poll shape) — that file's comment
 * is the rationale for why this can't be skipped: `BlobCasStore`/
 * `BlobSnapshotCache` create their real containers lazily on first use, so
 * without this, a slow-to-start Azurite would surface as an opaque timeout
 * on whichever behavior test happens to touch storage first, not as a clear
 * "Azurite isn't up yet" failure at boot.
 */
async function waitForAzurite(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const svc = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING);
  let lastError;
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

/** Poll a TCP port rather than an HTTP route, so readiness doesn't depend on any one endpoint's own logic working. */
async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = connect({ host, port }, () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(
    `nothing listening on ${host}:${port} within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

function runMigrations() {
  run("pnpm", ["--filter", "@unidocs/azure-sdk", "run", "migrate"], {
    env: { ...process.env, DATABASE_URL },
  });
}

/** `args` lets non-`@unidocs/*` services (azurite-blob) take CLI flags too, not just env vars. */
function spawnService(scriptPath, args, env, label) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return child;
}

/** SIGTERM, then SIGKILL if the process hasn't exited within `graceMs`. */
function stopProcess(child, graceMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * The backend-neutral `StorageProbe`: a global snapshot index lookup and a
 * CAS blob existence check, expressed directly over `pg` and
 * `@azure/storage-blob` (per the task brief) rather than by importing
 * `@unidocs/azure-sdk`'s own port classes — this script runs under plain
 * `node`, which (unlike vitest/esbuild) does not resolve a TS package's
 * `./foo.js`-referring-to-`foo.ts` specifiers, so importing that package's
 * `src/index.ts` here directly would fail to resolve its own internal
 * imports.
 */
function createStorageProbe() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  pool.on("error", (err) => {
    console.error("azure-runtime: storage probe pg pool error", err);
  });
  const blobService = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING);
  const container = blobService.getContainerClient(CAS_CONTAINER);

  return {
    async snapshotIndex(docType, docId) {
      const result = await pool.query(
        `SELECT version, hash FROM doc_snapshots
         WHERE doc_type = $1 AND doc_id = $2
         ORDER BY version ASC`,
        [docType, docId],
      );
      // `doc_snapshots.version` is Postgres `INTEGER`, which `pg` already
      // hands back as a JS number (unlike `bigint`/`int8` columns).
      return result.rows.map((row) => ({
        version: row.version,
        hash: row.hash,
      }));
    },
    async blobExists(hash) {
      return container.getBlockBlobClient(hash).exists();
    },
    async dispose() {
      await pool.end();
    },
  };
}

/**
 * Start the Azure gateway + markdown services against a freshly migrated
 * Postgres/Azurite stack. Mirrors `startLocalRuntime()`'s return shape
 * (`urls`, `storage`, `dispose`) so `scripts/behavior-suite.mjs` can target
 * either without knowing which backend it got.
 */
export async function startAzureRuntime({
  host = "127.0.0.1",
  ports: portOverrides = {},
} = {}) {
  const ports = { ...DEFAULT_PORTS, ...portOverrides };
  const bundleDir = join(ROOT, ".azure-runtime", "bundles");
  const gatewayBundle = join(bundleDir, "gateway.mjs");
  const markdownBundle = join(bundleDir, "markdown.mjs");

  announceFirstPullIfNeeded();
  run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"]);

  let gatewayProc;
  let markdownProc;
  let azuriteProc;
  let azuriteDataDir;
  let probe;
  try {
    ({ child: azuriteProc, dataDir: azuriteDataDir } = await spawnAzurite());
    await Promise.all([waitForPostgres(60_000), waitForAzurite(60_000)]);
    runMigrations();

    await Promise.all([
      bundleService(join(ROOT, "packages/azure-gateway/src/main.ts"), gatewayBundle),
      bundleService(join(ROOT, "packages/azure-markdown/src/main.ts"), markdownBundle),
    ]);

    const urls = {
      gateway: `http://${host}:${ports.gateway}`,
      markdown: `http://${host}:${ports.markdown}`,
    };

    markdownProc = spawnService(
      markdownBundle,
      [],
      {
        DATABASE_URL,
        BLOB_CONNECTION_STRING,
        INTERNAL_TOKEN,
        PORT: String(ports.markdown),
      },
      "azure-markdown",
    );
    await waitForPort(host, ports.markdown, 30_000);

    gatewayProc = spawnService(
      gatewayBundle,
      [],
      {
        DATABASE_URL,
        INTERNAL_TOKEN,
        PORT: String(ports.gateway),
        MARKDOWN_WORKER_URL: urls.markdown,
      },
      "azure-gateway",
    );
    await waitForPort(host, ports.gateway, 30_000);

    probe = createStorageProbe();

    return {
      urls,
      storage: probe,
      async dispose() {
        await Promise.all([
          stopProcess(gatewayProc),
          stopProcess(markdownProc),
          stopProcess(azuriteProc),
        ]);
        await probe?.dispose();
        await rm(azuriteDataDir, { recursive: true, force: true }).catch(() => {});
        run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"]);
      },
    };
  } catch (err) {
    // Every resource acquired above must be released here too, not just in
    // the happy-path `dispose()` — a throw anywhere in the `try` (a failed
    // migration, a port that never comes up) must not leak the azurite-blob
    // child process the way an unhandled exception would if it were only
    // ever cleaned up by the caller's `dispose()`, which never gets called.
    await Promise.allSettled([
      stopProcess(gatewayProc),
      stopProcess(markdownProc),
      stopProcess(azuriteProc),
    ]);
    await probe?.dispose().catch(() => {});
    if (azuriteDataDir) {
      await rm(azuriteDataDir, { recursive: true, force: true }).catch(() => {});
    }
    try {
      run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"]);
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw err;
  }
}
