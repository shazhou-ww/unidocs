export const PORTAL_PUBLIC_ORIGIN = "https://unidocs.shazhou.work";

export const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Loopback only, and only the two spellings a local runtime binds. A hostname
 * that merely starts with 127.0.0.1 is a different host, so this matches the
 * whole authority rather than a prefix, and requires an explicit port so a
 * bare `http://127.0.0.1` cannot slip through.
 *
 * Exported because the same rule is enforced in `google-login.ts` and
 * `auth.ts`: writing it three times is what let two of them keep requiring
 * HTTPS after the first was relaxed.
 */
export const LOCAL_DEV_ORIGIN_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

/**
 * True only for a *canonical* loopback origin. Self-safe on purpose: the three
 * call sites in this package each run their own `new URL(x).origin !== x`
 * first, and they keep doing so, but this is exported API and the whole point
 * of exporting it is that a fourth site will call it. A fourth site that
 * trusts the name alone must not accept `http://127.0.0.1:8795@evil.test`, so
 * the canonicality the callers supply is enforced here too rather than
 * assumed.
 *
 * Consequence worth knowing: a spelling whose canonical form differs is now
 * false even when the pattern matches it — `http://127.0.0.1:99999` (port out
 * of range, `new URL` throws) and `http://127.0.0.1:80` (canonically
 * `http://127.0.0.1`, which the pattern rejects for having no port). Both are
 * narrowings; the runtime only ever binds an explicit high port.
 */
export function isLocalDevOrigin(origin: string): boolean {
  if (!LOCAL_DEV_ORIGIN_PATTERN.test(origin)) return false;
  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

export interface PortalGoogleConfig {
  readonly issuer: "https://accounts.google.com";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly origin: string;
  readonly redirectUri: string;
}

export function portalGoogleConfigFromGateway(settings: Readonly<Record<string, string | undefined>>, portalOrigin = PORTAL_PUBLIC_ORIGIN): PortalGoogleConfig {
  const clientId = settings.GATEWAY_OIDC_CLIENT_ID?.trim();
  const clientSecret = settings.GATEWAY_OIDC_CLIENT_SECRET;
  const issuer = (settings.GATEWAY_OIDC_ISSUER ?? GOOGLE_ISSUER).replace(/\/$/, "");
  const origin = new URL(portalOrigin);
  if (origin.origin !== portalOrigin) throw new TypeError("Portal requires a canonical origin");
  if (origin.protocol !== "https:" && !isLocalDevOrigin(portalOrigin)) {
    throw new TypeError("Portal requires a canonical HTTPS origin, or a loopback origin for local development");
  }
  if (issuer !== GOOGLE_ISSUER) throw new TypeError("Portal requires the Google issuer");
  if (!clientId || !clientSecret?.trim()) throw new TypeError("Gateway Google OIDC client ID and secret are required");

  return { issuer: GOOGLE_ISSUER, clientId, clientSecret, origin: portalOrigin, redirectUri: `${portalOrigin}/admin/auth/callback` };
}