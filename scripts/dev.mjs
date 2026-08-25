import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAS_ACCESS_KEY, DOC_TYPES, parseDocTypes } from "./doc-types.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const USAGE =
  "Usage: pnpm dev [--azure] [docType ...]   e.g. pnpm dev docx markdown / pnpm dev --azure markdown";

const rawArgs = process.argv.slice(2);
const useAzure = rawArgs.includes("--azure");
const positional = rawArgs.filter((arg) => arg !== "--azure");

let docTypes;
try {
  docTypes = parseDocTypes(positional);
} catch (err) {
  console.error(err.message);
  console.error(USAGE);
  process.exit(1);
}

// Everything below is validation that must happen before we pay for
// starting anything (Docker containers, node processes, or — on the
// Miniflare side — the esbuild + Miniflare import graph). Order goes
// cheapest-first: pure argv checks, then a `docker info` probe, then a
// port probe, and only once all of those pass do we import the modules
// that actually pull in heavy dependencies (pg, @azure/storage-blob,
// esbuild, miniflare).

// Populated below when `useAzure` — hoisted out of that block so the port
// check and the `startAzureRuntime()` call further down can both reuse the
// same validated selection instead of recomputing it.
let azureDocTypes;
// Set only when docx is part of the Azure selection (see the reachability
// probe below); passed through to `startAzureRuntime()` so the gateway and
// docx services get `CAS_BASE_URL` wired up the same way the e2e test does.
let azureCasBaseUrl;

if (useAzure) {
  // No positional args means "start every known doc type" (same default as
  // the Miniflare backend).
  azureDocTypes = positional.length === 0 ? Object.keys(DOC_TYPES) : docTypes;

  // docx's image path needs tenant-scoped CAS. This round is transitional:
  // CAS_BASE_URL points at the Miniflare stack's CAS worker (default
  // http://127.0.0.1:8791). Probe it here, before starting anything, so
  // "you forgot to run `pnpm dev docx` in another terminal" is clear at
  // startup instead of surfacing as an ECONNREFUSED on the first apply that
  // touches an image.
  if (azureDocTypes.includes("docx")) {
    azureCasBaseUrl = process.env.CAS_BASE_URL ?? "http://127.0.0.1:8791";
    const casBaseUrl = azureCasBaseUrl;
    const reachable = await fetch(`${casBaseUrl}/tenants/_probe/cas/usage`, {
      headers: { "X-Internal-Token": CAS_ACCESS_KEY, Connection: "close" },
    }).then(response => response.ok, () => false);
    if (!reachable) {
      console.error(
        `docx on the Azure stack needs the transitional CAS worker at ${casBaseUrl}, which is not answering.\n` +
          `Start the Miniflare stack in another terminal first:\n\n  pnpm dev docx\n\n` +
          `(This cross-stack dependency goes away in phase 4, when azure-cas lands.)`,
      );
      process.exit(1);
    }
  }
}

/** Matches `docker compose -f packages/azure-sdk/docker-compose.yml up -d` failing for the same reason, but with an actionable message instead of the raw compose error. */
function assertDockerRunning() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    console.error(
      "Azure local stack requires Docker. Please start Docker Desktop, then retry `pnpm dev --azure`.",
    );
    process.exit(1);
  }
}

// Mirrors `assertPortFree()` in local-runtime.mjs (same probe-by-listening
// technique, same error shape). Duplicated rather than imported because
// local-runtime.mjs doesn't export it and this task is entry-layer wiring
// only — see the report for the follow-up note.
//
// `describeConflict` lets callers give a port-specific hint about *why* the
// port might be taken: for the Node services (41787/41788) it's almost
// always a leftover process from a previous `pnpm dev --azure`, but for the
// container ports (5433/10000) the far more common cause in practice is a
// completely unrelated project's `docker compose` stack squatting on the
// same host port — that's what actually happened during review of this
// change, on this very machine.
function assertPortFree(host, port, describeConflict) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use${describeConflict ? ` (${describeConflict})` : ""}. Stop the leftover process occupying it, then retry \`pnpm dev --azure\`.`,
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
    // Always probe 0.0.0.0, regardless of `host` — see
    // `assertPortFree()`'s comment in azure/local/runtime.mjs (around line
    // 308-323) for why a probe bound to a specific address (127.0.0.1)
    // fails to detect a pre-existing wildcard bind on BSD/Darwin.
    server.listen(port, "0.0.0.0");
  });
}

// Kept deliberately apart from Miniflare's 8787/8788 band so both backends
// can run at once. The Node-service ports themselves come from
// `azure/local/ports.mjs`'s layout below, not a local copy — that module has no
// imports at all, so pulling it in here is cheap and keeps this file from
// drifting out of sync with `azure/local/runtime.mjs`'s own port math.
const AZURE_HOST = "127.0.0.1";

