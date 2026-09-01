/**
 * Registry of locally runnable document types, plus the pure helpers that
 * expand it into Miniflare configuration.
 *
 * Dependency-free on purpose: `dev.mjs` parses argv against this table before
 * anything heavy (esbuild, Miniflare) is imported, and the table is the single
 * place a new document type has to be declared for local dev.
 */

import { join } from "node:path";

export const GATEWAY_PORT = 8787;
export const GATEWAY_WORKER = "unidocs-gateway";
/** Local mock Google OIDC provider (dev only). */
export const MOCK_OIDC_WORKER = "unidocs-mock-oidc";
/** 故障注入用的假 CAS,只在测试里启用。 */
export const CAS_FAULT_WORKER = "unidocs-cas-fault";
export const REMOTE_CAS_PROXY_WORKER = "unidocs-remote-cas-proxy";
/** Unified UniCAS service: tenant/admin APIs, BFF/UI, MCP, and public routing. */
export const SERVICE_WORKER = "unidocs-cas-service";
/** Middleware tenant D1 + R2 (stack-scoped schema; separate from legacy CAS_DB). */
export const CAS_MIDDLEWARE_DB = "unidocs-cas-middleware-db";
export const CAS_MIDDLEWARE_BUCKET = "unidocs-cas-middleware";
/** Local shared secret for the private audit-reader RPC (dev only). */
export const CAS_AUDIT_READER_KEY = "unidocs-dev-cas-audit-reader-key";
/** Admin BFF 直连端口(Vite dev 通过 5174 代理到它)。 */
export const ADMIN_PORT = 8792;
/** Mock OIDC provider 直连端口。 */
export const MOCK_OIDC_PORT = 8793;
/** Public CAS edge 直连端口(本地测试经它驱动中间件)。 */
export const EDGE_PORT = 8794;
/** 本地 CAS_CONTROL_DB 名称。 */
export const CONTROL_DB = "unidocs-cas-control";
/** 本地 admin 会话加密密钥(仅本地开发;生产用 wrangler secret)。 */
export const CAS_ADMIN_SESSION_KEY = "-rlX2kRi6wW59cGagXqw5GYFUWlsE0PXkgv0DLrK5L4";

/**
 * 代理式假 CAS:除 root-refs 外全部原样转发给真 CAS,
 * 使 lease 与读内容照常成功,只让引用计数写入失败。
 * 同时识别规范路由 /stacks/{stackId}/tenants/{tenantId}/root-refs
 * (stack 模式下的 updateRootRefs 走这里)。
 */
export const CAS_FAULT_SCRIPT = `
let failedVersionTwo = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isRootRefs = url.pathname.endsWith("/root-refs");
    if (isRootRefs) {
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
    // 8790, not 8791: the gateway (8787) and doc types take 8788-8790,
    // and `startLocalRuntime` asserts every port in the map is free.
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
export function bundleTargets(docTypes, { casMiddlewareOnly = false, casMiddleware = true } = {}) {
  const serviceTargets = [
    { entry: "unicas-packages/service-cloudflare/src/worker.ts", outfile: "cas-service.js" },
  ];
  if (casMiddlewareOnly) {
    return [
      ...serviceTargets,
      { entry: "stacks/unicas/local/mock-oidc-worker.mjs", outfile: "mock-oidc.js" },
    ];
  }
  return [
    ...(casMiddleware ? serviceTargets : []),
    { entry: "packages/cloudflare-gateway/src/worker.ts", outfile: "gateway.js" },
    ...(casMiddleware ? [
      { entry: "stacks/unicas/local/mock-oidc-worker.mjs", outfile: "mock-oidc.js" },
    ] : []),
    ...docTypes.map((name) => ({
      entry: DOC_TYPES[name].entry,
      outfile: `${name}.js`,
    })),
  ];
}

export function docServicesJson(docTypes, host, ports) {
  return JSON.stringify(Object.fromEntries(docTypes.map((name) => [name, {
    serviceId: name,
    url: `http://${host}:${ports[name]}`,
    audience: `unidocs-doc:${name}`,
  }])));
}

