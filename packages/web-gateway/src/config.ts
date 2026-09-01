/**
 * Build-time configuration. The Gateway webui (unidocs.shazhou.work) and the
 * OAuth issuer surface (unicas.shazhou.work) live on different origins in
 * production: the data-plane API calls are same-origin, while register/token/
 * refresh go to the issuer origin (the Gateway answers those with CORS). In
 * dev, Vite proxies /gw/* to the local gateway, so both origins collapse to
 * the dev server origin.
 */

const env = import.meta.env as Record<string, string | undefined>;

/** Dev builds proxy /gw/* to the local gateway; prod is same-origin. */
export const API_PREFIX = import.meta.env.DEV ? "/gw" : "";
/** Data-plane origin: where /tenants/* and /ui/* are served from. */
export const GATEWAY_ORIGIN = window.location.origin.replace(/\/$/, "");
/** OAuth issuer origin (register/authorize/token/login). */
export const OAUTH_ORIGIN = (env.VITE_OAUTH_ORIGIN ?? window.location.origin).replace(/\/$/, "");
export const DEFAULT_TENANT = env.VITE_DEFAULT_TENANT ?? "";
export const DEFAULT_DOC_TYPES = (env.VITE_DOC_TYPES ?? "docx,markdown,psd")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
export const CLIENT_NAME = "unidocs-gateway-webui";
/** The OAuth redirect route served by this SPA (same origin, /ui/* base). */
export const REDIRECT_PATH = "/ui/callback";
export const REDIRECT_URI = `${GATEWAY_ORIGIN}${REDIRECT_PATH}`;

export const OAUTH_BASE = `${OAUTH_ORIGIN}${API_PREFIX}/oauth/unidocs-cloudflare`;
export const API_BASE = `${GATEWAY_ORIGIN}${API_PREFIX}`;
