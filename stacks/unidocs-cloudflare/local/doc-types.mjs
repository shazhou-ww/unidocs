/**
 * Registry of locally runnable document types, plus the pure helpers that
 * expand it into Miniflare configuration.
 *
 * Dependency-free on purpose: `dev.mjs` parses argv against this table before
 * anything heavy (esbuild, Miniflare) is imported, and the table is the single
 * place a new document type has to be declared for local dev.
 */

import { join } from "node:path";
import { SERVICE_TARGETS, serviceWorkers } from "./services.mjs";

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
        && (requestId.includes(":version:2:roots") || requestId.includes(":commit:") || /^apply:.*:2$/.test(requestId));
      if (isVersionTwo && !failedVersionTwo) {
        failedVersionTwo = true;
        if (env.CAS_FAULT_MODE === "after-commit") {
          const response = await env.CAS_UPSTREAM.fetch(request);
          if (!response.ok) return response;
          await response.arrayBuffer();
          return Response.json({ error: "injected response loss after root-refs commit" }, { status: 503 });
        }
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
    // 租户级字体索引（setText 的来源）。只有 psd 有,所以是可选字段 ——
    // 本地环境按这张表装配,压根不解析 wrangler.toml,漏在这里的结果是
    // 线上能跑、本地起不来,而报错只会指向一个看不出根因的绑定缺失。
    fonts: "PSD_FONTS",
    fontsClass: "PsdFonts",
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

/**
 * Split positional arguments into document types and service targets.
 *
 * They share one argument position because that is how the command reads —
 * `pnpm dev portal psd` — but they expand along different paths: a document
 * type becomes an editor/operator pair behind the gateway, a service target
 * becomes one or more standalone processes. No arguments still means every
 * document type and no service, which is the historical behaviour.
 */
export function parseTargets(args) {
  if (args.length === 0) return { docTypes: Object.keys(DOC_TYPES), services: [] };
  const docTypes = [];
  const services = [];
  for (const arg of args) {
    if (Object.hasOwn(DOC_TYPES, arg)) {
      if (!docTypes.includes(arg)) docTypes.push(arg);
    } else if (Object.hasOwn(SERVICE_TARGETS, arg)) {
      if (!services.includes(arg)) services.push(arg);
    } else {
      throw new Error(
        `Unknown target: ${arg}. Document types: ${Object.keys(DOC_TYPES).join(", ")}. Services: ${Object.keys(SERVICE_TARGETS).join(", ")}`,
      );
    }
  }
  return { docTypes, services };
}

/** Ports for the gateway plus the selected doc types; overrides win per key. */
export function resolvePorts(docTypes, overrides = {}, services = []) {
  const ports = { gateway: overrides.gateway ?? GATEWAY_PORT };
  for (const name of docTypes) {
    ports[name] = overrides[name] ?? DOC_TYPES[name].port;
  }
  for (const component of serviceWorkers(services)) {
    ports[component.name] = overrides[component.name] ?? component.port;
    // A second port on the same worker, not a second worker — see
    // PORTAL_BUNDLE_PORT. It goes in the map so it is printed with the rest
    // and, more importantly, checked for being free alongside them.
    if (component.bundlePort) {
      const key = `${component.name}Bundles`;
      ports[key] = overrides[key] ?? component.bundlePort;
    }
  }
  return ports;
}

/**
 * Drop the keys a `.dev.vars` file names but leaves empty.
 *
 * `.dev.vars.example` ships `GATEWAY_OIDC_CLIENT_ID=` with nothing after the
 * `=`, so a reader fills it in by typing rather than by also remembering to
 * uncomment. Without this, copying the example and filling in *neither* line
 * would overwrite the working placeholder credentials with empty strings — and
 * the portal's config check refuses those, which does not disable sign-in but
 * 503s every route the worker has. An empty value means "not configured here",
 * never "configured as empty".
 */
export function configuredOnly(vars = {}) {
  return Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== ""));
}

/** The unified UniCAS service's bundle entry; see `serviceWorker` below. */
export const CAS_SERVICE_ENTRY = "unicas-packages/service-cloudflare/src/worker.ts";

/**
 * Every bundle entry whose Miniflare worker declares
 * `compatibilityFlags: ["nodejs_compat"]` — derived from the same two places
 * `buildWorkers` takes them from, never restated:
 *
 * - `CAS_SERVICE_ENTRY`, the unified UniCAS service (`serviceWorker`);
 * - every `SERVICE_TARGETS` component with an entry (`serviceWorkerConfigs`),
 *   which gets the flag unconditionally — so a new service row lands here for
 *   free instead of needing a second edit somewhere else.
 */
export const NODE_COMPAT_ENTRIES = [
  CAS_SERVICE_ENTRY,
  ...serviceWorkers(Object.keys(SERVICE_TARGETS)).map(component => component.entry),
];

/**
 * The esbuild `external` list for one bundle entry (see `bundleWorker` in
 * runtime.mjs).
 *
 * Two different reasons, deliberately not one list:
 *
 * - `cloudflare:workers` is a workerd *built-in* module. It resolves at
 *   runtime on every worker, with no compatibility flag involved, so esbuild
 *   must leave it alone for every entry — there is nothing to bundle and no
 *   condition to check. Scoping it to a path list is what broke
 *   `packages/cloudflare-gateway/src/worker.ts` (esbuild: `Could not resolve
 *   "cloudflare:workers"`) the moment platform-document-do.ts started
 *   importing `DurableObject` from it. The gateway is bundled on
 *   *every* `pnpm dev`, so that one unresolved import took the entire local
 *   runtime down, for every target. Keep this unconditional.
 * - `node:*` is the opposite: workerd resolves those only under
 *   `nodejs_compat`, so it stays scoped to the entries that declare that flag.
 *   Externalizing it everywhere would turn a missing flag from a build error
 *   into a runtime one. The portal needs it for `node:crypto`'s
 *   `timingSafeEqual` (auth.ts).
 *
 * `bundleWorker` passes `join(ROOT, entry)`, so the match is a suffix/substring
 * one on a forward-slash-normalized path rather than a prefix anchor.
 */
