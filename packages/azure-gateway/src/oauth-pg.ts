import type {
  GatewayOAuthAuditEvent,
  GatewayOAuthAuditPort,
  GatewayOAuthAuthorizationCodeStorePort,
  GatewayOAuthAuthorizationTransaction,
  GatewayOAuthAuthorizationTransactionStorePort,
  GatewayOAuthClientStorePort,
  GatewayOAuthRefreshRotationResult,
  GatewayOAuthRefreshTokenStorePort,
  GatewayOAuthRegisteredClient,
  GatewayOAuthStoredAuthorizationCode,
  GatewayOAuthStoredRefreshToken,
  GatewayOAuthTenantMembership,
  GatewayOAuthTenantMembershipPort,
  GatewayOAuthScope,
} from "@unidocs/gateway-oauth";
import type { CapabilityPermission } from "@unidocs/service-auth";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

interface ClientRow extends QueryResultRow {
  client_id: string;
  redirect_uris_json: unknown;
  client_name: string | null;
  created_at: string | number;
}

interface TransactionRow extends QueryResultRow {
  transaction_id: string;
  client_id: string;
  redirect_uri: string;
  tenant_id: string;
  principal_id: string | null;
  requested_scopes_json: unknown;
  state: string | null;
  code_challenge: string;
  created_at: string | number;
  expires_at: string | number;
}

interface CodeRow extends QueryResultRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  principal_id: string;
  tenant_id: string;
  scopes_json: unknown;
  permissions_json: unknown;
  code_challenge: string;
  ref_domain: string | null;
  created_at: string | number;
  expires_at: string | number;
}

interface RefreshRow extends QueryResultRow {
  token_hash: string;
  family_id: string;
  generation: number;
  client_id: string;
  principal_id: string;
  tenant_id: string;
  scopes_json: unknown;
  permissions_json: unknown;
  ref_domain: string | null;
  created_at: string | number;
  expires_at: string | number;
  consumed_at: string | number | null;
  revoked_at: string | number | null;
}

interface MembershipRow extends QueryResultRow {
  tenant_id: string;
  scopes_json: unknown;
  ref_domain: string | null;
}

export class PgGatewayOAuthClientStore implements GatewayOAuthClientStorePort {
  constructor(readonly db: Queryable) { }

  async find(clientId: string): Promise<GatewayOAuthRegisteredClient | null> {
    const result = await this.db.query<ClientRow>(
      "SELECT client_id, redirect_uris_json, client_name, created_at FROM gateway_oauth_clients WHERE client_id = $1",
      [clientId],
    );
    const row = result.rows[0];
    return row ? Object.freeze({
      clientId: row.client_id,
      redirectUris: stringArray(row.redirect_uris_json, "client redirect URIs"),
      clientName: row.client_name,
      createdAt: Number(row.created_at),
    }) : null;
  }

  async putIfAbsent(client: GatewayOAuthRegisteredClient): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO gateway_oauth_clients (client_id, redirect_uris_json, client_name, created_at)
       VALUES ($1, $2::jsonb, $3, $4) ON CONFLICT DO NOTHING`,
      [client.clientId, JSON.stringify(client.redirectUris), client.clientName, client.createdAt],
    );
    return result.rowCount === 1;
  }
}

export class PgGatewayOAuthAuthorizationTransactionStore
  implements GatewayOAuthAuthorizationTransactionStorePort {
  constructor(readonly db: Queryable, readonly now: () => number = epochSeconds) { }

  async putIfAbsent(transaction: GatewayOAuthAuthorizationTransaction): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO gateway_oauth_authorization_transactions
       (transaction_id, client_id, redirect_uri, tenant_id, principal_id, requested_scopes_json,
        state, code_challenge, created_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, NULL)
       ON CONFLICT DO NOTHING`,
      [
        transaction.transactionId, transaction.clientId, transaction.redirectUri,
        transaction.tenantId, transaction.principalId, JSON.stringify(transaction.requestedScopes),
        transaction.state, transaction.codeChallenge, transaction.createdAt, transaction.expiresAt,
      ],
    );
    return result.rowCount === 1;
  }

  async take(transactionId: string): Promise<GatewayOAuthAuthorizationTransaction | null> {
    const result = await this.db.query<TransactionRow>(
      `UPDATE gateway_oauth_authorization_transactions SET consumed_at = $1
       WHERE transaction_id = $2 AND consumed_at IS NULL
       RETURNING transaction_id, client_id, redirect_uri, tenant_id, principal_id,
         requested_scopes_json, state, code_challenge, created_at, expires_at`,
      [this.now(), transactionId],
    );
    return result.rows[0] ? transactionFromRow(result.rows[0]) : null;
  }
}

