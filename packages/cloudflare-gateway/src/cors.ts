/**
 * CORS for the Gateway OAuth endpoints. The Gateway webui lives on
 * unidocs.shazhou.work while the OAuth issuer surface (register/authorize/
 * token) stays on the registered issuer origin unicas.shazhou.work, so the
 * webui's register/token/refresh calls are cross-origin. Only the configured
 * webui origin is allowed; everything else stays same-origin-only.
 */

const OAUTH_PATH_PREFIX = "/oauth/unidocs-cloudflare/";
const CORS_ALLOW_HEADERS = "content-type, authorization";
const CORS_ALLOW_METHODS = "GET, POST, OPTIONS";

export interface CorsConfig {
  /** Exact webui origin allowed to call the OAuth endpoints cross-origin. */
  readonly webuiOrigin: string | null;
}

export function createCorsHandler(config: CorsConfig): {
  preflight(request: Request): Response | null;
  apply(request: Request, response: Response): Response;
} {
  const origin = config.webuiOrigin?.replace(/\/$/, "") ?? null;
  const isOAuthPath = (url: URL): boolean => url.pathname.startsWith(OAUTH_PATH_PREFIX);

  return {
    preflight(request: Request): Response | null {
      const url = new URL(request.url);
      if (request.method !== "OPTIONS" || !isOAuthPath(url)) return null;
      if (!origin || request.headers.get("Origin") !== origin) return null;
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
          "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    },
    apply(request: Request, response: Response): Response {
      const url = new URL(request.url);
      if (!origin || !isOAuthPath(url)) return response;
      if (request.headers.get("Origin") !== origin) return response;
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
