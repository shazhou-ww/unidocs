/**
 * Production data-plane identity for the UniDocs Gateway.
 *
 * The Gateway is its own Stack OAuth authorization server: it issues the
 * existing UniCAS capability JWT as the OAuth access token after user
 * authorization (see `@unidocs/gateway-oauth`). Every data-plane request is
 * authorized by validating that Bearer token against the Gateway's own
 * issuer and its published JWKS (the same keys served at `jwks_uri`), then
 * mapping the signed `tenantId` / `permissions` claims onto the tenant
 * identity the router needs.
 *
 * This replaces the development-only path identity resolver on the
 * production authorization path. The path resolver remains available only as
 * an explicit local-development opt-in (`INSECURE_PATH_IDENTITY=true`), and
 * only when a request carries no Bearer token at all — a presented-but-invalid
 * token always fails closed.
 */

import type { JSONWebKeySet } from "jose";
import {
  CapabilityAlgorithm,
  CapabilityVerifier,
  casManagePermission,
} from "@unidocs/service-auth";
import type { GatewayIdentity, GatewayIdentityResolver } from "./identity.js";
import { createInsecureTenantIdentityResolver } from "./identity.js";

/** Permission kinds an OAuth access token may carry on the data plane. */
const DATA_PLANE_PERMISSION_KINDS = ["cas:read", "cas:write", "cas:manage"] as const;

export interface OAuthAccessTokenIdentityConfig {
  /** Exact issuer of the access tokens; must equal the Gateway OAuth issuer. */
  readonly issuer: string;
  /** Audience the Gateway issues access tokens for (CAS capability audience). */
  readonly audience: string;
  /**
   * The issuer's public keys. On Cloudflare this is derived from the same
   * stack private key the OAuth discovery endpoint publishes at `jwks_uri`;
   * the keyset is identical, so verification is exactly the "issuer + JWKS"
   * contract without a self-referential live fetch.
   */
  readonly jwks: JSONWebKeySet;
  readonly maximumLifetimeSeconds?: number;
  readonly clockSkewSeconds?: number;
  readonly now?: () => number;
}

export interface DataPlaneIdentityOptions {
  /**
   * Access-token verification configuration. When omitted, any request
   * carrying a Bearer token fails closed (there is no trusted issuer).
   */
  readonly accessToken?: OAuthAccessTokenIdentityConfig;
  /**
   * Local-development-only fallback: a request with no Authorization header
   * is resolved to the path identity. Never enable in production.
   */
  readonly allowPathIdentity: boolean;
}

export function createOAuthAccessTokenIdentityResolver(
  config: OAuthAccessTokenIdentityConfig,
): GatewayIdentityResolver {
  const verifier = new CapabilityVerifier({
    issuer: config.issuer,
    audience: config.audience,
    algorithm: CapabilityAlgorithm,
    jwks: config.jwks,
    allowedPermissionKinds: DATA_PLANE_PERMISSION_KINDS,
    ...(config.maximumLifetimeSeconds === undefined
      ? {}
      : { maximumLifetimeSeconds: config.maximumLifetimeSeconds }),
    ...(config.clockSkewSeconds === undefined
      ? {}
      : { clockSkewSeconds: config.clockSkewSeconds }),
    ...(config.now === undefined ? {} : { now: config.now }),
  });

  return {
    async resolve(request, requestedTenantId): Promise<GatewayIdentity | null> {
      const token = bearerToken(request.headers.get("Authorization"));
      if (token === null) return null;
      let verified;
      try {
        verified = await verifier.verify(token);
      } catch {
        return null;
      }
      const claims = verified.claims;
      if (claims.tenantId !== requestedTenantId) return null;
      return Object.freeze({
        userId: claims.sub,
        tenantId: claims.tenantId,
        canManageTenant: claims.permissions.includes(casManagePermission(requestedTenantId)),
      });
    },
  };
}

export function createDataPlaneIdentityResolver(
  options: DataPlaneIdentityOptions,
): GatewayIdentityResolver {
  const tokenResolver = options.accessToken
    ? createOAuthAccessTokenIdentityResolver(options.accessToken)
    : null;
  const pathResolver = createInsecureTenantIdentityResolver(options.allowPathIdentity);
  return {
    async resolve(request, requestedTenantId): Promise<GatewayIdentity | null> {
      const authorization = request.headers.get("Authorization");
      if (authorization !== null && authorization.length > 0) {
        if (tokenResolver === null) return null;
        return tokenResolver.resolve(request, requestedTenantId);
      }
      return pathResolver.resolve(request, requestedTenantId);
    },
  };
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return null;
  return match[1]!;
}
