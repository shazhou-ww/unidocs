import { expect, test, vi } from "vitest";
import type { AuthRequest, CompleteAuthorizationOptions, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { ADMIN_MCP_CONSENT_COOKIE, createAdminMcpAuthorization, type AdminMcpPendingAuthorization } from "../src/mcp/authorization.js";

const origin = "https://portal.example";
const oauthRequest: AuthRequest = {
  responseType: "code", clientId: "copilot-client", redirectUri: "https://vscode.dev/oauth/callback",
  scope: ["admin:read", "admin:content"], state: "client-state", codeChallenge: "challenge",
  codeChallengeMethod: "S256", resource: `${origin}/mcp`, issuer: origin,
};
const identity = { issuer: "https://accounts.google.com", subject: "google-subject", email: "admin@example.com", authenticatedAt: 1_800_000_000 };

function fixture(options: { member?: boolean; allowedEmails?: string[] } = {}) {
  const values = new Map<string, AdminMcpPendingAuthorization>();
  const loggedIn = { value: false };
  const completeAuthorization = vi.fn(async (_input: CompleteAuthorizationOptions) => ({ redirectTo: "https://vscode.dev/oauth/callback?code=portal-code" }));
  const helpers = {
    parseAuthRequest: vi.fn(async () => oauthRequest),
    lookupClient: vi.fn(async () => ({ clientId: oauthRequest.clientId, clientName: "GitHub Copilot", redirectUris: [oauthRequest.redirectUri], tokenEndpointAuthMethod: "none" })),
    completeAuthorization,
  } as unknown as OAuthHelpers;
  const authorize = createAdminMcpAuthorization({
    publicOrigin: origin, helpers,
    transactions: {
      put: async (id, value) => { values.set(id, value); },
      take: async id => { const value = values.get(id) ?? null; values.delete(id); return value; },
    },
    authenticateSession: async () => {
      if (!loggedIn.value) throw new Error("No Admin session");
      return { memberId: "member-1", identity };
    },
    findMember: async () => options.member === false ? null : ({ memberId: "member-1", ...identity, active: true }),
    allowedEmails: options.allowedEmails ?? [identity.email], now: () => 1_800_000_010,
  });
  return { authorize, values, helpers, loggedIn, completeAuthorization };
}

async function begin(current: ReturnType<typeof fixture>) {
  const response = await current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize?client_id=copilot-client`));
  const location = new URL(response.headers.get("Location")!);
  const returnTo = new URLSearchParams(location.search).get("returnTo")!;
  return { response, transaction: new URL(returnTo, origin).searchParams.get("resume")! };
}

async function resume(current: ReturnType<typeof fixture>, transaction: string) {
  current.loggedIn.value = true;
  return current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize?resume=${transaction}`, { headers: { Cookie: "__Host-unidocs_admin=session" } }));
}

function hidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!match) throw new Error(`Missing ${name}`);
  return match[1];
}

test("uses the existing Admin login, resumes consent and completes a downgraded grant", async () => {
  const current = fixture();
  const started = await begin(current);
  expect(started.response.status).toBe(303);
  expect(new URL(started.response.headers.get("Location")!).pathname).toBe("/admin/auth/login");
  expect(current.helpers.parseAuthRequest).toHaveBeenCalledOnce();
  expect([...current.values.values()][0]).toEqual({ kind: "session", oauthRequest });

  const consent = await resume(current, started.transaction);
  expect(consent.status).toBe(200);
  expect(consent.headers.get("Content-Type")).toContain("text/html");
  expect(consent.headers.get("X-Admin-MCP-Client-Redirect")).toBe(oauthRequest.redirectUri);
  expect(consent.headers.getSetCookie()).toHaveLength(1);
  const html = await consent.text();
  expect(html).toContain("GitHub Copilot");
  expect(html).toContain("admin:content");
  const consentId = hidden(html, "consent_id");
  const csrfToken = hidden(html, "csrf_token");
  const cookie = consent.headers.getSetCookie().find(value => value.startsWith(`${ADMIN_MCP_CONSENT_COOKIE}=`))!.split(";", 1)[0];
  const approved = await current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ consent_id: consentId, csrf_token: csrfToken, decision: "approve", scope: "admin:read" }),
  }));
  expect(approved.status).toBe(302);
  expect(approved.headers.get("Location")).toBe("https://vscode.dev/oauth/callback?code=portal-code");
  expect(current.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
    userId: "member-1", scope: ["admin:read"],
    props: { memberId: "member-1", identity, authorizedAt: 1_800_000_010 },
    metadata: { clientHandle: expect.stringMatching(/^[a-f0-9]{64}$/), clientName: "GitHub Copilot" },
  }));
});

