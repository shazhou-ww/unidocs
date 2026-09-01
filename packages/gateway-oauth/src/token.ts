import { GatewayOAuthProtocolError } from "./errors.js";
import { systemGatewayOAuthHash, systemGatewayOAuthRandom } from "./crypto.js";
import { verifyGatewayOAuthPkceS256 } from "./pkce.js";
import type {
  GatewayOAuthAuditPort,
  GatewayOAuthAuthorizationCodeStorePort,
  GatewayOAuthCapabilityIssuerPort,
  GatewayOAuthClockPort,
  GatewayOAuthHashPort,
  GatewayOAuthRandomPort,
} from "./ports.js";

export interface GatewayOAuthAuthorizationCodeTokenRequest {
  readonly grantType: string;
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface GatewayOAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: string;
}

export interface GatewayOAuthTokenPorts {
  readonly codes: GatewayOAuthAuthorizationCodeStorePort;
  readonly capabilityIssuer: GatewayOAuthCapabilityIssuerPort;
  readonly audience: string;
  readonly clock: GatewayOAuthClockPort;
  readonly random?: GatewayOAuthRandomPort;
  readonly hash?: GatewayOAuthHashPort;
  readonly audit?: GatewayOAuthAuditPort;
  readonly accessTokenLifetimeSeconds?: number;
}

export async function exchangeGatewayOAuthAuthorizationCode(
  request: GatewayOAuthAuthorizationCodeTokenRequest,
  ports: GatewayOAuthTokenPorts,
): Promise<GatewayOAuthTokenResponse> {
  if (request.grantType !== "authorization_code") {
    throw new GatewayOAuthProtocolError(
      "unsupported_grant_type",
      400,
      "grant_type must be authorization_code",
    );
  }
  requireNonEmpty(request.code, "code");
  requireNonEmpty(request.clientId, "client_id");
  requireNonEmpty(request.redirectUri, "redirect_uri");

  const hash = ports.hash ?? systemGatewayOAuthHash;
  const stored = await ports.codes.take(await hash.sha256Base64Url(request.code));
  if (!stored) {
    await ports.audit?.record({
      action: "token.rejected",
      clientId: request.clientId,
      reason: "invalid_or_replayed_code",
    });
    throw invalidGrant("authorization code is invalid or already used");
  }
  const reject = async (reason: string): Promise<never> => {
    await ports.audit?.record({
      action: "token.rejected",
      clientId: request.clientId,
      principalId: stored.principalId,
      tenantId: stored.tenantId,
      scopes: stored.scopes,
      reason,
    });
    throw invalidGrant("authorization code exchange failed");
  };

  const now = ports.clock.now();
  requireEpochSeconds(now);
  if (stored.expiresAt <= now) return reject("expired_code");
  if (stored.clientId !== request.clientId) return reject("client_mismatch");
  if (stored.redirectUri !== request.redirectUri) return reject("redirect_uri_mismatch");
  let verified = false;
  try {
    verified = await verifyGatewayOAuthPkceS256(request.codeVerifier, stored.codeChallenge, hash);
  } catch {
    return reject("invalid_code_verifier");
  }
  if (!verified) return reject("pkce_mismatch");
  if (ports.audience.length === 0) {
    throw new GatewayOAuthProtocolError("server_error", 500, "capability audience is not configured");
  }
  const lifetime = ports.accessTokenLifetimeSeconds ?? 120;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 1800) {
    throw new TypeError("OAuth access token lifetime must be an integer from 1 to 1800");
  }
  const random = ports.random ?? systemGatewayOAuthRandom;
  const accessToken = await ports.capabilityIssuer.issue({
    subject: stored.principalId,
    audience: ports.audience,
    tenantId: stored.tenantId,
    permissions: stored.permissions,
    lifetimeSeconds: lifetime,
    jti: random.opaque(24),
    ...(stored.refDomain === undefined ? {} : { refDomain: stored.refDomain }),
  });
  await ports.audit?.record({
    action: "token.issued",
    clientId: stored.clientId,
    principalId: stored.principalId,
    tenantId: stored.tenantId,
    scopes: stored.scopes,
  });
  return Object.freeze({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: lifetime,
    scope: stored.scopes.join(" "),
  });
}

function requireNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new GatewayOAuthProtocolError("invalid_request", 400, `${name} is required`);
  }
}

function invalidGrant(description: string): GatewayOAuthProtocolError {
  return new GatewayOAuthProtocolError("invalid_grant", 400, description);
}

function requireEpochSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("OAuth clock must return epoch seconds");
}
