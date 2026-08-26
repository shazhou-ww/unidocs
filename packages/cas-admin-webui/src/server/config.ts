/**
 * BFF configuration. Secrets (Google OIDC client credentials, session
 * encryption keys) must never reach browser code; they are read only in the
 * Worker fetch handler and injected into the testable `createAdminBff`.
 */

export interface AdminBffConfig {
  /** Google OIDC client id (secret). */
  readonly googleClientId: string;
  /** Google OIDC client secret (secret). */
  readonly googleClientSecret: string;
  /**
   * Versioned session encryption keys: key id -> base64url 32-byte AES key.
   * New sessions use the newest key; older keys decrypt until retired.
   */
  readonly sessionEncryptionKeys: Readonly<Record<string, string>>;
  /** OIDC issuer; defaults to Google. */
  readonly oidcIssuer?: string;
  /** Discovery document URL override (tests / local mock provider). */
  readonly oidcDiscoveryUrl?: string;
  /**
   * Public origin of the CAS service (e.g. https://cas.example).
   * Used for absolute accept URLs and CSRF origin checks.
   */
  readonly publicOrigin: string;
  /** Session TTL; default 8 hours, sliding. */
  readonly sessionTtlMs?: number;
  /** Session cookie name; default cas_admin_session. */
  readonly sessionCookieName?: string;
  /** Set Secure on the cookie (disable only for local http dev). */
  readonly sessionCookieSecure?: boolean;
  readonly sessionCookieSameSite?: "Lax" | "Strict" | "None";
  /** Enforce Origin + CSRF checks on mutating methods. */
  readonly csrfEnforced?: boolean;
  /** Clock for tests. */
  readonly now?: () => number;
}

export const DEFAULT_OIDC_ISSUER = "https://accounts.google.com";
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_SESSION_COOKIE_NAME = "cas_admin_session";

/** Mount point of the admin WebUI/BFF on the CAS service domain. */
export const CAS_ADMIN_WEBUI_MOUNT = "/admin" as const;

export interface AdminBffEnv {
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  SESSION_ENCRYPTION_KEYS?: string;
  OIDC_ISSUER?: string;
  OIDC_DISCOVERY_URL?: string;
  PUBLIC_ORIGIN?: string;
  SESSION_TTL_MS?: string;
  SESSION_COOKIE_NAME?: string;
  SESSION_COOKIE_SECURE?: string;
  SESSION_COOKIE_SAME_SITE?: string;
  CSRF_ENFORCE?: string;
}

/** Parse Worker bindings into a validated BFF config; throws on misconfig. */
export function configFromEnv(env: AdminBffEnv): AdminBffConfig {
  const googleClientId = env.GOOGLE_OIDC_CLIENT_ID ?? "";
  const googleClientSecret = env.GOOGLE_OIDC_CLIENT_SECRET ?? "";
  const keysRaw = env.SESSION_ENCRYPTION_KEYS ?? "";
  let sessionEncryptionKeys: Readonly<Record<string, string>>;
  try {
    const parsed = JSON.parse(keysRaw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("SESSION_ENCRYPTION_KEYS must be a JSON object");
    }
    sessionEncryptionKeys = parsed as Record<string, string>;
    for (const [kid, key] of Object.entries(sessionEncryptionKeys)) {
      if (typeof key !== "string" || key.length === 0) {
        throw new Error(`SESSION_ENCRYPTION_KEYS.${kid} must be a non-empty base64url key`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SESSION_ENCRYPTION_KEYS")) {
      throw error;
    }
    throw new Error("SESSION_ENCRYPTION_KEYS must be a JSON object of key id -> base64url key");
  }
  if (Object.keys(sessionEncryptionKeys).length === 0) {
    throw new Error("SESSION_ENCRYPTION_KEYS must contain at least one key");
  }
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  if (publicOrigin.length === 0) {
    throw new Error("PUBLIC_ORIGIN must be configured");
  }
  new URL(publicOrigin); // throws on malformed origin
  return {
    googleClientId,
    googleClientSecret,
    sessionEncryptionKeys,
    oidcIssuer: env.OIDC_ISSUER ?? DEFAULT_OIDC_ISSUER,
    oidcDiscoveryUrl: env.OIDC_DISCOVERY_URL,
    publicOrigin,
    sessionTtlMs: env.SESSION_TTL_MS ? Number(env.SESSION_TTL_MS) : DEFAULT_SESSION_TTL_MS,
    sessionCookieName: env.SESSION_COOKIE_NAME ?? DEFAULT_SESSION_COOKIE_NAME,
    sessionCookieSecure: env.SESSION_COOKIE_SECURE !== "false",
    sessionCookieSameSite: (env.SESSION_COOKIE_SAME_SITE as "Lax" | "Strict" | "None") ?? "Lax",
    csrfEnforced: env.CSRF_ENFORCE !== "false",
  };
}
