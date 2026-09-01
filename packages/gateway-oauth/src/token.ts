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
  GatewayOAuthRefreshTokenStorePort,
  GatewayOAuthStoredRefreshToken,
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
  readonly refresh_token: string;
}

export interface GatewayOAuthRefreshTokenRequest {
  readonly grantType: string;
  readonly refreshToken: string;
  readonly clientId: string;
}

export interface GatewayOAuthTokenPorts {
  readonly codes: GatewayOAuthAuthorizationCodeStorePort;
  readonly capabilityIssuer: GatewayOAuthCapabilityIssuerPort;
  readonly refreshTokens: GatewayOAuthRefreshTokenStorePort;
  readonly audience: string;
  readonly clock: GatewayOAuthClockPort;
  readonly random?: GatewayOAuthRandomPort;
  readonly hash?: GatewayOAuthHashPort;
  readonly audit?: GatewayOAuthAuditPort;
  readonly accessTokenLifetimeSeconds?: number;
  readonly refreshTokenLifetimeSeconds?: number;
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
  const lifetime = accessTokenLifetime(ports.accessTokenLifetimeSeconds);
  const random = ports.random ?? systemGatewayOAuthRandom;
  const refreshLifetime = ports.refreshTokenLifetimeSeconds ?? 30 * 24 * 60 * 60;
  if (!Number.isSafeInteger(refreshLifetime) || refreshLifetime < 300 || refreshLifetime > 90 * 24 * 60 * 60) {
    throw new TypeError("OAuth refresh token lifetime must be an integer from 300 to 7776000");
  }
  const refresh = await createInitialRefreshToken({
    clientId: stored.clientId,
    principalId: stored.principalId,
    tenantId: stored.tenantId,
    scopes: stored.scopes,
    permissions: stored.permissions,
    ...(stored.refDomain === undefined ? {} : { refDomain: stored.refDomain }),
    createdAt: now,
    expiresAt: now + refreshLifetime,
  }, ports.refreshTokens, hash, random);
  let accessToken: string;
  try {
    accessToken = await issueAccessToken(stored, lifetime, ports, random);
  } catch (error) {
    await ports.refreshTokens.revoke(await hash.sha256Base64Url(refresh), stored.clientId);
    throw error;
  }
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
    refresh_token: refresh,
  });
}

export async function refreshGatewayOAuthAccessToken(
  request: GatewayOAuthRefreshTokenRequest,
  ports: GatewayOAuthTokenPorts,
): Promise<GatewayOAuthTokenResponse> {
  if (request.grantType !== "refresh_token") {
    throw new GatewayOAuthProtocolError("unsupported_grant_type", 400, "grant_type must be refresh_token");
  }
  requireNonEmpty(request.refreshToken, "refresh_token");
  requireNonEmpty(request.clientId, "client_id");
  const hash = ports.hash ?? systemGatewayOAuthHash;
  const random = ports.random ?? systemGatewayOAuthRandom;
  const currentHash = await hash.sha256Base64Url(request.refreshToken);
  const nextRefreshToken = random.opaque(48);
  const nextHash = await hash.sha256Base64Url(nextRefreshToken);
  const now = ports.clock.now();
  requireEpochSeconds(now);
  const rotation = await ports.refreshTokens.rotate({ currentHash, nextHash, now });
  if (rotation.status !== "rotated") {
    await ports.audit?.record({
      action: "refresh.rejected",
      clientId: request.clientId,
      reason: rotation.status,
    });
    throw invalidGrant("refresh token is invalid, expired, revoked, or already used");
  }
  const stored = rotation.token;
  if (stored.clientId !== request.clientId || stored.expiresAt <= now) {
    await ports.refreshTokens.revoke(nextHash, stored.clientId);
    await ports.audit?.record({
      action: "refresh.rejected",
      clientId: request.clientId,
      principalId: stored.principalId,
      tenantId: stored.tenantId,
      scopes: stored.scopes,
      reason: stored.clientId !== request.clientId ? "client_mismatch" : "expired",
    });
    throw invalidGrant("refresh token exchange failed");
  }
  const lifetime = accessTokenLifetime(ports.accessTokenLifetimeSeconds);
  let accessToken: string;
  try {
    accessToken = await issueAccessToken(stored, lifetime, ports, random);
  } catch (error) {
    await ports.refreshTokens.revoke(nextHash, stored.clientId);
    throw error;
  }
  await ports.audit?.record({
    action: "refresh.rotated",
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
    refresh_token: nextRefreshToken,
  });
}

export async function revokeGatewayOAuthRefreshToken(
  refreshToken: string,
  clientId: string,
  ports: Pick<GatewayOAuthTokenPorts, "refreshTokens" | "hash" | "audit">,
): Promise<void> {
  requireNonEmpty(refreshToken, "token");
  requireNonEmpty(clientId, "client_id");
  const hash = ports.hash ?? systemGatewayOAuthHash;
  await ports.refreshTokens.revoke(await hash.sha256Base64Url(refreshToken), clientId);
  await ports.audit?.record({ action: "refresh.revoked", clientId });
}

async function createInitialRefreshToken(
  value: Omit<GatewayOAuthStoredRefreshToken, "tokenHash" | "familyId" | "generation">,
  store: GatewayOAuthRefreshTokenStorePort,
  hash: GatewayOAuthHashPort,
  random: GatewayOAuthRandomPort,
): Promise<string> {
  const familyId = random.opaque(24);
  for (let attempt = 0; attempt < 3; attempt++) {
    const refreshToken = random.opaque(48);
    const tokenHash = await hash.sha256Base64Url(refreshToken);
    if (await store.putInitial(Object.freeze({
      ...value,
      tokenHash,
      familyId,
      generation: 0,
    }))) return refreshToken;
  }
  throw new GatewayOAuthProtocolError("server_error", 500, "could not allocate a refresh token");
}

async function issueAccessToken(
  stored: Pick<GatewayOAuthStoredRefreshToken, "principalId" | "tenantId" | "permissions" | "refDomain">,
  lifetime: number,
  ports: GatewayOAuthTokenPorts,
  random: GatewayOAuthRandomPort,
): Promise<string> {
  return ports.capabilityIssuer.issue({
    subject: stored.principalId,
    audience: ports.audience,
    tenantId: stored.tenantId,
    permissions: stored.permissions,
    lifetimeSeconds: lifetime,
    jti: random.opaque(24),
    ...(stored.refDomain === undefined ? {} : { refDomain: stored.refDomain }),
  });
}

function accessTokenLifetime(value: number | undefined): number {
  const lifetime = value ?? 120;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 1800) {
    throw new TypeError("OAuth access token lifetime must be an integer from 1 to 1800");
  }
  return lifetime;
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
