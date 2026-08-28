import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ADMIN_PORT,
  ADMIN_WORKER,
  buildWorkers,
  bundleTargets,
  CAS_FAULT_WORKER,
  CAS_AUDIT_READER_KEY,
  CAS_MIDDLEWARE_BUCKET,
  CAS_MIDDLEWARE_DB,
  CONTROL_DB,
  DOC_TYPES,
  docServicesJson,
  EDGE_WORKER,
  GATEWAY_WORKER,
  MIDDLEWARE_WORKER,
  MOCK_OIDC_PORT,
  MOCK_OIDC_WORKER,
  REMOTE_CAS_PROXY_WORKER,
  parseDocTypes,
  resolvePorts,
} from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";

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

test("every doc-type port is distinct from the gateway port", () => {
  const taken = new Map([[8787, "gateway"]]);
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

test("bundleTargets builds the middleware, edge, gateway, admin, mock-oidc, plus only the selected types", () => {
  expect(bundleTargets(["docx"]).map((t) => t.outfile))
    .toEqual(["cas-middleware.js", "cas-edge.js", "gateway.js", "cas-admin.js", "mock-oidc.js", "docx.js"]);
});

test("bundleTargets casMiddlewareOnly skips gateway and doc types", () => {
  expect(bundleTargets(["docx"], { casMiddlewareOnly: true }).map((t) => t.outfile))
    .toEqual(["cas-middleware.js", "cas-edge.js", "cas-admin.js", "mock-oidc.js"]);
});

test("buildWorkers always includes the gateway, middleware, edge, admin BFF, and mock OIDC", () => {
  const workers = buildWorkers(stackArgs());
  expect(workers.map((w) => w.name)).toEqual([
    GATEWAY_WORKER,
    MIDDLEWARE_WORKER,
    EDGE_WORKER,
    ADMIN_WORKER,
    MOCK_OIDC_WORKER,
  ]);
});

test("casMiddlewareOnly starts the middleware without the gateway", () => {
  const workers = buildWorkers(stackArgs({ casMiddlewareOnly: true }));
  expect(workers.map((w) => w.name)).toEqual([
    MIDDLEWARE_WORKER,
    EDGE_WORKER,
    ADMIN_WORKER,
    MOCK_OIDC_WORKER,
  ]);
});

test("buildWorkers omits doc types that were not selected", () => {
  const workers = buildWorkers(stackArgs({ docTypes: ["docx"], ports: { docx: 8789 } }));
  expect(workers.map((w) => w.name)).toEqual([
    GATEWAY_WORKER,
    MIDDLEWARE_WORKER,
    EDGE_WORKER,
    ADMIN_WORKER,
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
  expect(docx.serviceBindings).toEqual({ CAS_SERVICE: MIDDLEWARE_WORKER });
});

test("gateway proxies CAS to the middleware and the middleware owns the stores", () => {
  const [gateway, middleware] = buildWorkers(stackArgs());
  expect(gateway.serviceBindings).toEqual({ CAS_SERVICE: MIDDLEWARE_WORKER });
  expect(gateway.durableObjects).toBeUndefined();
  expect(middleware.durableObjects).toEqual({
    CAS_DO: { className: "CasDurableObject" },
    CAS_DOMAIN_DO: { className: "RootRefDomainDurableObject" },
  });
  expect(middleware.d1Databases).toEqual({ CAS_CONTROL_DB: CONTROL_DB, CAS_DB: CAS_MIDDLEWARE_DB });
  expect(middleware.r2Buckets).toEqual({ CAS_R2: CAS_MIDDLEWARE_BUCKET });
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
  expect(names).toContain(MIDDLEWARE_WORKER);

  const gateway = workers.find((w) => w.name === GATEWAY_WORKER);
  expect(gateway.serviceBindings.CAS_SERVICE).toBe(MIDDLEWARE_WORKER);

  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(docx.serviceBindings.CAS_SERVICE).toBe(CAS_FAULT_WORKER);

  const fault = workers.find((w) => w.name === CAS_FAULT_WORKER);
  expect(fault.serviceBindings.CAS_UPSTREAM).toBe(MIDDLEWARE_WORKER);
  expect(fault.script).toContain("root-refs");
});

test("casFault 默认关闭时,不产生假 CAS worker", () => {
  const workers = buildWorkers(stackArgs({ docTypes: ["docx"], ports: { docx: 8789 } }));
  expect(workers.map((w) => w.name)).not.toContain(CAS_FAULT_WORKER);
  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(docx.serviceBindings.CAS_SERVICE).toBe(MIDDLEWARE_WORKER);
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

test("接线:edge 是唯一公网入口,tenant/admin 私有绑定,admin 持有审计读取绑定", () => {
  const workers = buildWorkers(stackArgs());
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
