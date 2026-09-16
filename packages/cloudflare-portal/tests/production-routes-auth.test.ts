/**
 * T2: every route wrangler.production.jsonc gives this worker, requested
 * anonymously with the PRODUCTION vars - local vars would prove nothing about
 * production. The four MCP/OAuth route patterns are the exception: in this
 * Vitest environment they can only be asserted as a fail-closed 503, not the
 * real gate (see the comment above their SAMPLES entries below for why).
 *
 * Each route pattern must have an entry in SAMPLES, so a route added to the
 * production config without deciding how it is authenticated fails here.
 * Every sample must be refused (401/403, or a 303 to a sign-in page) unless it
 * is listed with an explicit expectation below; changing that list needs review.
 */
import { readFile } from "node:fs/promises";
import { parse, type ParseError } from "jsonc-parser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiContract } from "@unidocs/protocol-platform";
import { tenantApiContract } from "@unidocs/protocol-tenant-portal";
import worker from "../src/worker.js";
import { ADMIN_UI_ASSETS } from "../src/ui-assets.generated.js";
import { TENANT_UI_ASSETS } from "../src/tenant-ui-assets.generated.js";
import { startRealD1, type RealD1 } from "./tenant/real-d1.js";
import { contractProcedures } from "./tenant/walk-fixtures.js";

interface ProductionConfig {
  readonly routes: readonly { readonly pattern: string }[];
  readonly vars: Readonly<Record<string, string>>;
}

type Expectation =
  | { readonly kind: "gate" }
  | { readonly kind: "status"; readonly status: readonly number[]; readonly location?: RegExp; readonly bodyIsGenericError?: boolean }
  | { readonly kind: "clientError" }
  | { readonly kind: "emptyNotFound" };

interface Sample { readonly method: string; readonly url: string; readonly expect: Expectation }

const SITE = "https://unidocs.shazhou.work";
const BUNDLES = "https://bundles.shazhou.work";
const GATE: Expectation = { kind: "gate" };
const SIGN_IN_PATHS = ["/admin/login", "/admin/auth/login", "/portal/auth/login"];
const GOOGLE = /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/;
const probe = () => `__probe_${crypto.randomUUID()}`;
const get = (url: string, expectation: Expectation = GATE): Sample => ({ method: "GET", url, expect: expectation });
const post = (url: string, expectation: Expectation = GATE): Sample => ({ method: "POST", url, expect: expectation });
const ok = (status = 200): Expectation => ({ kind: "status", status: [status] });
/** See the comment above the ADMIN_MCP_PATHS routes in SAMPLES for why this exists. */
const MCP_ENV_LIMITED: Expectation = { kind: "status", status: [503], bodyIsGenericError: true };

const firstAsset = (assets: Readonly<Record<string, string>>, prefix: string) => {
  const path = Object.keys(assets).find(key => key.startsWith(prefix));
  if (!path) throw new Error(`no built asset under ${prefix}`);
  return path;
};

function contractSamples(): Sample[] {
  const values: Record<string, string> = {
    tenantId: "t-probe", documentId: "d", threadId: "th", versionIdx: "0", documentType: "markdown", documentContractIdx: "0", submissionId: "s",
  };
  return [...contractProcedures(tenantApiContract), ...contractProcedures(agentApiContract)].map(({ route }) => ({
    method: (route.method ?? "POST").toUpperCase(),
    url: SITE + (route.path ?? "").replace(/\{([^}]+)\}/g, (_match, name: string) => values[name]),
    expect: GATE,
  }));
}

