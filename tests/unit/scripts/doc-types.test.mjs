import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  configuredOnly,
  ADMIN_PORT,
  buildWorkers,
  bundleTargets,
  CAS_FAULT_WORKER,
  CAS_AUDIT_READER_KEY,
  CAS_MIDDLEWARE_BUCKET,
  CAS_MIDDLEWARE_DB,
  COMPATIBILITY_DATE,
  CONTROL_DB,
  DOC_TYPES,
  docServicesJson,
  EDGE_PORT,
  GATEWAY_PORT,
  GATEWAY_WORKER,
  SERVICE_WORKER,
  MOCK_OIDC_PORT,
  MOCK_OIDC_WORKER,
  REMOTE_CAS_PROXY_WORKER,
  parseDocTypes,
  resolvePorts,
} from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";
import { PORTAL_BUNDLE_PORT, PORTAL_PORT, serviceFrontends, serviceWorkers, SERVICE_TARGETS } from "../../../stacks/unidocs-cloudflare/local/services.mjs";

/** Ports every buildWorkers call needs in these tests. */
const BASE_PORTS = { gateway: 8787, admin: ADMIN_PORT, mockOidc: MOCK_OIDC_PORT, edge: 8794 };

/** The registered unidocs-cloudflare stack (what the gateway signs with). */
const STACK_FIXTURE = {
  stackId: "unidocs-cloudflare",
  issuer: "https://cas.example/cas/issuer/cloudflare",
  audience: "unidocs-cas-cloudflare",
  kid: "cf-rotate-1",
  privateKeyPkcs8: "pkcs8",
  jwks: { keys: [{ kid: "cf-rotate-1", kty: "EC", crv: "P-256" }] },
  refDomains: ["doc"],
};

/** The gateway/doc-service identity fixture (INSECURE_PATH_IDENTITY). */
const CAPABILITY_FIXTURE = {
  issuer: "https://cas.example/capability",
  kid: "cap-1",
  privateKeyPkcs8: "cap-pkcs8",
  jwks: { keys: [{ kid: "cap-1" }] },
};

const COMMON = { host: "127.0.0.1", bundleDir: "/b" };
const stackArgs = (extra = {}) => ({
  ...COMMON,
  ports: { ...BASE_PORTS, ...(extra.ports ?? {}) },
  stackFixture: STACK_FIXTURE,
  capabilityFixture: CAPABILITY_FIXTURE,
  docTypes: extra.docTypes ?? [],
  ...(extra.casMiddlewareOnly ? { casMiddlewareOnly: true } : {}),
  ...(extra.casFault ? { casFault: true } : {}),
});

test("parseDocTypes defaults to every registered doc type", () => {
  expect(parseDocTypes([])).toEqual(["markdown", "docx", "psd"]);
});

test("parseDocTypes selects the doc types named as positional args", () => {
  expect(parseDocTypes(["docx"])).toEqual(["docx"]);
});

test("parseDocTypes keeps the order the args were given in", () => {
  expect(parseDocTypes(["docx", "markdown"])).toEqual(["docx", "markdown"]);
});

test("parseDocTypes collapses a repeated doc type", () => {
  expect(parseDocTypes(["docx", "docx"])).toEqual(["docx"]);
});

test("parseDocTypes rejects an unknown doc type", () => {
  expect(() => parseDocTypes(["pdf"])).toThrow(/pdf/);
});

test("every registered doc type carries the fields the runtime needs", () => {
  for (const [name, spec] of Object.entries(DOC_TYPES)) {
    expect(spec.entry, `${name}.entry`).toBeTruthy();
    expect(spec.worker, `${name}.worker`).toBeTruthy();
    expect(spec.editorClass, `${name}.editorClass`).toBeTruthy();
    expect(spec.operatorClass, `${name}.operatorClass`).toBeTruthy();
    expect(typeof spec.port, `${name}.port`).toBe("number");
  }
});

test("gateway and every doc type have unique default ports", () => {
  const ports = [
    8787,
    ...Object.values(DOC_TYPES).map(spec => spec.port),
  ];
  expect(new Set(ports).size).toBe(ports.length);
});

