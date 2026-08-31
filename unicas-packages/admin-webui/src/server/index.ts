/**
 * `/admin` BFF Worker entry. Wires bindings into the testable `createAdminBff`
 * and runs CAS_CONTROL_DB migrations at startup.
 *
 * Secret material (Google client credentials, session encryption keys) is read
 * only here and never reaches browser code. This Worker has no binding to
 * tenant D1/R2/DO and does not import tenant worker/DO implementation modules.
 */

import { migrateControlSchema } from "@unicas/control-plane";
import { createAdminBff } from "./bff.js";
import { configFromEnv } from "./config.js";
import type { AdminBffEnv } from "./config.js";
import { UI_ASSETS } from "./ui-assets.generated.js";

export { createAdminBff } from "./bff.js";
export { configFromEnv } from "./config.js";
export { OidcClient } from "./oidc.js";
export { SessionCrypto } from "./session.js";
export { UI_ASSETS } from "./ui-assets.generated.js";

export interface Env extends AdminBffEnv {
  CAS_CONTROL_DB: D1Database;
  /** Private tenant audit-reader service binding (Task 7+). */
  CAS_TENANT_AUDIT_READER?: Fetcher;
}

/** Inlined admin console assets (built by scripts/build-ui-assets.mjs). */
function uiAssets(pathname: string): Promise<Response | null> {
  const content = UI_ASSETS[pathname];
  if (content === undefined) return Promise.resolve(null);
  // Skill files are fetched by agents and should never be cached as
  // immutable; revalidate on every request so updates propagate.
  const cacheControl = pathname.startsWith("/assets/skills/")
    ? "no-cache"
    : "public, max-age=31536000, immutable";
  return Promise.resolve(new Response(content, {
    headers: {
      "Content-Type": contentTypeFor(pathname),
      "Cache-Control": cacheControl,
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Internal readiness probe used when testing this transitional adapter.
    if (request.method === "GET" && url.pathname === "/_internal/health") {
      return Response.json({ ok: true, service: "unidocs-cas-admin" });
    }
    const config = configFromEnv(env);
    await migrateControlSchema(env.CAS_CONTROL_DB);
    const adminFetch = createAdminBff({
      config,
      db: env.CAS_CONTROL_DB,
      auditReader: env.CAS_TENANT_AUDIT_READER,
      assets: uiAssets,
    });
    return adminFetch(request);
  },
};