/** The only place a production route is classified. */
const SAMPLES: Record<string, () => Sample[]> = {
  "unidocs.shazhou.work/admin": () => [get(`${SITE}/admin`)],
  "unidocs.shazhou.work/admin/*": () => [
    get(`${SITE}/admin/`), get(`${SITE}/admin/document-types`), get(`${SITE}/admin/administrators`), get(`${SITE}/admin/audit`),
    get(`${SITE}/admin/login`, ok()), get(`${SITE}/admin/access-denied`, ok()),
    get(SITE + firstAsset(ADMIN_UI_ASSETS, "/admin/assets/"), ok()),
    get(`${SITE}/admin/auth/login`, { kind: "status", status: [303], location: GOOGLE }),
    get(`${SITE}/admin/auth/callback`), get(`${SITE}/admin/auth/session`), post(`${SITE}/admin/auth/logout`),
    get(`${SITE}/admin/api/v1/administrators`), get(`${SITE}/admin/api/v1/tenant-members`),
    get(`${SITE}/admin/api/v1/document-types`), get(`${SITE}/admin/api/v1/audit-events`),
    get(`${SITE}/admin/${probe()}`, { kind: "emptyNotFound" }),
  ],
  // Measured, not predicted: every exact ADMIN_MCP_PATHS match below dynamically
  // imports @cloudflare/workers-oauth-provider (`./mcp/oauth.js`), which imports
  // `WorkerEntrypoint` from `cloudflare:workers` - a module workerd provides
  // that this Vitest suite's plain Node process does not ("Only URLs with a
  // scheme in: file, data, and node are supported by the default ESM loader.
  // Received protocol 'cloudflare:'"). The import throws before any binding or
  // credential is read, so worker.ts's catch-all turns it into a 503 with a
  // generic body (`{"error":{"code":"internal_error",...,"requestId":...}}`)
  // regardless of vars. MCP_ENV_LIMITED's `bodyIsGenericError` makes that a
  // standing assertion (parses as JSON, `error.code === "internal_error"`, no
  // stack-trace-shaped content) rather than a one-time manual check, so a
  // future change that turns this into a real leak fails here - the same
  // reason tests/worker.test.ts's "MCP kill switch" test asserts 503,
  // not the real auth outcome, once MCP_ENABLED is "true". This is fail-closed,
  // not a leak, but it means this suite cannot confirm the status Google or an
  // MCP client would actually see for these four route patterns in production;
  // that is covered instead by tests/mcp-dispatcher.test.ts,
  // tests/mcp-authorization.test.ts and tests/mcp-authorization-transactions.test.ts,
  // which call the handlers directly rather than through worker.fetch.
  "unidocs.shazhou.work/mcp": () => [get(`${SITE}/mcp`, MCP_ENV_LIMITED), post(`${SITE}/mcp`, MCP_ENV_LIMITED)],
  "unidocs.shazhou.work/.well-known/oauth-protected-resource/mcp": () => [get(`${SITE}/.well-known/oauth-protected-resource/mcp`, MCP_ENV_LIMITED)],
  "unidocs.shazhou.work/.well-known/oauth-authorization-server": () => [get(`${SITE}/.well-known/oauth-authorization-server`, MCP_ENV_LIMITED)],
  "unidocs.shazhou.work/oauth/admin-mcp/*": () => [
    post(`${SITE}/oauth/admin-mcp/register`, MCP_ENV_LIMITED),
    post(`${SITE}/oauth/admin-mcp/token`, MCP_ENV_LIMITED),
    post(`${SITE}/oauth/admin-mcp/revoke`, MCP_ENV_LIMITED),
    get(`${SITE}/oauth/admin-mcp/authorize`, MCP_ENV_LIMITED),
    get(`${SITE}/oauth/admin-mcp/${probe()}`, { kind: "emptyNotFound" }),
  ],
  "bundles.shazhou.work": () => [
    get(`${BUNDLES}/view-bundles/vb_${"0".repeat(64)}/unidocs-view.json`, { kind: "status", status: [404] }),
    get(`${BUNDLES}/${probe()}`, { kind: "status", status: [404] }),
  ],
  "unidocs.shazhou.work/portal": () => [get(`${SITE}/portal`, ok())],
  "unidocs.shazhou.work/portal/*": () => [
    get(`${SITE}/portal/`, ok()), get(`${SITE}/portal/index.html`, ok()), { method: "HEAD", url: `${SITE}/portal/`, expect: ok() },
    get(SITE + firstAsset(TENANT_UI_ASSETS, "/portal/assets/"), ok()),
    get(`${SITE}/portal/auth/login`, { kind: "status", status: [303], location: GOOGLE }),
    get(`${SITE}/portal/auth/callback`, { kind: "status", status: [303], location: /^https:\/\/unidocs\.shazhou\.work\/portal\/\?login=failed&requestId=/ }),
    get(`${SITE}/portal/auth/session`), post(`${SITE}/portal/auth/logout`),
    get(`${SITE}/portal/${probe()}`, { kind: "emptyNotFound" }),
  ],
  "unidocs.shazhou.work/api/v1/tenants/*": () => [
    ...contractSamples(),
    // Authentication runs before routing on this surface: an unknown path is 401, not 404.
    get(`${SITE}/api/v1/tenants/t-probe/${probe()}`),
  ],
};

