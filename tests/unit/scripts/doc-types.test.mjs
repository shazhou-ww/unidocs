import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ADMIN_PORT,
  ADMIN_WORKER,
  buildWorkers,
  bundleTargets,
  CAS_FAULT_WORKER,
  CAS_ACCESS_KEY,
  CAS_AUDIT_READER_KEY,
  CAS_MIDDLEWARE_BUCKET,
  CAS_MIDDLEWARE_DB,
  CAS_PORT,
  CAS_WORKER,
  CONTROL_DB,
  DOC_TYPES,
  docServiceAccessKey,
  docServicesJson,
  EDGE_WORKER,
  GATEWAY_WORKER,
  MIDDLEWARE_WORKER,
  MOCK_OIDC_PORT,
  MOCK_OIDC_WORKER,
  parseDocTypes,
  resolvePorts,
} from "../../../stacks/cloudflare/local/doc-types.mjs";

/** Ports every buildWorkers call needs in these tests. */
const BASE_PORTS = { gateway: 8787, admin: ADMIN_PORT, mockOidc: MOCK_OIDC_PORT, cas: CAS_PORT };

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

test("gateway, CAS, and every doc type have unique default ports", () => {
  const ports = [
    8787,
    CAS_PORT,
    ...Object.values(DOC_TYPES).map(spec => spec.port),
  ];
  expect(new Set(ports).size).toBe(ports.length);
});

test("resolvePorts only allocates ports for the gateway and selected types", () => {
  expect(resolvePorts(["docx"])).toEqual({ gateway: 8787, docx: 8789 });
});

// Regression: psd was registered on 8790, the same port as CAS_PORT.
// `startLocalRuntime` merges `ports.cas = CAS_PORT` into the very map it
// port-checks, so the duplicate produced two concurrent `assertPortFree(8790)`
// probes — one bound the port, the other saw EADDRINUSE — and `pnpm dev psd`
// failed with "Port 8790 is already in use" on a completely free machine.
test("every doc-type port is distinct from the gateway and CAS ports", () => {
  const taken = new Map([
    [8787, "gateway"],
    [CAS_PORT, "cas"],
  ]);
  for (const [name, spec] of Object.entries(DOC_TYPES)) {
    expect(taken.has(spec.port), `${name} port ${spec.port} collides with ${taken.get(spec.port)}`)
      .toBe(false);
    taken.set(spec.port, name);
    if (spec.web) {
      expect(taken.has(spec.web.port), `${name}.web port ${spec.web.port} collides with ${taken.get(spec.web.port)}`)
        .toBe(false);
      taken.set(spec.web.port, `${name}.web`);
    }
  }
});

// The port map startLocalRuntime actually probes (doc types + gateway + cas)
// must have no duplicate values, or the concurrent probes race each other.
test("the probed port map has no duplicates for any doc-type selection", () => {
  for (const sel of [["psd"], ["markdown"], ["docx"], ["markdown", "docx", "psd"]]) {
    const ports = { ...resolvePorts(sel), cas: CAS_PORT };
    const values = Object.values(ports);
    expect(new Set(values).size, `duplicate port in ${JSON.stringify(ports)}`).toBe(values.length);
  }
});

test("resolvePorts lets a caller override individual ports", () => {
  expect(resolvePorts(["markdown"], { gateway: 18787, markdown: 18788 }))
    .toEqual({ gateway: 18787, markdown: 18788 });
});

test("bundleTargets builds the gateway, cas, admin, mock-oidc, plus only the selected types", () => {
  expect(bundleTargets(["docx"]).map((t) => t.outfile))
    .toEqual(["gateway.js", "cas.js", "cas-admin.js", "mock-oidc.js", "docx.js"]);
});

test("bundleTargets casMiddlewareOnly skips gateway and doc types", () => {
  expect(bundleTargets(["docx"], { casMiddlewareOnly: true }).map((t) => t.outfile))
    .toEqual(["cas.js", "cas-admin.js", "mock-oidc.js"]);
});

