import { timingSafeEqual } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { TenantAccessError, type TenantContext } from "@unidocs/portal-service";
import { hashSessionSecret } from "../auth.js";
import { authenticateAgent } from "./agent-auth.js";

export const TENANT_SESSION_COOKIE = "__Host-unidocs_tenant";
export const TENANT_CSRF_COOKIE = "__Host-unidocs_tenant_csrf";
export const TENANT_SESSION_TTL_SECONDS = 28_800;

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

  async issue(tenantId: string, principalId: string, now: number): Promise<{ token: string; csrfToken: string }> {
    requireClock(now);
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const csrfToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const sessionHash = await hashSessionSecret(token);
    const csrfHash = await hashSessionSecret(csrfToken);
    const expiresAt = now + TENANT_SESSION_TTL_SECONDS;
    await this.db
      .prepare(
        "INSERT INTO portal_tenant_sessions (session_hash, tenant_id, principal_id, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(sessionHash, tenantId, principalId, csrfHash, now, expiresAt)
      .run();
    return { token, csrfToken };
  }

  async find(sessionHash: string, now: number): Promise<TenantSessionRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM portal_tenant_sessions WHERE session_hash = ? AND created_at <= ? AND expires_at > ?")
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

  async revoke(sessionHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM portal_tenant_sessions WHERE session_hash = ?").bind(sessionHash).run();
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
    /** AGENT_API_TOKEN and AGENT_TENANT_ID; either one unset refuses every bearer. */
    readonly agentToken?: string;
    readonly agentTenantId?: string;
  },
): Promise<TenantContext> {
  const { origin, now, store } = options;
  requireClock(now);

  // Any Authorization header takes the Agent bearer path, and its verdict is
  // final: a rejected bearer never falls back to the cookie, even a valid one.
  if (request.headers.get("authorization") !== null) {
    return authenticateAgent(request, { origin, token: options.agentToken, tenantId: options.agentTenantId });
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