test("resolvePorts only allocates ports for the gateway and selected types", () => {
  expect(resolvePorts(["docx"])).toEqual({ gateway: 8787, docx: 8789 });
});

/**
 * The one fixed port that lives in no registry: `scripts/dev.mjs` spawns the
 * gateway WebUI's Vite server on a literal, so it is read back out of the
 * script rather than restated here — a copy would drift the moment the literal
 * moves. `--strictPort` is part of the match because it is what makes a
 * collision fatal instead of a silent re-bind on the next port.
 */
const GATEWAY_WEB_PORT = (() => {
  const source = readFileSync(new URL("../../../scripts/dev.mjs", import.meta.url), "utf8");
  const match = /"--port", "(\d+)", "--strictPort"/.exec(source);
  if (!match) throw new Error("scripts/dev.mjs no longer spawns the gateway WebUI on a literal port; update FIXED_LOCAL_PORTS.");
  return Number(match[1]);
})();

/**
 * Every fixed port the local runtime binds, whichever module declares it.
 *
 * `resolvePorts` only covers the gateway, doc types and services, so the
 * uniqueness check over its output cannot see admin/mockOidc/edge — which are
 * exactly the three the 879x service band is adjacent to. A collision between
 * two of these does not surface as a clear message: `startLocalRuntime` probes
 * the port map with a concurrent `Promise.all(assertPortFree)`, so one probe
 * binds and the other reports EADDRINUSE, and the reader goes looking through
 * their process list for a port nothing else is holding.
 */
const FIXED_LOCAL_PORTS = [
  ["gateway", GATEWAY_PORT],
  ["web-gateway", GATEWAY_WEB_PORT],
  ["cas admin", ADMIN_PORT],
  ["mock OIDC", MOCK_OIDC_PORT],
  ["cas edge", EDGE_PORT],
  ...Object.entries(DOC_TYPES).flatMap(([name, spec]) => [
    [name, spec.port],
    ...(spec.web ? [[`${name}.web`, spec.web.port]] : []),
  ]),
  ...serviceWorkers(Object.keys(SERVICE_TARGETS)).map(component => [component.name, component.port]),
  ...serviceFrontends(Object.keys(SERVICE_TARGETS)).map(component => [`${component.name}.web`, component.web.port]),
];

test("every fixed local port is distinct, across doc types, services and the CAS middleware", () => {
  const taken = new Map();
  for (const [name, port] of FIXED_LOCAL_PORTS) {
    expect(taken.has(port), `${name} port ${port} collides with ${taken.get(port)}`).toBe(false);
    taken.set(port, name);
  }
});

test("the probed port map has no duplicates for any doc-type selection", () => {
  for (const sel of [["psd"], ["markdown"], ["docx"], ["markdown", "docx", "psd"]]) {
    const ports = resolvePorts(sel);
    const values = Object.values(ports);
    expect(new Set(values).size, `duplicate port in ${JSON.stringify(ports)}`).toBe(values.length);
  }
});

test("resolvePorts lets a caller override individual ports", () => {
  expect(resolvePorts(["markdown"], { gateway: 18787, markdown: 18788 }))
    .toEqual({ gateway: 18787, markdown: 18788 });
});

test("bundleTargets builds the UniCAS service, gateway, mock-oidc, and selected types", () => {
  expect(bundleTargets(["docx"]).map((t) => t.outfile))
    .toEqual(["cas-service.js", "gateway.js", "mock-oidc.js", "docx.js"]);
});

test("bundleTargets casMiddlewareOnly skips gateway and doc types", () => {
  expect(bundleTargets(["docx"], { casMiddlewareOnly: true }).map((t) => t.outfile))
    .toEqual(["cas-service.js", "mock-oidc.js"]);
});

test("buildWorkers includes one UniCAS service and the mock OIDC provider", () => {
  const workers = buildWorkers(stackArgs());
  expect(workers.map((w) => w.name)).toEqual([
    GATEWAY_WORKER,
    SERVICE_WORKER,
    MOCK_OIDC_WORKER,
  ]);
});