export class PgGatewayOAuthAuthorizationCodeStore implements GatewayOAuthAuthorizationCodeStorePort {
  constructor(readonly db: Queryable, readonly now: () => number = epochSeconds) { }

  async putIfAbsent(code: GatewayOAuthStoredAuthorizationCode): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO gateway_oauth_authorization_codes
       (code_hash, client_id, redirect_uri, principal_id, tenant_id, scopes_json,
        permissions_json, code_challenge, ref_domain, created_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, NULL)
       ON CONFLICT DO NOTHING`,
      [
        code.codeHash, code.clientId, code.redirectUri, code.principalId, code.tenantId,
        JSON.stringify(code.scopes), JSON.stringify(code.permissions), code.codeChallenge,
        code.refDomain ?? null, code.createdAt, code.expiresAt,
      ],
    );
    return result.rowCount === 1;
  }

  async take(codeHash: string): Promise<GatewayOAuthStoredAuthorizationCode | null> {
    const result = await this.db.query<CodeRow>(
      `UPDATE gateway_oauth_authorization_codes SET consumed_at = $1
       WHERE code_hash = $2 AND consumed_at IS NULL
       RETURNING code_hash, client_id, redirect_uri, principal_id, tenant_id, scopes_json,
         permissions_json, code_challenge, ref_domain, created_at, expires_at`,
      [this.now(), codeHash],
    );
    return result.rows[0] ? codeFromRow(result.rows[0]) : null;
  }
}

export class PgGatewayOAuthRefreshTokenStore implements GatewayOAuthRefreshTokenStorePort {
  constructor(readonly pool: Pool) { }

  async putInitial(token: GatewayOAuthStoredRefreshToken): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      const family = await client.query(
        `INSERT INTO gateway_oauth_refresh_families
         (family_id, client_id, principal_id, tenant_id, created_at, revoked_at, replayed_at)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL)
         ON CONFLICT DO NOTHING`,
        [token.familyId, token.clientId, token.principalId, token.tenantId, token.createdAt],
      );
      if (family.rowCount !== 1) return false;
      const inserted = await client.query(
        `INSERT INTO gateway_oauth_refresh_tokens
         (token_hash, family_id, generation, client_id, principal_id, tenant_id,
          scopes_json, permissions_json, ref_domain, created_at, expires_at, consumed_at, successor_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, NULL, NULL)
         ON CONFLICT DO NOTHING`,
        [
          token.tokenHash, token.familyId, token.generation, token.clientId,
          token.principalId, token.tenantId, JSON.stringify(token.scopes),
          JSON.stringify(token.permissions), token.refDomain ?? null, token.createdAt, token.expiresAt,
        ],
      );
      if (inserted.rowCount !== 1) throw new Error("OAuth refresh family token was not persisted");
      return true;
    });
  }

  async rotate(input: {
    readonly currentHash: string;
    readonly nextHash: string;
    readonly now: number;
  }): Promise<GatewayOAuthRefreshRotationResult> {
    return withTransaction(this.pool, async client => {
      const locked = await client.query<RefreshRow>(
        `SELECT tokens.*, families.revoked_at
         FROM gateway_oauth_refresh_tokens AS tokens
         JOIN gateway_oauth_refresh_families AS families USING (family_id)
         WHERE tokens.token_hash = $1
         FOR UPDATE OF tokens, families`,
        [input.currentHash],
      );
      const current = locked.rows[0];
      if (!current || current.revoked_at !== null || Number(current.expires_at) <= input.now) {
        return { status: "invalid" };
      }
      if (current.consumed_at !== null) {
        await client.query(
          `UPDATE gateway_oauth_refresh_families
           SET revoked_at = COALESCE(revoked_at, $1), replayed_at = COALESCE(replayed_at, $1)
           WHERE family_id = $2`,
          [input.now, current.family_id],
        );
        await client.query(
          `UPDATE gateway_oauth_refresh_tokens SET consumed_at = COALESCE(consumed_at, $1)
           WHERE family_id = $2`,
          [input.now, current.family_id],
        );
        return { status: "replayed" };
      }
      const collision = await client.query(
        "SELECT 1 FROM gateway_oauth_refresh_tokens WHERE token_hash = $1",
        [input.nextHash],
      );
      if (collision.rows[0]) return { status: "invalid" };
      await client.query(
        `UPDATE gateway_oauth_refresh_tokens SET consumed_at = $1, successor_hash = $2
         WHERE token_hash = $3`,
        [input.now, input.nextHash, input.currentHash],
      );
      const inserted = await client.query<RefreshRow>(
        `INSERT INTO gateway_oauth_refresh_tokens
         (token_hash, family_id, generation, client_id, principal_id, tenant_id,
          scopes_json, permissions_json, ref_domain, created_at, expires_at, consumed_at, successor_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, NULL, NULL)
         RETURNING *, NULL::BIGINT AS revoked_at`,
        [
          input.nextHash, current.family_id, current.generation + 1, current.client_id,
          current.principal_id, current.tenant_id, JSON.stringify(current.scopes_json),
          JSON.stringify(current.permissions_json), current.ref_domain, input.now, current.expires_at,
        ],
      );
      return { status: "rotated", token: refreshFromRow(inserted.rows[0]!) };
    });
  }

  async revoke(tokenHash: string, clientId: string): Promise<void> {
    await this.pool.query(
      `UPDATE gateway_oauth_refresh_families SET revoked_at = COALESCE(revoked_at, $1)
       WHERE family_id = (
         SELECT family_id FROM gateway_oauth_refresh_tokens WHERE token_hash = $2 AND client_id = $3
       )`,
      [epochSeconds(), tokenHash, clientId],
    );
  }
}

export class PgGatewayOAuthTenantMembershipStore implements GatewayOAuthTenantMembershipPort {
  constructor(readonly db: Queryable) { }

  async find(principalId: string, tenantId: string): Promise<GatewayOAuthTenantMembership | null> {
    const result = await this.db.query<MembershipRow>(
      `SELECT tenant_id, scopes_json, ref_domain FROM gateway_oauth_tenant_memberships
       WHERE principal_id = $1 AND tenant_id = $2`,
      [principalId, tenantId],
    );
    const row = result.rows[0];
    return row ? Object.freeze({
      tenantId: row.tenant_id,
      scopes: scopeArray(row.scopes_json),
      ...(row.ref_domain === null ? {} : { refDomain: row.ref_domain }),
    }) : null;
  }

  async defaultForPrincipal(principalId: string): Promise<GatewayOAuthTenantMembership | null> {
    const result = await this.db.query<MembershipRow>(
      `SELECT tenant_id, scopes_json, ref_domain FROM gateway_oauth_tenant_memberships
       WHERE principal_id = $1 ORDER BY tenant_id LIMIT 1`,
      [principalId],
    );
    const row = result.rows[0];
    return row ? Object.freeze({
      tenantId: row.tenant_id,
      scopes: scopeArray(row.scopes_json),
      ...(row.ref_domain === null ? {} : { refDomain: row.ref_domain }),
    }) : null;
  }
}

export class PgGatewayOAuthAuditPort implements GatewayOAuthAuditPort {
  constructor(
    readonly db: Queryable,
    readonly now: () => number = epochSeconds,
    readonly generateId: () => string = () => crypto.randomUUID(),
  ) { }

  async record(event: GatewayOAuthAuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO gateway_oauth_audit_events
       (event_id, action, client_id, principal_id, tenant_id, scopes_json, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        this.generateId(), event.action, event.clientId,
        "principalId" in event ? event.principalId ?? null : null,
        "tenantId" in event ? event.tenantId ?? null : null,
        "scopes" in event && event.scopes ? JSON.stringify(event.scopes) : null,
        "reason" in event ? event.reason ?? null : null,
        this.now(),
      ],
    );
  }
}

export async function cleanupGatewayOAuthPg(
  pool: Pool,
  now = epochSeconds(),
  auditRetentionSeconds = 90 * 24 * 60 * 60,
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("OAuth cleanup time is invalid");
  if (!Number.isSafeInteger(auditRetentionSeconds) || auditRetentionSeconds < 24 * 60 * 60) {
    throw new TypeError("OAuth audit retention must be at least one day");
  }
  await withTransaction(pool, async client => {
    await client.query("DELETE FROM gateway_oauth_authorization_transactions WHERE expires_at <= $1", [now]);
    await client.query("DELETE FROM gateway_oauth_authorization_codes WHERE expires_at <= $1", [now]);
    await client.query("DELETE FROM gateway_oauth_refresh_tokens WHERE expires_at <= $1", [now]);
    await client.query(
      `DELETE FROM gateway_oauth_refresh_families AS families
       WHERE NOT EXISTS (
         SELECT 1 FROM gateway_oauth_refresh_tokens AS tokens WHERE tokens.family_id = families.family_id
       )`,
    );
    await client.query("DELETE FROM gateway_oauth_audit_events WHERE created_at < $1", [now - auditRetentionSeconds]);
  });
}

function transactionFromRow(row: TransactionRow): GatewayOAuthAuthorizationTransaction {
  return Object.freeze({
    transactionId: row.transaction_id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    requestedScopes: scopeArray(row.requested_scopes_json),
    state: row.state,
    codeChallenge: row.code_challenge,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  });
}

function codeFromRow(row: CodeRow): GatewayOAuthStoredAuthorizationCode {
  return Object.freeze({
    codeHash: row.code_hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    principalId: row.principal_id,
    tenantId: row.tenant_id,
    scopes: scopeArray(row.scopes_json),
    permissions: permissionArray(row.permissions_json),
    codeChallenge: row.code_challenge,
    ...(row.ref_domain === null ? {} : { refDomain: row.ref_domain }),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  });
}

function refreshFromRow(row: RefreshRow): GatewayOAuthStoredRefreshToken {
  return Object.freeze({
    tokenHash: row.token_hash,
    familyId: row.family_id,
    generation: row.generation,
    clientId: row.client_id,
    principalId: row.principal_id,
    tenantId: row.tenant_id,
    scopes: scopeArray(row.scopes_json),
    permissions: permissionArray(row.permissions_json),
    ...(row.ref_domain === null ? {} : { refDomain: row.ref_domain }),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  });
}

function scopeArray(value: unknown): readonly GatewayOAuthScope[] {
  const values = stringArray(value, "OAuth scopes");
  if (!values.every(scope => scope === "cas:read" || scope === "cas:write" || scope === "cas:manage")) {
    throw new Error("Stored OAuth scopes are invalid");
  }
  return Object.freeze(values as GatewayOAuthScope[]);
}

function permissionArray(value: unknown): readonly CapabilityPermission[] {
  return Object.freeze(stringArray(value, "OAuth permissions") as CapabilityPermission[]);
}

function stringArray(value: unknown, label: string): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(`Stored ${label} JSON is invalid`);
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
    throw new Error(`Stored ${label} must be a string array`);
  }
  return parsed;
}

async function withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let poisoned = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        poisoned = true;
      }
      throw error;
    }
  } finally {
    client.release(poisoned || undefined);
  }
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
