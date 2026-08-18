import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare,
} from "miniflare";

export const INTERNAL_TOKEN = "unidocs-dev-token";
export const DEFAULT_PORTS = {
  gateway: 8787,
  markdown: 8788,
  docx: 8789,
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPATIBILITY_DATE = "2025-08-17";
const SNAPSHOTS_DB = "unidocs-snapshots";
const CAS_BUCKET = "unidocs-cas";
const REGISTRY_KV = "unidocs-registry";

const WORKSPACE_ALIASES = {
  "@unidocs/core": join(ROOT, "packages/core/src/index.ts"),
  "@unidocs/cloudflare-sdk": join(ROOT, "packages/cloudflare-sdk/src/index.ts"),
  "@unidocs/doctype-markdown": join(
    ROOT,
    "packages/doctype-markdown/src/index.ts",
  ),
  "@unidocs/doctype-docx": join(ROOT, "packages/doctype-docx/src/index.ts"),
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
 * Start gateway + markdown + docx in one Miniflare runtime.
 * Shared D1/R2; KV registry is seeded with each worker's HTTP URL.
 */
export async function startLocalRuntime({
  host = "127.0.0.1",
  ports = DEFAULT_PORTS,
  persistPath,
  logLevel = LogLevel.WARN,
} = {}) {
  await Promise.all(
    Object.values(ports).map((port) => assertPortFree(host, port)),
  );

  const bundleDir = join(ROOT, ".wrangler", "local-bundles");

  await Promise.all([
    bundleWorker(
      join(ROOT, "packages/cloudflare-gateway/src/worker.ts"),
      join(bundleDir, "gateway.js"),
    ),
    bundleWorker(
      join(ROOT, "packages/cloudflare-markdown/src/worker.ts"),
      join(bundleDir, "markdown.js"),
    ),
    bundleWorker(
      join(ROOT, "packages/cloudflare-docx/src/worker.ts"),
      join(bundleDir, "docx.js"),
    ),
  ]);

  const urls = {
    gateway: workerUrl(host, ports.gateway),
    markdown: workerUrl(host, ports.markdown),
    docx: workerUrl(host, ports.docx),
  };

  const sharedBindings = {
    INTERNAL_TOKEN,
  };
  const sharedStorage = {
    d1Databases: { SNAPSHOTS_DB },
    r2Buckets: { CAS: CAS_BUCKET },
  };

  let mf;
  try {
    mf = new Miniflare(
    convertV4MiniflareOptions({
      host,
      port: ports.gateway,
      log: new Log(logLevel),
      logRequests: logLevel >= LogLevel.INFO,
      ...(persistPath ? { resourcePersistencePath: persistPath } : {}),
      workers: [
        {
          name: "unidocs-gateway",
          modules: true,
          scriptPath: join(bundleDir, "gateway.js"),
          compatibilityDate: COMPATIBILITY_DATE,
          bindings: sharedBindings,
          kvNamespaces: { REGISTRY: REGISTRY_KV },
          d1Databases: { SNAPSHOTS_DB },
        },
        {
          name: "unidocs-markdown",
          modules: true,
          scriptPath: join(bundleDir, "markdown.js"),
          compatibilityDate: COMPATIBILITY_DATE,
          bindings: sharedBindings,
          durableObjects: {
            MARKDOWN_EDITOR: { className: "MarkdownEditor", useSQLite: true },
            MARKDOWN_OPERATOR: {
              className: "MarkdownOperator",
              useSQLite: true,
            },
          },
          ...sharedStorage,
          unsafeDirectSockets: [{ host, port: ports.markdown }],
        },
        {
          name: "unidocs-docx",
          modules: true,
          scriptPath: join(bundleDir, "docx.js"),
          compatibilityDate: COMPATIBILITY_DATE,
          bindings: sharedBindings,
          durableObjects: {
            DOCX_EDITOR: { className: "DocxEditor", useSQLite: true },
            DOCX_OPERATOR: { className: "DocxOperator", useSQLite: true },
          },
          ...sharedStorage,
          unsafeDirectSockets: [{ host, port: ports.docx }],
        },
      ],
    }),
    );

    await mf.ready;

    const registry = await mf.getKVNamespace("REGISTRY", "unidocs-gateway");
    await registry.put(
      "docType:markdown",
      JSON.stringify({ workerUrl: urls.markdown }),
    );
    await registry.put(
      "docType:docx",
      JSON.stringify({ workerUrl: urls.docx }),
    );

    return {
      mf,
      urls,
      async dispose() {
        await mf.dispose();
      },
    };
  } catch (err) {
    await mf?.dispose();
    throw err;
  }
}
