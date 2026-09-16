/**
 * T1: every tenant and Agent API procedure, through worker.fetch, so the
 * requests pass the real gate in serveTenant rather than a handler called
 * directly. The procedure set comes from the contracts: a procedure added to
 * either contract fails the completeness check until it has a fixture here.
 *
 * Checks 1, 3, 4 and 5 are decided in serveTenant before any routing; per
 * procedure they prove that the path reaches serveTenant at all. Check 2 (a
 * session of another tenant) is the one that depends on each handler calling
 * requireTenantScope, and the only one that catches a new handler forgetting
 * it. The control group proves each refusal above is the gate, not an invalid
 * fixture: with seeded data no fixture may answer 400/401/403/404.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentApiContract } from "@unidocs/protocol-platform";
import { tenantApiContract } from "@unidocs/protocol-tenant-portal";
import worker from "../../src/worker.js";
import { D1TenantSessionStore, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE } from "../../src/tenant/session.js";
import { insertMember } from "./members.js";
import { startRealD1, type RealD1 } from "./real-d1.js";
import { contractProcedures, seedDocumentWithVersion } from "./walk-fixtures.js";

const ORIGIN = "http://127.0.0.1:19195";
const AGENT_TOKEN = "agent-walk-token-0123456789";
const message = (text: string) => ({ text, richContent: null, attachments: [] });

interface Fixture { readonly body?: unknown; readonly headers?: Record<string, string> }

/** One valid request per procedure, keyed by dotted contract path. */
const TENANT_FIXTURES: Record<string, Fixture> = {
  "documentTypes.list": {},
  "documentTypes.getDocumentContract": {},
  "documents.list": {},
  "documents.create": { body: { documentType: "markdown", name: "Walk" }, headers: { "idempotency-key": "walk-doc" } },
  "documents.get": {},
  "documents.moveCurrentVersion": { body: { observedCurrentVersionIdx: 0, targetVersionIdx: 0, reason: "walk" } },
  "documents.listAudit": {},
  "versions.list": {},
  "versions.get": {},
  "versions.getSnapshot": {},
  "threads.list": {},
  "threads.create": { body: { baseVersionIdx: 0, content: message("walk thread"), location: null }, headers: { "idempotency-key": "walk-thread" } },
  "threads.get": {},
  "threads.appendComment": { body: { baseVersionIdx: 0, content: message("walk comment"), location: null }, headers: { "idempotency-key": "walk-comment" } },
  "cas.issueCapability": { body: {} },
};

/** Object order matters: the control group creates the receipt that `get` then reads. */
const AGENT_FIXTURES: Record<string, Fixture> = {
  "submissions.create": {
    body: {
      submissionId: "walk-sub",
      threadUpdates: [{ threadId: "th-walk", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 0, content: message("walk reply"), resultLocations: [] }],
    },
  },
  "submissions.get": {},
};

const PARAMS: Record<string, string> = {
  tenantId: "t-local", documentId: "doc-walk", threadId: "th-walk", versionIdx: "0",
  documentType: "markdown", documentContractIdx: "0", submissionId: "walk-sub",
};

let real: RealD1;
let env: Env;
const cookies: Record<"member" | "otherTenant" | "removed", { session: string; csrf: string }> = {} as never;

beforeEach(async () => {
  real = await startRealD1();
  const now = Math.floor(Date.now() / 1000);
  await seedDocumentWithVersion(real.db, "doc-walk");
  await real.db.prepare("INSERT INTO portal_threads (tenant_id, document_id, thread_id, created_at) VALUES ('t-local', 'doc-walk', 'th-walk', 0)").run();
  await real.db.prepare(`INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
    VALUES ('t-local', 'doc-walk', 'th-walk', 0, 0, '{"text":"seed","richContent":null,"attachments":[]}', NULL, 'user:walker', 0)`).run();

  const store = new D1TenantSessionStore(real.db);
  const issue = async (tenantId: string, principalId: string, active: boolean) => {
    await insertMember(real.db, { tenantId, principalId, active });
    const { token, csrfToken } = await store.issue(tenantId, principalId, now);
    return { session: token, csrf: csrfToken };
  };
  cookies.member = await issue("t-local", "user:walker", true);
  cookies.otherTenant = await issue("t-other", "user:other", true);
  cookies.removed = await issue("t-local", "user:removed", false);

  env = {
    DB: real.db, BUNDLES: {}, ADMIN_MARKDOWN_SERVICE: {}, MARKDOWN_OPERATOR_HMAC_KEY: "",
    PORTAL_ORIGIN: ORIGIN, BUNDLE_ORIGIN: "http://127.0.0.1:19196",
    GATEWAY_OIDC_ISSUER: "https://accounts.google.com", GATEWAY_OIDC_CLIENT_ID: "", GATEWAY_OIDC_CLIENT_SECRET: "",
    PORTAL_BOOTSTRAP_EMAIL: "", PORTAL_TENANT_DEV_SESSION: "",
    MCP_ENABLED: "false", MCP_PUBLIC_ORIGIN: ORIGIN, MCP_ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
    MCP_CONTENT_MUTATIONS_ENABLED: "false", MCP_PUBLISH_MUTATIONS_ENABLED: "false", MCP_SECURITY_MUTATIONS_ENABLED: "false",
    OAUTH_STATE_ENCRYPTION_KEY: "unused", OAUTH_KV: {},
    CAS_ORIGIN: "", CAS_STACK_ID: "", CAS_ISSUER: "", CAS_AUDIENCE: "", CAS_REF_DOMAIN: "", CAS_SIGNING_KID: "", CAS_SIGNING_KEY: "",
    AGENT_API_TOKEN: AGENT_TOKEN, AGENT_TENANT_ID: "t-local",
  } as unknown as Env;
});

