/**
 * In-memory fake of the Unicas `/admin` BFF API: the id_token-exchange
 * endpoint, session enforcement, and the control-plane operations the CLI
 * exercises. Lets every CLI test run without the network or a real OIDC
 * provider.
 */

import { casAdminRoutes } from "@unicas/admin-protocol";
import { s256Challenge } from "@unicas/control-auth";

export interface FakeAdminOptions {
  /** When set, the exchange endpoint requires exactly this id_token. */
  readonly expectedIdToken?: string;
  readonly onRequest?: (request: RecordedRequest) => void;
}

export interface RecordedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
  readonly cookie: string | null;
  readonly csrf: string | null;
}

export const FAKE_ORIGIN = "https://unicas.test";

interface FakeStack {
  stackId: string;
  displayName: string;
  description: string;
  status: "active" | "suspended";
  createdAt: number;
  revision: number;
}

interface FakeKey {
  stackId: string;
  kid: string;
  algorithm: string;
  publicJwk: Record<string, unknown>;
  state: "active" | "retiring" | "revoked";
  revision: number;
}

export class FakeAdminApi {
  readonly requests: RecordedRequest[] = [];
  readonly #options: FakeAdminOptions;
  readonly stacks = new Map<string, FakeStack>();
  readonly members = new Map<string, { identityIssuer: string; subject: string }[]>();
  readonly keys = new Map<string, FakeKey[]>();
  issuer = new Map<string, { issuer: string; audience: string; revision: number }>();
  oauthIssuer = new Map<string, { issuer: string; audience: string; status: "pending" | "active"; revision: number }>();
  readonly sessions = new Set<string>();
  /** PKCE challenge the cli/exchange endpoint expects (registered by tests). */
  cliCodeChallenge: string | null = null;

  constructor(options: FakeAdminOptions = {}) {
    this.#options = options;
    this.sessions.add("session-1");
    this.#seed();
  }

