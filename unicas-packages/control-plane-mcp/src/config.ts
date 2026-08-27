export const CONTROL_PLANE_MCP_PATH = "/mcp" as const;

export const CONTROL_PLANE_MCP_SCOPES = [
  "control:read",
  "control:write",
  "control:security",
] as const;

export interface ControlPlaneMcpConfig {
  readonly publicOrigin: string;
  readonly resource: string;
  readonly allowedOriginHostnames: readonly string[];
}

export interface ControlPlaneMcpEnvConfig {
  PUBLIC_ORIGIN?: string;
  MCP_ALLOWED_ORIGIN_HOSTNAMES?: string;
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  OAUTH_STATE_ENCRYPTION_KEY?: string;
  OIDC_ISSUER?: string;
  OIDC_DISCOVERY_URL?: string;
  ADMIN_EMAIL_ALLOWLIST?: string;
  CAS_AUDIT_READER_KEY?: string;
  MCP_MUTATIONS_ENABLED?: string;
}

export function mcpConfigFromEnv(env: ControlPlaneMcpEnvConfig): ControlPlaneMcpConfig {
  const publicOrigin = normalizeOrigin(env.PUBLIC_ORIGIN ?? "");
  const configuredOrigins = (env.MCP_ALLOWED_ORIGIN_HOSTNAMES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return {
    publicOrigin,
    resource: `${publicOrigin}/mcp`,
    allowedOriginHostnames: [...new Set(configuredOrigins)],
  };
}

export function emailAllowed(email: string | null, configuredAllowlist: string | undefined): boolean {
  if (email === null) return false;
  if (configuredAllowlist === undefined) return true;
  const allowed = new Set(configuredAllowlist
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0));
  return allowed.size > 0 && allowed.has(email.toLowerCase());
}

function normalizeOrigin(value: string): string {
  if (value.length === 0) throw new Error("PUBLIC_ORIGIN must be configured");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("PUBLIC_ORIGIN must use https outside local development");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_ORIGIN must contain only scheme, host, and optional port");
  }
  return url.origin;
}