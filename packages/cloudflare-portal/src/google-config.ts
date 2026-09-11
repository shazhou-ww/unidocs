export const PORTAL_PUBLIC_ORIGIN = "https://unidocs.shazhou.work";

export const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Loopback only, and only the two spellings a local runtime actually binds.
 * A hostname that merely starts with 127.0.0.1 is a different host, so this
 * matches the whole authority rather than a prefix.
 */
export const LOCAL_DEV_ORIGIN_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

function isLoopback(origin: string): boolean {
  return LOCAL_DEV_ORIGIN_PATTERN.test(origin);
}

export interface PortalGoogleConfig {
  /** Always the Google issuer in production; a loopback mock only in local development. */
  readonly issuer: string;
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

  // A loopback origin is a local runtime, and it may only talk to a loopback
  // OIDC provider — the mock. Pairing them is what keeps this allowance from
  // ever applying in production: a deployed origin is not loopback, and a
  // loopback issuer is refused for any other origin, so neither half can be
  // reached by a misconfigured deployment on its own.
  const local = isLoopback(portalOrigin);
  const localIssuer = isLoopback(issuer);
  if (local !== localIssuer) throw new TypeError("Portal pairs a loopback origin with a loopback OIDC issuer, or neither");
  if (!local && (origin.protocol !== "https:" || issuer !== GOOGLE_ISSUER)) {
    throw new TypeError("Portal requires a canonical HTTPS origin and the Google issuer");
  }
  if (!clientId || !clientSecret?.trim()) throw new TypeError("Gateway Google OIDC client ID and secret are required");

  return { issuer: issuer as PortalGoogleConfig["issuer"], clientId, clientSecret, origin: portalOrigin, redirectUri: `${portalOrigin}/admin/auth/callback` };
}