test("buildWorkers always includes the gateway, cas, admin BFF, and mock OIDC", () => {
  const workers = buildWorkers({
    docTypes: [],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS },
    bundleDir: "/b",
  });
  expect(workers.map((w) => w.name)).toEqual([
    GATEWAY_WORKER,
    CAS_WORKER,
    ADMIN_WORKER,
    MOCK_OIDC_WORKER,
  ]);
});

test("casMiddlewareOnly starts the middleware without the gateway", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, docx: 8789 },
    bundleDir: "/b",
    casMiddlewareOnly: true,
  });
  expect(workers.map((w) => w.name)).toEqual([CAS_WORKER, ADMIN_WORKER, MOCK_OIDC_WORKER]);
});

test("buildWorkers omits doc types that were not selected", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, docx: 8789 },
    bundleDir: "/b",
  });
  expect(workers.map((w) => w.name)).toEqual([
    GATEWAY_WORKER,
    CAS_WORKER,
    ADMIN_WORKER,
    MOCK_OIDC_WORKER,
    "unidocs-docx",
  ]);
});

test("buildWorkers binds each selected type's own DO classes and socket", () => {
  const docx = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, docx: 8789 },
    bundleDir: "/b",
  }).find((w) => w.name === "unidocs-docx");
  expect(docx.durableObjects).toEqual({
    DOCX_EDITOR: { className: "DocxEditor", useSQLite: true },
    DOCX_OPERATOR: { className: "DocxOperator", useSQLite: true },
  });
  expect(docx.unsafeDirectSockets).toEqual([{ host: "127.0.0.1", port: 8789 }]);
  expect(docx.scriptPath).toBe(join("/b", "docx.js"));
  expect(docx.serviceBindings).toEqual({ CAS_SERVICE: "unidocs-cas" });
});

test("gateway proxies CAS via service binding and cas worker owns the stores", () => {
  const [gateway, cas] = buildWorkers({
    docTypes: [],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS },
    bundleDir: "/b",
  });
  expect(gateway.serviceBindings).toEqual({ CAS_SERVICE: "unidocs-cas" });
  expect(gateway.durableObjects).toBeUndefined();
  expect(cas.durableObjects).toEqual({
    CAS_DO: { className: "CasDurableObject" },
  });
  expect(cas.d1Databases).toEqual({ CAS_DB: "unidocs-cas-db" });
  expect(cas.r2Buckets).toEqual({ CAS_R2: "unidocs-cas" });
});

test("docServicesJson contains only selected types with their own keys", () => {
  expect(JSON.parse(docServicesJson(["docx"], "h", {
    gateway: 8787,
    docx: 8789,
  }))).toEqual({
    docx: {
      serviceId: "docx",
      url: "http://h:8789",
      accessKey: docServiceAccessKey("docx"),
      audience: "unidocs-doc:docx",
    },
  });
});

test("buildWorkers separates Gateway, Doc, and CAS credentials", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, docx: 8789 },
    bundleDir: "/b",
  });
  const gateway = workers.find((w) => w.name === GATEWAY_WORKER);
  const cas = workers.find((w) => w.name === CAS_WORKER);
  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(gateway.bindings.CAS_ACCESS_KEY).toBe(CAS_ACCESS_KEY);
  expect(gateway.bindings.INTERNAL_AUTH_MODE).toBe("legacy");
  expect(cas.bindings).toEqual({
    INTERNAL_AUTH_MODE: "legacy",
    CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "300",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    CAS_ACCESS_KEY,
  });
  expect(docx.bindings).toEqual({
    CAS_ACCESS_KEY,
    INTERNAL_AUTH_MODE: "legacy",
    DOC_CAPABILITY_AUDIENCE: "unidocs-doc:docx",
    CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "300",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    SERVICE_ACCESS_KEY: docServiceAccessKey("docx"),
  });
  expect(docx.bindings.SERVICE_ACCESS_KEY).not.toBe(CAS_ACCESS_KEY);
});

