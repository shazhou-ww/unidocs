import { serveGatewayWebUi } from "./static-assets.js";

export interface AdminRoutingBindings {
  UNIDOCS_ADMIN_ENABLED?: string;
  UNIDOCS_ADMIN?: DurableObjectNamespace;
  readonly GATEWAY_PUBLIC_ORIGIN?: string;
  readonly GATEWAY_OIDC_REDIRECT_PATH?: string;
}

export async function routeAdmin(request: Request, env: AdminRoutingBindings): Promise<Response | null> {
  const url = new URL(request.url);
  const adminPath = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
  const callbackPath = env.GATEWAY_OIDC_REDIRECT_PATH;
  const googlePath = callbackPath && (url.pathname === callbackPath || url.pathname === callbackPath.replace(/\/callback$/, ""));
  if (!adminPath && !googlePath) return null;
  if (env.UNIDOCS_ADMIN_ENABLED !== "1") return adminPath ? new Response("Not found", { status: 404 }) : null;
  if (!env.UNIDOCS_ADMIN || !env.GATEWAY_PUBLIC_ORIGIN) return new Response("Management unavailable", { status: 503 });
  if (url.origin !== new URL(env.GATEWAY_PUBLIC_ORIGIN).origin) return new Response("Invalid management origin", { status: 403 });
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    const ui = serveGatewayWebUi(new Request(new URL("/ui/", url), { method: request.method }));
    if (ui) {
      ui.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      ui.headers.set("Referrer-Policy", "no-referrer");
      ui.headers.set("Cache-Control", "no-store");
    }
    return ui;
  }
  if (adminPath && !url.pathname.startsWith("/admin/api/v1/") && !url.pathname.startsWith("/admin/auth/")) return new Response("Not found", { status: 404 });
  return env.UNIDOCS_ADMIN.get(env.UNIDOCS_ADMIN.idFromName("unidocs-management-v1")).fetch(request);
}