let config: ProductionConfig;
let real: RealD1;
let env: Env;
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

beforeAll(async () => {
  const text = await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");
  const errors: ParseError[] = [];
  config = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as ProductionConfig;
  expect(errors, "wrangler.production.jsonc must parse").toEqual([]);
});

beforeEach(async () => {
  real = await startRealD1();
  env = {
    ...config.vars,
    DB: real.db, OAUTH_KV: real.kv, BUNDLES: real.r2,
    GATEWAY_OIDC_CLIENT_SECRET: "t2-client-secret",
    OAUTH_STATE_ENCRYPTION_KEY: "A".repeat(43),
    MARKDOWN_OPERATOR_HMAC_KEY: "",
    ADMIN_MARKDOWN_SERVICE: {},
  } as unknown as Env;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://accounts.google.com/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (/^https:\/\/([a-z0-9-]+\.)*(google|googleapis)\.com\//.test(url)) throw new Error(`T2 must not reach Google: ${url}`);
    throw new Error(`T2 must not reach the network: ${url}`);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await real.dispose();
});

function judge(sample: Sample, response: Response, body: string): string | null {
  const location = response.headers.get("location");
  switch (sample.expect.kind) {
    case "gate":
      if ([401, 403].includes(response.status)) return null;
      if (response.status === 303 && location && SIGN_IN_PATHS.includes(new URL(location, SITE).pathname)) return null;
      return `expected 401/403 or a 303 to a sign-in page, got ${response.status} ${location ?? ""}`;
    case "status": {
      if (!sample.expect.status.includes(response.status)) return `expected ${sample.expect.status.join("/")}, got ${response.status}`;
      if (sample.expect.location && !sample.expect.location.test(location ?? "")) return `unexpected Location ${location}`;
      if (sample.expect.bodyIsGenericError) {
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { return `expected a generic JSON error body, got unparseable: ${body.slice(0, 200)}`; }
        const errorCode = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
        if (errorCode !== "internal_error") return `expected error.code "internal_error", got ${JSON.stringify(errorCode)}`;
        if (/\.(ts|js|mjs|cjs):\d+:\d+/.test(body) || /\bat\s+[\w.$]+\s*\(/.test(body)) return `body looks like it carries a stack trace: ${body.slice(0, 200)}`;
      }
      return null;
    }
    case "clientError":
      return response.status >= 400 && response.status < 500 ? null : `expected a 4xx, got ${response.status}`;
    case "emptyNotFound":
      return response.status === 404 && body === "" ? null : `expected an empty 404, got ${response.status} with ${body.length} bytes`;
  }
}

describe("production routes (anonymous, production vars)", () => {
  it("classifies every production route, and only production routes", () => {
    expect(config.routes.map(route => route.pattern).sort()).toEqual(Object.keys(SAMPLES).sort());
    for (const [pattern, samples] of Object.entries(SAMPLES)) expect(samples().length, pattern).toBeGreaterThan(0);
  });

  it("refuses every sample that is not explicitly public", async () => {
    const failures: Record<string, string> = {};
    for (const pattern of config.routes.map(route => route.pattern)) {
      for (const sample of SAMPLES[pattern]?.() ?? []) {
        // No Origin, no cookie, no Authorization: an anonymous POST to
        // /admin/auth/logout with a same-origin Origin would get a cookie-clearing
        // 204 (bff.ts), which is not a leak but would make the verdict depend on headers.
        const response = await worker.fetch(new Request(sample.url, { method: sample.method }), env, context);
        const body = sample.method === "HEAD" ? "" : await response.text();
        const failure = judge(sample, response, body);
        if (failure) failures[`${sample.method} ${sample.url}`] = failure;
      }
    }
    expect(failures).toEqual({});
  });

  it("serves a tenant shell that carries no local identity or fixture data", () => {
    for (const [path, content] of Object.entries(TENANT_UI_ASSETS)) {
      for (const forbidden of ["t-local", "user-local", "dev@unidocs.local"]) {
        expect(content.includes(forbidden), `${path} contains ${forbidden}`).toBe(false);
      }
    }
  });
});