afterEach(async () => { await real.dispose(); });

function pathFor(name: string, template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_match, param: string) => {
    const value = PARAMS[param];
    if (value === undefined) throw new Error(`${name}: no walk value for path parameter {${param}}`);
    return encodeURIComponent(value);
  });
}

type Caller =
  | { readonly kind: "anonymous" }
  | { readonly kind: "session"; readonly who: keyof typeof cookies; readonly csrf: boolean; readonly site?: string }
  | { readonly kind: "bearer" };

let sequence = 0;
async function send(name: string, route: { method?: string; path?: string }, fixture: Fixture, caller: Caller): Promise<number> {
  const method = (route.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = {};
  for (const [header, value] of Object.entries(fixture.headers ?? {})) {
    headers[header] = header === "idempotency-key" ? `${value}-${sequence += 1}` : value;
  }
  if (fixture.body !== undefined) headers["content-type"] = "application/json";
  if (caller.kind === "bearer") headers.authorization = `Bearer ${AGENT_TOKEN}`;
  if (caller.kind === "session") {
    const pair = cookies[caller.who];
    headers.cookie = `${TENANT_SESSION_COOKIE}=${pair.session}; ${TENANT_CSRF_COOKIE}=${pair.csrf}`;
    if (method !== "GET") headers.origin = ORIGIN;
    if (caller.csrf && method !== "GET") headers["x-csrf-token"] = pair.csrf;
    if (caller.site) headers["sec-fetch-site"] = caller.site;
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${pathFor(name, route.path ?? "")}`, {
    method, headers, body: fixture.body === undefined ? undefined : JSON.stringify(fixture.body),
  }), env);
  await response.body?.cancel();
  return response.status;
}

const tenantProcedures = () => contractProcedures(tenantApiContract);
const agentProcedures = () => contractProcedures(agentApiContract);

it("covers every procedure of both contracts, and nothing else", () => {
  expect(tenantProcedures().length).toBeGreaterThan(0);
  expect(agentProcedures().length).toBeGreaterThan(0);
  expect(tenantProcedures().map(({ name }) => name).sort()).toEqual(Object.keys(TENANT_FIXTURES).sort());
  expect(agentProcedures().map(({ name }) => name).sort()).toEqual(Object.keys(AGENT_FIXTURES).sort());
});

it("gates every tenant API procedure in serveTenant", async () => {
  const outcomes: Record<string, Record<string, number>> = {};
  const expected: Record<string, Record<string, number>> = {};
  for (const { name, route } of tenantProcedures()) {
    const fixture = TENANT_FIXTURES[name];
    const write = (route.method ?? "POST").toUpperCase() !== "GET";
    outcomes[name] = {
      anonymous: await send(name, route, fixture, { kind: "anonymous" }),
      otherTenant: await send(name, route, fixture, { kind: "session", who: "otherTenant", csrf: true }),
      removedMember: await send(name, route, fixture, { kind: "session", who: "removed", csrf: true }),
      crossSite: await send(name, route, fixture, { kind: "session", who: "member", csrf: true, site: "cross-site" }),
      ...(write ? { missingCsrf: await send(name, route, fixture, { kind: "session", who: "member", csrf: false }) } : {}),
    };
    expected[name] = { anonymous: 401, otherTenant: 403, removedMember: 401, crossSite: 403, ...(write ? { missingCsrf: 403 } : {}) };
  }
  expect(outcomes).toEqual(expected);
});

it("gates every Agent API procedure: bearer only", async () => {
  const outcomes: Record<string, Record<string, number>> = {};
  for (const { name, route } of agentProcedures()) {
    outcomes[name] = {
      anonymous: await send(name, route, AGENT_FIXTURES[name], { kind: "anonymous" }),
      memberSession: await send(name, route, AGENT_FIXTURES[name], { kind: "session", who: "member", csrf: true }),
    };
  }
  expect(outcomes).toEqual(Object.fromEntries(agentProcedures().map(({ name }) => [name, { anonymous: 401, memberSession: 403 }])));
});

it("control group: every fixture reaches its handler for a legitimate caller", async () => {
  const refused = [400, 401, 403, 404];
  const outcomes: Record<string, number> = {};
  for (const { name, route } of tenantProcedures()) {
    outcomes[name] = await send(name, route, TENANT_FIXTURES[name], { kind: "session", who: "member", csrf: true });
  }
  for (const { name, route } of agentProcedures()) {
    outcomes[`agent:${name}`] = await send(name, route, AGENT_FIXTURES[name], { kind: "bearer" });
  }
  const rejected = Object.fromEntries(Object.entries(outcomes).filter(([, status]) => refused.includes(status)));
  expect(rejected).toEqual({});
});