test("rejects removed members and a fail-closed empty canary allowlist", async () => {
  for (const current of [fixture({ member: false }), fixture({ allowedEmails: [] })]) {
    const started = await begin(current);
    expect((await resume(current, started.transaction)).status).toBe(403);
    expect(current.completeAuthorization).not.toHaveBeenCalled();
  }
});

test("consumes invalid CSRF attempts and rejects replay or scope escalation", async () => {
  for (const body of [
    { csrf: "x".repeat(43), scopes: ["admin:read"] },
    { csrf: null, scopes: ["admin:security"] },
  ]) {
    const current = fixture();
    const started = await begin(current);
    const consent = await resume(current, started.transaction);
    const html = await consent.text();
    const consentId = hidden(html, "consent_id");
    const csrfToken = hidden(html, "csrf_token");
    const cookie = consent.headers.getSetCookie().find(value => value.startsWith(`${ADMIN_MCP_CONSENT_COOKIE}=`))!.split(";", 1)[0];
    const submit = (csrf: string) => current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize`, {
      method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([...[ ["consent_id", consentId], ["csrf_token", csrf], ["decision", "approve"] ], ...body.scopes.map(scope => ["scope", scope])] as string[][]),
    }));
    const rejected = await submit(body.csrf ?? csrfToken);
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("X-Admin-MCP-Authorization-Stage")).toBe(body.csrf ? "consent_transaction" : "consent_scope");
    expect((await submit(csrfToken)).status).toBe(400);
    expect(current.completeAuthorization).not.toHaveBeenCalled();
  }
});

test("denial returns a standard client redirect without issuing a grant", async () => {
  const current = fixture();
  const started = await begin(current);
  const consent = await resume(current, started.transaction);
  const html = await consent.text();
  const consentId = hidden(html, "consent_id");
  const csrfToken = hidden(html, "csrf_token");
  const cookie = consent.headers.getSetCookie().find(value => value.startsWith(`${ADMIN_MCP_CONSENT_COOKIE}=`))!.split(";", 1)[0];
  const denied = await current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ consent_id: consentId, csrf_token: csrfToken, decision: "deny" }),
  }));
  expect(new URL(denied.headers.get("Location")!).searchParams).toMatchObject(new URLSearchParams({ error: "access_denied", state: "client-state", iss: origin }));
  expect(current.completeAuthorization).not.toHaveBeenCalled();
});

test("an existing Admin session proceeds directly to consent", async () => {
  const current = fixture();
  current.loggedIn.value = true;
  const response = await current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize?client_id=copilot-client`, { headers: { Cookie: "__Host-unidocs_admin=session" } }));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("GitHub Copilot");
  expect(current.values.size).toBe(1);
});

test("an unauthenticated resume redirects to login without consuming its transaction", async () => {
  const current = fixture();
  const started = await begin(current);
  expect((await current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize?resume=${started.transaction}`))).status).toBe(303);
  expect(current.values.get(started.transaction)).toEqual({ kind: "session", oauthRequest });
  expect((await resume(current, started.transaction)).status).toBe(200);
});

test("accepts null Origin only with same-origin Fetch Metadata", async () => {
  for (const fetchSite of ["same-origin", "cross-site"]) {
    const current = fixture();
    current.loggedIn.value = true;
    const consent = await current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize?client_id=copilot-client`, { headers: { Cookie: "__Host-unidocs_admin=session" } }));
    const html = await consent.text();
    const consentId = hidden(html, "consent_id");
    const csrfToken = hidden(html, "csrf_token");
    const cookie = consent.headers.getSetCookie().find(value => value.startsWith(`${ADMIN_MCP_CONSENT_COOKIE}=`))!.split(";", 1)[0];
    const response = await current.authorize(new Request(`${origin}/oauth/admin-mcp/authorize`, {
      method: "POST", headers: { Origin: "null", "Sec-Fetch-Site": fetchSite, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent_id: consentId, csrf_token: csrfToken, decision: "approve", scope: "admin:read" }),
    }));
    expect(response.status).toBe(fetchSite === "same-origin" ? 302 : 403);
  }
});