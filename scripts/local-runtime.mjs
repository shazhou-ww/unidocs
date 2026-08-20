import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare,
} from "miniflare";
import {
  buildWorkers,
  bundleTargets,
  DOC_TYPES,
  registryEntries,
  resolvePorts,
} from "./doc-types.mjs";

export { DOC_TYPES, INTERNAL_TOKEN, parseDocTypes } from "./doc-types.mjs";

export const DEFAULT_PORTS = resolvePorts(Object.keys(DOC_TYPES));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const WORKSPACE_ALIASES = {
  "@unidocs/core": join(ROOT, "packages/core/src/index.ts"),
  "@unidocs/cloudflare-sdk": join(ROOT, "packages/cloudflare-sdk/src/index.ts"),
  "@unidocs/doctype-markdown": join(
    ROOT,
    "packages/doctype-markdown/src/index.ts",
  ),
  "@unidocs/doctype-docx": join(ROOT, "packages/doctype-docx/src/index.ts"),
  "@unidocs/doctype-psd": join(ROOT, "packages/doctype-psd/src/index.ts"),
};

async function bundleWorker(entry, outfile) {
  await mkdir(dirname(outfile), { recursive: true });
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    alias: WORKSPACE_ALIASES,
    logOverride: { "empty-import-meta": "silent" },
  });
}

function workerUrl(host, port) {
  return `http://${host}:${port}`;
}

/**
 * Parse a wrangler-style .dev.vars file (KEY=VALUE lines, # comments,
 * optional surrounding quotes). Missing file → empty object.
 */
async function readDevVars(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function assertPortFree(host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Stop the leftover workerd/node process occupying it, then retry \`pnpm dev\`.`,
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

/**
 * Start the gateway plus the selected document type workers in one Miniflare
 * runtime. Shared D1/R2; the KV registry is seeded only with the doc types
 * that are actually running, so the gateway 404s on the rest.
 */
export async function startLocalRuntime({
  host = "127.0.0.1",
  docTypes = Object.keys(DOC_TYPES),
  ports: portOverrides = {},
  persistPath,
  logLevel = LogLevel.WARN,
} = {}) {
  const ports = resolvePorts(docTypes, portOverrides);

  await Promise.all(
    Object.values(ports).map((port) => assertPortFree(host, port)),
  );

  const bundleDir = join(ROOT, ".wrangler", "local-bundles");

  await Promise.all(
    bundleTargets(docTypes).map(({ entry, outfile }) =>
      bundleWorker(join(ROOT, entry), join(bundleDir, outfile)),
    ),
  );

  const urls = Object.fromEntries(
    Object.entries(ports).map(([name, port]) => [name, workerUrl(host, port)]),
  );

  // Load per-doc-type secrets from .dev.vars into that worker's bindings.
  const extraBindings = {};
  for (const name of docTypes) {
    const devVars = DOC_TYPES[name].devVars;
    if (devVars) extraBindings[name] = await readDevVars(join(ROOT, devVars));
  }

  let mf;
  try {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        host,
        port: ports.gateway,
        log: new Log(logLevel),
        logRequests: logLevel >= LogLevel.INFO,
        ...(persistPath ? { resourcePersistencePath: persistPath } : {}),
        workers: buildWorkers({ docTypes, host, ports, bundleDir, extraBindings }),
      }),
    );

    await mf.ready;

    const registry = await mf.getKVNamespace("REGISTRY", "unidocs-gateway");
    for (const [key, value] of registryEntries(docTypes, urls)) {
      await registry.put(key, value);
    }

    return {
      mf,
      urls,
      docTypes,
      async dispose() {
        await mf.dispose();
      },
    };
  } catch (err) {
    await mf?.dispose();
    throw err;
  }
}