  #seed(): void {
    const stack: FakeStack = {
      stackId: "cas_stack_a",
      displayName: "Ops",
      description: "",
      status: "active",
      createdAt: 1,
      revision: 3,
    };
    this.stacks.set(stack.stackId, stack);
    this.members.set(stack.stackId, [
      { identityIssuer: "https://accounts.google.com", subject: "sub-1" },
      { identityIssuer: "https://accounts.google.com", subject: "sub-2" },
    ]);
  }

  get fetch(): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit) => this.#handle(input, init);
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const cookie = headers.get("Cookie");
    const csrf = headers.get("X-CSRF-Token");
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = rawBody.length > 0 ? JSON.parse(rawBody) as Record<string, unknown> : undefined;
    this.requests.push({ method, pathname: url.pathname, body, cookie, csrf });
    this.#options.onRequest?.(this.requests[this.requests.length - 1]);

    if (url.pathname === "/admin/auth/exchange" && method === "POST") {
      if (this.#options.expectedIdToken !== undefined && body?.idToken !== this.#options.expectedIdToken) {
        return json({ error: "ADMIN_AUTH_REQUIRED", message: "id_token verification failed" }, 401);
      }
      this.sessions.add("cli-session-1");
      return Response.json(
        { csrfToken: "cli-csrf-1" },
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Set-Cookie": "cas_admin_session=cli-session-1; Path=/; HttpOnly",
          },
        },
      );
    }
    if (url.pathname === "/admin/auth/cli/exchange" && method === "POST") {
      const codeVerifier = typeof body?.codeVerifier === "string" ? body.codeVerifier : "";
      if (this.cliCodeChallenge !== null) {
        const challenge = await s256Challenge(codeVerifier);
        if (challenge !== this.cliCodeChallenge) {
          return json({ error: "ADMIN_AUTH_REQUIRED", message: "PKCE code verifier mismatch" }, 401);
        }
      }
      this.sessions.add("cli-session-1");
      return Response.json(
        {
          csrfToken: "cli-csrf-1",
          identity: { identityIssuer: "https://accounts.google.com", subject: "google-user-123", displayName: "Alice", emailForDisplay: "alice@example.com" },
        },
        {
          status: 200,
          headers: { "Cache-Control": "no-store", "Set-Cookie": "cas_admin_session=cli-session-1; Path=/; HttpOnly" },
        },
      );
    }
    if (url.pathname === "/admin/auth/logout" && method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === casAdminRoutes.possessionChallenge() && method === "POST") {
      return json({ nonce: "challenge-nonce-1", expiresAt: 1_800_000_000 });
    }

    if (cookie === null || !this.sessions.has(cookie.replace("cas_admin_session=", ""))) {
      return json({ error: "ADMIN_AUTH_REQUIRED", message: "session required" }, 401);
    }
    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating && csrf !== "cli-csrf-1") {
      return json({ error: "CSRF_REJECTED" }, 403);
    }

    // me
    if (url.pathname === casAdminRoutes.me()) {
      return json({
        identity: { identityIssuer: "https://accounts.google.com", subject: "sub-1", displayName: "Alice", emailForDisplay: "alice@example.com" },
        memberships: [{ stackId: "cas_stack_a", identityIssuer: "https://accounts.google.com", subject: "sub-1", displayName: "Alice", emailForDisplay: "alice@example.com" }],
      });
    }
    // stacks
    if (url.pathname === casAdminRoutes.stacks() && method === "GET") {
      return json({ items: [...this.stacks.values()], nextCursor: null });
    }
    if (url.pathname === casAdminRoutes.stacks() && method === "POST") {
      const stack: FakeStack = {
        stackId: "cas_stack_new",
        displayName: String(body?.displayName ?? ""),
        description: "",
        status: "active",
        createdAt: 2,
        revision: 1,
      };
      this.stacks.set(stack.stackId, stack);
      return jsonWithEtag(stack);
    }
    const stackMatch = /^\/admin\/stacks\/([^/]+)$/.exec(url.pathname);
    if (stackMatch) {
      const stackId = decodeURIComponent(stackMatch[1]!);
      const stack = this.stacks.get(stackId);
      if (method === "GET") {
        return stack === undefined ? json({ error: "NOT_FOUND" }, 404) : jsonWithEtag(stack);
      }
      if (method === "PATCH" && stack !== undefined) {
        if (headers.get("If-Match") !== `"rev-${stack.revision}"`) return json({ error: "REVISION_MISMATCH" }, 412);
        stack.revision += 1;
        if (body?.displayName !== undefined) stack.displayName = String(body.displayName);
        if (body?.description !== undefined) stack.description = String(body.description);
        return jsonWithEtag(stack);
      }
      return json({ error: "NOT_FOUND" }, 404);
    }
    // members
    if (url.pathname === casAdminRoutes.members({ stackId: "cas_stack_a" }) && method === "GET") {
      const rows = this.members.get("cas_stack_a") ?? [];
      return json({ items: rows.map((row) => ({ stackId: "cas_stack_a", ...row, displayName: null, emailForDisplay: null })), nextCursor: null });
    }
    if (url.pathname === casAdminRoutes.members({ stackId: "cas_stack_a" }) && method === "DELETE") {
      return json({ ok: true });
    }
    if (url.pathname === casAdminRoutes.memberInvitations({ stackId: "cas_stack_a" }) && method === "POST") {
      return json({
        invitation: { invitationId: "inv-1", stackId: "cas_stack_a", status: "pending", emailConstraint: body?.emailConstraint ?? null, expiresAt: 1_800_000_000, createdAt: 1, revision: 1 },
        acceptUrl: `${FAKE_ORIGIN}/admin/invitations/inv-1/accept`,
      });
    }
    // issuer
    if (url.pathname === casAdminRoutes.issuer({ stackId: "cas_stack_a" }) && method === "GET") {
      const record = this.issuer.get("cas_stack_a");
      return record === undefined
        ? json({ error: "NOT_FOUND" }, 404)
        : jsonWithEtag({ stackId: "cas_stack_a", ...record });
    }
    if (url.pathname === casAdminRoutes.issuer({ stackId: "cas_stack_a" }) && method === "PUT") {
      const record = { issuer: String(body?.issuer ?? ""), audience: String(body?.audience ?? ""), revision: 1 };
      this.issuer.set("cas_stack_a", record);
      return jsonWithEtag({ stackId: "cas_stack_a", ...record });
    }
    if (url.pathname === casAdminRoutes.oauthIssuerInspections({ stackId: "cas_stack_a" }) && method === "POST") {
      const record = { issuer: String(body?.issuer ?? ""), audience: String(body?.audience ?? ""), status: "pending" as const, revision: 1 };
      this.oauthIssuer.set("cas_stack_a", record);
      return jsonWithEtag({
        inspectionId: "oinsp_test",
        stackId: "cas_stack_a",
        ...record,
        challenge: "cas-oauth-issuer-inspection-v1\\nchallenge",
        expiresAt: 1_800_000_000,
        keys: [],
      });
    }
    if (url.pathname === casAdminRoutes.oauthIssuer({ stackId: "cas_stack_a" }) && method === "GET") {
      const record = this.oauthIssuer.get("cas_stack_a");
      return record === undefined ? json({ error: "NOT_FOUND" }, 404) : jsonWithEtag({ stackId: "cas_stack_a", ...record });
    }
    if (url.pathname === casAdminRoutes.oauthIssuer({ stackId: "cas_stack_a" }) && method === "PUT") {
      const current = this.oauthIssuer.get("cas_stack_a");
      if (!current) return json({ error: "NOT_FOUND" }, 404);
      const record = { ...current, status: "active" as const, revision: current.revision + 1 };
      this.oauthIssuer.set("cas_stack_a", record);
      return jsonWithEtag({ stackId: "cas_stack_a", ...record });
    }
    // keys
    if (url.pathname === casAdminRoutes.issuerKeys({ stackId: "cas_stack_a" }) && method === "GET") {
      return json({ keys: this.keys.get("cas_stack_a") ?? [] });
    }
    if (url.pathname === casAdminRoutes.issuerKeys({ stackId: "cas_stack_a" }) && method === "POST") {
      const key: FakeKey = {
        stackId: "cas_stack_a",
        kid: String(body?.kid ?? ""),
        algorithm: String(body?.algorithm ?? ""),
        publicJwk: (body?.publicJwk ?? {}) as Record<string, unknown>,
        state: "active",
        revision: 1,
      };
      (this.keys.get("cas_stack_a") ?? this.keys.set("cas_stack_a", []).get("cas_stack_a")!).push(key);
      return jsonWithEtag(key);
    }
    const keyMatch = /^\/admin\/stacks\/cas_stack_a\/issuer\/keys\/([^/]+)$/.exec(url.pathname);
    if (keyMatch && method === "DELETE") {
      const kid = decodeURIComponent(keyMatch[1]!);
      const rows = this.keys.get("cas_stack_a") ?? [];
      const key = rows.find((entry) => entry.kid === kid);
      if (!key) return json({ error: "NOT_FOUND" }, 404);
      key.state = body?.toState === "revoked" ? "revoked" : "retiring";
      key.revision += 1;
      return jsonWithEtag(key);
    }
    // ref-domains + audit
    if (url.pathname === casAdminRoutes.refDomains({ stackId: "cas_stack_a" })) {
      return json({ domains: [{ stackId: "cas_stack_a", refDomain: "doc", revision: 1 }] });
    }
    if (url.pathname === casAdminRoutes.controlAuditEvents({ stackId: "cas_stack_a" })) {
      return json({ items: [], nextCursor: null });
    }
    if (url.pathname === casAdminRoutes.rootDomainRefs({ stackId: "cas_stack_a", refDomain: "doc" })) {
      return json({ revision: 1, refs: [], nextCursor: null });
    }
    if (url.pathname === casAdminRoutes.rootDomainEvents({ stackId: "cas_stack_a", refDomain: "doc" })) {
      return json({ events: [], latestRevision: 1, nextAfter: 1 });
    }
    return json({ error: "NOT_FOUND" }, 404);
  }
}

export function sessionCookie(): string {
  return "cas_admin_session=session-1";
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function jsonWithEtag(value: unknown): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (typeof value === "object" && value !== null && "revision" in value) {
    headers["ETag"] = `"rev-${(value as { revision: unknown }).revision}"`;
  }
  return Response.json(value, { status: 200, headers });
}
