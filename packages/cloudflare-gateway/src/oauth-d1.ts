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
} from "@unidocs/gateway-oauth";
import type { CapabilityPermission } from "@unidocs/service-auth";
import type { GatewayOAuthScope } from "@unidocs/gateway-oauth";

interface ClientRow {
  client_id: string;
  redirect_uris_json: string;
  client_name: string | null;
  created_at: number;
}

interface TransactionRow {
  transaction_id: string;
  client_id: string;
  redirect_uri: string;
  tenant_id: string;
  principal_id: string | null;
  requested_scopes_json: string;
  state: string | null;
  code_challenge: string;
  created_at: number;
  expires_at: number;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  principal_id: string;
  tenant_id: string;
  scopes_json: string;
  permissions_json: string;
  code_challenge: string;
  ref_domain: string | null;
  created_at: number;
  expires_at: number;
}

interface RefreshRow {
  token_hash: string;
  family_id: string;
  generation: number;
  client_id: string;
  principal_id: string;
  tenant_id: string;
  scopes_json: string;
  permissions_json: string;
  ref_domain: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}

interface MembershipRow {
  tenant_id: string;
  scopes_json: string;
  ref_domain: string | null;
}

export class D1GatewayOAuthClientStore implements GatewayOAuthClientStorePort {
  constructor(readonly db: D1Database) {}

  async find(clientId: string): Promise<GatewayOAuthRegisteredClient | null> {
    const row = await this.db.prepare(
      "SELECT client_id, redirect_uris_json, client_name, created_at FROM gateway_oauth_clients WHERE client_id = ?",
    ).bind(clientId).first<ClientRow>();
    return row ? Object.freeze({
      clientId: row.client_id,
      redirectUris: stringArray(row.redirect_uris_json, "client redirect URIs"),
      clientName: row.client_name,
      createdAt: row.created_at,
    }) : null;
  }

  async putIfAbsent(client: GatewayOAuthRegisteredClient): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT OR IGNORE INTO gateway_oauth_clients
       (client_id, redirect_uris_json, client_name, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(
      client.clientId,
      JSON.stringify(client.redirectUris),
      client.clientName,
      client.createdAt,
    ).run();
    return changed(result);
  }
}

export class D1GatewayOAuthAuthorizationTransactionStore
implements GatewayOAuthAuthorizationTransactionStorePort {
  constructor(readonly db: D1Database, readonly now: () => number = epochSeconds) {}

  async putIfAbsent(transaction: GatewayOAuthAuthorizationTransaction): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT OR IGNORE INTO gateway_oauth_authorization_transactions
       (transaction_id, client_id, redirect_uri, tenant_id, principal_id,
        requested_scopes_json, state, code_challenge, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      transaction.transactionId,
      transaction.clientId,
      transaction.redirectUri,
      transaction.tenantId,
      transaction.principalId,
      JSON.stringify(transaction.requestedScopes),
      transaction.state,
      transaction.codeChallenge,
      transaction.createdAt,
      transaction.expiresAt,
    ).run();
    return changed(result);
  }

  async take(transactionId: string): Promise<GatewayOAuthAuthorizationTransaction | null> {
    const row = await this.db.prepare(
      `UPDATE gateway_oauth_authorization_transactions
       SET consumed_at = ?
       WHERE transaction_id = ? AND consumed_at IS NULL
       RETURNING transaction_id, client_id, redirect_uri, tenant_id, principal_id,
         requested_scopes_json, state, code_challenge, created_at, expires_at`,
    ).bind(this.now(), transactionId).first<TransactionRow>();
    return row ? transactionFromRow(row) : null;
  }
}

