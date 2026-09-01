import type { CapabilityPermission, IssueCapabilityInput } from "@unidocs/service-auth";
import type { GatewayOAuthScope } from "./scopes.js";

export interface GatewayOAuthRegisteredClient {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly clientName: string | null;
  readonly createdAt: number;
}

export interface GatewayOAuthClientStorePort {
  find(clientId: string): Promise<GatewayOAuthRegisteredClient | null>;
  putIfAbsent(client: GatewayOAuthRegisteredClient): Promise<boolean>;
}

export interface GatewayOAuthAuthenticatedUser {
  /** Stable, server-derived identifier used as the capability subject. */
  readonly principalId: string;
  readonly displayName: string | null;
}

export interface GatewayOAuthIdentityPort {
  currentUser(request: Request): Promise<GatewayOAuthAuthenticatedUser | null>;
}

export interface GatewayOAuthTenantMembership {
  readonly tenantId: string;
  readonly scopes: readonly GatewayOAuthScope[];
  readonly refDomain?: string;
}

export interface GatewayOAuthTenantMembershipPort {
  find(principalId: string, tenantId: string): Promise<GatewayOAuthTenantMembership | null>;
}

export interface GatewayOAuthAuthorizationTransaction {
  readonly transactionId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly tenantId: string;
  readonly principalId: string | null;
  readonly requestedScopes: readonly GatewayOAuthScope[];
  readonly state: string | null;
  readonly codeChallenge: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface GatewayOAuthAuthorizationTransactionStorePort {
  putIfAbsent(transaction: GatewayOAuthAuthorizationTransaction): Promise<boolean>;
  /** Atomically consume a transaction; repeated calls return null. */
  take(transactionId: string): Promise<GatewayOAuthAuthorizationTransaction | null>;
}

export interface GatewayOAuthStoredAuthorizationCode {
  readonly codeHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly scopes: readonly GatewayOAuthScope[];
  readonly permissions: readonly CapabilityPermission[];
  readonly codeChallenge: string;
  readonly refDomain?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface GatewayOAuthAuthorizationCodeStorePort {
  putIfAbsent(code: GatewayOAuthStoredAuthorizationCode): Promise<boolean>;
  /** Atomically consume a hash-addressed code; every attempted exchange burns it. */
  take(codeHash: string): Promise<GatewayOAuthStoredAuthorizationCode | null>;
}

export interface GatewayOAuthStoredRefreshToken {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly generation: number;
  readonly clientId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly scopes: readonly GatewayOAuthScope[];
  readonly permissions: readonly CapabilityPermission[];
  readonly refDomain?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type GatewayOAuthRefreshRotationResult =
  | { readonly status: "rotated"; readonly token: GatewayOAuthStoredRefreshToken }
  | { readonly status: "invalid" | "replayed" };

export interface GatewayOAuthRefreshTokenStorePort {
  putInitial(token: GatewayOAuthStoredRefreshToken): Promise<boolean>;
  /**
   * Atomically consumes `currentHash` and inserts its successor under
   * `nextHash`. Reuse of a consumed token revokes the entire family and
   * returns `replayed`.
   */
  rotate(input: {
    readonly currentHash: string;
    readonly nextHash: string;
    readonly now: number;
  }): Promise<GatewayOAuthRefreshRotationResult>;
  /** RFC 7009-style idempotent revocation; implementations revoke the family. */
  revoke(tokenHash: string, clientId: string): Promise<void>;
}

export interface GatewayOAuthCapabilityIssuerPort {
  issue(input: IssueCapabilityInput): Promise<string>;
}

export interface GatewayOAuthClockPort {
  /** Current Unix epoch time in whole seconds. */
  now(): number;
}

export interface GatewayOAuthRandomPort {
  opaque(byteLength: number): string;
}

export interface GatewayOAuthHashPort {
  sha256Base64Url(value: string): Promise<string>;
}

export type GatewayOAuthAuditEvent =
  | {
    readonly action: "client.registered";
    readonly clientId: string;
    readonly redirectUriCount: number;
  }
  | {
    readonly action: "authorization.started" | "authorization.denied";
    readonly clientId: string;
    readonly tenantId: string;
    readonly scopes: readonly GatewayOAuthScope[];
  }
  | {
    readonly action: "authorization.approved";
    readonly clientId: string;
    readonly principalId: string;
    readonly tenantId: string;
    readonly scopes: readonly GatewayOAuthScope[];
  }
  | {
    readonly action: "token.issued" | "token.rejected";
    readonly clientId: string;
    readonly principalId?: string;
    readonly tenantId?: string;
    readonly scopes?: readonly GatewayOAuthScope[];
    readonly reason?: string;
  }
  | {
    readonly action: "refresh.rotated" | "refresh.rejected" | "refresh.revoked";
    readonly clientId: string;
    readonly principalId?: string;
    readonly tenantId?: string;
    readonly scopes?: readonly GatewayOAuthScope[];
    readonly reason?: string;
  };

export interface GatewayOAuthAuditPort {
  record(event: GatewayOAuthAuditEvent): void | Promise<void>;
}