export function bundleExternals(entry) {
  const path = entry.replaceAll("\\", "/");
  const nodeCompat = NODE_COMPAT_ENTRIES.some(candidate => path.includes(candidate));
  return nodeCompat ? ["cloudflare:workers", "node:*"] : ["cloudflare:workers"];
}

/** Entry point of every worker that needs bundling for the given selection. */
export function bundleTargets(docTypes, { casMiddlewareOnly = false, casMiddleware = true, services = [] } = {}) {
  const serviceTargets = [
    { entry: CAS_SERVICE_ENTRY, outfile: "cas-service.js" },
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
    ...serviceWorkers(services).map(component => ({ entry: component.entry, outfile: component.outfile })),
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
  portalBootstrapEmail = "",
  casMiddlewareOnly = false,
  casMiddleware = false,
  casOrigin,
  gatewayOAuth,
  services = [],
  // Per-service `.dev.vars`, keyed by component name — the portal's Google
  // client secret. Read in runtime.mjs (this module does no I/O).
  serviceDevVars = {},
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

  // NOTE: these bindings are *portal-shaped*, and every service component gets
  // the same set. With one service in the registry that is invisible; with two
  // it is wrong — a second service would boot bound to PORTAL_ORIGIN, the
  // portal's Google client id and PORTAL_BOOTSTRAP_EMAIL, and none of its own.
  // Making this genuinely per-service means describing each service's bindings
  // in SERVICE_TARGETS, which is a design change worth making when there is a
  // second service to design against. Until then the registry-coverage guard in
  // tests/unit/scripts/services.test.mjs fails the moment a row is added, and
  // names this as one of the edits.
  //
  // The portal always points at the real Google. The placeholder credentials
  // mirror the CAS admin BFF's: the config only checks they are non-empty, so
  // the worker boots and serves everything except a completed sign-in. Failing
  // closed instead would make `pnpm dev portal` useless to anyone who has not
  // registered a loopback redirect URI, which is most readers most of the time.
  // Same precedence `mergeDocBindings` pins for doc types: placeholders are
  // only what nobody configured, `.dev.vars` beats them, and the process
  // environment beats both. Only keys that are actually set take part, or an
  // unset variable would overwrite a line the reader wrote in the file.
  const serviceEnvOverrides = {};
  if (googleOidcClientId) serviceEnvOverrides.GATEWAY_OIDC_CLIENT_ID = googleOidcClientId;
  if (googleOidcClientSecret) serviceEnvOverrides.GATEWAY_OIDC_CLIENT_SECRET = googleOidcClientSecret;
  // PORTAL_BOOTSTRAP_EMAIL belongs in this layer for the same reason the two
  // above do. It used to be assigned *after* the `.dev.vars` spread, which
  // made the line in `.dev.vars.example` documenting it silently do nothing:
  // unset, it is "", and "" is what overwrote whatever the reader wrote.
  if (portalBootstrapEmail) serviceEnvOverrides.PORTAL_BOOTSTRAP_EMAIL = portalBootstrapEmail;

  const serviceWorkerConfigs = serviceWorkers(services).map(component => ({
    name: component.worker,
    modules: true,
    scriptPath: join(bundleDir, component.outfile),
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      PORTAL_ORIGIN: `http://${host}:${ports[component.name]}`,
      // Always the real Google: the portal requires auth_time and
      // email_verified, which the local mock provider does not issue.
      GATEWAY_OIDC_ISSUER: "https://accounts.google.com",
      GATEWAY_OIDC_CLIENT_ID: "unidocs-portal-local",
      GATEWAY_OIDC_CLIENT_SECRET: "unidocs-portal-local-secret",
      // Empty means "nobody is designated": `worker.ts` turns "" into null and
      // the bootstrap check refuses every identity against a null.
      PORTAL_BOOTSTRAP_EMAIL: "",
      ...configuredOnly(serviceDevVars[component.name]),
      ...serviceEnvOverrides,
      // Not optional, despite only the bundle routes reading it: the worker
      // builds its type-card bundle service on every request, and an absent
      // BUNDLE_ORIGIN throws there before any route is chosen — turning the
      // whole portal, admin sign-in included, into a blanket 503.
      ...(component.bundlePort ? { BUNDLE_ORIGIN: `http://${host}:${ports[`${component.name}Bundles`]}` } : {}),
    },
    d1Databases: { [component.d1Binding]: component.worker },
    ...(component.r2Binding ? { r2Buckets: { [component.r2Binding]: `${component.worker}-bundles` } } : {}),
    unsafeDirectSockets: [
      { host, port: ports[component.name] },
      ...(component.bundlePort ? [{ host, port: ports[`${component.name}Bundles`] }] : []),
    ],
  }));

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
      bindings: { CAS_FAULT_MODE: casFault === "after-commit" ? "after-commit" : "before-commit" },
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
        ...(spec.fonts
          ? { [spec.fonts]: { className: spec.fontsClass, useSQLite: true } }
          : {}),
      },
      serviceBindings: { CAS_SERVICE: docCasServiceTarget },
      unsafeDirectSockets: [{ host, port: ports[name] }],
    });
  }

  workers.push(...serviceWorkerConfigs);

  return workers;
}
