import type {
  GatewayOAuthAuthenticatedUser,
  GatewayOAuthIdentityPort,
} from "@unidocs/gateway-oauth";

export interface CloudflareGatewayOAuthIdentityBindings {
  /** Never configure outside local Miniflare/test environments. */
  readonly GATEWAY_OAUTH_LOCAL_IDENTITY?: string;
  readonly GATEWAY_OAUTH_LOCAL_PRINCIPAL?: string;
  readonly GATEWAY_OAUTH_LOCAL_DISPLAY_NAME?: string;
}

const failClosedIdentity: GatewayOAuthIdentityPort = Object.freeze({
  async currentUser(): Promise<null> {
    return null;
  },
});

/**
 * Production remains fail closed until the Gateway has an application-owned
 * OIDC/session adapter. The fixed local identity requires both an unmistakable
 * opt-in and a loopback or reserved `.test` request host.
 */
export function createCloudflareGatewayOAuthIdentity(
  bindings: CloudflareGatewayOAuthIdentityBindings,
): GatewayOAuthIdentityPort {
  if (bindings.GATEWAY_OAUTH_LOCAL_IDENTITY === undefined) return failClosedIdentity;
  if (bindings.GATEWAY_OAUTH_LOCAL_IDENTITY !== "unsafe-development-only") {
    throw new Error("GATEWAY_OAUTH_LOCAL_IDENTITY has an invalid value");
  }
  const principalId = bindings.GATEWAY_OAUTH_LOCAL_PRINCIPAL?.trim();
  if (!principalId) throw new Error("GATEWAY_OAUTH_LOCAL_PRINCIPAL is required in local identity mode");
  const user = Object.freeze({
    principalId,
    displayName: bindings.GATEWAY_OAUTH_LOCAL_DISPLAY_NAME?.trim() || null,
  }) satisfies GatewayOAuthAuthenticatedUser;
  return Object.freeze({
    async currentUser(request: Request): Promise<GatewayOAuthAuthenticatedUser | null> {
      return isDevelopmentHost(new URL(request.url).hostname) ? user : null;
    },
  });
}

function isDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname.endsWith(".test");
}
