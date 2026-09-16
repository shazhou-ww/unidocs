import { timingSafeEqual } from "node:crypto";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { TenantAccessError, type TenantContext } from "@unidocs/portal-service";
import { hashSessionSecret } from "../auth.js";
import { authenticateAgent } from "./agent-auth.js";

export const TENANT_SESSION_COOKIE = "__Host-unidocs_tenant";
export const TENANT_CSRF_COOKIE = "__Host-unidocs_tenant_csrf";
export const TENANT_SESSION_TTL_SECONDS = 28_800;

/** The tenant and principal the local dev session (see issueDevSession) always uses. */
export const DEV_TENANT_ID = "t-local";
export const DEV_PRINCIPAL_ID = "user-local";

const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface TenantSessionRecord {
  readonly sessionHash: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly csrfHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Same encoding as auth.ts's local base64url helper. That one is not exported
 * (the brief says not to change auth.ts's export surface), so it is
 * duplicated here rather than reached into.
 */
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * D1 stores seconds. A fractional, negative or unsafe clock is a caller bug,
 * not a request to refuse, so it throws TypeError like auth.ts's clock guard.
 */
function requireClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid tenant session clock");
}

interface TenantSessionRow {
  readonly session_hash: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly csrf_hash: string;
  readonly created_at: number;
  readonly expires_at: number;
}

export class D1TenantSessionStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Mints the secrets and the INSERT without running it, so a caller can put
   * the session in the same batch as the writes that justify it.
   */
  async prepareIssue(tenantId: string, principalId: string, now: number): Promise<{ token: string; csrfToken: string; statement: D1PreparedStatement }> {
    requireClock(now);
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const csrfToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const statement = this.db
      .prepare(
        "INSERT INTO portal_tenant_sessions (session_hash, tenant_id, principal_id, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(await hashSessionSecret(token), tenantId, principalId, await hashSessionSecret(csrfToken), now, now + TENANT_SESSION_TTL_SECONDS);
    return { token, csrfToken, statement };
  }

  async issue(tenantId: string, principalId: string, now: number): Promise<{ token: string; csrfToken: string }> {
    const { token, csrfToken, statement } = await this.prepareIssue(tenantId, principalId, now);
    await statement.run();
    return { token, csrfToken };
  }

  /**
   * The local dev session. It goes through the same member check as any other
   * session, so it brings its own member row, (re)activated in the same batch.
   * Not audited: it is not a sign-in.
   *
   * The row AT the natural key (tenant_id, principal_id) is the dev member,
   * whichever member_id it already has (member_id is the primary key and
   * cannot change) — so the single conflict target is that natural key, and
   * every other canonical field is restored on conflict. Deliberately no
   * conflict target for the (email) WHERE active = 1 index: an unrelated
   * active member already holding dev@unidocs.local is a misconfiguration
   * (someone really invited that address), and this fails loudly rather than
   * silently reactivating or renaming their row.
   */
  async issueDevSession(now: number): Promise<{ token: string; csrfToken: string }> {
    const { token, csrfToken, statement } = await this.prepareIssue(DEV_TENANT_ID, DEV_PRINCIPAL_ID, now);
    await this.db.batch([
      this.db.prepare(`INSERT INTO portal_tenant_members
          (member_id, tenant_id, principal_id, email, issuer, subject, active, added_by, created_at, updated_at)
        VALUES ('member-local-dev', ?, ?, 'dev@unidocs.local', 'local-dev', ?, 1, 'dev-session', ?, ?)
        ON CONFLICT (tenant_id, principal_id) DO UPDATE SET
          active = 1, email = excluded.email, issuer = excluded.issuer, subject = excluded.subject,
          added_by = excluded.added_by, updated_at = excluded.updated_at`)
        .bind(DEV_TENANT_ID, DEV_PRINCIPAL_ID, DEV_PRINCIPAL_ID, now, now),
      statement,
    ]);
    return { token, csrfToken };
  }

  /** Only a session whose member is active and bound authenticates: removal takes effect on the next request. */
  async find(sessionHash: string, now: number): Promise<TenantSessionRecord | null> {
    const row = await this.db
      .prepare(`SELECT session.* FROM portal_tenant_sessions AS session
        JOIN portal_tenant_members AS member
          ON member.tenant_id = session.tenant_id AND member.principal_id = session.principal_id
        WHERE session.session_hash = ? AND session.created_at <= ? AND session.expires_at > ?
          AND member.active = 1 AND member.subject IS NOT NULL`)
      .bind(sessionHash, now, now)
      .first<TenantSessionRow>();
    if (!row) return null;
    return {
      sessionHash: row.session_hash,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      csrfHash: row.csrf_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async revoke(sessionHash: string, requestId: string, now: number): Promise<void> {
    requireClock(now);
    await this.db.batch([
      this.db.prepare(`INSERT INTO portal_tenant_auth_audit (event_id, member_id, action, occurred_at, request_id)
        SELECT ?, member.member_id, 'session.revoked', ?, ? FROM portal_tenant_sessions AS session
        JOIN portal_tenant_members AS member
          ON member.tenant_id = session.tenant_id AND member.principal_id = session.principal_id
        WHERE session.session_hash = ?`)
        .bind(crypto.randomUUID(), now, requestId, sessionHash),
      this.db.prepare("DELETE FROM portal_tenant_sessions WHERE session_hash = ?").bind(sessionHash),
    ]);
  }
}

function sessionTokenFromCookie(cookie: string | null): string {
  const tokens = (cookie ?? "").split(";").map(part => part.trim()).filter(part => part.split("=", 1)[0] === TENANT_SESSION_COOKIE);
  if (tokens.length !== 1) throw new TenantAccessError("unauthorized");
  const token = tokens[0].slice(TENANT_SESSION_COOKIE.length + 1);
  if (!opaqueTokenPattern.test(token)) throw new TenantAccessError("unauthorized");
  return token;
}

export async function authenticateTenant(
  request: Request,
  options: {
    readonly origin: string;
    readonly now: number;
    readonly store: D1TenantSessionStore;
    /** AGENT_API_TOKEN; unset refuses every bearer. The tenant it acts for comes from the request path, not from configuration. */
    readonly agentToken?: string;
  },
): Promise<TenantContext> {
  const { origin, now, store } = options;
  requireClock(now);

  // Any Authorization header takes the Agent bearer path, and its verdict is
  // final: a rejected bearer never falls back to the cookie, even a valid one.
  if (request.headers.get("authorization") !== null) {
    return authenticateAgent(request, { origin, token: options.agentToken });
  }

  if (new URL(request.url).origin !== origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new TenantAccessError("forbidden");
  }

  const token = sessionTokenFromCookie(request.headers.get("cookie"));
  const sessionHash = await hashSessionSecret(token);
  const session = await store.find(sessionHash, now);
  if (!session) throw new TenantAccessError("unauthorized");

  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    const csrf = request.headers.get("x-csrf-token");
    if (request.headers.get("origin") !== origin || !csrf || !opaqueTokenPattern.test(csrf)) {
      throw new TenantAccessError("forbidden");
    }
    const providedHash = await hashSessionSecret(csrf);
    const provided = new TextEncoder().encode(providedHash);
    const expected = new TextEncoder().encode(session.csrfHash);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new TenantAccessError("forbidden");
    }
  }

  return {
    tenantId: session.tenantId,
    principalId: session.principalId,
    transport: "session",
    sessionHash,
  };
}