export class D1GatewayOAuthAuthorizationCodeStore
implements GatewayOAuthAuthorizationCodeStorePort {
  constructor(readonly db: D1Database, readonly now: () => number = epochSeconds) {}

  async putIfAbsent(code: GatewayOAuthStoredAuthorizationCode): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT OR IGNORE INTO gateway_oauth_authorization_codes
       (code_hash, client_id, redirect_uri, principal_id, tenant_id, scopes_json,
        permissions_json, code_challenge, ref_domain, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      code.codeHash,
      code.clientId,
      code.redirectUri,
      code.principalId,
      code.tenantId,
      JSON.stringify(code.scopes),
      JSON.stringify(code.permissions),
      code.codeChallenge,
      code.refDomain ?? null,
      code.createdAt,
      code.expiresAt,
    ).run();
    return changed(result);
  }

  async take(codeHash: string): Promise<GatewayOAuthStoredAuthorizationCode | null> {
    const row = await this.db.prepare(
      `UPDATE gateway_oauth_authorization_codes
       SET consumed_at = ?
       WHERE code_hash = ? AND consumed_at IS NULL
       RETURNING code_hash, client_id, redirect_uri, principal_id, tenant_id,
         scopes_json, permissions_json, code_challenge, ref_domain, created_at, expires_at`,
    ).bind(this.now(), codeHash).first<CodeRow>();
    return row ? codeFromRow(row) : null;
  }
}

export class D1GatewayOAuthRefreshTokenStore implements GatewayOAuthRefreshTokenStorePort {
  constructor(readonly db: D1Database) {}

