import { GatewayOAuthProtocolError } from "./errors.js";
import { systemGatewayOAuthRandom } from "./crypto.js";
import type {
  GatewayOAuthAuditPort,
  GatewayOAuthClientStorePort,
  GatewayOAuthClockPort,
  GatewayOAuthRandomPort,
  GatewayOAuthRegisteredClient,
} from "./ports.js";

export interface GatewayOAuthClientRegistrationRequest {
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method?: "none" | string;
  readonly client_name?: string;
}

export interface GatewayOAuthClientRegistrationResponse {
  readonly client_id: string;
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method: "none";
  readonly client_name?: string;
}

export interface GatewayOAuthClientRegistrationPorts {
  readonly clients: GatewayOAuthClientStorePort;
  readonly clock: GatewayOAuthClockPort;
  readonly random?: GatewayOAuthRandomPort;
  readonly audit?: GatewayOAuthAuditPort;
}

export function validateGatewayOAuthRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidClientMetadata("redirect_uris must contain absolute URLs");
  }
  if (url.username || url.password || url.hash) {
    throw invalidClientMetadata("redirect URIs must not contain credentials or fragments");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw invalidClientMetadata("redirect URIs must use HTTPS except native loopback redirects");
  }
  if (url.hostname.includes("*")) throw invalidClientMetadata("redirect URI hosts must not contain wildcards");
  return value;
}

export function gatewayOAuthRedirectUriMatches(
  registeredUri: string,
  requestedUri: string,
): boolean {
  if (registeredUri === requestedUri) return true;
  const registered = new URL(registeredUri);
  const requested = new URL(requestedUri);
  if (registered.protocol !== "http:" || requested.protocol !== "http:"
    || !isLoopbackHost(registered.hostname) || registered.hostname !== requested.hostname) {
    return false;
  }
  registered.port = "";
  requested.port = "";
  return registered.href === requested.href;
}

export async function registerGatewayOAuthClient(
  request: GatewayOAuthClientRegistrationRequest,
  ports: GatewayOAuthClientRegistrationPorts,
): Promise<GatewayOAuthClientRegistrationResponse> {
  if (request.token_endpoint_auth_method !== undefined
    && request.token_endpoint_auth_method !== "none") {
    throw invalidClientMetadata("only public clients with token_endpoint_auth_method none are supported");
  }
  if (!Array.isArray(request.redirect_uris) || request.redirect_uris.length === 0
    || request.redirect_uris.length > 20) {
    throw invalidClientMetadata("redirect_uris must contain between 1 and 20 entries");
  }
  const redirectUris = request.redirect_uris.map(validateGatewayOAuthRedirectUri);
  if (new Set(redirectUris).size !== redirectUris.length) {
    throw invalidClientMetadata("redirect_uris must not contain duplicates");
  }
  const clientName = optionalBoundedText(request.client_name, "client_name", 200);
  const random = ports.random ?? systemGatewayOAuthRandom;
  const now = ports.clock.now();
  requireEpochSeconds(now);

  for (let attempt = 0; attempt < 3; attempt++) {
    const clientId = random.opaque(24);
    const client: GatewayOAuthRegisteredClient = Object.freeze({
      clientId,
      redirectUris: Object.freeze([...redirectUris]),
      clientName,
      createdAt: now,
    });
    if (await ports.clients.putIfAbsent(client)) {
      await ports.audit?.record({
        action: "client.registered",
        clientId,
        redirectUriCount: redirectUris.length,
      });
      return Object.freeze({
        client_id: clientId,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        ...(clientName === null ? {} : { client_name: clientName }),
      });
    }
  }
  throw new GatewayOAuthProtocolError("server_error", 500, "could not allocate a client identifier");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

function optionalBoundedText(value: string | undefined, name: string, maximum: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) {
    throw invalidClientMetadata(`${name} must contain between 1 and ${maximum} characters`);
  }
  return trimmed;
}

function invalidClientMetadata(description: string): GatewayOAuthProtocolError {
  return new GatewayOAuthProtocolError("invalid_client_metadata", 400, description);
}

function requireEpochSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("OAuth clock must return epoch seconds");
}
