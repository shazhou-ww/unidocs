/**
 * `/admin` BFF dispatcher (testable, no Worker globals).
 *
 * Owns: Google OIDC login/callback/logout, encrypted session cookies, CSRF
 * and origin checks, the frozen control-plane API routes, the invitation
 * accept page redirect, the possession-challenge helper route, and SPA shell
 * serving. All CAS_CONTROL_DB access goes through `cas-control-plane`.
 */

import type { D1Database } from "@cloudflare/workers-types";
import {
  CasAdminErrorCodes,
  casAdminErrorHttpStatus,
  formatCasAdminETag,
  matchCasAdminRoute,
} from "@unicas/protocol-admin";
import type {
  CasAdminErrorResponse,
  CasAdminRoute,
} from "@unicas/protocol-admin";
import {
  ControlPlaneService,
  ControlSessionStore,
} from "@unicas/control-plane";
import type { ControlPlaneCallContext } from "@unicas/control-plane";
import type { AdminBffConfig } from "./config.js";
import {
  generateOidcNonce,
  generateOidcState,
  generatePkceVerifier,
  OidcClient,
  s256Challenge,
} from "./oidc.js";
import type { VerifiedOidcIdentity } from "./oidc.js";
import {
  clearSessionCookie,
  generateCsrfToken,
  generateSessionId,
  parseCookies,
  SessionCrypto,
  sessionCookieHeader,
} from "./session.js";
import type { AdminSessionPayload } from "./session.js";
import { checkCsrfToken, checkSameOrigin } from "./csrf.js";

export interface CreateAdminBffOptions {
  readonly config: AdminBffConfig;
  /** CAS_CONTROL_DB binding. */
  readonly db: D1Database;
  /** Inject a client for tests; defaults to a real Google client. */
  readonly oidc?: OidcClient;
  /** SPA static asset fetcher (Phase C wires the built console). */
  readonly assets?: (pathname: string) => Promise<Response | null>;
  /**
   * Private tenant audit-reader RPC fetcher (CAS_TENANT_AUDIT_READER service
   * binding). When absent, Root Ref audit routes report not available.
   */
  readonly auditReader?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

const NOT_AVAILABLE_MESSAGE = "Root Ref audit reads are not yet available from the admin plane";
const TEST_ACCOUNT_ISSUER = "urn:unicas:admin:test-account";

/** Read-side refDomain validation; reserved migration domains are readable. */
function validateAuditRefDomain(value: string): string | null {
  if (value.length === 0) return "refDomain must not be empty";
  if (value.length > 64) return "refDomain is too long";
  if (!/^[a-z0-9_][a-z0-9_:.-]*$/.test(value)) return "refDomain is malformed";
  return null;
}

export function createAdminBff(options: CreateAdminBffOptions): (request: Request) => Promise<Response> {
  const { config } = options;
  const now = config.now ?? (() => Date.now());
  const service = new ControlPlaneService(options.db, { now });
  const sessionStore = new ControlSessionStore(options.db, now);
  const sessionCrypto = new SessionCrypto(config.sessionEncryptionKeys);
  const oidc = options.oidc
    ?? new OidcClient({
      issuer: config.oidcIssuer ?? "https://accounts.google.com",
      discoveryUrl: config.oidcDiscoveryUrl,
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: `${config.publicOrigin}/admin/auth/callback`,
    });
  const assets = options.assets ?? (async () => null);
  const sessionTtlMs = config.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  const cookieName = config.sessionCookieName ?? "cas_admin_session";
  const cookieOptions = {
    name: cookieName,
    secure: config.sessionCookieSecure ?? true,
    sameSite: config.sessionCookieSameSite ?? "Lax",
    maxAgeSeconds: Math.ceil(sessionTtlMs / 1000),
  };
  const absolutize = (path: string): string => `${config.publicOrigin}${path}`;
  const emailAllowlist = config.emailAllowlist
    ? new Set(config.emailAllowlist.map((email) => email.toLowerCase()))
    : null;

  return async function adminFetch(request: Request): Promise<Response> {
    try {
      return await dispatch(request);
    } catch (error) {
      // Unexpected failure: keep the response structured and observable.
      console.error("cas-admin BFF unhandled error", error);
      return json({ error: "SERVICE_UNAVAILABLE", message: "admin request failed" }, 500);
    }
  };

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (pathname === "/admin/auth/login" && method === "GET") {
      return handleLogin(request, url);
    }
    if (pathname === "/admin/auth/callback" && method === "GET") {
      return handleCallback(request, url);
    }
    if (pathname === "/admin/auth/logout" && method === "POST") {
      return handleLogout(request);
    }

    const inviteMatch = /^\/admin\/invitations\/([^/]+)$/.exec(pathname);
    if (inviteMatch && method === "GET") {
      return handleInvitationPage(request, inviteMatch[1]!);
    }

    if (pathname === "/admin/issuer/possession-challenge" && method === "POST") {
      return handlePossessionChallenge(request);
    }

    if (pathname === "/admin" || pathname === "/admin/") {
      return handleShell(request);
    }
    if (pathname.startsWith("/admin/assets/")) {
      const asset = await assets(pathname.slice("/admin".length));
      return asset ?? new Response("Not Found", { status: 404 });
    }

    const route = matchCasAdminRoute(method, pathname);
    if (route) {
      return handleAdminApi(request, url, route);
    }
    return json({ error: "Not Found" }, 404);
  };

