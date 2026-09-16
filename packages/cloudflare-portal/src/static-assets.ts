import { ADMIN_UI_ASSETS } from "./ui-assets.generated.js";
import { TENANT_UI_ASSETS } from "./tenant-ui-assets.generated.js";

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * One embedded file, with the cache policy its kind earns: the shell must be
 * revalidated every load (it names the current hashed bundles), the hashed
 * bundles never change under their name.
 */
function assetResponse(assets: Readonly<Record<string, string>>, path: string, request: Request, missing: string): Response {
  const body = assets[path];
  if (body === undefined) return new Response(missing, { status: 404 });
  const extensionAt = path.lastIndexOf(".");
  const extension = extensionAt === -1 ? "" : path.slice(extensionAt).toLowerCase();
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      "Cache-Control": path.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
    }
  });
}

export function isProtectedAdminWebUiPath(pathname: string): boolean {
  return pathname === "/admin" || pathname === "/admin/" || pathname === "/admin/document-types"
    || pathname === "/admin/administrators" || pathname === "/admin/audit"
    || /^\/admin\/document-types\/[A-Za-z0-9!#$&^_.+-]+$/.test(pathname);
}

export function serveAdminWebUi(request: Request): Response | null {
  const url = new URL(request.url);
  if (!isProtectedAdminWebUiPath(url.pathname) && url.pathname !== "/admin/index.html" && url.pathname !== "/admin/login" && url.pathname !== "/admin/access-denied" && !url.pathname.startsWith("/admin/assets/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const path = isProtectedAdminWebUiPath(url.pathname) || url.pathname === "/admin/login" || url.pathname === "/admin/access-denied" ? "/admin/index.html" : url.pathname;
  return assetResponse(ADMIN_UI_ASSETS, path, request, "Admin WebUI asset not found");
}

export function isTenantWebUiPath(pathname: string): boolean {
  return pathname === "/portal" || pathname === "/portal/" || pathname === "/portal/index.html"
    || pathname.startsWith("/portal/assets/");
}

/**
 * The tenant WebUI, embedded and served on the portal's own origin exactly as
 * the admin one is.
 *
 * Two deliberate differences from `serveAdminWebUi`:
 *
 * - **No SPA fallback list.** The tenant UI is hash-routed (see its
 *   `src/router.ts`): every in-app location is `#/d/...`, so the shell and its
 *   hashed assets are the only real paths. There is nothing to fall back from,
 *   and inventing path routes here would serve the shell on URLs the app
 *   itself never produces.
 * - **No authentication gate, on purpose.** Because the app is hash-routed
 *   (above), the server never sees `#/d/...`; a server-side gate would 303 an
 *   unauthenticated deep link and lose that location across sign-in. The
 *   shell carries no data — the gate is on the tenant API instead. So
 *   `worker.ts` calls this ahead of the admin-shaped BFF, and sets the
 *   security headers itself since the BFF's do not apply here.
 *   `tests/production-routes-auth.test.ts` asserts the served shell carries
 *   no local identity strings and that `index.html` stays `no-store`.
 */
export function serveTenantWebUi(request: Request): Response | null {
  const url = new URL(request.url);
  if (!isTenantWebUiPath(url.pathname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const path = url.pathname.startsWith("/portal/assets/") ? url.pathname : "/portal/index.html";
  const response = assetResponse(TENANT_UI_ASSETS, path, request, "Tenant WebUI asset not found");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Two relaxations over the admin policy, both forced by what the tenant UI
  // actually loads:
  //
  // - `'unsafe-inline'` for styles: thread markers position themselves over
  //   the rendered document by writing element.style
  //   (tenant-portal-webui/src/view/markdown-view.ts).
  // - the two Google Fonts origins: `src/mock-base.css` opens with
  //   `@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC…')`,
  //   which pulls its font files from fonts.gstatic.com. It came in with the
  //   design mock and is the only external fetch anything in this repository
  //   makes from a browser; self-hosting the face would let both go.
  //
  // Scripts are not relaxed: `default-src 'self'` covers them, and every
  // bundle is served from this origin.
  response.headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  return response;
}
