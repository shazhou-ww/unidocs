/**
 * `.dev.vars` is how the local Miniflare runtime gives a doc-type worker its
 * secrets (the PSD Operator's LLM_API_KEY & friends). The parser regressed out
 * of stacks/unidocs-cloudflare/local/runtime.mjs once already, taking PSD chat with it, so pin
 * its behavior here.
 *
 * Everything below uses a throwaway temp file — never the real
 * packages/cloudflare-psd/.dev.vars, whose contents must not be read or
 * printed by tests.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readDevVars } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import {
  ADMIN_PORT,
  buildWorkers,
  DOC_TYPES,
  docServiceAccessKey,
  MIDDLEWARE_WORKER,
  MOCK_OIDC_PORT,
} from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";

const BASE_PORTS = { gateway: 8787, admin: ADMIN_PORT, mockOidc: MOCK_OIDC_PORT, edge: 8794 };

const STACK_FIXTURE = {
  stackId: "unidocs-cloudflare",
  issuer: "https://cas.example/cas/issuer/cloudflare",
  audience: "unidocs-cas-cloudflare",
  kid: "cf-rotate-1",
  privateKeyPkcs8: "pkcs8",
  jwks: { keys: [{ kid: "cf-rotate-1" }] },
  refDomains: ["doc"],
};
const CAPABILITY_FIXTURE = {
  issuer: "https://cas.example/capability",
  kid: "cap-1",
  privateKeyPkcs8: "cap-pkcs8",
  jwks: { keys: [{ kid: "cap-1" }] },
};

let dir;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "unidocs-devvars-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function parse(contents) {
  const path = join(dir, `vars-${Math.random().toString(36).slice(2)}`);
  await writeFile(path, contents, "utf8");
  return readDevVars(path);
}

test("readDevVars parses KEY=VALUE lines", async () => {
  expect(await parse("A=1\nB=two\n")).toEqual({ A: "1", B: "two" });
});

test("readDevVars ignores blank lines and # comments", async () => {
  const vars = await parse([
    "# a comment",
    "",
    "   ",
    "A=1",
    "  # indented comment",
    "B=2",
    "",
  ].join("\n"));
  expect(vars).toEqual({ A: "1", B: "2" });
});

test("readDevVars keeps '=' inside a value", async () => {
  expect(await parse("URL=https://h/x?a=b&c=d\n"))
    .toEqual({ URL: "https://h/x?a=b&c=d" });
});

test("readDevVars strips one layer of surrounding quotes", async () => {
  expect(await parse(`A="quoted"\nB='single'\nC=bare\n`))
    .toEqual({ A: "quoted", B: "single", C: "bare" });
});

test("readDevVars trims whitespace around key and value", async () => {
  expect(await parse("  A =  1  \n")).toEqual({ A: "1" });
});

test("readDevVars skips lines with no '='", async () => {
  expect(await parse("NOT_A_PAIR\nA=1\n")).toEqual({ A: "1" });
});

test("readDevVars returns {} for a missing file", async () => {
  expect(await readDevVars(join(dir, "does-not-exist"))).toEqual({});
});

test("psd declares a .dev.vars file so the Operator gets its LLM config", () => {
  expect(DOC_TYPES.psd.devVars).toBe("packages/cloudflare-psd/.dev.vars");
});

test("buildWorkers merges extraBindings into that doc type's worker only", () => {
  const workers = buildWorkers({
    docTypes: ["psd"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, psd: 8790 },
    bundleDir: "/b",
    stackFixture: STACK_FIXTURE,
    capabilityFixture: CAPABILITY_FIXTURE,
    extraBindings: { psd: { LLM_API_KEY: "test-value-not-a-secret" } },
  });
  const gateway = workers.find((w) => w.name === "unidocs-gateway");
  const middleware = workers.find((w) => w.name === MIDDLEWARE_WORKER);
  const psd = workers.find((w) => w.name === "unidocs-psd");

  expect(psd.bindings).toEqual({
    CAS_ACCESS_KEY: "unidocs-dev-cas-key",
    INTERNAL_AUTH_MODE: "stack",
    DOC_CAPABILITY_AUDIENCE: "unidocs-doc:psd",
    CAS_CAPABILITY_AUDIENCE: STACK_FIXTURE.audience,
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "300",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    CAPABILITY_ISSUER: CAPABILITY_FIXTURE.issuer,
    CAPABILITY_TRUSTED_JWKS: JSON.stringify(CAPABILITY_FIXTURE.jwks),
    CAS_STACK_ID: STACK_FIXTURE.stackId,
    CAS_STACK_ISSUER: STACK_FIXTURE.issuer,
    CAS_STACK_TRUSTED_JWKS: JSON.stringify(STACK_FIXTURE.jwks),
    SERVICE_ACCESS_KEY: docServiceAccessKey("psd"),
    LLM_API_KEY: "test-value-not-a-secret",
  });
  expect(gateway.bindings.LLM_API_KEY).toBeUndefined();
  expect(middleware.bindings.LLM_API_KEY).toBeUndefined();
});

test("buildWorkers leaves bindings untouched when no extraBindings are given", () => {
  const psd = buildWorkers({
    docTypes: ["psd"],
    host: "127.0.0.1",
    ports: { ...BASE_PORTS, psd: 8790 },
    bundleDir: "/b",
    stackFixture: STACK_FIXTURE,
    capabilityFixture: CAPABILITY_FIXTURE,
  }).find((w) => w.name === "unidocs-psd");
  expect(psd.bindings).toEqual({
    CAS_ACCESS_KEY: "unidocs-dev-cas-key",
    INTERNAL_AUTH_MODE: "stack",
    DOC_CAPABILITY_AUDIENCE: "unidocs-doc:psd",
    CAS_CAPABILITY_AUDIENCE: STACK_FIXTURE.audience,
    CAPABILITY_ALGORITHM: "ES256",
    CAPABILITY_TTL_SECONDS: "120",
    CAPABILITY_MAX_LIFETIME_SECONDS: "300",
    CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    CAPABILITY_ISSUER: CAPABILITY_FIXTURE.issuer,
    CAPABILITY_TRUSTED_JWKS: JSON.stringify(CAPABILITY_FIXTURE.jwks),
    CAS_STACK_ID: STACK_FIXTURE.stackId,
    CAS_STACK_ISSUER: STACK_FIXTURE.issuer,
    CAS_STACK_TRUSTED_JWKS: JSON.stringify(STACK_FIXTURE.jwks),
    SERVICE_ACCESS_KEY: docServiceAccessKey("psd"),
  });
});