test("casMiddlewareOnly starts the unified service without the gateway", () => {
  const workers = buildWorkers(stackArgs({ casMiddlewareOnly: true }));
  expect(workers.map((w) => w.name)).toEqual([
    SERVICE_WORKER,
    MOCK_OIDC_WORKER,
  ]);
});

test("buildWorkers omits doc types that were not selected", () => {
  const workers = buildWorkers(stackArgs({ docTypes: ["docx"], ports: { docx: 8789 } }));
  expect(workers.map((w) => w.name)).toEqual([
    GATEWAY_WORKER,
    SERVICE_WORKER,
    MOCK_OIDC_WORKER,
    "unidocs-docx",
  ]);
});

test("buildWorkers binds each selected type's own DO classes and socket", () => {
  const docx = buildWorkers(stackArgs({ docTypes: ["docx"], ports: { docx: 8789 } }))
    .find((w) => w.name === "unidocs-docx");
  expect(docx.durableObjects).toEqual({
    DOCX_EDITOR: { className: "DocxEditor", useSQLite: true },
    DOCX_OPERATOR: { className: "DocxOperator", useSQLite: true },
  });
  expect(docx.unsafeDirectSockets).toEqual([{ host: "127.0.0.1", port: 8789 }]);
  expect(docx.scriptPath).toBe(join("/b", "docx.js"));
  expect(docx.serviceBindings).toEqual({ CAS_SERVICE: SERVICE_WORKER });
});

test("psd 的租户级字体索引也在本地绑定表里", () => {
  // 本地环境按 DOC_TYPES 装配，压根不解析 wrangler.toml：只改 wrangler.toml
  // 的结果是线上能跑、本地起不来，报错只会指向一个看不出根因的绑定缺失。
  const psd = buildWorkers(stackArgs({ docTypes: ["psd"], ports: { psd: 8790 } }))
    .find((w) => w.name === "unidocs-psd");
  expect(psd.durableObjects).toEqual({
    PSD_EDITOR: { className: "PsdEditor", useSQLite: true },
    PSD_OPERATOR: { className: "PsdOperator", useSQLite: true },
    PSD_FONTS: { className: "PsdFonts", useSQLite: true },
  });
});

test("没有 fonts 字段的文档类型不会凭空多出一条绑定", () => {
  const markdown = buildWorkers(stackArgs({ docTypes: ["markdown"], ports: { markdown: 8788 } }))
    .find((w) => w.name === "unidocs-markdown");
  expect(Object.keys(markdown.durableObjects)).toEqual(["MARKDOWN_EDITOR", "MARKDOWN_OPERATOR"]);
});

test("gateway proxies CAS to the unified service and the service owns the stores", () => {
  const [gateway, service] = buildWorkers(stackArgs());
  expect(gateway.serviceBindings).toEqual({ CAS_SERVICE: SERVICE_WORKER });
  expect(gateway.durableObjects).toBeUndefined();
  expect(service.durableObjects).toEqual({
    CAS_DO: { className: "CasDurableObject" },
    CAS_DOMAIN_DO: { className: "RootRefDomainDurableObject" },
  });
  expect(service.d1Databases).toEqual({ CAS_CONTROL_DB: CONTROL_DB, CAS_DB: CAS_MIDDLEWARE_DB });
  expect(service.r2Buckets).toEqual({ CAS_R2: CAS_MIDDLEWARE_BUCKET });
});

test("docServicesJson contains only selected types with capability audiences", () => {
  expect(JSON.parse(docServicesJson(["docx"], "h", {
    gateway: 8787,
    docx: 8789,
  }))).toEqual({
    docx: {
      serviceId: "docx",
      url: "http://h:8789",
      audience: "unidocs-doc:docx",
    },
  });
});

