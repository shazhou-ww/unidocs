import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { ADMIN_MCP_SCOPES, normalizeAdministratorEmail, type AdminIdentity, type AdminMcpMember } from "@unidocs/portal-service";

export const ADMIN_MCP_CONSENT_COOKIE = "__Host-unidocs_admin_mcp_consent";
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;

export type AdminMcpPendingAuthorization = {
  readonly kind: "session";
  readonly oauthRequest: AuthRequest;
} | {
  readonly kind: "consent";
  readonly oauthRequest: AuthRequest;
  readonly memberId: string;
  readonly identity: AdminIdentity;
  readonly clientName: string;
  readonly csrfToken: string;
  readonly authorizedAt: number;
};

export interface AdminMcpAuthorizationTransactions {
  readonly put: (id: string, value: AdminMcpPendingAuthorization) => Promise<void>;
  readonly take: (id: string) => Promise<AdminMcpPendingAuthorization | null>;
}

export function createAdminMcpAuthorization(options: {
  readonly publicOrigin: string;
  readonly helpers: OAuthHelpers;
  readonly transactions: AdminMcpAuthorizationTransactions;
  readonly authenticateSession: (request: Request) => Promise<{ readonly memberId: string; readonly identity: AdminIdentity }>;
  readonly findMember: (memberId: string) => Promise<AdminMcpMember | null>;
  readonly allowedEmails: readonly string[];
  readonly now?: () => number;
}) {
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || origin.protocol !== "https:") throw new TypeError("Invalid MCP authorization origin");
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const allowedEmails = options.allowedEmails.map(normalizeAdministratorEmail);

  return async function authorize(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin.origin || url.pathname !== "/oauth/admin-mcp/authorize") return failure(404, "route");
    let stage = "request";
    try {
      if (url.pathname === "/oauth/admin-mcp/authorize" && request.method === "GET") {
        stage = "authorize_request";
        const resume = url.searchParams.get("resume");
        if (resume !== null && (!opaquePattern.test(resume) || url.searchParams.size !== 1)) return failure(400, "resume_request");
        let oauthRequest = resume === null ? await options.helpers.parseAuthRequest(request) : null;
        if (oauthRequest && !validScopes(oauthRequest.scope)) return failure(400, "authorize_scope");
        let session: Awaited<ReturnType<typeof options.authenticateSession>>;
        try {
          stage = "admin_session";
          session = await options.authenticateSession(request);
        } catch {
          const transactionId = resume ?? randomToken();
          if (resume === null) await options.transactions.put(transactionId, { kind: "session", oauthRequest: oauthRequest! });
          const returnTo = `/oauth/admin-mcp/authorize?resume=${transactionId}`;
          return new Response(null, { status: 303, headers: { Location: `${origin.origin}/admin/auth/login?returnTo=${encodeURIComponent(returnTo)}` } });
        }
        if (resume !== null) {
          stage = "resume_transaction";
          const pending = await options.transactions.take(resume);
          if (!pending || pending.kind !== "session") return failure(400, stage);
          oauthRequest = pending.oauthRequest;
        }
        if (!oauthRequest) return failure(400, "authorize_request");
        stage = "member_check";
        const member = await options.findMember(session.memberId);
        if (!member || !member.active || member.issuer !== session.identity.issuer || member.subject !== session.identity.subject
          || !allowedEmails.includes(normalizeAdministratorEmail(member.email))) return failure(403, stage);
        stage = "client_lookup";
        const client = await options.helpers.lookupClient(oauthRequest.clientId);
        if (!client) return failure(400, stage);
        const consentId = randomToken();
        const csrfToken = randomToken();
        await options.transactions.put(consentId, {
          kind: "consent", oauthRequest, memberId: member.memberId,
          identity: { ...session.identity, email: normalizeAdministratorEmail(member.email) },
          clientName: client.clientName?.trim() || "MCP client", csrfToken, authorizedAt: now(),
        });
        return new Response(renderConsent(client.clientName?.trim() || "MCP client", normalizeAdministratorEmail(member.email), oauthRequest.scope, consentId, csrfToken, origin.origin), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": consentCookie(consentId, 600),
            "X-Admin-MCP-Client-Redirect": oauthRequest.redirectUri,
          },
        });
      }
      if (url.pathname === "/oauth/admin-mcp/authorize" && request.method === "POST") {
        stage = "consent_origin";
        const requestOrigin = request.headers.get("Origin");
        const sameOrigin = requestOrigin === origin.origin
          || (requestOrigin === "null" && request.headers.get("Sec-Fetch-Site") === "same-origin");
        if (!sameOrigin || request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/x-www-form-urlencoded") return failure(403, stage);
        stage = "consent_request";
        const form = new URLSearchParams(await request.text());
        if ([...new Set(form.keys())].some(key => key !== "scope" && form.getAll(key).length !== 1)) return failure(400, stage);
        const consentId = form.get("consent_id");
        const csrfToken = form.get("csrf_token");
        stage = "consent_binding";
        if (!consentId || !opaquePattern.test(consentId) || readCookie(request, ADMIN_MCP_CONSENT_COOKIE) !== consentId || !csrfToken || !opaquePattern.test(csrfToken)) return failure(400, stage);
        stage = "consent_transaction";
        const pending = await options.transactions.take(consentId);
        if (!pending || pending.kind !== "consent" || !await secureEqual(csrfToken, pending.csrfToken)) return failure(400, stage, consentCookie("", 0));
        if (form.get("decision") !== "approve") return denied(pending.oauthRequest, origin.origin);
        stage = "consent_scope";
        const scopes = form.getAll("scope");
        if (!validScopes(scopes) || scopes.some(scope => !pending.oauthRequest.scope.includes(scope)) || new Set(scopes).size !== scopes.length) return failure(400, stage, consentCookie("", 0));
        stage = "grant_write";
        const clientHandle = await sha256Hex(pending.oauthRequest.clientId);
        const { redirectTo } = await options.helpers.completeAuthorization({
          request: pending.oauthRequest,
          userId: pending.memberId,
          metadata: { clientHandle, clientName: pending.clientName },
          scope: scopes,
          props: { memberId: pending.memberId, identity: pending.identity, authorizedAt: pending.authorizedAt },
        });
        return redirect(redirectTo, consentCookie("", 0));
      }
      return failure(405, "method");
    } catch {
      return failure(400, stage);
    }
  };
}

