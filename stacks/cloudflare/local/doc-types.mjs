/**
 * Registry of locally runnable document types, plus the pure helpers that
 * expand it into Miniflare configuration.
 *
 * Dependency-free on purpose: `dev.mjs` parses argv against this table before
 * anything heavy (esbuild, Miniflare) is imported, and the table is the single
 * place a new document type has to be declared for local dev.
 */

import { join } from "node:path";

export const CAS_ACCESS_KEY = "unidocs-dev-cas-key";
export const GATEWAY_PORT = 8787;
export const GATEWAY_WORKER = "unidocs-gateway";
export const CAS_WORKER = "unidocs-cas";
/**
 * 过渡形态(阶段 4 删除):Azure 栈的 CAS_BASE_URL 要能从进程外打到这个
 * worker。service binding 只在 Miniflare 进程内有效,而 CasClient 的
 * updateRootRefs 走 /_internal/root-refs,gateway 不代理这条路由 ——
 * 所以必须直连 worker 本身。8787-8790 已被 gateway 与 doc type 占用,
 * 这里用 8791。
 */
export const CAS_PORT = 8791;
/** 故障注入用的假 CAS,只在测试里启用。 */
export const CAS_FAULT_WORKER = "unidocs-cas-fault";

/**
 * 代理式假 CAS:除 root-refs 外全部原样转发给真 CAS,
 * 使 lease 与读内容照常成功,只让引用计数写入失败。
 */
export const CAS_FAULT_SCRIPT = `
let failedVersionTwo = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/_internal/root-refs")) {
      const body = await request.clone().json().catch(() => null);
      const requestId = body?.requestId;
      const isVersionTwo = typeof requestId === "string"
        && (requestId.includes(":version:2:roots") || /^apply:.*:2$/.test(requestId));
      if (isVersionTwo && !failedVersionTwo) {
        failedVersionTwo = true;
        return Response.json({ error: "injected root-refs failure" }, { status: 503 });
      }
    }
    return env.CAS_UPSTREAM.fetch(request);
  },
};
`;
export const COMPATIBILITY_DATE = "2025-08-17";
export const GATEWAY_DB = "unidocs-snapshots";
export const CAS_BUCKET = "unidocs-cas";
export const CAS_DB = "unidocs-cas-db";

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
    // 8790, not 8791: CAS_PORT is 8791 (see its comment above — 8787-8790
    // are taken by gateway and the doc types), and `startLocalRuntime`
    // merges `ports.cas = CAS_PORT` into the same map it port-checks.
    // Putting psd on 8791 would collide with CAS.
    port: 8790,
    // Optional dev-only frontend: a Vite app started alongside the worker,
    // with GATEWAY_URL injected so it proxies API calls to the gateway.
    web: { dir: "packages/web-psd", port: 5173 },
    // Optional .dev.vars file merged into this worker's bindings (secrets:
    // the Operator's LLM_API_KEY / LLM_BASE_URL / LLM_MODEL). Not committed —
    // see .dev.vars.example. Read by `readDevVars` in local-runtime.mjs.
    devVars: "packages/cloudflare-psd/.dev.vars",
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

export function docServiceAccessKey(docType) {
  return `unidocs-dev-${docType}-key`;
}

export function docServicesJson(docTypes, host, ports) {
  return JSON.stringify(Object.fromEntries(docTypes.map((name) => [name, {
    serviceId: name,
    url: `http://${host}:${ports[name]}`,
    accessKey: docServiceAccessKey(name),
    audience: `unidocs-doc:${name}`,
  }])));
}

/**
 * Miniflare worker configs: the gateway always, then one per selected type.
 * `extraBindings` maps a doc type name to additional bindings (e.g. secrets
 * loaded from its .dev.vars) merged into that worker only.
 */
export function buildWorkers({
  docTypes,
  host,
  ports,
  bundleDir,
  casFault = false,
  extraBindings = {},
  internalAuthMode = "legacy",
  capabilityFixture,
}) {
  if (!["legacy", "dual", "capability"].includes(internalAuthMode)) {
    throw new Error("internalAuthMode must be legacy, dual, or capability");
  }
  if (internalAuthMode !== "legacy" && !capabilityFixture) {
    throw new Error("capabilityFixture is required for dual/capability local runtime");
  }
  const policyBindings = {
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "300",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
  };
  const validatorBindings = capabilityFixture ? {
    CAPABILITY_ISSUER: capabilityFixture.issuer,
    CAPABILITY_TRUSTED_JWKS: JSON.stringify(capabilityFixture.jwks),
  } : {};
  const workers = [
    {
      name: GATEWAY_WORKER,
      modules: true,
      scriptPath: join(bundleDir, "gateway.js"),
      compatibilityDate: COMPATIBILITY_DATE,
      bindings: {
        CAS_ACCESS_KEY,
        DOC_SERVICES_JSON: docServicesJson(docTypes, host, ports),
        INTERNAL_AUTH_MODE: internalAuthMode,
        ...policyBindings,
        ...(capabilityFixture ? {
          CAPABILITY_ISSUER: capabilityFixture.issuer,
          CAPABILITY_KEY_ID: capabilityFixture.kid,
          CAPABILITY_PRIVATE_KEY_PKCS8: capabilityFixture.privateKeyPkcs8,
          CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
        } : {}),
        INSECURE_PATH_IDENTITY: "true",
      },
      d1Databases: { GATEWAY_DB },
      serviceBindings: { CAS_SERVICE: CAS_WORKER },
    },
    {
      name: CAS_WORKER,
      modules: true,
      scriptPath: join(bundleDir, "cas.js"),
      compatibilityDate: COMPATIBILITY_DATE,
      bindings: {
        INTERNAL_AUTH_MODE: internalAuthMode,
        CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
        ...policyBindings,
        ...validatorBindings,
        CAS_ACCESS_KEY,
      },
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
      bindings: {
        CAS_ACCESS_KEY,
        INTERNAL_AUTH_MODE: internalAuthMode,
        DOC_CAPABILITY_AUDIENCE: `unidocs-doc:${name}`,
        CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
        ...policyBindings,
        ...validatorBindings,
        SERVICE_ACCESS_KEY: docServiceAccessKey(name),
        ...(extraBindings[name] ?? {}),
      },
      durableObjects: {
        [spec.editor]: { className: spec.editorClass, useSQLite: true },
        [spec.operator]: { className: spec.operatorClass, useSQLite: true },
      },
      serviceBindings: { CAS_SERVICE: casFault ? CAS_FAULT_WORKER : CAS_WORKER },
      unsafeDirectSockets: [{ host, port: ports[name] }],
    });
  }

  return workers;
}
