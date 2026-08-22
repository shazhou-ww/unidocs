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
 *
 * The `docker compose up -d` step for Postgres is itself optional: pass
 * `postgres: "external"` to skip it and connect to an already-running
 * server instead (see `startAzureRuntime()`'s own doc comment) — the mode
 * `tests/bootstrap/` uses, since that container has no docker at all.
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
import { EXTERNAL_NPM_PACKAGES, resolveWorkspaceAliases } from "./workspace-aliases.mjs";
import { allAzurePorts, azurePortLayout, describeAzurePorts } from "./azure-ports.mjs";
import { startReplicaProxy } from "./replica-proxy.mjs";

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

const AZURITE_HOST = "127.0.0.1";
const AZURITE_PORT = 10000;
const POSTGRES_PORT = 5433;

/** Must match `docker-compose.azure.yml`'s `postgres` service image — used only to decide whether to print the one-time-download notice below. */
const POSTGRES_IMAGE = "postgres:18-alpine";

/**
 * Async replacement for the old `execFileSync`-based `run()`. This runs
 * inside a vitest worker (via `azure-behavior.test.mjs`'s `beforeAll`), and
 * `execFileSync` blocks the whole event loop for as long as the child runs —
 * on a cold machine that's tens of seconds for `docker compose up -d`
 * (image pull) or several seconds for `pnpm run build` + `pnpm run migrate`
 * (tsc plus an esbuild bundle, then plain `node`). While the event loop is
 * blocked, the worker can't
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

/**
 * Not `packages: "external"` for the npm dependency side of this build —
 * `EXTERNAL_NPM_PACKAGES`, imported above from `scripts/workspace-aliases.mjs`
 * (the same shared list `packages/azure-docx/scripts/bundle.mjs` uses), names
 * exactly the npm specifiers that genuinely resolve at runtime from a bundle
 * written anywhere under this repo. See that module's doc comment for the
 * full runtime-resolution reasoning.
 */
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
    external: EXTERNAL_NPM_PACKAGES,
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

/**
 * `migrate` now only runs the build-time artifact `dist/migrate-cli.js`
 * (`packages/azure-sdk/package.json`) — it no longer bundles itself with
 * esbuild on every invocation, so esbuild can stay a devDependency instead
 * of being required at production-install runtime. That moved the bundling
 * into `build`, so it must run first here: `startAzureRuntime()` is meant to
 * be runnable standalone (e.g. bare `pnpm test:local` on a workspace that
 * never ran a top-level `pnpm build`), and without this the plain `node
 * dist/migrate-cli.js` in `migrate` fails `MODULE_NOT_FOUND` against a dist
 * directory that was never produced.
 */
async function runMigrations() {
  await run("pnpm", ["--filter", "@unidocs/azure-sdk", "run", "build"]);
  await run("pnpm", ["--filter", "@unidocs/azure-sdk", "run", "migrate"], {
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

/**
 * Ports `startAzureRuntime()` needs exclusive use of: every port in the
 * layout (Task 3's `azure-ports.mjs` — gateway, per-doc-type proxy, and
 * every replica), plus the two backing stores that aren't part of that
 * layout because they're fixed infrastructure rather than spawned Node
 * services (`docker-compose.azure.yml`'s Postgres and the spawned
 * `azurite-blob` process).
 *
 * `skipPostgresPort` is set when `postgres: "external"` is in effect: 5433
 * is then deliberately held by a Postgres server this run did not start and
 * has no business asserting exclusivity over — it's the one port this mode
 * *expects* to find already bound. Every other port probe (gateway, proxy,
 * replicas, Azurite) still runs unchanged; only the Postgres check is
 * skipped, never inferred.
 */
async function assertPortsFree(layout, { skipPostgresPort = false } = {}) {
  const byPort = {
    ...describeAzurePorts(layout),
    [AZURITE_PORT]: "expected by the azurite-blob process this run is about to spawn",
    [POSTGRES_PORT]: "expected by docker-compose.azure.yml's postgres service (host port mapping)",
  };
  const ports = allAzurePorts(layout).concat(
    skipPostgresPort ? [AZURITE_PORT] : [AZURITE_PORT, POSTGRES_PORT],
  );
  await Promise.all(ports.map((port) => assertPortFree(port, byPort[port])));
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
 * Doc types this task knows how to spawn a bundle for. Each name here must
 * have a corresponding `packages/azure-${name}/src/main.ts` entry point
 * (see `packages/azure-markdown` and `packages/azure-docx` for the shape).
 * Passing an unlisted name must fail before anything is spawned, not
 * partway through an `esbuild.build()` against a path that doesn't exist.
 */
const SUPPORTED_DOC_TYPES = ["markdown", "docx"];

function assertDocTypesSupported(docTypes) {
  const unsupported = docTypes.filter((name) => !SUPPORTED_DOC_TYPES.includes(name));
  if (unsupported.length > 0) {
    throw new Error(
      `startAzureRuntime() only supports ${SUPPORTED_DOC_TYPES.join(", ")} right now (got ` +
        `${unsupported.join(", ")}). Add a packages/azure-${unsupported[0]} entry point and list ` +
        `it in SUPPORTED_DOC_TYPES to support it.`,
    );
  }
}

/**
 * Start the Azure gateway + markdown services — `replicas` copies of
 * markdown, all sharing the same Postgres/Azurite, fronted by a round-robin
 * proxy that stands in for the platform ingress — against a freshly
 * migrated Postgres/Azurite stack. Mirrors `startLocalRuntime()`'s return
 * shape (`urls`, `storage`, `dispose`) so `scripts/behavior-suite.mjs` can
 * target either without knowing which backend it got.
 *
 * Defaults to 2 replicas, not 1: what dev runs against and what tests run
 * against should not diverge, since that gap is itself a source of
 * incidents. `replicas` stays configurable only for troubleshooting (drop to
 * 1 to tell apart "only reproduces with multiple replicas" from "was always
 * broken") — `scripts/azure-multi-replica.test.mjs` asserts `replicas >= 2`
 * itself so that dropping to 1 can't quietly become the new normal.
 *
 * `casBaseUrl` (过渡形态,阶段 4 删除): forwarded as `CAS_BASE_URL` to every
 * markdown replica's env *and* the gateway's env — both need it, for
 * different reasons (see `doc-type-service.ts` and `azure-gateway/main.ts`).
 * Points at the Cloudflare CAS worker's direct port (Miniflare's
 * `unsafeDirectSockets`, e.g. `startLocalRuntime()`'s `urls.cas`), never at
 * a gateway. Omitted entirely (not set to an empty string) when the caller
 * doesn't pass one, so the services fall back to their own 501 stubs.
 *
 * `postgres` (default `"compose"`): how this run gets a Postgres to talk to.
 * `"compose"` is today's behavior — `docker compose up -d` against
 * `docker-compose.azure.yml`, torn down with `down -v` in `dispose()`.
 * `"external"` skips compose entirely (no `announceFirstPullIfNeeded()`, no
 * `up`, no `down -v`) and just polls the already-running server at
 * `DATABASE_URL` via `waitForPostgres()` — for environments with no docker
 * at all (the treespec e2e container; see `e2e/Dockerfile`, which bakes a
 * Postgres listening on 5433 straight into the image). This has to be an
 * explicit opt-in, never auto-detected: auto-detecting "is something
 * already listening on 5433" would turn a genuine failure ("compose didn't
 * start") into a silent wrong-target success ("connected to some other
 * Postgres on that port") — the same shape of false-green
 * `assertPortsFree()` above exists to rule out for the other ports. When
 * `postgres` is `"external"`, `assertPortsFree()` skips the 5433 probe too
 * — that port is expected to be held, by the external server, on purpose —
 * while every other port this function claims is still checked.
 */
export async function startAzureRuntime({
  host = "127.0.0.1",
  docTypes = ["markdown"],
  replicas = 2,
  casBaseUrl,
  postgres = "compose",
} = {}) {
  if (postgres !== "compose" && postgres !== "external") {
    throw new Error(`startAzureRuntime(): postgres must be "compose" or "external", got ${JSON.stringify(postgres)}`);
  }
  const externalPostgres = postgres === "external";
  assertDocTypesSupported(docTypes);
  const layout = azurePortLayout({ docTypes, replicas });

  const bundleDir = join(ROOT, ".azure-runtime", "bundles");
  const gatewayBundle = join(bundleDir, "gateway.mjs");
  // One bundle per selected doc type, entry point `packages/azure-${name}/src/main.ts`.
  const docTypeBundles = Object.fromEntries(
    docTypes.map((name) => [name, join(bundleDir, `${name}.mjs`)]),
  );

  // Fail loudly on a held port before anything is spawned — see
  // `assertPortFree()`'s comment for why this matters more than it looks
  // like it should (a leaked process from a previous run answering in place
  // of the fresh stack, making the behavior suite pass against stale state).
  await assertPortsFree(layout, { skipPostgresPort: externalPostgres });

  if (externalPostgres) {
    // Nothing to pull, nothing to start — the caller's environment already
    // has a Postgres listening on `DATABASE_URL`. `waitForPostgres()` below
    // still runs unconditionally, so a not-yet-ready external server is
    // waited out exactly the same way a not-yet-ready compose one would be.
  } else {
    announceFirstPullIfNeeded();
    await run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"]);
  }

  let gatewayProc;
  // One replica-process array per doc type, keyed by name.
  const docTypeProcs = Object.fromEntries(docTypes.map((name) => [name, []]));
  let azuriteProc;
  let azuriteDataDir;
  let probe;
  // One replica proxy per doc type, keyed by name.
  const proxies = {};
  // Registered before anything is spawned so it covers every child from the
  // moment it exists; `getChildren` reads these bindings at cleanup time,
  // not at registration time, so it sees whichever of them got assigned
  // before the process went down. `docTypeProcs[name]` arrays are read live
  // (not spread here) so replicas spawned after registration are still
  // covered. See the function's own comment for what this can and can't
  // guarantee.
  const uninstallCleanup = installChildProcessCleanup(() => [
    gatewayProc,
    ...docTypes.flatMap((name) => docTypeProcs[name]),
    azuriteProc,
  ]);
  try {
    ({ child: azuriteProc, dataDir: azuriteDataDir } = await spawnAzurite());
    await Promise.all([waitForPostgres(60_000), waitForAzurite(60_000)]);
    await runMigrations();

    await Promise.all([
      bundleService(join(ROOT, "packages/azure-gateway/src/main.ts"), gatewayBundle),
      ...docTypes.map((name) =>
        bundleService(join(ROOT, `packages/azure-${name}/src/main.ts`), docTypeBundles[name]),
      ),
    ]);

    const urls = { gateway: `http://${host}:${layout.gateway}` };
    // `{TYPE}_WORKER_URL` per doc type — matches `azure-gateway/src/main.ts`'s
    // `resolveWorkerUrl()`, which already generalises over any doc type.
    const workerUrlEnv = {};

    for (const name of docTypes) {
      const replicaUrls = [];
      for (const [i, port] of layout.docTypes[name].replicas.entries()) {
        const proc = spawnService(
          docTypeBundles[name],
          [],
          {
            DATABASE_URL,
            BLOB_CONNECTION_STRING,
            INTERNAL_TOKEN,
            PORT: String(port),
            ...(casBaseUrl ? { CAS_BASE_URL: casBaseUrl } : {}),
          },
          `azure-${name}-${i + 1}`,
        );
        docTypeProcs[name].push(proc);
        await waitForPort(host, port, 30_000);
        replicaUrls.push(`http://${host}:${port}`);
      }

      // The proxy plays ACA ingress. The gateway only ever learns this one
      // address — it must never know replicas exist.
      proxies[name] = await startReplicaProxy({
        host,
        port: layout.docTypes[name].proxy,
        targets: replicaUrls,
      });

      urls[name] = proxies[name].url; // unchanged meaning: the address the gateway should talk to
      urls[`${name}Replicas`] = replicaUrls; // direct-to-replica, for cross-replica scenarios
      workerUrlEnv[`${name.toUpperCase()}_WORKER_URL`] = urls[name];
    }

    gatewayProc = spawnService(
      gatewayBundle,
      [],
      {
        DATABASE_URL,
        INTERNAL_TOKEN,
        PORT: String(layout.gateway),
        ...workerUrlEnv,
        ...(casBaseUrl ? { CAS_BASE_URL: casBaseUrl } : {}),
      },
      "azure-gateway",
    );
    await waitForPort(host, layout.gateway, 30_000);

    probe = createStorageProbe();

    return {
      urls,
      storage: probe,
      // A function, not a snapshot: `startReplicaProxy()`'s own `hits()` is
      // itself a live accessor, and callers here (the multi-replica suite,
      // in particular) need counts taken *after* a batch of gateway
      // requests, not whatever the count happened to be at boot. Defaults to
      // the first requested doc type so single-doc-type callers (existing
      // markdown-only tests) can keep calling `replicaHits()` with no args.
      replicaHits: (name = docTypes[0]) => proxies[name].hits(),
      async dispose() {
        // Processes are being stopped deliberately below, via the graceful
        // stopProcess() path — uninstall the exit/signal handlers first so
        // they don't also fire a redundant kill() (harmless, since kill() on
        // an already-exited child is a no-op, but there's no reason to leave
        // process-level listeners registered past this runtime's lifetime).
        uninstallCleanup();
        await Promise.all(docTypes.map((name) => proxies[name]?.close()));
        await Promise.all([
          stopProcess(gatewayProc),
          ...docTypes.flatMap((name) => docTypeProcs[name].map((proc) => stopProcess(proc))),
          stopProcess(azuriteProc),
        ]);
        await probe?.dispose();
        await rm(azuriteDataDir, { recursive: true, force: true }).catch(() => {});
        // `postgres: "external"` never ran `docker compose up` above, so it
        // must not run `down -v` here either — this run doesn't own that
        // server's lifecycle.
        if (!externalPostgres) {
          await run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"]);
        }
      },
    };
  } catch (err) {
    // Every resource acquired above must be released here too, not just in
    // the happy-path `dispose()` — a throw anywhere in the `try` (a failed
    // migration, a port that never comes up) must not leak the azurite-blob
    // child process the way an unhandled exception would if it were only
    // ever cleaned up by the caller's `dispose()`, which never gets called.
    uninstallCleanup();
    await Promise.all(
      Object.values(proxies).map((proxy) => proxy?.close().catch(() => {})),
    );
    await Promise.allSettled([
      stopProcess(gatewayProc),
      ...docTypes.flatMap((name) => docTypeProcs[name].map((proc) => stopProcess(proc))),
      stopProcess(azuriteProc),
    ]);
    await probe?.dispose().catch(() => {});
    if (azuriteDataDir) {
      await rm(azuriteDataDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!externalPostgres) {
      try {
        await run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"]);
      } catch {
        // Best-effort cleanup; the original error is what matters.
      }
    }
    throw err;
  }
}
