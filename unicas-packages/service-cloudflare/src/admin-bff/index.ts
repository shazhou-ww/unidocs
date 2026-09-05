/** Dependency-free `/admin` BFF presentation exports. */

import { UI_ASSETS } from "./ui-assets.generated.js";

export { createAdminBff } from "./bff.js";
export type { CreateAdminBffOptions } from "./bff.js";
export { configFromEnv } from "./config.js";
export type { AdminBffConfig, AdminBffEnv } from "./config.js";
export { OidcClient } from "./oidc.js";
export { SessionCrypto } from "./session.js";
export { UI_ASSETS } from "./ui-assets.generated.js";

/** Inlined admin console assets (built by scripts/build-ui-assets.mjs). */
export function uiAssets(pathname: string): Promise<Response | null> {
  const content = UI_ASSETS[pathname];
  if (content === undefined) return Promise.resolve(null);
  return Promise.resolve(new Response(content, {
    headers: {
      "Content-Type": contentTypeFor(pathname),
      "Cache-Control": "no-cache",
    },
  }));
}

function contentTypeFor(pathname: string): string {
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
