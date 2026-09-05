/**
 * Read-only D1-backed stack authority repository.
 *
 * The registry is written exclusively by the control plane through the Stack
 * OAuth discovery/activation flow. Signing keys are resolved from the
 * discovered jwks_uri, with refresh bounded by the verifier's cache policy.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type {
  ResolvedStackAuthority,
  StackAuthorityResolver,
} from "@unicas/service";

export class AuthorityRepository implements StackAuthorityResolver {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Resolve a globally unique issuer to its stack authority; null when
   *  unknown. The issuer value is unique across stacks (registry invariant). */
  async resolveIssuer(issuer: string): Promise<ResolvedStackAuthority | null> {
    const oauthRow = await this.#db
      .prepare(
        `SELECT stack_id, issuer, audience, jwks_uri, capability_max_lifetime_seconds
         FROM cas_stack_oauth_issuers WHERE issuer = ? AND status = 'active' AND mode = 'external'
         UNION ALL
         SELECT stack_id, issuer, audience, jwks_uri, capability_max_lifetime_seconds
         FROM cas_stack_managed_issuers WHERE issuer = ? AND status = 'active'
         LIMIT 1`,
      )
      .bind(issuer, issuer)
      .first<IssuerRow>();
    if (!oauthRow) return null;
    return toAuthority(oauthRow);
  }
}

function toAuthority(row: IssuerRow): ResolvedStackAuthority {
  return {
    stackId: row.stack_id,
    issuer: row.issuer,
    audience: row.audience,
    jwksUri: row.jwks_uri,
    capabilityMaxLifetimeSeconds: row.capability_max_lifetime_seconds,
  };
}

interface IssuerRow {
  readonly stack_id: string;
  readonly issuer: string;
  readonly audience: string;
  readonly jwks_uri: string;
  readonly capability_max_lifetime_seconds: number;
}
