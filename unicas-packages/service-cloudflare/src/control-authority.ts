/**
 * Read-only D1-backed stack authority repository.
 *
 * The registry is written exclusively by the control plane. Revocation and
 * key-removal propagation is bounded by the verifier's cache policy.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type {
  RegisteredStackKey,
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
        "SELECT stack_id, issuer, audience, capability_max_lifetime_seconds FROM cas_stack_oauth_issuers WHERE issuer = ? AND status = 'active'",
      )
      .bind(issuer)
      .first<IssuerRow>();
    if (oauthRow) {
      const oauthKeys = await this.#db
        .prepare(
          "SELECT kid, algorithm, public_jwk, 'active' AS state FROM cas_stack_oauth_issuer_keys WHERE stack_id = ? ORDER BY kid",
        )
        .bind(oauthRow.stack_id)
        .all<KeyRow>();
      const keys = oauthKeys.results ?? [];
      if (keys.length === 0) return null;
      return toAuthority(oauthRow, keys);
    }
    const row = await this.#db
      .prepare(
        "SELECT legacy.stack_id, legacy.issuer, legacy.audience, legacy.capability_max_lifetime_seconds FROM cas_stack_issuer legacy WHERE legacy.issuer = ? AND NOT EXISTS (SELECT 1 FROM cas_stack_oauth_issuers oauth WHERE oauth.stack_id = legacy.stack_id AND oauth.status = 'active')",
      )
      .bind(issuer)
      .first<IssuerRow>();
    if (!row) return null;
    const keyRows = await this.#db
      .prepare(
        "SELECT kid, algorithm, public_jwk, state FROM cas_stack_issuer_keys WHERE stack_id = ? ORDER BY kid",
      )
      .bind(row.stack_id)
      .all<KeyRow>();
    return toAuthority(row, keyRows.results ?? []);
  }
}

function toAuthority(row: IssuerRow, keys: readonly KeyRow[]): ResolvedStackAuthority {
  return {
    stackId: row.stack_id,
    issuer: row.issuer,
    audience: row.audience,
    capabilityMaxLifetimeSeconds: row.capability_max_lifetime_seconds,
    keys: keys.map((key): RegisteredStackKey => ({
      kid: key.kid,
      algorithm: key.algorithm,
      publicJwk: JSON.parse(key.public_jwk) as Record<string, unknown>,
      state: key.state as RegisteredStackKey["state"],
    })),
  };
}

interface IssuerRow {
  readonly stack_id: string;
  readonly issuer: string;
  readonly audience: string;
  readonly capability_max_lifetime_seconds: number;
}

interface KeyRow {
  readonly kid: string;
  readonly algorithm: string;
  readonly public_jwk: string;
  readonly state: string;
}