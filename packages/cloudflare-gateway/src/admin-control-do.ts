import { AdminDirectory, AdminDirectoryError } from "@unidocs/gateway-common";
import { SqliteAdminDirectoryStore } from "./admin-directory-sqlite.js";
import { SqliteAdminSessionStore } from "./admin-session-store.js";
import { createAdminAuth } from "./admin-auth.js";
import { createCloudflareGatewayOAuthIdentity, type CloudflareGatewayOAuthIdentityBindings } from "./oauth-identity.js";
import { createAdminTypes, type AdminTypeBindings } from "./admin-type-service.js";

export interface AdminControlBindings extends CloudflareGatewayOAuthIdentityBindings, AdminTypeBindings {
  GATEWAY_OAUTH_ISSUER?: string;
  UNIDOCS_ADMIN_BOOTSTRAP_EMAIL?: string;
}

export class UniDocsAdminControl {
  private readonly handle: (request: Request) => Promise<Response | null>;
  private readonly google: ReturnType<typeof createCloudflareGatewayOAuthIdentity>;

  constructor(ctx: DurableObjectState, env: AdminControlBindings) {
    if (!env.GATEWAY_PUBLIC_ORIGIN || !env.GATEWAY_OAUTH_ISSUER || !env.GATEWAY_OIDC_CLIENT_ID || env.GATEWAY_OIDC_ISSUER !== "https://accounts.google.com") throw new Error("Google management configuration required");
    const directory = new AdminDirectory(new SqliteAdminDirectoryStore(ctx.storage));
    const sessions = new SqliteAdminSessionStore(ctx.storage);
    this.google = createCloudflareGatewayOAuthIdentity(env, env.GATEWAY_OAUTH_ISSUER, sessions);
    this.handle = createAdminAuth({ directory, sessions, google: this.google, origin: env.GATEWAY_PUBLIC_ORIGIN, types: createAdminTypes(directory, env) });
    ctx.blockConcurrencyWhile(async () => {
      if (!env.UNIDOCS_ADMIN_BOOTSTRAP_EMAIL) return;
      try { await directory.bootstrap(env.UNIDOCS_ADMIN_BOOTSTRAP_EMAIL); }
      catch (error) { if (!(error instanceof AdminDirectoryError) || error.code !== "already_initialized") throw error; }
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const login = await this.google.handleLogin(request);
      if (login) return login;
      return await this.handle(request) ?? new Response("Not found", { status: 404 });
    } catch {
      return Response.json({ error: { code: "management_unavailable" } }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
}