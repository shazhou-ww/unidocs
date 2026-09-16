// The loopback rule lives in the cloud-neutral core, which the type-card
// bundle guard also has to reach. Re-exported here because it was this
// package's API first and three call sites in it still import it by name.
import { isLocalDevOrigin } from "@unidocs/portal-service";
export { isLocalDevOrigin, LOCAL_DEV_ORIGIN_PATTERN } from "@unidocs/portal-service";

export const PORTAL_PUBLIC_ORIGIN = "https://unidocs.shazhou.work";

export const GOOGLE_ISSUER = "https://accounts.google.com";


export interface PortalGoogleConfig {
  readonly issuer: "https://accounts.google.com";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly origin: string;
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

  return { issuer: GOOGLE_ISSUER, clientId, clientSecret, origin: portalOrigin };
}