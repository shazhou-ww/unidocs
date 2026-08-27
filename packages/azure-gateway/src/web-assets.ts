/**
 * Serve the built web-psd app from the Gateway's own origin.
 *
 * Same-origin is the point: the dev setup relies on Vite proxying `/gw/*` to
 * the gateway to dodge CORS, and shipping the SPA from any other host would
 * mean adding CORS to the gateway instead. Served from here, the browser's
 * API calls are already same-origin and `web-psd/src/main.ts` drops its `/gw`
 * prefix in a production build.
 *
 * Routing rule: `/tenants/*` always belongs to the API. Everything else is a
 * UI path, with unknown paths falling back to `index.html` so client-side
 * routes survive a reload.
 */
import { WEB_ASSETS } from "./web-assets.generated.js";

const CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  psd: "image/vnd.adobe.photoshop",
  svg: "image/svg+xml",
  wasm: "application/wasm",
  woff2: "font/woff2",
};

export function contentTypeFor(pathname: string): string {
  const extension = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function hasWebAssets(): boolean {
  return Object.keys(WEB_ASSETS).length > 0;
}

/** `Uint8Array.from` copies into an exactly-sized buffer, so `.buffer` carries
 *  no trailing slack from Buffer's pooled allocator. */
function decode(base64: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(base64, "base64")).buffer as ArrayBuffer;
}

/**
 * Returns the UI response for a request, or null when the request belongs to
 * the API (or there is no UI bundled in this build).
 */
export function webAssetResponse(request: Request): Response | null {
  if (!hasWebAssets()) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const { pathname } = new URL(request.url);
  // The API owns this prefix outright — never shadow it with a UI fallback,
  // or a typo'd API path would return HTML with a 200 instead of a 404.
  if (pathname === "/tenants" || pathname.startsWith("/tenants/")) return null;

  const direct = WEB_ASSETS[pathname];
  if (direct !== undefined) return asset(pathname, direct, true);

  // Hashed filenames under /assets are immutable; a miss there is a genuine
  // 404, not a client-side route worth serving index.html for.
  if (pathname.startsWith("/assets/")) return null;

  const index = WEB_ASSETS["/index.html"];
  if (index === undefined) return null;
  return asset("/index.html", index, false);
}

function asset(pathname: string, base64: string, immutable: boolean): Response {
  return new Response(decode(base64), {
    headers: {
      "Content-Type": contentTypeFor(pathname),
      // Vite emits content-hashed asset names, so those are safe to pin.
      // index.html must never be, or a deploy would not reach returning users.
      "Cache-Control": immutable && pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}
