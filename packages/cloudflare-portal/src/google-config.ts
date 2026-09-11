export const PORTAL_PUBLIC_ORIGIN = "https://unidocs.shazhou.work";

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
  const issuer = (settings.GATEWAY_OIDC_ISSUER ?? "https://accounts.google.com").replace(/\/$/, "");
  if (!clientId || !clientSecret?.trim() || issuer !== "https://accounts.google.com") {
    throw new TypeError("Gateway Google OIDC client ID, secret and Google issuer are required");
  }
  const origin = new URL(portalOrigin);
  if (origin.protocol !== "https:" || origin.origin !== portalOrigin) throw new TypeError("Portal requires a canonical HTTPS origin");
  return { issuer, clientId, clientSecret, origin: portalOrigin, redirectUri: `${portalOrigin}/admin/auth/callback` };
}