import { GatewayOAuthProtocolError } from "./errors.js";
import { systemGatewayOAuthHash, systemGatewayOAuthRandom } from "./crypto.js";
import { gatewayOAuthRedirectUriMatches, validateGatewayOAuthRedirectUri } from "./client-registration.js";
import { validateGatewayOAuthPkceS256Challenge } from "./pkce.js";
import {
  gatewayOAuthScopesToCapabilityPermissions,
  isGatewayOAuthScope,
  type GatewayOAuthScope,
} from "./scopes.js";
import type {
  GatewayOAuthAuditPort,
  GatewayOAuthAuthenticatedUser,
  GatewayOAuthAuthorizationCodeStorePort,
  GatewayOAuthAuthorizationTransactionStorePort,
  GatewayOAuthClientStorePort,
  GatewayOAuthClockPort,
  GatewayOAuthHashPort,
  GatewayOAuthRandomPort,
  GatewayOAuthTenantMembershipPort,
} from "./ports.js";

export interface GatewayOAuthAuthorizationRequest {
  readonly responseType: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly tenantId: string;
  readonly scope: string;
  readonly state?: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
}

export interface GatewayOAuthPendingAuthorization {
  readonly transactionId: string;
  readonly clientId: string;
  readonly tenantId: string;
  readonly scopes: readonly GatewayOAuthScope[];
  readonly expiresAt: number;
}

export interface GatewayOAuthAuthorizationResult {
  readonly redirectUri: string;
  readonly state: string | null;
  readonly code?: string;
  readonly error?: "access_denied";
}

export interface GatewayOAuthAuthorizationPorts {
  readonly clients: GatewayOAuthClientStorePort;
  readonly transactions: GatewayOAuthAuthorizationTransactionStorePort;
  readonly codes: GatewayOAuthAuthorizationCodeStorePort;
  readonly memberships: GatewayOAuthTenantMembershipPort;
  readonly clock: GatewayOAuthClockPort;
  readonly random?: GatewayOAuthRandomPort;
  readonly hash?: GatewayOAuthHashPort;
  readonly audit?: GatewayOAuthAuditPort;
  readonly transactionLifetimeSeconds?: number;
  readonly codeLifetimeSeconds?: number;
}

export async function startGatewayOAuthAuthorization(
  request: GatewayOAuthAuthorizationRequest,
  ports: GatewayOAuthAuthorizationPorts,
): Promise<GatewayOAuthPendingAuthorization> {
  if (request.responseType !== "code") {
    throw protocolError("unsupported_response_type", "response_type must be code");
  }
  if (request.clientId.length === 0) throw protocolError("invalid_request", "client_id is required");
  const client = await ports.clients.find(request.clientId);
  if (!client) throw protocolError("invalid_client", "client_id is not registered");
  validateGatewayOAuthRedirectUri(request.redirectUri);
  if (!client.redirectUris.some(uri => gatewayOAuthRedirectUriMatches(uri, request.redirectUri))) {
    throw protocolError("invalid_request", "redirect_uri is not registered for this client");
  }
  if (request.tenantId.length === 0) throw protocolError("invalid_request", "tenant_id is required");
  const scopes = parseGatewayOAuthScope(request.scope);
  if (request.codeChallengeMethod !== "S256") {
    throw protocolError("invalid_request", "code_challenge_method must be S256");
  }
  try {
    validateGatewayOAuthPkceS256Challenge(request.codeChallenge);
  } catch (error) {
    throw protocolError("invalid_request", messageOf(error));
  }
  if (request.state !== undefined && request.state.length > 2048) {
    throw protocolError("invalid_request", "state must not exceed 2048 characters");
  }

  const now = ports.clock.now();
  requireEpochSeconds(now);
  const lifetime = boundedLifetime(ports.transactionLifetimeSeconds ?? 600, "transaction", 60, 900);
  const random = ports.random ?? systemGatewayOAuthRandom;
  for (let attempt = 0; attempt < 3; attempt++) {
    const transactionId = random.opaque(32);
    const transaction = Object.freeze({
      transactionId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      tenantId: request.tenantId,
      requestedScopes: scopes,
      state: request.state ?? null,
      codeChallenge: request.codeChallenge,
      createdAt: now,
      expiresAt: now + lifetime,
    });
    if (await ports.transactions.putIfAbsent(transaction)) {
      await ports.audit?.record({
        action: "authorization.started",
        clientId: request.clientId,
        tenantId: request.tenantId,
        scopes,
      });
      return Object.freeze({
        transactionId,
        clientId: request.clientId,
        tenantId: request.tenantId,
        scopes,
        expiresAt: transaction.expiresAt,
      });
    }
  }
  throw new GatewayOAuthProtocolError("server_error", 500, "could not allocate an authorization transaction");
}