test("buildWorkers separates Gateway, Doc, and CAS capabilities", () => {
  const workers = buildWorkers(stackArgs({ docTypes: ["docx"], ports: { docx: 8789 } }));
  const gateway = workers.find((w) => w.name === GATEWAY_WORKER);
  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(gateway.bindings.CAS_STACK_ID).toBe(STACK_FIXTURE.stackId);
  expect(gateway.bindings.CAS_STACK_ISSUER).toBe(STACK_FIXTURE.issuer);
  expect(gateway.bindings.CAS_STACK_KEY_ID).toBe(STACK_FIXTURE.kid);
  expect(gateway.bindings.CAS_STACK_PRIVATE_KEY_PKCS8).toBe(STACK_FIXTURE.privateKeyPkcs8);
  expect(gateway.bindings.CAS_CAPABILITY_AUDIENCE).toBe(STACK_FIXTURE.audience);
  expect(gateway.bindings.CAPABILITY_ISSUER).toBe(CAPABILITY_FIXTURE.issuer);
  expect(docx.bindings).toEqual({
    DOC_CAPABILITY_AUDIENCE: "unidocs-doc:docx",
    CAS_CAPABILITY_AUDIENCE: STACK_FIXTURE.audience,
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "1800",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    CAPABILITY_ISSUER: CAPABILITY_FIXTURE.issuer,
    CAPABILITY_TRUSTED_JWKS: JSON.stringify(CAPABILITY_FIXTURE.jwks),
    CAS_STACK_ID: STACK_FIXTURE.stackId,
    CAS_STACK_ISSUER: STACK_FIXTURE.issuer,
    CAS_STACK_TRUSTED_JWKS: JSON.stringify(STACK_FIXTURE.jwks),
  });
});

test("stack buildWorkers requires both the stack and capability fixtures", () => {
  expect(() => buildWorkers({ ...stackArgs(), stackFixture: undefined }))
    .toThrow(/stackFixture/);
  expect(() => buildWorkers({ ...stackArgs(), capabilityFixture: undefined }))
    .toThrow(/capabilityFixture/);
});

test("casFault 为 true 时,doc-type worker 指向假 CAS,gateway 仍指向中间件", () => {
  const workers = buildWorkers(stackArgs({
    docTypes: ["docx"],
    ports: { docx: 8789 },
    casFault: true,
  }));

  const names = workers.map((w) => w.name);
  expect(names).toContain(CAS_FAULT_WORKER);
  expect(names).toContain(SERVICE_WORKER);

  const gateway = workers.find((w) => w.name === GATEWAY_WORKER);
  expect(gateway.serviceBindings.CAS_SERVICE).toBe(SERVICE_WORKER);

  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(docx.serviceBindings.CAS_SERVICE).toBe(CAS_FAULT_WORKER);

  const fault = workers.find((w) => w.name === CAS_FAULT_WORKER);
  expect(fault.serviceBindings.CAS_UPSTREAM).toBe(SERVICE_WORKER);
  expect(fault.script).toContain("root-refs");
});

test("casFault 默认关闭时,不产生假 CAS worker", () => {
  const workers = buildWorkers(stackArgs({ docTypes: ["docx"], ports: { docx: 8789 } }));
  expect(workers.map((w) => w.name)).not.toContain(CAS_FAULT_WORKER);
  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(docx.serviceBindings.CAS_SERVICE).toBe(SERVICE_WORKER);
});

test("remote CAS mode omits local middleware and binds gateway/docs through the proxy", () => {
  const workers = buildWorkers({
    ...stackArgs({ docTypes: ["docx"], ports: { docx: 8789 } }),
    casOrigin: "https://unicas.example",
  });
  expect(workers.map((worker) => worker.name)).toEqual([
    GATEWAY_WORKER,
    REMOTE_CAS_PROXY_WORKER,
    "unidocs-docx",
  ]);
  expect(workers.find((worker) => worker.name === GATEWAY_WORKER).serviceBindings.CAS_SERVICE)
    .toBe(REMOTE_CAS_PROXY_WORKER);
  expect(workers.find((worker) => worker.name === "unidocs-docx").serviceBindings.CAS_SERVICE)
    .toBe(REMOTE_CAS_PROXY_WORKER);
  expect(workers.find((worker) => worker.name === REMOTE_CAS_PROXY_WORKER).bindings.CAS_ORIGIN)
    .toBe("https://unicas.example");
});