  async putInitial(token: GatewayOAuthStoredRefreshToken): Promise<boolean> {
    const [, inserted] = await this.db.batch([
      this.db.prepare(
        `INSERT OR IGNORE INTO gateway_oauth_refresh_families
         (family_id, client_id, principal_id, tenant_id, created_at, revoked_at, replayed_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      ).bind(token.familyId, token.clientId, token.principalId, token.tenantId, token.createdAt),
      this.db.prepare(
        `INSERT OR IGNORE INTO gateway_oauth_refresh_tokens
         (token_hash, family_id, generation, client_id, principal_id, tenant_id,
          scopes_json, permissions_json, ref_domain, created_at, expires_at,
          consumed_at, successor_hash)
         SELECT ?, family_id, ?, client_id, principal_id, tenant_id, ?, ?, ?, ?, ?, NULL, NULL
         FROM gateway_oauth_refresh_families
         WHERE family_id = ? AND client_id = ? AND principal_id = ? AND tenant_id = ?
           AND revoked_at IS NULL`,
      ).bind(
        token.tokenHash,
        token.generation,
        JSON.stringify(token.scopes),
        JSON.stringify(token.permissions),
        token.refDomain ?? null,
        token.createdAt,
        token.expiresAt,
        token.familyId,
        token.clientId,
        token.principalId,
        token.tenantId,
      ),
    ]);
    return changed(inserted);
  }

  async rotate(input: {
    readonly currentHash: string;
    readonly nextHash: string;
    readonly now: number;
  }): Promise<GatewayOAuthRefreshRotationResult> {
    const [, inserted] = await this.db.batch([
      this.db.prepare(
        `UPDATE gateway_oauth_refresh_tokens
         SET consumed_at = ?, successor_hash = ?
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
           AND NOT EXISTS (
             SELECT 1 FROM gateway_oauth_refresh_tokens WHERE token_hash = ?
           )
           AND EXISTS (
             SELECT 1 FROM gateway_oauth_refresh_families AS families
             WHERE families.family_id = gateway_oauth_refresh_tokens.family_id
               AND families.revoked_at IS NULL
           )`,
      ).bind(input.now, input.nextHash, input.currentHash, input.now, input.nextHash),
      this.db.prepare(
        `INSERT INTO gateway_oauth_refresh_tokens
         (token_hash, family_id, generation, client_id, principal_id, tenant_id,
          scopes_json, permissions_json, ref_domain, created_at, expires_at,
          consumed_at, successor_hash)
         SELECT ?, family_id, generation + 1, client_id, principal_id, tenant_id,
           scopes_json, permissions_json, ref_domain, ?, expires_at, NULL, NULL
         FROM gateway_oauth_refresh_tokens
         WHERE token_hash = ? AND consumed_at = ? AND successor_hash = ?`,
      ).bind(input.nextHash, input.now, input.currentHash, input.now, input.nextHash),
    ]);

    if (changed(inserted)) {
      const row = await this.#find(input.nextHash);
      if (!row) throw new Error("OAuth refresh rotation successor was not persisted");
      return { status: "rotated", token: refreshFromRow(row) };
    }

    const current = await this.#find(input.currentHash);
    if (!current || current.consumed_at === null || current.revoked_at !== null) {
      return { status: "invalid" };
    }
    await this.db.batch([
      this.db.prepare(
        `UPDATE gateway_oauth_refresh_families
         SET revoked_at = COALESCE(revoked_at, ?), replayed_at = COALESCE(replayed_at, ?)
         WHERE family_id = ?`,
      ).bind(input.now, input.now, current.family_id),
      this.db.prepare(
        `UPDATE gateway_oauth_refresh_tokens
         SET consumed_at = COALESCE(consumed_at, ?)
         WHERE family_id = ?`,
      ).bind(input.now, current.family_id),
    ]);
    return { status: "replayed" };
  }

  async revoke(tokenHash: string, clientId: string): Promise<void> {
    const now = epochSeconds();
    await this.db.prepare(
      `UPDATE gateway_oauth_refresh_families
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE family_id = (
         SELECT family_id FROM gateway_oauth_refresh_tokens
         WHERE token_hash = ? AND client_id = ?
       )`,
    ).bind(now, tokenHash, clientId).run();
  }

  #find(tokenHash: string): Promise<RefreshRow | null> {
    return this.db.prepare(
      `SELECT tokens.*, families.revoked_at
       FROM gateway_oauth_refresh_tokens AS tokens
       JOIN gateway_oauth_refresh_families AS families USING (family_id)
       WHERE tokens.token_hash = ?`,
    ).bind(tokenHash).first<RefreshRow>();
  }
}

export class D1GatewayOAuthTenantMembershipStore implements GatewayOAuthTenantMembershipPort {
  constructor(readonly db: D1Database) {}

  async find(principalId: string, tenantId: string): Promise<GatewayOAuthTenantMembership | null> {
    const row = await this.db.prepare(
      `SELECT tenant_id, scopes_json, ref_domain
       FROM gateway_oauth_tenant_memberships
       WHERE principal_id = ? AND tenant_id = ?`,
    ).bind(principalId, tenantId).first<MembershipRow>();
    return row ? Object.freeze({
      tenantId: row.tenant_id,
      scopes: scopeArray(row.scopes_json),
      ...(row.ref_domain === null ? {} : { refDomain: row.ref_domain }),
    }) : null;
  }
}

export class D1GatewayOAuthAuditPort implements GatewayOAuthAuditPort {
  constructor(
    readonly db: D1Database,
    readonly now: () => number = epochSeconds,
    readonly generateId: () => string = () => crypto.randomUUID(),
  ) {}

  async record(event: GatewayOAuthAuditEvent): Promise<void> {
    await this.db.prepare(
      `INSERT INTO gateway_oauth_audit_events
       (event_id, action, client_id, principal_id, tenant_id, scopes_json, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      this.generateId(),
      event.action,
      event.clientId,
      "principalId" in event ? event.principalId ?? null : null,
      "tenantId" in event ? event.tenantId ?? null : null,
      "scopes" in event && event.scopes ? JSON.stringify(event.scopes) : null,
      "reason" in event ? event.reason ?? null : null,
      this.now(),
    ).run();
  }
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
    createdAt: row.created_at,
    expiresAt: row.expires_at,
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
    createdAt: row.created_at,
    expiresAt: row.expires_at,
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
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}

function scopeArray(value: string): readonly GatewayOAuthScope[] {
  const values = stringArray(value, "OAuth scopes");
  if (!values.every(scope => scope === "cas:read" || scope === "cas:write" || scope === "cas:manage")) {
    throw new Error("Stored OAuth scopes are invalid");
  }
  return Object.freeze(values as GatewayOAuthScope[]);
}

function permissionArray(value: string): readonly CapabilityPermission[] {
  return Object.freeze(stringArray(value, "OAuth permissions") as CapabilityPermission[]);
}

function stringArray(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Stored ${label} JSON is invalid`);
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
    throw new Error(`Stored ${label} must be a string array`);
  }
  return parsed;
}

function changed(result: D1Result): boolean {
  return (result.meta.changes ?? 0) === 1;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
