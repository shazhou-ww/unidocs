/**
 * Serves the embedded gateway webui (packages/web-gateway) at /ui/*.
 * Unknown /ui/* paths fall back to index.html so the SPA can handle routes
 * like /ui/callback itself. Never used for the API surface.
 */

import { UI_ASSETS } from "./ui-assets.generated.js";

const UI_MOUNT = "/ui/";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function serveGatewayWebUi(request: Request): Response | null {
  const url = new URL(request.url);
  const isRoot = url.pathname === "/" || url.pathname === "/index.html";
  if (!isRoot && url.pathname !== "/ui" && !url.pathname.startsWith(UI_MOUNT)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  // The bare domain root serves the webui (its assets resolve under /ui/*).
  const requested = isRoot ? "/ui/index.html" : url.pathname === "/ui" ? "/ui/index.html" : url.pathname;
  const asset = UI_ASSETS[requested];
  if (asset === undefined) {
    // SPA fallback: any unknown /ui/* path (e.g. /ui/callback) serves the app.
    const index = UI_ASSETS["/ui/index.html"];
    if (index === undefined) {
      return new Response("Gateway webui is not built", { status: 503 });
    }
    return textResponse(index, CONTENT_TYPES[".html"], true);
  }
  return textResponse(asset, contentType(requested), false);
}

function textResponse(body: string, contentTypeValue: string, spaFallback: boolean): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentTypeValue,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": spaFallback ? "no-store" : "public, max-age=31536000, immutable",
    },
  });
}
