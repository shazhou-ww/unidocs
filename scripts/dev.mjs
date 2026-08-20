import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocTypes } from "./doc-types.mjs";

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

if (useAzure) {
  // startAzureRuntime() doesn't take a docTypes selector — it always starts
  // exactly one worker (azure-markdown), because docx depends on
  // user-scoped CAS, which the Azure backend doesn't implement yet (see
  // phase 4). No positional args means "start what Azure supports", i.e.
  // markdown; any positional arg other than markdown is a request we can't
  // fulfill and must reject up front rather than starting a stack that
  // can't route to it.
  const requested = positional.length === 0 ? ["markdown"] : docTypes;
  const unsupported = requested.filter((type) => type !== "markdown");
  if (unsupported.length > 0) {
    console.error(
      `Azure local stack only supports markdown right now (${unsupported.join(", ")} depends on user-scoped CAS, which isn't implemented for Azure yet — see phase 4). Drop ${unsupported.length > 1 ? "those doc types" : "that doc type"} or run \`pnpm dev ${unsupported.join(" ")}\` on the Miniflare backend instead.`,
    );
    process.exit(1);
  }
}

/** Matches `docker compose -f docker-compose.azure.yml up -d` failing for the same reason, but with an actionable message instead of the raw compose error. */
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
    server.listen(port, host);
  });
}

// Must match `DEFAULT_PORTS` in azure-runtime.mjs (41787/41788), which
// doesn't export it. Kept deliberately apart from Miniflare's 8787/8788 so
// both backends can run at once.
const AZURE_HOST = "127.0.0.1";
const AZURE_PORTS = { gateway: 41787, markdown: 41788 };

// The host ports `docker-compose.azure.yml` maps Postgres and Azurite onto
// (see that file and `packages/azure-sdk/tests/containers.ts`). CLAUDE.md
// promises "occupied port fails fast" for the local runtime; before this
// check existed, the Azure path only honoured that promise for the two Node
// services and let `docker compose up -d` hit these two silently, which
// either wedges on an unrelated container already bound to the port or —
// worse — quietly attaches to whatever stack got there first.
const AZURE_CONTAINER_PORTS = {
  postgres: {
    port: 5433,
    hint: "needed by the local Azure stack's Postgres container — likely either a leftover `docker compose` stack from this repo, or an unrelated project's Postgres container bound to the same host port",
  },
  azurite: {
    port: 10000,
    hint: "needed by the local Azure stack's Azurite container — likely either a leftover `docker compose` stack from this repo, or an unrelated project's compose stack bound to the same host port",
  },
};

let runtime;
let backend;

if (useAzure) {
  assertDockerRunning();
  await Promise.all([
    ...Object.values(AZURE_PORTS).map((port) => assertPortFree(AZURE_HOST, port)),
    ...Object.values(AZURE_CONTAINER_PORTS).map(({ port, hint }) =>
      assertPortFree(AZURE_HOST, port, hint),
    ),
  ]);

  const { startAzureRuntime, DATABASE_URL, BLOB_CONNECTION_STRING } = await import(
    "./azure-runtime.mjs"
  );

  runtime = await startAzureRuntime({ host: AZURE_HOST, ports: AZURE_PORTS });
  backend = { name: "Azure (Postgres + Azurite)", DATABASE_URL, BLOB_CONNECTION_STRING };
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
  console.log(`  ${name.padEnd(8)} ${url}`);
}

if (useAzure) {
  console.log(`  postgres psql "${backend.DATABASE_URL}"`);
  console.log(`  azurite  http://127.0.0.1:10000  (connection string: ${backend.BLOB_CONNECTION_STRING})`);
} else {
  console.log(
    `Registry: ${docTypes.map((t) => `docType:${t}`).join(" / ")} → workerUrl`,
  );
}
console.log("Ctrl+C to stop.");

const shutdown = async () => {
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