test("接线:统一服务是公网入口并持有全部 CAS 存储绑定", () => {
  const workers = buildWorkers(stackArgs());
  const names = workers.map((w) => w.name);
  expect(names).toContain(SERVICE_WORKER);

  const service = workers.find((w) => w.name === SERVICE_WORKER);
  expect(service.bindings.CAS_AUDIT_READER_KEY).toBe(CAS_AUDIT_READER_KEY);
  expect(service.d1Databases.CAS_CONTROL_DB).toBe(CONTROL_DB);
  expect(service.d1Databases.CAS_DB).toBe(CAS_MIDDLEWARE_DB);
  expect(service.r2Buckets.CAS_R2).toBe(CAS_MIDDLEWARE_BUCKET);
  expect(service.durableObjects.CAS_DO.className).toBe("CasDurableObject");
  expect(service.durableObjects.CAS_DOMAIN_DO.className).toBe("RootRefDomainDurableObject");
  expect(service.kvNamespaces).toEqual(["OAUTH_KV"]);
  expect(service.serviceBindings).toBeUndefined();
  expect(service.unsafeDirectSockets).toEqual([
    { host: "127.0.0.1", port: ADMIN_PORT },
    { host: "127.0.0.1", port: 8794 },
  ]);
});

test("selected services contribute their own bundle targets", () => {
  const withPortal = bundleTargets(["psd"], { services: ["portal"] }).map(target => target.outfile);
  expect(withPortal).toContain("portal.js");
  expect(bundleTargets(["psd"]).map(target => target.outfile)).not.toContain("portal.js");
});

test("service ports are reserved alongside the gateway and document types", () => {
  const ports = resolvePorts(["psd"], {}, ["portal"]);
  expect(ports.portal).toBe(serviceWorkers(["portal"])[0].port);
  expect(new Set(Object.values(ports)).size).toBe(Object.keys(ports).length);
});

const portalWorker = (extra = {}) => buildWorkers({
  docTypes: [], host: "127.0.0.1", ports: resolvePorts([], {}, ["portal"]),
  bundleDir: "/tmp/bundle", services: ["portal"],
  stackFixture: STACK_FIXTURE, capabilityFixture: CAPABILITY_FIXTURE,
  ...extra,
}).find(worker => worker.name === "unidocs-portal");

test("a selected service becomes a Miniflare worker with its D1 binding", () => {
  const portal = portalWorker();
  expect(portal).toBeDefined();
  expect(portal.d1Databases).toMatchObject({ DB: expect.any(String) });
  // Exact, not /:\d+/: mutating `ports[component.name]` to `ports.gateway`
  // still yields a loopback URL, and PORTAL_ORIGIN is what the portal turns
  // into its OAuth redirect URI — the wrong port is a broken sign-in.
  expect(portal.bindings.PORTAL_ORIGIN).toBe(`http://127.0.0.1:${PORTAL_PORT}`);
  // The portal always points at the real Google, never the local mock OIDC
  // provider — see google-config.ts: the mock omits auth_time/email_verified,
  // which the portal requires.
  expect(portal.bindings.GATEWAY_OIDC_ISSUER).toBe("https://accounts.google.com");
  expect(portal.compatibilityDate).toBe(COMPATIBILITY_DATE);
});

// `packages/cloudflare-portal/src/auth.ts` imports node:crypto's
// timingSafeEqual, and runtime.mjs leaves `node:*` external for that entry on
// the strength of this flag. Without it workerd does not degrade — the whole
// Miniflare process refuses to start (ERR_RUNTIME_FAILURE).
test("the portal worker runs with nodejs_compat", () => {
  expect(portalWorker().compatibilityFlags).toEqual(["nodejs_compat"]);
});