test("capability local workers require a fixture", () => {
  expect(() => buildWorkers({
    docTypes: ["markdown"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, markdown: 8788 },
    bundleDir: "/b",
    internalAuthMode: "capability",
  })).toThrow(/capabilityFixture/);
});

test("casFault 为 true 时,doc-type worker 指向假 CAS,gateway 仍指向真 CAS", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, docx: 8789 },
    bundleDir: "/tmp/bundles",
    casFault: true,
  });

  const names = workers.map((w) => w.name);
  expect(names).toContain(CAS_FAULT_WORKER);
  expect(names).toContain(CAS_WORKER);

  const gateway = workers.find((w) => w.name === GATEWAY_WORKER);
  expect(gateway.serviceBindings.CAS_SERVICE).toBe(CAS_WORKER);

  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(docx.serviceBindings.CAS_SERVICE).toBe(CAS_FAULT_WORKER);

  const fault = workers.find((w) => w.name === CAS_FAULT_WORKER);
  expect(fault.serviceBindings.CAS_UPSTREAM).toBe(CAS_WORKER);
  expect(fault.script).toContain("/_internal/root-refs");
});

test("casFault 默认关闭时,不产生假 CAS worker", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, docx: 8789 },
    bundleDir: "/tmp/bundles",
  });

  expect(workers.map((w) => w.name)).not.toContain(CAS_FAULT_WORKER);
  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(docx.serviceBindings.CAS_SERVICE).toBe(CAS_WORKER);
});

test("casMiddleware 接线:edge 是唯一公网入口,tenant/admin 私有绑定,admin 持有审计读取绑定", () => {
  const workers = buildWorkers({
    docTypes: [],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, edge: 8794 },
    bundleDir: "/tmp/bundles",
    casMiddleware: true,
  });
  const names = workers.map((w) => w.name);
  expect(names).toContain(MIDDLEWARE_WORKER);
  expect(names).toContain(EDGE_WORKER);

  const edge = workers.find((w) => w.name === EDGE_WORKER);
  expect(edge.serviceBindings.CAS_TENANT_SERVICE).toBe(MIDDLEWARE_WORKER);
  expect(edge.serviceBindings.CAS_ADMIN_SERVICE).toBe(ADMIN_WORKER);
  expect(edge.unsafeDirectSockets[0].port).toBe(8794);

  const middleware = workers.find((w) => w.name === MIDDLEWARE_WORKER);
  expect(middleware.bindings.CAS_AUDIT_READER_KEY).toBe(CAS_AUDIT_READER_KEY);
  expect(middleware.d1Databases.CAS_CONTROL_DB).toBe(CONTROL_DB);
  expect(middleware.d1Databases.CAS_DB).toBe(CAS_MIDDLEWARE_DB);
  expect(middleware.r2Buckets.CAS_R2).toBe(CAS_MIDDLEWARE_BUCKET);
  expect(middleware.durableObjects.CAS_DO.className).toBe("CasDurableObject");
  expect(middleware.durableObjects.CAS_DOMAIN_DO.className).toBe("RootRefDomainDurableObject");
  expect(middleware.unsafeDirectSockets).toBeUndefined(); // private; behind cas-edge

  const admin = workers.find((w) => w.name === ADMIN_WORKER);
  expect(admin.serviceBindings.CAS_TENANT_AUDIT_READER).toBe(MIDDLEWARE_WORKER);
});

test("casMiddleware 默认关闭时,不产生中间件与 edge worker", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, docx: 8789 },
    bundleDir: "/tmp/bundles",
  });
  expect(workers.map((w) => w.name)).not.toContain(MIDDLEWARE_WORKER);
  expect(workers.map((w) => w.name)).not.toContain(EDGE_WORKER);
});
