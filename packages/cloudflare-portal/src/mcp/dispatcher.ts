import { ADMIN_MCP_ZIP_MAX_BASE64_LENGTH } from "@unidocs/protocol-admin-portal";
import { boundedBytes } from "@unidocs/portal-service";

export const ADMIN_MCP_PATHS = [
  "/mcp",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/admin-mcp/register",
  "/oauth/admin-mcp/authorize",
  "/oauth/admin-mcp/token",
  "/oauth/admin-mcp/revoke",
] as const;

export const ADMIN_MCP_BODY_MAX_BYTES = ADMIN_MCP_ZIP_MAX_BASE64_LENGTH + 64 * 1024;
export const ADMIN_MCP_OAUTH_BODY_MAX_BYTES = 64 * 1024;
const browserPaths = new Set(["/oauth/admin-mcp/authorize"]);
const consentCookie = "__Host-unidocs_admin_mcp_consent";

export interface AdminMcpDispatchOptions {
  readonly enabled: boolean;
  readonly publicOrigin: string;
  readonly handler?: (request: Request) => Promise<Response>;
}

function responseHeaders(response: Response, browser: boolean, publicOrigin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.delete("Set-Cookie");
  if (browser) {
    const clientRedirect = clientRedirectCspSource(headers.get("X-Admin-MCP-Client-Redirect"));
    headers.delete("X-Admin-MCP-Client-Redirect");
    for (const cookie of response.headers.getSetCookie()) {
      if (cookie.slice(0, cookie.indexOf("=")).trim() === consentCookie) headers.append("Set-Cookie", cookie);
    }
    headers.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${publicOrigin}${clientRedirect ? ` ${clientRedirect}` : ""}; base-uri 'none'; frame-ancestors 'none'`);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function clientRedirectCspSource(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return url.origin;
    if (["vscode:", "vscode-insiders:"].includes(url.protocol) && url.hostname) return url.protocol;
    return null;
  } catch {
    return null;
  }
}

function failure(status: number, browser: boolean, publicOrigin: string): Response {
  return responseHeaders(new Response(null, { status }), browser, publicOrigin);
}

export async function dispatchAdminMcp(request: Request, options: AdminMcpDispatchOptions): Promise<Response | null> {
  const url = new URL(request.url);
  if (!(ADMIN_MCP_PATHS as readonly string[]).includes(url.pathname)) return null;
  const browser = browserPaths.has(url.pathname);
  if (options.enabled !== true) return failure(404, browser, options.publicOrigin);
  if (url.origin !== options.publicOrigin) return failure(404, browser, options.publicOrigin);
  const origin = request.headers.get("Origin");
  const nullOriginSameSitePost = browser && request.method === "POST" && origin === "null" && request.headers.get("Sec-Fetch-Site") === "same-origin";
  if ((origin !== null && origin !== options.publicOrigin && !nullOriginSameSitePost)
    || (browser && request.method === "POST" && origin !== options.publicOrigin && !nullOriginSameSitePost)
    || (browser && request.headers.get("Sec-Fetch-Site") === "cross-site" && request.method !== "GET")) return failure(403, browser, options.publicOrigin);

  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  headers.delete("X-CSRF-Token");
  if (browser) {
    const allowedCookies = new Set(request.method === "GET" ? ["__Host-unidocs_admin", consentCookie] : [consentCookie]);
    const retained = new Map<string, string>();
    for (const segment of (request.headers.get("Cookie") ?? "").split(";")) {
      const cookie = segment.trim();
      const separator = cookie.indexOf("=");
      const name = cookie.slice(0, separator);
      if (separator < 0 || !allowedCookies.has(name)) continue;
      if (retained.has(name)) return failure(400, browser, options.publicOrigin);
      retained.set(name, cookie);
    }
    if (retained.size > 0) headers.set("Cookie", [...retained.values()].join("; "));
  }

  const limit = url.pathname === "/mcp" ? ADMIN_MCP_BODY_MAX_BYTES : ADMIN_MCP_OAUTH_BODY_MAX_BYTES;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
    await request.body?.cancel().catch(() => {});
    return failure(413, browser, options.publicOrigin);
  }
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.body) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of boundedBytes(request.body, limit)) {
        chunks.push(chunk);
        size += chunk.byteLength;
      }
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch {
      return failure(413, browser, options.publicOrigin);
    }
  }
  headers.delete("Content-Length");
  try {
    if (!options.handler) return failure(503, browser, options.publicOrigin);
    const sanitized = new Request(request.url, { method: request.method, headers, body, signal: request.signal, redirect: "manual" });
    return responseHeaders(await options.handler(sanitized), browser, options.publicOrigin);
  } catch {
    return failure(503, browser, options.publicOrigin);
  }
}