// Without this the worker is built and bound but nothing listens on 8795, so
// `pnpm dev portal` fails with a connection refused that looks like a port
// problem. `runtime.urls.portal` is derived from `ports` and keeps working,
// which is exactly why its absence is silent.
test("the portal worker listens on its own reserved port, and on the bundle one", () => {
  expect(portalWorker().unsafeDirectSockets).toEqual([
    { host: "127.0.0.1", port: PORTAL_PORT },
    { host: "127.0.0.1", port: PORTAL_BUNDLE_PORT },
  ]);
});

// One worker, two origins. `worker.ts` decides a request is a bundle fetch by
// comparing its origin against BUNDLE_ORIGIN, so the two ports must differ —
// were they equal, every portal request would be answered out of R2.
test("the bundle origin is a second port on the portal worker, never the portal's own", () => {
  expect(PORTAL_BUNDLE_PORT).not.toBe(PORTAL_PORT);
  expect(portalWorker().bindings.BUNDLE_ORIGIN).toBe(`http://127.0.0.1:${PORTAL_BUNDLE_PORT}`);
  expect(portalWorker().bindings.PORTAL_ORIGIN).toBe(`http://127.0.0.1:${PORTAL_PORT}`);
});

// An absent BUNDLES bucket is not a missing feature but a dead portal: the
// worker constructs its type-card bundle service on every request.
test("the portal worker binds the R2 bucket its bundle service needs", () => {
  expect(portalWorker().r2Buckets).toEqual({ BUNDLES: "unidocs-portal-bundles" });
});

// scriptPath must name the file bundleTargets actually writes. Asserting the
// literal "portal.js" on both sides would not pin their agreement; deriving
// the expectation from bundleTargets does.
test("the portal worker's scriptPath is the file bundleTargets writes", () => {
  const [component] = serviceWorkers(["portal"]);
  const target = bundleTargets([], { services: ["portal"] })
    .find(entry => entry.entry === component.entry);
  expect(target).toBeDefined();
  expect(portalWorker().scriptPath).toBe(join("/tmp/bundle", target.outfile));
});

// The fallbacks are what let the portal boot for a reader who has not
// registered a loopback redirect URI. worker.ts wraps its handler in a catch
// that answers `portal_unavailable`, so an empty client id turns every
// response into a 503 rather than a working sign-in page.
test("the portal worker boots with placeholder Google credentials", () => {
  const bindings = portalWorker().bindings;
  expect(bindings.GATEWAY_OIDC_CLIENT_ID).toBe("unidocs-portal-local");
  expect(bindings.GATEWAY_OIDC_CLIENT_SECRET).toBe("unidocs-portal-local-secret");
});

test("real Google credentials win over the placeholders", () => {
  const bindings = portalWorker({
    googleOidcClientId: "real-client-id",
    googleOidcClientSecret: "real-client-secret",
  }).bindings;
  expect(bindings.GATEWAY_OIDC_CLIENT_ID).toBe("real-client-id");
  expect(bindings.GATEWAY_OIDC_CLIENT_SECRET).toBe("real-client-secret");
});

// doc-types.mjs is dependency-free and pure by construction, so every
// environment-derived value is threaded in from runtime.mjs. PORTAL_BOOTSTRAP_EMAIL
// was the one exception; reading process.env here would make a developer's
// shell change buildWorkers' output.
test("the bootstrap email is a parameter, not an ambient environment read", () => {
  const previous = process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL;
  process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL = "ambient@example.test";
  try {
    expect(portalWorker().bindings.PORTAL_BOOTSTRAP_EMAIL).toBe("");
    expect(portalWorker({ portalBootstrapEmail: "owner@example.test" }).bindings.PORTAL_BOOTSTRAP_EMAIL)
      .toBe("owner@example.test");
  } finally {
    if (previous === undefined) delete process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL;
    else process.env.UNIDOCS_PORTAL_BOOTSTRAP_EMAIL = previous;
  }
});