/**
 * Miniflare worker configs: the gateway always, then one per selected type.
 * `extraBindings` maps a doc type name to additional bindings (e.g. secrets
 * loaded from its .dev.vars) merged into that worker only.
 *
 * `casMiddlewareOnly` starts the unified UniCAS service and mock OIDC provider
 * with no UniDocs gateway or document type workers.
 */
export function buildWorkers({
  docTypes,
  host,
  ports,
  bundleDir,
  casFault = false,
  extraBindings = {},
  capabilityFixture,
  stackFixture,
  casAdminPublicOrigin = `http://localhost:4070`,
  googleOidcClientId,
  googleOidcClientSecret,
  googleOidcIssuer,
  casMiddlewareOnly = false,
  casMiddleware = false,
  casOrigin,
  gatewayOAuth,
}) {
  if (!stackFixture) {
    throw new Error("stackFixture is required for the stack local runtime");
  }
  if (!capabilityFixture) {
    throw new Error("capabilityFixture is required for the stack local runtime");
  }
  const policyBindings = {
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "1800",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
  };
  const validatorBindings = {
    CAPABILITY_ISSUER: capabilityFixture.issuer,
    CAPABILITY_TRUSTED_JWKS: JSON.stringify(capabilityFixture.jwks),
  };

  // Admin BFF configuration for the unified service. It binds both the public
  // CAS port and the direct admin port used by the Vite development proxy.
  const useRealGoogle = Boolean(googleOidcClientId) || Boolean(googleOidcClientSecret);
  const adminBindings = {
    GOOGLE_OIDC_CLIENT_ID: googleOidcClientId ?? "unidocs-local-admin",
    GOOGLE_OIDC_CLIENT_SECRET: googleOidcClientSecret ?? "unidocs-local-admin-secret",
    SESSION_ENCRYPTION_KEYS: JSON.stringify({ local: CAS_ADMIN_SESSION_KEY }),
    PUBLIC_ORIGIN: casAdminPublicOrigin,
    SESSION_COOKIE_SECURE: "false",
  };
  if (useRealGoogle) {
    adminBindings.OIDC_ISSUER = googleOidcIssuer ?? "https://accounts.google.com";
  } else {
    adminBindings.OIDC_ISSUER = `http://${host}:${ports.mockOidc}`;
    adminBindings.OIDC_DISCOVERY_URL = `http://${host}:${ports.mockOidc}/.well-known/openid-configuration`;
  }
  const serviceWorker = {
    name: SERVICE_WORKER,
    modules: true,
    scriptPath: join(bundleDir, "cas-service.js"),
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
    bindings: {
      ...adminBindings,
      CAS_AUDIT_READER_KEY,
      CAS_PUBLIC_ORIGIN: `http://${host}:${ports.edge}`,
      MCP_ALLOWED_ORIGIN_HOSTNAMES: "",
      MCP_MUTATIONS_ENABLED: "true",
      OAUTH_STATE_ENCRYPTION_KEY: CAS_ADMIN_SESSION_KEY,
    },
    durableObjects: {
      CAS_DO: { className: "CasDurableObject" },
      CAS_DOMAIN_DO: { className: "RootRefDomainDurableObject" },
    },
    d1Databases: {
      CAS_CONTROL_DB: CONTROL_DB,
      CAS_DB: CAS_MIDDLEWARE_DB,
    },
    r2Buckets: { CAS_R2: CAS_MIDDLEWARE_BUCKET },
    kvNamespaces: ["OAUTH_KV"],
    unsafeDirectSockets: [
      { host, port: ports.admin },
      { host, port: ports.edge },
    ],
  };
  const mockOidcWorker = {
    name: MOCK_OIDC_WORKER,
    modules: true,
    scriptPath: join(bundleDir, "mock-oidc.js"),
    compatibilityDate: COMPATIBILITY_DATE,
    unsafeDirectSockets: [{ host, port: ports.mockOidc }],
  };

  if (casMiddlewareOnly) {
    return [
      serviceWorker,
      mockOidcWorker,
    ];
  }

  const gatewayCasServiceTarget = casOrigin ? REMOTE_CAS_PROXY_WORKER : SERVICE_WORKER;
  const docCasServiceTarget = casOrigin
    ? REMOTE_CAS_PROXY_WORKER
    : (casFault ? CAS_FAULT_WORKER : SERVICE_WORKER);
  const workers = [
    {
      name: GATEWAY_WORKER,
      modules: true,
      scriptPath: join(bundleDir, "gateway.js"),
      compatibilityDate: COMPATIBILITY_DATE,
      bindings: {
        DOC_SERVICES_JSON: docServicesJson(docTypes, host, ports),
        ...policyBindings,
        CAPABILITY_ISSUER: capabilityFixture.issuer,
        CAPABILITY_KEY_ID: capabilityFixture.kid,
        CAPABILITY_PRIVATE_KEY_PKCS8: capabilityFixture.privateKeyPkcs8,
        CAS_CAPABILITY_AUDIENCE: stackFixture.audience,
        CAS_STACK_ID: stackFixture.stackId,
        CAS_STACK_ISSUER: stackFixture.issuer,
        CAS_STACK_KEY_ID: stackFixture.kid,
        CAS_STACK_PRIVATE_KEY_PKCS8: stackFixture.privateKeyPkcs8,
        CAS_REF_DOMAIN: "doc",
        INSECURE_PATH_IDENTITY: "true",
        ...(gatewayOAuth ? {
          GATEWAY_OAUTH_ISSUER: stackFixture.issuer,
          GATEWAY_OAUTH_LOCAL_IDENTITY: "unsafe-development-only",
          GATEWAY_OAUTH_LOCAL_PRINCIPAL: gatewayOAuth.principalId,
          ...(gatewayOAuth.displayName
            ? { GATEWAY_OAUTH_LOCAL_DISPLAY_NAME: gatewayOAuth.displayName }
            : {}),
        } : {}),
      },
      d1Databases: { GATEWAY_DB },
      serviceBindings: { CAS_SERVICE: gatewayCasServiceTarget },
    },
  ];

  if (casOrigin) {
    workers.push({
      name: REMOTE_CAS_PROXY_WORKER,
      modules: true,
      script: `export default {
        async fetch(request, env) {
          const source = new URL(request.url);
          const target = new URL(env.CAS_ORIGIN);
          target.pathname = source.pathname;
          target.search = source.search;
          return fetch(new Request(target, request));
        }
      };`,
      compatibilityDate: COMPATIBILITY_DATE,
      bindings: { CAS_ORIGIN: casOrigin },
    });
  }

  if (casFault) {
    workers.push({
      name: CAS_FAULT_WORKER,
      modules: true,
      script: CAS_FAULT_SCRIPT,
      compatibilityDate: COMPATIBILITY_DATE,
      serviceBindings: { CAS_UPSTREAM: SERVICE_WORKER },
    });
  }

  if (!casOrigin) {
    workers.push(serviceWorker, mockOidcWorker);
  }

  const stackBindings = {
    CAS_STACK_ID: stackFixture.stackId,
    CAS_STACK_ISSUER: stackFixture.issuer,
    CAS_STACK_TRUSTED_JWKS: JSON.stringify(stackFixture.jwks),
  };
  for (const name of docTypes) {
    const spec = DOC_TYPES[name];
    workers.push({
      name: spec.worker,
      modules: true,
      scriptPath: join(bundleDir, `${name}.js`),
      compatibilityDate: COMPATIBILITY_DATE,
      bindings: {
        DOC_CAPABILITY_AUDIENCE: `unidocs-doc:${name}`,
        CAS_CAPABILITY_AUDIENCE: stackFixture.audience,
        ...policyBindings,
        ...validatorBindings,
        ...stackBindings,
        ...(extraBindings[name] ?? {}),
      },
      durableObjects: {
        [spec.editor]: { className: spec.editorClass, useSQLite: true },
        [spec.operator]: { className: spec.operatorClass, useSQLite: true },
      },
      serviceBindings: { CAS_SERVICE: docCasServiceTarget },
      unsafeDirectSockets: [{ host, port: ports[name] }],
    });
  }

  return workers;
}
