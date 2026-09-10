import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AdminAccessError, googleIdentityFromVerifiedClaims, requireBoundAdministrator, requireRecentAuthentication, type AdminContext, type AdminIdentity, type BoundAdministrator } from "@unidocs/portal-service";

export const ADMIN_COOKIE = "__Host-unidocs_admin";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface AdminSession {
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly memberId: string;
  readonly identity: AdminIdentity;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface AdminAuthDependencies {
  readonly now: () => number;
  readonly findSession: (hash: string) => Promise<AdminSession | null>;
  readonly findMemberById: (memberId: string) => Promise<BoundAdministrator | null>;
  readonly findMemberByIdentity: (identity: AdminIdentity) => Promise<BoundAdministrator | null>;
  readonly keys?: JWTVerifyGetKey;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function hashSessionSecret(secret: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))));
}

export async function createAdminSession(member: BoundAdministrator, identity: AdminIdentity, now: number) {
  requireBoundAdministrator(identity, member);
  requireRecentAuthentication(identity, now);
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const csrfToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const session: AdminSession = {
    sessionHash: await hashSessionSecret(token),
    csrfHash: await hashSessionSecret(csrfToken),
    memberId: member.memberId,
    identity,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS,
  };
  return { token, csrfToken, session, cookie: `${ADMIN_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}` };
}

export function clearedAdminCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function sessionTokenFromCookie(cookie: string | null): string {
  const tokens = (cookie ?? "").split(";").map(part => part.trim()).filter(part => part.split("=", 1)[0] === ADMIN_COOKIE);
  if (tokens.length !== 1) throw new AdminAccessError("unauthorized");
  const token = tokens[0].slice(ADMIN_COOKIE.length + 1);
  if (!opaqueTokenPattern.test(token)) throw new AdminAccessError("unauthorized");
  return token;
}

export function createAdminAuthenticator(config: { readonly origin: string; readonly audience: string }, dependencies: AdminAuthDependencies) {
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.origin !== config.origin || !config.audience.trim()) throw new TypeError("Invalid administrator auth configuration");
  const keys = dependencies.keys ?? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });

  return async function authenticate(request: Request): Promise<AdminContext> {
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid auth clock");
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
      if (!match || authorization.length > 16_384) throw new AdminAccessError("unauthorized");
      let identity: AdminIdentity;
      try {
        const { payload } = await jwtVerify(match[1], keys, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: config.audience,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "iat", "sub", "auth_time", "email", "email_verified"],
          maxTokenAge: 3_600,
          clockTolerance: 30,
          currentDate: new Date(now * 1_000),
        });
        if ((payload.azp !== undefined && payload.azp !== config.audience) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.audience)) throw new AdminAccessError("unauthorized");
        identity = googleIdentityFromVerifiedClaims(payload, now);
      } catch {
        throw new AdminAccessError("unauthorized");
      }
      const member = requireBoundAdministrator(identity, await dependencies.findMemberByIdentity(identity));
      return { memberId: member.memberId, identity, transport: "bearer" };
    }

    if (new URL(request.url).origin !== config.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new AdminAccessError("forbidden");
    const token = sessionTokenFromCookie(request.headers.get("cookie"));
    const hash = await hashSessionSecret(token);
    const session = await dependencies.findSession(hash);
    if (!session || session.sessionHash !== hash || !Number.isSafeInteger(session.createdAt) || !Number.isSafeInteger(session.expiresAt) || session.createdAt > now || session.expiresAt <= now || session.expiresAt <= session.createdAt || session.expiresAt - session.createdAt > SESSION_TTL_SECONDS) throw new AdminAccessError("unauthorized");
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      const csrf = request.headers.get("x-csrf-token");
      if (request.headers.get("origin") !== config.origin || !csrf || !opaqueTokenPattern.test(csrf) || !opaqueTokenPattern.test(session.csrfHash)) throw new AdminAccessError("forbidden");
      const provided = new TextEncoder().encode(await hashSessionSecret(csrf));
      const expected = new TextEncoder().encode(session.csrfHash);
      if (!timingSafeEqual(provided, expected)) throw new AdminAccessError("forbidden");
    }
    const member = requireBoundAdministrator(session.identity, await dependencies.findMemberById(session.memberId));
    if (member.memberId !== session.memberId) throw new AdminAccessError("forbidden");
    return { memberId: member.memberId, identity: session.identity, transport: "session" };
  };
}