test("no selected service leaves the worker list exactly as it was", () => {
  const base = buildWorkers({
    docTypes: ["psd"], host: "127.0.0.1", ports: resolvePorts(["psd"]), bundleDir: "/tmp/bundle",
    stackFixture: STACK_FIXTURE, capabilityFixture: CAPABILITY_FIXTURE,
  });
  expect(base.some(worker => worker.name === "unidocs-portal")).toBe(false);
});

// `.dev.vars` sits between the placeholder credentials and the process
// environment. Getting this order wrong does not fail loudly — it makes the
// line a reader typed into the file silently not take effect.
test("the portal's .dev.vars beats the placeholders and loses to the environment", () => {
  const fromFile = { portal: { GATEWAY_OIDC_CLIENT_ID: "from-file", GATEWAY_OIDC_CLIENT_SECRET: "secret-from-file" } };

  const withFile = portalWorker({ serviceDevVars: fromFile });
  expect(withFile.bindings.GATEWAY_OIDC_CLIENT_ID).toBe("from-file");
  expect(withFile.bindings.GATEWAY_OIDC_CLIENT_SECRET).toBe("secret-from-file");

  const withBoth = portalWorker({ serviceDevVars: fromFile, googleOidcClientId: "from-env" });
  expect(withBoth.bindings.GATEWAY_OIDC_CLIENT_ID).toBe("from-env");
  // Only the key the environment actually sets is overridden; the other one
  // still comes from the file rather than reverting to the placeholder.
  expect(withBoth.bindings.GATEWAY_OIDC_CLIENT_SECRET).toBe("secret-from-file");
});

// Copying .dev.vars.example without filling it in must leave a working portal.
// The example ships both keys present and empty, and the portal's config check
// refuses an empty client id by 503-ing every route the worker serves.
test("keys the .dev.vars names but leaves empty fall back to the placeholders", () => {
  const worker = portalWorker({ serviceDevVars: { portal: { GATEWAY_OIDC_CLIENT_ID: "", GATEWAY_OIDC_CLIENT_SECRET: "" } } });
  expect(worker.bindings.GATEWAY_OIDC_CLIENT_ID).toBe("unidocs-portal-local");
  expect(worker.bindings.GATEWAY_OIDC_CLIENT_SECRET).toBe("unidocs-portal-local-secret");
  expect(configuredOnly({ a: "", b: "x" })).toEqual({ b: "x" });
});

// The reason the file exists at all. GOOGLE_OIDC_* in the environment is read
// once and handed to the CAS admin BFF as well, so setting it there moves the
// console on :4070 off its local mock provider — a side effect nobody
// configuring the portal asked for. A .dev.vars must not do that.
test("the portal's .dev.vars leaves the CAS admin BFF on its mock provider", () => {
  const cas = () => buildWorkers({
    docTypes: [], host: "127.0.0.1",
    // BASE_PORTS carries admin/mockOidc/edge, which `resolvePorts` does not
    // produce — runtime.mjs assigns those separately.
    ports: { ...BASE_PORTS, ...resolvePorts([], BASE_PORTS, ["portal"]) },
    bundleDir: "/tmp/bundle", services: ["portal"],
    stackFixture: STACK_FIXTURE, capabilityFixture: CAPABILITY_FIXTURE,
    serviceDevVars: { portal: { GATEWAY_OIDC_CLIENT_ID: "from-file", GATEWAY_OIDC_CLIENT_SECRET: "secret-from-file" } },
  }).find(worker => worker.name === SERVICE_WORKER);

  expect(cas().bindings.OIDC_ISSUER).toBe(`http://127.0.0.1:${MOCK_OIDC_PORT}`);
  expect(cas().bindings.GOOGLE_OIDC_CLIENT_ID).toBe("unidocs-local-admin");
});

// An empty environment variable used to reach the binding through `??` and
// 503 the portal the same way. It now reads as "not configured" too.
test("an empty GOOGLE_OIDC_CLIENT_ID does not blank the placeholder", () => {
  expect(portalWorker({ googleOidcClientId: "" }).bindings.GATEWAY_OIDC_CLIENT_ID).toBe("unidocs-portal-local");
});
