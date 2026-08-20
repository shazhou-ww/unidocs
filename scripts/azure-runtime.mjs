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
import { connect, createServer } from "node:net";
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

/**
 * Async replacement for the old `execFileSync`-based `run()`. This runs
 * inside a vitest worker (via `azure-behavior.test.mjs`'s `beforeAll`), and
 * `execFileSync` blocks the whole event loop for as long as the child runs —
 * on a cold machine that's tens of seconds for `docker compose up -d`
 * (image pull) or several seconds for `pnpm run migrate` (it shells out to
 * esbuild internally). While the event loop is blocked, the worker can't
 * answer the main vitest process's `onTaskUpdate` RPC, which then times out
 * and fails the whole run — even though every individual test passed. Using
 * `spawn` + awaiting its `exit` event keeps `stdio: "inherit"` (so e.g. a
 * `docker pull`'s progress output still streams straight to the terminal,
 * same as before) without blocking anything else sharing this process.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${cmd} ${args.join(" ")} terminated by signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Left as `execFileSync`, deliberately: `docker image inspect` reads local
 * image metadata only (no daemon-side pull, no network call), so it returns
 * in low single-digit milliseconds even on a cold machine. Blocking the
 * event loop for that long can't threaten the vitest RPC timeout the way the
 * multi-second/multi-ten-second calls above can, so there's no correctness
 * reason to pay for making this one async too.
 */
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
  return run("pnpm", ["--filter", "@unidocs/azure-sdk", "run", "migrate"], {
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
 * The four ports `startAzureRuntime()` needs exclusive use of: the two Node
 * services it spawns, plus the two backing stores (`docker-compose.azure.yml`'s
 * Postgres and the spawned `azurite-blob` process). Kept local to this module
 * (rather than reusing `scripts/dev.mjs`'s copy) because `dev.mjs` isn't
 * something other code imports from, and `azure-behavior.test.mjs` calls
 * `startAzureRuntime()` directly — never through `dev.mjs` — so the guard has
 * to live here to cover that path at all.
 */
function describeAzurePorts(ports) {
  return {
    [ports.gateway]: "expected by the azure-gateway service this run is about to spawn",
    [ports.markdown]: "expected by the azure-markdown service this run is about to spawn",
    [AZURITE_PORT]: "expected by the azurite-blob process this run is about to spawn",
    5433: "expected by docker-compose.azure.yml's postgres service (host port mapping)",
  };
}

/**
 * Probe a port by trying to listen on it, same technique as
 * `scripts/dev.mjs`'s `assertPortFree()`: `listen()` succeeding means
 * nothing else is bound there, so close right back up and report free;
 * `EADDRINUSE` means something already is.
 *
 * This exists because, before it did, `startAzureRuntime()` went straight to
 * `spawn()` for the gateway/markdown services and straight to
 * `docker compose up` for Postgres, with no check that the ports they need
 * were actually free. A previous run's leaked process (see
 * `installChildProcessCleanup()` below for why one can leak in the first
 * place) sitting on 41787 answers HTTP requests well enough that the new
 * run's readiness poll (`waitForPort`) succeeds against the *old* process,
 * and the whole behavior suite then runs green against stale state instead
 * of the fresh stack it thinks it started — a false pass in exactly the
 * suite meant to prove the stack works. Failing loudly here, before anything
 * is spawned, turns that silent false-green into an explicit, actionable
 * error instead.
 *
 * Always probes `0.0.0.0`, not whatever host the caller eventually talks to
 * the service on (`startAzureRuntime()`'s `host` param, `127.0.0.1` by
 * default — used for building URLs and for `waitForPort`, nothing more).
 * `azure-gateway`/`azure-markdown` both bind `host: "0.0.0.0"` explicitly
 * (`packages/azure-{gateway,markdown}/src/main.ts`), and Docker's default
 * port publish does the same for Postgres — probing the same address they
 * bind is required, not cosmetic: on BSD/Darwin sockets, a wildcard
 * (`0.0.0.0`) bind conflicts with *any* other bind already on that port,
 * wildcard or address-specific, but a bind to one specific address (say,
 * `127.0.0.1`) does **not** conflict with a pre-existing wildcard bind — the
 * OS treats the specific address as more specific and routes to it. Verified
 * empirically on this stack's dev machine: a stray process bound with no
 * explicit host (Node's default, effectively wildcard) still let a fresh
 * probe bind `127.0.0.1` on the same port without error, while `0.0.0.0`
 * correctly reported `EADDRINUSE` against it — which is exactly the
 * leaked-process shape this check exists to catch. Probing `0.0.0.0`
 * also still catches a leaked `azurite-blob` (bound to the specific
 * `127.0.0.1` via `AZURITE_HOST`): a wildcard probe conflicts with an
 * existing specific bind too, just not the reverse.
 */
function assertPortFree(port, hint) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${port} is already in use (${hint}). This is most likely a process leaked by a ` +
              `previous \`startAzureRuntime()\` run (a parent process killed with SIGKILL can't take its ` +
              `spawned children down with it — see the comment on \`installChildProcessCleanup()\`) or an ` +
              `unrelated stack bound to the same port. Find and stop it (e.g. \`lsof -i :${port}\`), then retry.`,
          ),
        );
        return;
      }
      reject(err);
    });
    server.once("listening", () => {
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve();
      });
    });
    server.listen(port, "0.0.0.0");
  });
}