export async function completeGatewayOAuthAuthorization(
  transactionId: string,
  decision: { readonly approved: boolean; readonly user: GatewayOAuthAuthenticatedUser },
  ports: GatewayOAuthAuthorizationPorts,
): Promise<GatewayOAuthAuthorizationResult> {
  const transaction = await ports.transactions.take(transactionId);
  if (!transaction) throw protocolError("invalid_request", "authorization transaction is invalid or already used");
  const now = ports.clock.now();
  requireEpochSeconds(now);
  if (transaction.expiresAt <= now) {
    throw protocolError("invalid_request", "authorization transaction has expired");
  }
  if (!decision.approved) {
    await ports.audit?.record({
      action: "authorization.denied",
      clientId: transaction.clientId,
      tenantId: transaction.tenantId,
      scopes: transaction.requestedScopes,
    });
    return Object.freeze({
      redirectUri: transaction.redirectUri,
      state: transaction.state,
      error: "access_denied",
    });
  }
  if (decision.user.principalId.length === 0) {
    throw protocolError("invalid_request", "authenticated principal is invalid");
  }
  const membership = await ports.memberships.find(
    decision.user.principalId,
    transaction.tenantId,
  );
  if (!membership || membership.tenantId !== transaction.tenantId) {
    throw new GatewayOAuthProtocolError("invalid_scope", 403, "user is not a member of the requested tenant");
  }
  const allowed = new Set(membership.scopes);
  if (!transaction.requestedScopes.every(scope => allowed.has(scope))) {
    throw new GatewayOAuthProtocolError("invalid_scope", 403, "requested scopes exceed tenant membership");
  }

  const random = ports.random ?? systemGatewayOAuthRandom;
  const hash = ports.hash ?? systemGatewayOAuthHash;
  const codeLifetime = boundedLifetime(ports.codeLifetimeSeconds ?? 60, "authorization code", 30, 300);
  const permissions = gatewayOAuthScopesToCapabilityPermissions(
    transaction.tenantId,
    transaction.requestedScopes,
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = random.opaque(32);
    const codeHash = await hash.sha256Base64Url(code);
    if (await ports.codes.putIfAbsent(Object.freeze({
      codeHash,
      clientId: transaction.clientId,
      redirectUri: transaction.redirectUri,
      principalId: decision.user.principalId,
      tenantId: transaction.tenantId,
      scopes: transaction.requestedScopes,
      permissions,
      codeChallenge: transaction.codeChallenge,
      ...(membership.refDomain === undefined ? {} : { refDomain: membership.refDomain }),
      createdAt: now,
      expiresAt: now + codeLifetime,
    }))) {
      await ports.audit?.record({
        action: "authorization.approved",
        clientId: transaction.clientId,
        principalId: decision.user.principalId,
        tenantId: transaction.tenantId,
        scopes: transaction.requestedScopes,
      });
      return Object.freeze({ redirectUri: transaction.redirectUri, state: transaction.state, code });
    }
  }
  throw new GatewayOAuthProtocolError("server_error", 500, "could not allocate an authorization code");
}

function parseGatewayOAuthScope(value: string): readonly GatewayOAuthScope[] {
  const values = value.split(" ").filter(Boolean);
  if (values.length === 0) throw protocolError("invalid_scope", "scope must not be empty");
  const unique = new Set<GatewayOAuthScope>();
  for (const scope of values) {
    if (!isGatewayOAuthScope(scope)) throw protocolError("invalid_scope", `unsupported scope: ${scope}`);
    unique.add(scope);
  }
  return Object.freeze([...unique]);
}

function protocolError(
  code: "invalid_request" | "invalid_client" | "invalid_scope" | "unsupported_response_type",
  description: string,
): GatewayOAuthProtocolError {
  return new GatewayOAuthProtocolError(code, 400, description);
}

function boundedLifetime(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`OAuth ${label} lifetime must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireEpochSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("OAuth clock must return epoch seconds");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "invalid PKCE challenge";
}
