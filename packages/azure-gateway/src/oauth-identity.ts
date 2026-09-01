import type { GatewayOAuthIdentityPort } from "@unidocs/gateway-oauth";

export interface AzureGatewayOAuthIdentityEnv {
  readonly GATEWAY_OAUTH_LOCAL_IDENTITY?: string;
  readonly GATEWAY_OAUTH_LOCAL_PRINCIPAL?: string;
  readonly GATEWAY_OAUTH_LOCAL_DISPLAY_NAME?: string;
}

export function createAzureGatewayOAuthIdentity(env: AzureGatewayOAuthIdentityEnv): GatewayOAuthIdentityPort {
  if (env.GATEWAY_OAUTH_LOCAL_IDENTITY === undefined) {
    return Object.freeze({ currentUser: async () => null });
  }
  if (env.GATEWAY_OAUTH_LOCAL_IDENTITY !== "unsafe-development-only") {
    throw new Error("GATEWAY_OAUTH_LOCAL_IDENTITY has an invalid value");
  }
  const principalId = env.GATEWAY_OAUTH_LOCAL_PRINCIPAL?.trim();
  if (!principalId) throw new Error("GATEWAY_OAUTH_LOCAL_PRINCIPAL is required in local identity mode");
  const displayName = env.GATEWAY_OAUTH_LOCAL_DISPLAY_NAME?.trim() || null;
  return Object.freeze({
    currentUser: async (request: Request) => isDevelopmentHost(new URL(request.url).hostname)
      ? { principalId, displayName }
      : null,
  });
}

function isDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname.endsWith(".test");
}
