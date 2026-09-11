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

export function isLocalDevOrigin(origin: string): boolean {
  return LOCAL_DEV_ORIGIN_PATTERN.test(origin);
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