async function assertPortsFree(ports) {
  const byPort = describeAzurePorts(ports);
  await Promise.all(
    Object.entries(byPort).map(([port, hint]) => assertPortFree(Number(port), hint)),
  );
}

/**
 * Best-effort "take the children down with the parent" cleanup for the
 * gateway/markdown/azurite child processes `startAzureRuntime()` spawns.
 *
 * `process.once("exit", ...)` only allows synchronous work, which is exactly
 * why this calls plain `child.kill()` (fire-and-forget SIGTERM) rather than
 * `stopProcess()`'s graceful-wait-then-SIGKILL — there's no event loop left
 * to wait on by the time `exit` fires. `SIGINT`/`SIGTERM` are handled
 * explicitly too: registering a listener for either suppresses Node's
 * default "terminate immediately" behavior, so without an explicit handler
 * that itself calls `process.exit()`, a Ctrl-C wouldn't reliably reach the
 * `exit` cleanup at all.
 *
 * This is a mitigation, not a fix — it cannot be one. If the parent process
 * itself is killed with `SIGKILL` (or the machine loses power, or the parent
 * segfaults), no JS handler in that process ever runs, and `spawn()`'s
 * children become orphans reparented to `launchd`/`init`, exactly like the
 * leaked `gateway.mjs` process this task was filed over. That's an inherent
 * boundary of the `spawn()` process model, not a bug in this function, and
 * no amount of signal handling here closes it. What actually keeps a leaked
 * process from causing a *silent* false-green next time is
 * `assertPortsFree()` above: it can't stop the leak, but it guarantees the
 * next run notices the port is still held and fails loudly instead of
 * quietly talking to the stale process.
 */
function installChildProcessCleanup(getChildren) {
  const killAll = () => {
    for (const child of getChildren()) {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // Best-effort; the process may already be gone.
        }
      }
    }
  };
  const makeSignalHandler = (exitCode) => () => {
    killAll();
    process.exit(exitCode);
  };
  const onSigint = makeSignalHandler(130);
  const onSigterm = makeSignalHandler(143);
  process.once("exit", killAll);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return function uninstall() {
    process.off("exit", killAll);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
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

  // Fail loudly on a held port before anything is spawned — see
  // `assertPortFree()`'s comment for why this matters more than it looks
  // like it should (a leaked process from a previous run answering in place
  // of the fresh stack, making the behavior suite pass against stale state).
  await assertPortsFree(ports);

  announceFirstPullIfNeeded();
  await run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"]);

  let gatewayProc;
  let markdownProc;
  let azuriteProc;
  let azuriteDataDir;
  let probe;
  // Registered before anything is spawned so it covers every child from the
  // moment it exists; `getChildren` reads the `let` bindings above at
  // cleanup time, not at registration time, so it sees whichever of them got
  // assigned before the process went down. See the function's own comment
  // for what this can and can't guarantee.
  const uninstallCleanup = installChildProcessCleanup(() => [gatewayProc, markdownProc, azuriteProc]);
  try {
    ({ child: azuriteProc, dataDir: azuriteDataDir } = await spawnAzurite());
    await Promise.all([waitForPostgres(60_000), waitForAzurite(60_000)]);
    await runMigrations();

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
        // Processes are being stopped deliberately below, via the graceful
        // stopProcess() path — uninstall the exit/signal handlers first so
        // they don't also fire a redundant kill() (harmless, since kill() on
        // an already-exited child is a no-op, but there's no reason to leave
        // process-level listeners registered past this runtime's lifetime).
        uninstallCleanup();
        await Promise.all([
          stopProcess(gatewayProc),
          stopProcess(markdownProc),
          stopProcess(azuriteProc),
        ]);
        await probe?.dispose();
        await rm(azuriteDataDir, { recursive: true, force: true }).catch(() => {});
        await run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"]);
      },
    };
  } catch (err) {
    // Every resource acquired above must be released here too, not just in
    // the happy-path `dispose()` — a throw anywhere in the `try` (a failed
    // migration, a port that never comes up) must not leak the azurite-blob
    // child process the way an unhandled exception would if it were only
    // ever cleaned up by the caller's `dispose()`, which never gets called.
    uninstallCleanup();
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
      await run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"]);
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw err;
  }
}
