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
export const CAS_WORKER = "unidocs-cas";
/**
 * 过渡形态(阶段 4 删除):Azure 栈的 CAS_BASE_URL 要能从进程外打到这个
 * worker。service binding 只在 Miniflare 进程内有效,而 CasClient 的
 * updateRootRefs 走 /_internal/root-refs,gateway 不代理这条路由 ——
 * 所以必须直连 worker 本身。8787/8788/8789 已被 gateway 与两个 doc type
 * 占用,这里用 8790。
 */
export const CAS_PORT = 8790;
/** 故障注入用的假 CAS,只在测试里启用。 */
export const CAS_FAULT_WORKER = "unidocs-cas-fault";

/**
 * 代理式假 CAS:除 root-refs 外全部原样转发给真 CAS,
 * 使 lease 与读内容照常成功,只让引用计数写入失败。
 */
export const CAS_FAULT_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/_internal/root-refs") {
      return Response.json({ error: "injected root-refs failure" }, { status: 503 });
    }
    return env.CAS_UPSTREAM.fetch(request);
  },
};
`;
export const COMPATIBILITY_DATE = "2025-08-17";
export const SNAPSHOTS_DB = "unidocs-snapshots";
export const CAS_BUCKET = "unidocs-cas";
export const CAS_DB = "unidocs-cas-db";
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
    { entry: "packages/cloudflare-cas/src/worker.ts", outfile: "cas.js" },
    ...docTypes.map((name) => ({
      entry: DOC_TYPES[name].entry,
      outfile: `${name}.js`,
    })),
  ];
}

/** Miniflare worker configs: the gateway always, then one per selected type. */
export function buildWorkers({ docTypes, host, ports, bundleDir, casFault = false }) {
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
      serviceBindings: { CAS_SERVICE: CAS_WORKER },
    },
    {
      name: CAS_WORKER,
      modules: true,
      scriptPath: join(bundleDir, "cas.js"),
      compatibilityDate: COMPATIBILITY_DATE,
      bindings,
      durableObjects: {
        CAS_DO: { className: "CasDurableObject" },
      },
      d1Databases: { CAS_DB },
      r2Buckets: { CAS_R2: CAS_BUCKET },
      // 过渡形态(阶段 4 删除):Azure 栈的 CAS_BASE_URL 要能从进程外打到
      // 这个 worker。service binding 只在 Miniflare 进程内有效,而
      // CasClient 的 updateRootRefs 走 /_internal/root-refs,gateway 不
      // 代理这条路由 —— 所以必须直连 worker 本身。
      unsafeDirectSockets: [{ host, port: ports.cas }],
    },
  ];

  if (casFault) {
    workers.push({
      name: CAS_FAULT_WORKER,
      modules: true,
      script: CAS_FAULT_SCRIPT,
      compatibilityDate: COMPATIBILITY_DATE,
      bindings,
      serviceBindings: { CAS_UPSTREAM: CAS_WORKER },
    });
  }

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
      serviceBindings: { CAS_SERVICE: casFault ? CAS_FAULT_WORKER : CAS_WORKER },
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
