/**
 * Build-time configuration. The Gateway webui is served by the gateway worker
 * on unidocs.shazhou.work (same origin as the data plane). The OAuth issuer
 * surface is served on the same app origin too. In dev, Vite proxies /gw/*
 * to the local gateway, so both collapse to the dev server origin.
 */

const env = import.meta.env as Record<string, string | undefined>;

/** Dev builds proxy /gw/* to the local gateway; prod is same-origin. */
export const API_PREFIX = import.meta.env.DEV ? "/gw" : "";
export const GATEWAY_ORIGIN = window.location.origin.replace(/\/$/, "");
export const DEFAULT_DOC_TYPES = (env.VITE_DOC_TYPES ?? "docx,markdown,psd")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
export const CLIENT_NAME = "unidocs-gateway-webui";
/** The OAuth redirect route served by this SPA (same origin, /ui/* base). */
export const REDIRECT_PATH = "/ui/callback";
export const REDIRECT_URI = `${GATEWAY_ORIGIN}${REDIRECT_PATH}`;

export const OAUTH_BASE = `${GATEWAY_ORIGIN}${API_PREFIX}/oauth/unidocs-cloudflare`;
export const API_BASE = `${GATEWAY_ORIGIN}${API_PREFIX}`;
