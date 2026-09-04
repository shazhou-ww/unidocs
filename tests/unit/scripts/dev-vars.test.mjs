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
import { mergeDocBindings, readDevVars } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import {
  ADMIN_PORT,
  buildWorkers,
  DOC_TYPES,
  SERVICE_WORKER,
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

// 顺序反了不会报错,只会让用户在 .dev.vars 里亲手写的那一行悄悄不生效。
// 第一个撞上这条的是 PSD_FONT_FALLBACKS:它的默认值由 `pnpm dev` 传进来,
// 而它的文档位置是 .dev.vars.example —— 那里写了就必须赢。
test("mergeDocBindings lets .dev.vars beat a caller default, and the process env beat both", () => {
  expect(mergeDocBindings({
    defaults: { PSD_FONT_FALLBACKS: "Default-Regular", ONLY_DEFAULT: "d" },
    devVars: { PSD_FONT_FALLBACKS: "FromDevVars-Regular", LLM_MODEL: "from-dev-vars" },
    processEnv: { LLM_MODEL: "from-process-env" },
  })).toEqual({
    PSD_FONT_FALLBACKS: "FromDevVars-Regular",
    ONLY_DEFAULT: "d",
    LLM_MODEL: "from-process-env",
  });
  // 没人显式配时,默认值才生效 —— 否则"自动灌了字体但回退链是空的"又回来了。
  expect(mergeDocBindings({ defaults: { PSD_FONT_FALLBACKS: "Default-Regular" } }))
    .toEqual({ PSD_FONT_FALLBACKS: "Default-Regular" });
  expect(mergeDocBindings()).toEqual({});
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
  const service = workers.find((w) => w.name === SERVICE_WORKER);
  const psd = workers.find((w) => w.name === "unidocs-psd");

  expect(psd.bindings).toEqual({
    DOC_CAPABILITY_AUDIENCE: "unidocs-doc:psd",
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
    LLM_API_KEY: "test-value-not-a-secret",
  });
  expect(gateway.bindings.LLM_API_KEY).toBeUndefined();
  expect(service.bindings.LLM_API_KEY).toBeUndefined();
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
    DOC_CAPABILITY_AUDIENCE: "unidocs-doc:psd",
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
