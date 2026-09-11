import { ADMIN_UI_ASSETS } from "./ui-assets.generated.js";

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

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
  const body = ADMIN_UI_ASSETS[path];
  if (body === undefined) return new Response("Admin WebUI asset not found", { status: 404 });
  const extensionAt = path.lastIndexOf(".");
  const extension = extensionAt === -1 ? "" : path.slice(extensionAt).toLowerCase();
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      "Cache-Control": path.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
    }
  });
}