// The host ports `packages/azure-sdk/docker-compose.yml` maps Postgres onto, and the port
// the spawned `azurite-blob` process listens on (see that file and
// `packages/azure-sdk/tests/containers.ts`). CLAUDE.md promises "occupied
// port fails fast" for the local runtime; before this check existed, the
// Azure path only honoured that promise for the two Node services and let
// `docker compose up -d` / the azurite-blob spawn hit these two silently,
// which either wedges on something unrelated already bound to the port or —
// worse — quietly attaches to whatever stack got there first.
const AZURE_CONTAINER_PORTS = {
  postgres: {
    port: 5433,
    hint: "needed by the local Azure stack's Postgres container — likely either a leftover `docker compose` stack from this repo, or an unrelated project's Postgres container bound to the same host port",
  },
  azurite: {
    port: 10000,
    hint: "needed by the local Azure stack's azurite-blob process — likely either a leftover `pnpm dev --azure` / test run from this repo, or an unrelated process bound to the same host port",
  },
};

let runtime;
let backend;

if (useAzure) {
  assertDockerRunning();

  // `azure/local/ports.mjs` has no imports at all, so this can go ahead of the
  // heavier imports further down (mirrors `doc-types.mjs`'s same
  // dependency-free convention) — argv validation has already happened
  // above, so this is just cheap port math before the port probe.
  const { azurePortLayout, allAzurePorts, describeAzurePorts } = await import("../azure/local/ports.mjs");
  const layout = azurePortLayout({ docTypes: azureDocTypes, replicas: 2 });
  const described = describeAzurePorts(layout);
  await Promise.all([
    ...allAzurePorts(layout).map((port) => assertPortFree(AZURE_HOST, port, described[port])),
    assertPortFree(AZURE_HOST, 5433, AZURE_CONTAINER_PORTS.postgres.hint),
    assertPortFree(AZURE_HOST, 10000, AZURE_CONTAINER_PORTS.azurite.hint),
  ]);

  const {
    startAzureRuntime,
    GATEWAY_DATABASE_URL,
    docDatabaseUrl,
    BLOB_CONNECTION_STRING,
  } = await import(
    "../azure/local/runtime.mjs"
  );

  runtime = await startAzureRuntime({
    host: AZURE_HOST,
    docTypes: azureDocTypes,
    replicas: 2,
    ...(azureCasBaseUrl ? { casBaseUrl: azureCasBaseUrl } : {}),
  });
  backend = {
    name: "Azure (Postgres + Azurite)",
    gatewayDatabaseUrl: GATEWAY_DATABASE_URL,
    docDatabaseUrls: Object.fromEntries(azureDocTypes.map(name => [name, docDatabaseUrl(name)])),
    BLOB_CONNECTION_STRING,
  };
} else {
  // Imported after argv validation so a typo fails fast instead of paying for
  // the esbuild + Miniflare import graph first.
  const { LogLevel } = await import("miniflare");
  const { startLocalRuntime } = await import("./local-runtime.mjs");

  runtime = await startLocalRuntime({
    docTypes,
    persistPath: join(root, ".wrangler", "miniflare"),
    logLevel: LogLevel.INFO,
  });
  backend = { name: "Miniflare" };
}

console.log(`UniDocs local runtime (${backend.name})`);
for (const [name, url] of Object.entries(runtime.urls)) {
  if (Array.isArray(url)) {
    // e.g. `markdownReplicas` — print each replica's own address so
    // "there are really two of these running" is visible in the terminal,
    // not just implied by a single proxy URL.
    url.forEach((replicaUrl, i) => {
      console.log(`  ${`${name} #${i + 1}`.padEnd(20)} ${replicaUrl}`);
    });
    continue;
  }
  console.log(`  ${name.padEnd(8)} ${url}`);
}

if (useAzure) {
  console.log(`  gateway db psql "${backend.gatewayDatabaseUrl}"`);
  for (const [name, url] of Object.entries(backend.docDatabaseUrls)) {
    console.log(`  ${name} db psql "${url}"`);
  }
  console.log(`  azurite  http://127.0.0.1:10000  (connection string: ${backend.BLOB_CONNECTION_STRING})`);
} else {
  console.log(
    `Static registrations: ${docTypes.join(" / ")}`,
  );
}

// Start each selected doc type's dev frontend (if it declares one), with the
// gateway URL injected so its Vite proxy can forward API calls end-to-end.
// Runs on both backends: the proxy only needs a gateway URL, and `runtime.urls`
// has the same shape either way.
const webChildren = [];
for (const name of docTypes) {
  const web = DOC_TYPES[name].web;
  if (!web) continue;
  const child = spawn("npx", ["vite", "--port", String(web.port), "--strictPort"], {
    cwd: join(root, web.dir),
    stdio: "inherit",
    env: { ...process.env, GATEWAY_URL: runtime.urls.gateway },
  });
  child.on("error", (err) => console.error(`[${name} web] failed to start:`, err.message));
  webChildren.push(child);
  console.log(`  ${(name + " web").padEnd(8)} http://127.0.0.1:${web.port}`);
}

console.log("Ctrl+C to stop.");

const shutdown = async () => {
  for (const child of webChildren) child.kill("SIGINT");
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