function validScopes(scopes: readonly string[]): boolean {
  return scopes.length > 0 && scopes.every(scope => (ADMIN_MCP_SCOPES as readonly string[]).includes(scope));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  return difference === 0;
}

function readCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("Cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

function consentCookie(value: string, maxAge: number): string {
  return `${ADMIN_MCP_CONSENT_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function failure(status: number, stage: string, cookie?: string): Response {
  const headers = new Headers({ "X-Admin-MCP-Authorization-Stage": stage });
  if (cookie) headers.append("Set-Cookie", cookie);
  return Response.json({ error: "access_denied", error_description: "Admin MCP authorization request rejected" }, { status, headers });
}

function redirect(location: string, cookie: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Set-Cookie": cookie } });
}

function denied(request: AuthRequest, issuer: string): Response {
  const location = new URL(request.redirectUri);
  location.searchParams.set("error", "access_denied");
  location.searchParams.set("state", request.state);
  location.searchParams.set("iss", issuer);
  return redirect(location.href, consentCookie("", 0));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function renderConsent(clientName: string, email: string, scopes: readonly string[], consentId: string, csrfToken: string, origin: string): string {
  const scopeLabels: Record<string, string> = { "admin:read": "Read configuration and audit history", "admin:content": "Manage content candidates", "admin:publish": "Publish document type changes", "admin:security": "Manage administrators" };
  const rows = scopes.map(scope => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked><span><strong>${escapeHtml(scopeLabels[scope] ?? scope)}</strong><code>${escapeHtml(scope)}</code></span></label>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${escapeHtml(clientName)} · UniDocs</title><style>:root{font-family:Aptos,"Segoe UI",sans-serif;color:#18181b;background:#f4f4f5}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background-image:linear-gradient(#00000008 1px,transparent 1px),linear-gradient(90deg,#00000008 1px,transparent 1px);background-size:28px 28px}.panel{width:min(500px,100%);background:#fff;border:1px solid #d4d4d8;border-radius:7px;padding:24px;box-shadow:0 12px 35px #0000000d}h1{font-size:23px;margin:0 0 8px}p{color:#52525b;margin:0 0 20px}.identity{padding:12px;background:#f4f4f5;border-radius:6px;overflow-wrap:anywhere}.scopes{margin:18px 0;border-top:1px solid #e4e4e7}.scopes label{display:flex;gap:12px;padding:14px 2px;border-bottom:1px solid #e4e4e7;align-items:start}.scopes input{margin-top:4px}.scopes span,.scopes strong,.scopes code{display:block}.scopes code{margin-top:3px;color:#71717a}form>div:last-child{display:grid;grid-template-columns:1fr 1fr;gap:10px}button{min-height:40px;border:1px solid #a1a1aa;border-radius:6px;background:#fff;font:inherit;font-weight:650}.approve{background:#18181b;color:#fff;border-color:#18181b}@media(max-width:520px){.panel{padding:20px}}</style></head><body><main class="panel"><h1>Authorize ${escapeHtml(clientName)}</h1><p>Choose the access this client may use.</p><div class="identity">Signed in as <strong>${escapeHtml(email)}</strong></div><form method="post" action="${escapeHtml(origin)}/oauth/admin-mcp/authorize"><input type="hidden" name="consent_id" value="${consentId}"><input type="hidden" name="csrf_token" value="${csrfToken}"><div class="scopes">${rows}</div><div><button name="decision" value="deny">Deny</button><button class="approve" name="decision" value="approve">Approve</button></div></form></main></body></html>`;
}