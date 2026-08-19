/**
 * Registry of locally runnable document types, plus the pure helpers that
 * expand it into Miniflare configuration.
 *
 * Dependency-free on purpose: `dev.mjs` parses argv against this table before
 * anything heavy (esbuild, Miniflare) is imported, and the table is the single
 * place a new document type has to be declared for local dev.
 */

import { join } from "node:path";

export const INTERNAL_TOKEN = "unidocs-dev-token";
export const GATEWAY_PORT = 8787;
export const GATEWAY_WORKER = "unidocs-gateway";
export const COMPATIBILITY_DATE = "2025-08-17";
export const SNAPSHOTS_DB = "unidocs-snapshots";
export const CAS_BUCKET = "unidocs-cas";
export const REGISTRY_KV = "unidocs-registry";

export const DOC_TYPES = {
  markdown: {
    entry: "packages/cloudflare-markdown/src/worker.ts",
    worker: "unidocs-markdown",
    editor: "MARKDOWN_EDITOR",
    editorClass: "MarkdownEditor",
    operator: "MARKDOWN_OPERATOR",
    operatorClass: "MarkdownOperator",
    port: 8788,
  },
  docx: {
    entry: "packages/cloudflare-docx/src/worker.ts",
    worker: "unidocs-docx",
    editor: "DOCX_EDITOR",
    editorClass: "DocxEditor",
    operator: "DOCX_OPERATOR",
    operatorClass: "DocxOperator",
    port: 8789,
  },
  psd: {
    entry: "packages/cloudflare-psd/src/worker.ts",
    worker: "unidocs-psd",
    editor: "PSD_EDITOR",
    editorClass: "PsdEditor",
    operator: "PSD_OPERATOR",
    operatorClass: "PsdOperator",
    port: 8790,
  },
};

/**
 * Resolve positional CLI args to the doc types to start.
 * No args means every registered type. Order is preserved, duplicates collapse.
 */
export function parseDocTypes(args) {
  const known = Object.keys(DOC_TYPES);
  if (args.length === 0) return known;

  const selected = [];
  for (const arg of args) {
    if (!Object.hasOwn(DOC_TYPES, arg)) {
      throw new Error(
        `Unknown document type: ${arg}. Available: ${known.join(", ")}`,
      );
    }
    if (!selected.includes(arg)) selected.push(arg);
  }
  return selected;
}

/** Ports for the gateway plus the selected doc types; overrides win per key. */
export function resolvePorts(docTypes, overrides = {}) {
  const ports = { gateway: overrides.gateway ?? GATEWAY_PORT };
  for (const name of docTypes) {
    ports[name] = overrides[name] ?? DOC_TYPES[name].port;
  }
  return ports;
}

/** Entry point of every worker that needs bundling for the given selection. */
export function bundleTargets(docTypes) {
  return [
    { entry: "packages/cloudflare-gateway/src/worker.ts", outfile: "gateway.js" },
    ...docTypes.map((name) => ({
      entry: DOC_TYPES[name].entry,
      outfile: `${name}.js`,
    })),
  ];
}

/** Miniflare worker configs: the gateway always, then one per selected type. */
export function buildWorkers({ docTypes, host, ports, bundleDir }) {
  const bindings = { INTERNAL_TOKEN };

  const workers = [
    {
      name: GATEWAY_WORKER,
      modules: true,
      scriptPath: join(bundleDir, "gateway.js"),
      compatibilityDate: COMPATIBILITY_DATE,
      bindings,
      kvNamespaces: { REGISTRY: REGISTRY_KV },
      d1Databases: { SNAPSHOTS_DB },
    },
  ];

  for (const name of docTypes) {
    const spec = DOC_TYPES[name];
    workers.push({
      name: spec.worker,
      modules: true,
      scriptPath: join(bundleDir, `${name}.js`),
      compatibilityDate: COMPATIBILITY_DATE,
      bindings,
      durableObjects: {
        [spec.editor]: { className: spec.editorClass, useSQLite: true },
        [spec.operator]: { className: spec.operatorClass, useSQLite: true },
      },
      d1Databases: { SNAPSHOTS_DB },
      r2Buckets: { CAS: CAS_BUCKET },
      unsafeDirectSockets: [{ host, port: ports[name] }],
    });
  }

  return workers;
}

/** KV registry rows so the gateway can only route to types that are running. */
export function registryEntries(docTypes, urls) {
  return docTypes.map((name) => [
    `docType:${name}`,
    JSON.stringify({ workerUrl: urls[name] }),
  ]);
}