  // ------------------------------------------------------------------
  // OIDC flow
  // ------------------------------------------------------------------

  async function handleLogin(request: Request, url: URL): Promise<Response> {
    const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo")) ?? undefined;
    if (url.searchParams.get("test-account") === "1") {
      return handleTestAccountLogin(request, returnTo);
    }
    const oidcState = generateOidcState();
    const oidcNonce = generateOidcNonce();
    const codeVerifier = generatePkceVerifier();
    const codeChallenge = await s256Challenge(codeVerifier);
    const sessionId = generateSessionId();
    const payload: AdminSessionPayload = {
      v: 1,
      authenticated: false,
      identityIssuer: "",
      subject: "",
      displayName: null,
      emailForDisplay: null,
      csrfToken: "",
      oidcState,
      oidcNonce,
      codeVerifier,
      returnTo,
    };
    await sessionStore.create(sessionId, await sessionCrypto.encrypt(payload), sessionTtlMs);
    const authorizationUrl = await oidc.authorizationUrl({ state: oidcState, nonce: oidcNonce, codeChallenge });
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizationUrl,
        "Set-Cookie": sessionCookieHeader(cookieOptions, sessionId),
      },
    });
  }

  async function handleTestAccountLogin(request: Request, returnTo?: string): Promise<Response> {
    const account = config.testAccount;
    if (!account) return new Response("Not Found", { status: 404 });
    const credentials = readBasicCredentials(request);
    const emailMatches = credentials
      ? await secureEqual(credentials.email.toLowerCase(), account.email.toLowerCase())
      : false;
    const passwordMatches = credentials
      ? await secureEqual(credentials.password, account.password)
      : false;
    if (!emailMatches || !passwordMatches) {
      await auditLoginFailure("test-account");
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Unicas test account", charset="UTF-8"',
          "Cache-Control": "no-store",
        },
      });
    }
    if (!isEmailAllowed(account.email, true)) {
      await auditLoginFailure("test-account-email-not-allowed");
      return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    const authenticatedPayload: AdminSessionPayload = {
      v: 1,
      authenticated: true,
      identityIssuer: TEST_ACCOUNT_ISSUER,
      subject: account.email.toLowerCase(),
      displayName: account.email,
      emailForDisplay: account.email,
      csrfToken: generateCsrfToken(),
    };
    return createAuthenticatedSession(
      request,
      authenticatedPayload,
      returnTo ?? "/admin/",
      readSessionId(request),
    );
  }

  async function handleCallback(request: Request, callbackUrl: URL): Promise<Response> {
    const error = callbackUrl.searchParams.get("error");
    const code = callbackUrl.searchParams.get("code");
    const state = callbackUrl.searchParams.get("state");
    const sessionId = readSessionId(request);
    const preLogin = sessionId ? await readSession(sessionId) : null;

    if (error || !code || !state || !preLogin || preLogin.oidcState !== state) {
      if (sessionId && preLogin) await sessionStore.delete(sessionId);
      await auditLoginFailure(state ?? "");
      return new Response(null, {
        status: 302,
        headers: { Location: "/admin/#/login-error" },
      });
    }
    let identity: VerifiedOidcIdentity;
    try {
      const exchanged = await oidc.exchangeCode({
        code,
        codeVerifier: preLogin.codeVerifier!,
      });
      identity = await oidc.verifyIdToken({
        idToken: exchanged.idToken,
        nonce: preLogin.oidcNonce!,
      });
    } catch {
      if (sessionId) await sessionStore.delete(sessionId);
      await auditLoginFailure(state);
      return new Response(null, {
        status: 302,
        headers: { Location: "/admin/#/login-error" },
      });
    }

    if (!isEmailAllowed(identity.email, identity.emailVerified)) {
      if (sessionId) await sessionStore.delete(sessionId);
      await auditLoginFailure("email-not-allowed");
      return new Response(null, {
        status: 302,
        headers: { Location: "/admin/#/login-error" },
      });
    }

    // Session rotation on privilege change: new id + fresh CSRF token.
    const authenticatedPayload: AdminSessionPayload = {
      v: 1,
      authenticated: true,
      identityIssuer: config.oidcIssuer ?? "https://accounts.google.com",
      subject: identity.sub,
      displayName: identity.name,
      emailForDisplay: identity.email,
      csrfToken: generateCsrfToken(),
    };
    return createAuthenticatedSession(
      request,
      authenticatedPayload,
      preLogin.returnTo ?? "/admin/",
      sessionId,
    );
  }

  async function createAuthenticatedSession(
    request: Request,
    authenticatedPayload: AdminSessionPayload,
    target: string,
    previousSessionId: string | null,
  ): Promise<Response> {
    const authenticatedId = generateSessionId();
    await sessionStore.create(authenticatedId, await sessionCrypto.encrypt(authenticatedPayload), sessionTtlMs);
    if (previousSessionId) await sessionStore.delete(previousSessionId);
    await service.recordSessionAudit(
      serviceContext(authenticatedPayload, request),
      "session.login",
      `${authenticatedPayload.identityIssuer}:${authenticatedPayload.subject}`,
      null,
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: target,
        "Set-Cookie": sessionCookieHeader(cookieOptions, authenticatedId),
      },
    });
  }

  async function handleLogout(request: Request): Promise<Response> {
    const sessionId = readSessionId(request);
    if (sessionId) {
      const payload = await readSession(sessionId);
      if (payload) {
        await service.recordSessionAudit(
          serviceContext(payload, request),
          "session.logout",
          `${payload.identityIssuer}:${payload.subject}`,
          null,
        );
      }
      await sessionStore.delete(sessionId);
    }
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": clearSessionCookie(cookieOptions) },
    });
  }

  async function handleInvitationPage(request: Request, token: string): Promise<Response> {
    const sessionId = readSessionId(request);
    const payload = sessionId ? await readSession(sessionId) : null;
    if (!payload || !payload.authenticated) {
      const returnTo = `/admin/invitations/${encodeURIComponent(token)}`;
      const loginUrl = new URL("/admin/auth/login", request.url);
      loginUrl.searchParams.set("returnTo", returnTo);
      return new Response(null, {
        status: 302,
        headers: { Location: `${loginUrl.pathname}${loginUrl.search}` },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/#/invitations/${encodeURIComponent(token)}` },
    });
  }

  async function handlePossessionChallenge(request: Request): Promise<Response> {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) return auth;
    if (!(await passCsrf(request, auth.payload))) return csrfRejected();
    const body = await readJsonBody<{ stackId?: unknown; kid?: unknown; algorithm?: unknown }>(request);
    if (!body || typeof body.stackId !== "string" || typeof body.kid !== "string" || typeof body.algorithm !== "string") {
      return adminErrorResponse(CasAdminErrorCodes.INVALID_REQUEST, "stackId, kid, and algorithm are required");
    }
    const result = await service.createPossessionChallenge(serviceContext(auth.payload, request), {
      stackId: body.stackId,
      kid: body.kid,
      algorithm: body.algorithm,
    });
    return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
  }

  async function handleShell(request: Request): Promise<Response> {
    const sessionId = readSessionId(request);
    const payload = sessionId ? await readSession(sessionId) : null;
    if (!payload || !payload.authenticated) {
      const loginUrl = new URL("/admin/auth/login", request.url);
      loginUrl.searchParams.set("returnTo", "/admin/");
      return new Response(null, {
        status: 302,
        headers: { Location: `${loginUrl.pathname}${loginUrl.search}` },
      });
    }
    await sessionStore.touch(sessionId!, sessionTtlMs);
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-csrf-token" content="${payload.csrfToken}" />
  <title>CAS Admin</title>
  <link rel="stylesheet" href="/admin/assets/index.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/admin/assets/index.js"></script>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // ------------------------------------------------------------------
  // Frozen admin API
  // ------------------------------------------------------------------

  async function handleAdminApi(
    request: Request,
    url: URL,
    route: CasAdminRoute,
  ): Promise<Response> {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) return auth;
    if (isMutating(request.method) && !(await passCsrf(request, auth.payload))) {
      return csrfRejected();
    }
    const ctx = serviceContext(auth.payload, request);
    const query = queryFromUrl(url);
    const mutation = {
      ifMatch: request.headers.get("If-Match") ?? undefined,
      idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
    };

    switch (route.operation) {
      case "me": {
        const result = await service.me(ctx);
        return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
      }
      case "listStacks": {
        const result = await service.listStacks(ctx, { query: pageQuery(query) });
        return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
      }
      case "createStack": {
        const body = await readJsonBody<{ displayName?: unknown }>(request);
        if (!body) return invalidRequest("JSON body is required");
        const result = await service.createStack(ctx, { body: { displayName: String(body.displayName ?? "") } }, mutation);
        return jsonWithEtag(result);
      }
      case "getStack": {
        const result = await service.getStack(ctx, { path: { stackId: route.stackId } });
        return jsonWithEtag(result);
      }
      case "patchStack": {
        const body = await readJsonBody<{ displayName?: unknown }>(request);
        if (!body) return invalidRequest("JSON body is required");
        const result = await service.patchStack(ctx, {
          path: { stackId: route.stackId },
          body: { displayName: body.displayName === undefined ? undefined : String(body.displayName) },
        }, mutation);
        return jsonWithEtag(result);
      }
      case "listMembers": {
        const result = await service.listMembers(ctx, { path: { stackId: route.stackId }, query: pageQuery(query) });
        return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
      }
      case "deleteMember": {
        const result = await service.deleteMember(ctx, {
          path: { stackId: route.stackId },
          query: {
            identityIssuer: query.identityIssuer ?? "",
            subject: query.subject ?? "",
          },
        }, mutation);
        return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
      }
      case "createMemberInvitation": {
        const body = await readJsonBody<{ emailConstraint?: unknown }>(request);
        const result = await service.createMemberInvitation(ctx, {
          path: { stackId: route.stackId },
          body: body === null || body.emailConstraint === undefined
            ? undefined
            : { emailConstraint: String(body.emailConstraint) },
        }, mutation);
        if ("error" in result) return json(result, casAdminErrorHttpStatus[result.error]);
        return json({ ...result, acceptUrl: absolutize(result.acceptUrl) }, 200);
      }
      case "acceptMemberInvitation": {
        const result = await service.acceptMemberInvitation(ctx, { path: { token: route.token } });
        return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
      }
      case "getIssuer": {
        const result = await service.getIssuer(ctx, { path: { stackId: route.stackId } });
        return jsonWithEtag(result);
      }
      case "putIssuer": {
        const body = await readJsonBody<{ issuer?: unknown; audience?: unknown }>(request);
        if (!body) return invalidRequest("JSON body is required");
        const result = await service.putIssuer(ctx, {
          path: { stackId: route.stackId },
          body: { issuer: String(body.issuer ?? ""), audience: String(body.audience ?? "") },
        }, mutation);
        return jsonWithEtag(result);
      }
      case "listIssuerKeys": {
        const result = await service.listIssuerKeys(ctx, { path: { stackId: route.stackId } });
        return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
      }
      case "createIssuerKey": {
        const body = await readJsonBody<{
          kid?: unknown;
          algorithm?: unknown;
          publicJwk?: unknown;
          possessionProof?: unknown;
        }>(request);
        if (!body || typeof body.publicJwk !== "object" || body.publicJwk === null || Array.isArray(body.publicJwk)) {
          return invalidRequest("kid, algorithm, publicJwk, and possessionProof are required");
        }
        const result = await service.createIssuerKey(ctx, {
          path: { stackId: route.stackId },
          body: {
            kid: String(body.kid ?? ""),
            algorithm: String(body.algorithm ?? ""),
            publicJwk: body.publicJwk as Record<string, unknown>,
            possessionProof: String(body.possessionProof ?? ""),
          },
        }, mutation);
        return jsonWithEtag(result);
      }
      case "deleteIssuerKey": {
        const body = await readJsonBody<{ toState?: unknown }>(request);
        const toState = body && body.toState === "revoked"
          ? "revoked" as const
          : body && body.toState === "retiring"
            ? "retiring" as const
            : undefined;
        const result = await service.deleteIssuerKey(ctx, {
          path: { stackId: route.stackId, kid: route.kid },
          body: toState ? { toState } : undefined,
        }, mutation);
        return jsonWithEtag(result);
      }
      case "listRefDomains": {
        const result = await service.listRefDomains(ctx, { path: { stackId: route.stackId } });
        return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
      }
      case "createRefDomain": {
        const body = await readJsonBody<{ refDomain?: unknown }>(request);
        if (!body) return invalidRequest("JSON body is required");
        const result = await service.createRefDomain(ctx, {
          path: { stackId: route.stackId },
          body: { refDomain: String(body.refDomain ?? "") },
        }, mutation);
        return jsonWithEtag(result);
      }
      case "patchRefDomain": {
        const body = await readJsonBody<{ status?: unknown }>(request);
        if (!body || (body.status !== "write_disabled" && body.status !== "retired")) {
          return invalidRequest("status must be write_disabled or retired");
        }
        const result = await service.patchRefDomain(ctx, {
          path: { stackId: route.stackId, refDomain: route.refDomain },
          body: { status: body.status },
        }, mutation);
        return jsonWithEtag(result);
      }
      case "listControlAuditEvents": {
        const result = await service.listControlAuditEvents(ctx, {
          path: { stackId: route.stackId },
          query: pageQuery(query),
        });
        return json(result, "error" in result ? casAdminErrorHttpStatus[result.error] : 200);
      }
      case "listRootDomainRefs":
      case "listRootDomainEvents": {
        return handleAuditRead(request, route, ctx, query);
      }
    }
  }

  /** Root Ref audit reads: membership first, then the private reader RPC. */
  async function handleAuditRead(
    request: Request,
    route: CasAdminRoute & { operation: "listRootDomainRefs" | "listRootDomainEvents" },
    ctx: ControlPlaneCallContext,
    query: Record<string, string>,
  ): Promise<Response> {
    const membership = await service.getStack(ctx, { path: { stackId: route.stackId } });
    if ("error" in membership) {
      return json(membership, casAdminErrorHttpStatus[membership.error]);
    }
    const domainError = validateAuditRefDomain(route.refDomain);
    if (domainError) return adminErrorResponse(CasAdminErrorCodes.INVALID_REQUEST, domainError);
    if (!options.auditReader) {
      return adminErrorResponse(CasAdminErrorCodes.SERVICE_UNAVAILABLE, NOT_AVAILABLE_MESSAGE);
    }
    const rpcPath = route.operation === "listRootDomainRefs"
      ? "/_internal/audit/refs"
      : "/_internal/audit/events";
    const rpcUrl = new URL(`https://cas-audit.internal${rpcPath}`);
    rpcUrl.searchParams.set("stackId", route.stackId);
    rpcUrl.searchParams.set("refDomain", route.refDomain);
    if (query.tenantId !== undefined) rpcUrl.searchParams.set("tenantId", query.tenantId);
    if (query.limit !== undefined) rpcUrl.searchParams.set("limit", query.limit);
    if (query.cursor !== undefined) rpcUrl.searchParams.set("cursor", query.cursor);
    if (query.after !== undefined) rpcUrl.searchParams.set("after", query.after);
    const headers: Record<string, string> = {};
    if (config.auditReaderKey) headers["X-CAS-Audit-Reader-Key"] = config.auditReaderKey;
    try {
      const rpcResponse = await options.auditReader.fetch(rpcUrl.toString(), { headers });
      const body = await rpcResponse.text();
      return new Response(body, {
        status: rpcResponse.status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      return adminErrorResponse(CasAdminErrorCodes.SERVICE_UNAVAILABLE, "audit reader is unavailable");
    }
  }

  // ------------------------------------------------------------------
  // Session / auth helpers
  // ------------------------------------------------------------------

  function readSessionId(request: Request): string | null {
    const cookies = parseCookies(request);
    const value = cookies[cookieName];
    return value && value.length > 0 ? value : null;
  }

  async function readSession(sessionId: string): Promise<AdminSessionPayload | null> {
    const stored = await sessionStore.read(sessionId);
    if (!stored) return null;
    try {
      const payload = await sessionCrypto.decrypt(stored.encryptedPayload);
      if (payload.authenticated && !isEmailAllowed(payload.emailForDisplay, true)) {
        await sessionStore.delete(sessionId);
        return null;
      }
      return payload;
    } catch {
      await sessionStore.delete(sessionId);
      return null;
    }
  }

  async function requireAuthenticated(request: Request): Promise<
    { payload: AdminSessionPayload; sessionId: string } | Response
  > {
    const sessionId = readSessionId(request);
    if (!sessionId) return adminErrorResponse(CasAdminErrorCodes.ADMIN_AUTH_REQUIRED, "login required");
    const payload = await readSession(sessionId);
    if (!payload || !payload.authenticated || payload.subject.length === 0) {
      return adminErrorResponse(CasAdminErrorCodes.ADMIN_AUTH_REQUIRED, "login required");
    }
    await sessionStore.touch(sessionId, sessionTtlMs);
    return { payload, sessionId };
  }

  async function passCsrf(
    request: Request,
    payload: AdminSessionPayload,
  ): Promise<boolean> {
    if (config.csrfEnforced === false) return true;
    return checkSameOrigin(request, config.publicOrigin)
      && checkCsrfToken(request, payload.csrfToken);
  }

  function serviceContext(
    payload: AdminSessionPayload,
    request: Request,
  ): ControlPlaneCallContext {
    return {
      identity: { identityIssuer: payload.identityIssuer, subject: payload.subject },
      profile: {
        displayName: payload.displayName,
        emailForDisplay: payload.emailForDisplay,
      },
      requestId: request.headers.get("X-Request-Id") ?? generateRequestId(),
      traceId: generateRequestId(),
    };
  }

  async function auditLoginFailure(state: string): Promise<void> {
    try {
      await service.recordSessionAudit(
        {
          identity: {
            identityIssuer: config.oidcIssuer ?? "https://accounts.google.com",
            subject: "unauthenticated",
          },
          requestId: generateRequestId(),
          traceId: generateRequestId(),
        },
        "session.login_failed",
        state.length > 0 ? state : "oidc-callback",
        null,
      );
    } catch {
      // Auditing must never break the login flow.
    }
  }

  function isEmailAllowed(email: string | null, emailVerified: boolean): boolean {
    if (!emailAllowlist) return true;
    return emailVerified && email !== null && emailAllowlist.has(email.toLowerCase());
  }

  function sanitizeReturnTo(value: string | null): string | null {
    if (!value) return null;
    if (!value.startsWith("/admin")) return null;
    if (value.startsWith("//")) return null;
    return value;
  }
}

// ----------------------------------------------------------------------
// Response helpers
// ----------------------------------------------------------------------

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isMutating(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function jsonWithEtag(result: unknown): Response {
  if (isAdminError(result)) {
    return json(result, casAdminErrorHttpStatus[result.error]);
  }
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (typeof result === "object" && result !== null && "revision" in result) {
    const revision = (result as { revision: unknown }).revision;
    if (typeof revision === "number") headers["ETag"] = formatCasAdminETag(revision);
  }
  return Response.json(result, { status: 200, headers });
}

function adminErrorResponse(code: CasAdminErrorResponse["error"], message?: string): Response {
  const body: CasAdminErrorResponse = { error: code, ...(message ? { message } : {}) };
  return json(body, casAdminErrorHttpStatus[code]);
}

function invalidRequest(message: string): Response {
  return adminErrorResponse(CasAdminErrorCodes.INVALID_REQUEST, message);
}

function csrfRejected(): Response {
  return json({ error: "CSRF_ORIGIN_FAILED", message: "origin or CSRF check failed" }, 403);
}

function isAdminError(value: unknown): value is CasAdminErrorResponse {
  return (
    typeof value === "object"
    && value !== null
    && "error" in value
    && typeof (value as { error: unknown }).error === "string"
  );
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (text.length === 0) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function pageQuery(query: Record<string, string>): {
  limit?: number;
  cursor?: string;
  after?: string;
} {
  const out: { limit?: number; cursor?: string; after?: string } = {};
  if (query.limit !== undefined) out.limit = Number(query.limit);
  if (query.cursor !== undefined) out.cursor = query.cursor;
  if (query.after !== undefined) out.after = query.after;
  return out;
}

function queryFromUrl(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  const search = url.search.replace(/^\?/, "");
  if (!search) return out;
  for (const pair of search.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) {
      out[decodeURIComponent(pair)] = "";
    } else {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return out;
}

function generateRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readBasicCredentials(request: Request): { email: string; password: string } | null {
  const authorization = request.headers.get("Authorization");
  const match = authorization ? /^Basic\s+([^\s]+)$/i.exec(authorization) : null;
  if (!match) return null;
  try {
    const binary = atob(match[1]!);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return { email: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}
