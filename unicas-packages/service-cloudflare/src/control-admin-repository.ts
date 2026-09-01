import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { CasOperatorIdentityKey } from "@unicas/admin-protocol";
import type {
  ControlAcceptMemberInvitationCommitResult,
  ControlAcceptMemberInvitationPlan,
  ControlAuditRecord,
  ControlCreateIssuerKeyCommitResult,
  ControlCreateIssuerKeyPlan,
  ControlCreateMemberInvitationCommitResult,
  ControlCreateMemberInvitationPlan,
  ControlCreateStackCommitResult,
  ControlCreateStackPlan,
  ControlDeleteIssuerKeyCommitResult,
  ControlDeleteIssuerKeyPlan,
  ControlDeleteMemberCommitResult,
  ControlDeleteMemberPlan,
  ControlIdempotencyRecord,
  ControlIdentityPlan,
  ControlIdentityRecord,
  ControlIssuerKeyRecord,
  ControlIssuerRecord,
  ControlOAuthIssuerRecord,
  ControlMembershipRecord,
  ControlMemberInvitationRecord,
  ControlPatchStackCommitResult,
  ControlPatchStackPlan,
  ControlPlaneAdminRepository,
  ControlPossessionChallengeRecord,
  ControlPutIssuerCommitResult,
  ControlPutIssuerPlan,
  ControlStackRecord,
} from "@unicas/service";

const SNAPSHOT_KEY = "snapshot";

/** D1 storage adapter for the cloud-neutral control admin semantic repository. */
export class D1ControlPlaneAdminRepository implements ControlPlaneAdminRepository {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async getIdentity(identity: CasOperatorIdentityKey): Promise<ControlIdentityRecord | null> {
    const row = await this.#db
      .prepare("SELECT identity_issuer, subject, display_name, email_for_display, created_at FROM cas_operator_identities WHERE identity_issuer = ? AND subject = ?")
      .bind(identity.identityIssuer, identity.subject)
      .first<IdentityRow>();
    return row ? toIdentity(row) : null;
  }

  async commitIdentity(plan: ControlIdentityPlan): Promise<void> {
    const statement = plan.kind === "insert"
      ? this.#db.prepare("INSERT INTO cas_operator_identities (identity_issuer, subject, display_name, email_for_display, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(plan.identity.identityIssuer, plan.identity.subject, plan.identity.displayName, plan.identity.emailForDisplay, plan.identity.createdAt)
      : this.#db.prepare("UPDATE cas_operator_identities SET display_name = ?, email_for_display = ? WHERE identity_issuer = ? AND subject = ?")
        .bind(plan.identity.displayName, plan.identity.emailForDisplay, plan.identity.identityIssuer, plan.identity.subject);
    await this.#db.batch([statement, this.#auditStatement(plan.audit)]);
  }

  async listMemberships(identity: CasOperatorIdentityKey): Promise<readonly ControlMembershipRecord[]> {
    const rows = await this.#db
      .prepare(
        "SELECT m.stack_id, m.identity_issuer, m.subject, m.joined_at, i.display_name, i.email_for_display FROM cas_stack_members m LEFT JOIN cas_operator_identities i ON i.identity_issuer = m.identity_issuer AND i.subject = m.subject WHERE m.identity_issuer = ? AND m.subject = ? ORDER BY m.stack_id",
      )
      .bind(identity.identityIssuer, identity.subject)
      .all<MembershipRow>();
    return (rows.results ?? []).map(toMembership);
  }

  async listMembers(input: {
    readonly stackId: string;
    readonly afterSubject: string;
    readonly limit: number;
  }): Promise<readonly ControlMembershipRecord[]> {
    const rows = await this.#db
      .prepare(
        "SELECT m.stack_id, m.identity_issuer, m.subject, m.joined_at, i.display_name, i.email_for_display FROM cas_stack_members m LEFT JOIN cas_operator_identities i ON i.identity_issuer = m.identity_issuer AND i.subject = m.subject WHERE m.stack_id = ? AND m.subject > ? ORDER BY m.subject LIMIT ?",
      )
      .bind(input.stackId, input.afterSubject, input.limit)
      .all<MembershipRow>();
    return (rows.results ?? []).map(toMembership);
  }

  async readSnapshot(): Promise<number> {
    const row = await this.#db
      .prepare("SELECT value FROM cas_control_meta WHERE key = ?")
      .bind(SNAPSHOT_KEY)
      .first<{ value: number }>();
    return row?.value ?? 0;
  }

  async listStacks(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly afterStackId: string;
    readonly limit: number;
  }): Promise<readonly ControlStackRecord[]> {
    const rows = await this.#db
      .prepare(
        "SELECT s.stack_id, s.display_name, s.description, s.status, s.created_at, s.revision FROM cas_stacks s JOIN cas_stack_members m ON m.stack_id = s.stack_id WHERE m.identity_issuer = ? AND m.subject = ? AND s.stack_id > ? ORDER BY s.stack_id LIMIT ?",
      )
      .bind(input.identity.identityIssuer, input.identity.subject, input.afterStackId, input.limit)
      .all<StackRow>();
    return (rows.results ?? []).map(toStack);
  }

  async getStack(stackId: string): Promise<ControlStackRecord | null> {
    const row = await this.#db
      .prepare("SELECT stack_id, display_name, description, status, created_at, revision FROM cas_stacks WHERE stack_id = ?")
      .bind(stackId)
      .first<StackRow>();
    return row ? toStack(row) : null;
  }

  async hasMembership(identity: CasOperatorIdentityKey, stackId: string): Promise<boolean> {
    const row = await this.#db
      .prepare("SELECT 1 AS ok FROM cas_stack_members WHERE stack_id = ? AND identity_issuer = ? AND subject = ?")
      .bind(stackId, identity.identityIssuer, identity.subject)
      .first<{ ok: number }>();
    return row !== null;
  }

  async getIdempotency<T = unknown>(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly method: string;
    readonly canonicalRoute: string;
    readonly key: string;
    readonly now: number;
  }): Promise<ControlIdempotencyRecord<T> | null> {
    const row = await this.#db
      .prepare(
        "SELECT identity_issuer, subject, method, canonical_route, idempotency_key, payload_hash, response_json, created_at, expires_at FROM cas_control_idempotency WHERE identity_issuer = ? AND subject = ? AND method = ? AND canonical_route = ? AND idempotency_key = ? AND expires_at > ?",
      )
      .bind(input.identity.identityIssuer, input.identity.subject, input.method, input.canonicalRoute, input.key, input.now)
      .first<IdempotencyRow>();
    return row ? toIdempotency<T>(row) : null;
  }

  async getInvitationByTokenHash(tokenHash: string): Promise<ControlMemberInvitationRecord | null> {
    const row = await this.#db
      .prepare(
        "SELECT invitation_id, stack_id, status, email_constraint, token_hash, expires_at, created_at, revision FROM cas_stack_member_invitations WHERE token_hash = ?",
      )
      .bind(tokenHash)
      .first<InvitationRow>();
    return row ? toInvitation(row) : null;
  }

  async commitCreateStack(plan: ControlCreateStackPlan): Promise<ControlCreateStackCommitResult> {
    const statements = [
      ...this.#mutationStatements(plan.audit),
      this.#db.prepare("INSERT INTO cas_stacks (stack_id, display_name, description, status, created_at, revision) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(plan.stack.stackId, plan.stack.displayName, plan.stack.description, plan.stack.status, plan.stack.createdAt, plan.stack.revision),
      this.#db.prepare("INSERT INTO cas_stack_members (stack_id, identity_issuer, subject, joined_at) VALUES (?, ?, ?, ?)")
        .bind(plan.membership.stackId, plan.membership.identityIssuer, plan.membership.subject, plan.membership.joinedAt),
    ];
    if (plan.idempotency) statements.push(this.#idempotencyStatement(plan.idempotency));
    try {
      await this.#db.batch(statements);
      return { kind: "created" };
    } catch (error) {
      if (plan.idempotency && isUniqueViolation(error, "cas_control_idempotency")) {
        const record = await this.getIdempotency({
          identity: plan.idempotency,
          method: plan.idempotency.method,
          canonicalRoute: plan.idempotency.canonicalRoute,
          key: plan.idempotency.key,
          now: plan.idempotency.createdAt,
        });
        if (record) return { kind: "idempotency-race", record };
      }
      throw error;
    }
  }

  async commitPatchStack(plan: ControlPatchStackPlan): Promise<ControlPatchStackCommitResult> {
    const update = this.#db
      .prepare("UPDATE cas_stacks SET display_name = ?, description = ?, revision = ? WHERE stack_id = ? AND revision = ?")
      .bind(plan.displayName, plan.description, plan.nextRevision, plan.stackId, plan.expectedRevision);
    const requireUpdated = this.#db.prepare(
      "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('invalid', '$') END AS updated",
    );
    try {
      await this.#db.batch([update, requireUpdated, ...this.#mutationStatements(plan.audit)]);
      return { kind: "updated" };
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      const current = await this.getStack(plan.stackId);
      return current ? { kind: "revision-mismatch" } : { kind: "not-found" };
    }
  }

  async commitCreateMemberInvitation(
    plan: ControlCreateMemberInvitationPlan,
  ): Promise<ControlCreateMemberInvitationCommitResult> {
    const statements = [
      ...this.#mutationStatements(plan.audit),
      this.#db.prepare(
        "INSERT INTO cas_stack_member_invitations (invitation_id, stack_id, status, email_constraint, token_hash, expires_at, created_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        plan.invitation.invitationId,
        plan.invitation.stackId,
        plan.invitation.status,
        plan.invitation.emailConstraint,
        plan.invitation.tokenHash,
        plan.invitation.expiresAt,
        plan.invitation.createdAt,
        plan.invitation.revision,
      ),
    ];
    if (plan.idempotency) statements.push(this.#idempotencyStatement(plan.idempotency));
    try {
      await this.#db.batch(statements);
      return { kind: "created" };
    } catch (error) {
      if (plan.idempotency && isUniqueViolation(error, "cas_control_idempotency")) {
        const record = await this.getIdempotency<ControlCreateMemberInvitationPlan["response"]>({
          identity: plan.idempotency,
          method: plan.idempotency.method,
          canonicalRoute: plan.idempotency.canonicalRoute,
          key: plan.idempotency.key,
          now: plan.idempotency.createdAt,
        });
        if (record) return { kind: "idempotency-race", record };
      }
      throw error;
    }
  }

  async commitDeleteMember(plan: ControlDeleteMemberPlan): Promise<ControlDeleteMemberCommitResult> {
    const requirePreconditions = this.#db.prepare(
      "SELECT CASE WHEN EXISTS (SELECT 1 FROM cas_stacks WHERE stack_id = ? AND revision = ?) AND (SELECT COUNT(*) FROM cas_stack_members WHERE stack_id = ?) > 1 THEN 1 ELSE json_extract('invalid', '$') END AS allowed",
    ).bind(plan.stackId, plan.expectedRevision, plan.stackId);
    const remove = this.#db.prepare(
      "DELETE FROM cas_stack_members WHERE stack_id = ? AND identity_issuer = ? AND subject = ?",
    ).bind(plan.stackId, plan.identity.identityIssuer, plan.identity.subject);
    try {
      await this.#db.batch([requirePreconditions, remove, ...this.#mutationStatements(plan.audit)]);
      return { kind: "deleted" };
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      const stack = await this.getStack(plan.stackId);
      if (!stack) return { kind: "stack-not-found" };
      if (stack.revision !== plan.expectedRevision) return { kind: "revision-mismatch" };
      const row = await this.#db.prepare(
        "SELECT COUNT(*) AS count FROM cas_stack_members WHERE stack_id = ?",
      ).bind(plan.stackId).first<{ count: number }>();
      return (row?.count ?? 0) <= 1 ? { kind: "last-member" } : { kind: "not-member" };
    }
  }

  async commitAcceptMemberInvitation(
    plan: ControlAcceptMemberInvitationPlan,
  ): Promise<ControlAcceptMemberInvitationCommitResult> {
    const claim = this.#db.prepare(
      "UPDATE cas_stack_member_invitations SET status = 'accepted' WHERE invitation_id = ? AND token_hash = ? AND status = 'pending' AND expires_at > ?",
    ).bind(plan.invitationId, plan.tokenHash, plan.now);
    const requireClaimed = this.#db.prepare(
      "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('invalid', '$') END AS claimed",
    );
    const synchronizeIdentity = this.#db.prepare(
      "INSERT INTO cas_operator_identities (identity_issuer, subject, display_name, email_for_display, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(identity_issuer, subject) DO UPDATE SET display_name = excluded.display_name, email_for_display = excluded.email_for_display",
    ).bind(
      plan.identity.identityIssuer,
      plan.identity.subject,
      plan.identity.displayName,
      plan.identity.emailForDisplay,
      plan.identity.createdAt,
    );
    const insertMember = this.#db.prepare(
      "INSERT OR IGNORE INTO cas_stack_members (stack_id, identity_issuer, subject, joined_at) VALUES (?, ?, ?, ?)",
    ).bind(
      plan.membership.stackId,
      plan.membership.identityIssuer,
      plan.membership.subject,
      plan.membership.joinedAt,
    );
    try {
      await this.#db.batch([
        claim,
        requireClaimed,
        synchronizeIdentity,
        insertMember,
        ...this.#mutationStatements(plan.audit),
      ]);
      return { kind: "accepted" };
    } catch (error) {
      if (isJsonFailure(error)) return { kind: "unavailable" };
      throw error;
    }
  }

  async appendAudit(record: ControlAuditRecord): Promise<void> {
    await this.#auditStatement(record).run();
  }

  async getIssuer(stackId: string): Promise<ControlIssuerRecord | null> {
    const row = await this.#db
      .prepare(
        "SELECT stack_id, issuer, audience, capability_max_lifetime_seconds, revision FROM cas_stack_issuer WHERE stack_id = ?",
      )
      .bind(stackId)
      .first<IssuerRow>();
    return row ? toIssuer(row) : null;
  }

  async getOAuthIssuer(stackId: string): Promise<ControlOAuthIssuerRecord | null> {
    const row = await this.#db
      .prepare(
        "SELECT stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, registration_endpoint, scopes_supported, code_challenge_methods_supported, status, verified_at, last_refresh_at, last_refresh_error, jwks_digest, capability_max_lifetime_seconds, revision FROM cas_stack_oauth_issuers WHERE stack_id = ?",
      )
      .bind(stackId)
      .first<OAuthIssuerRow>();
    return row ? toOAuthIssuer(row) : null;
  }

  async hasIssuerElsewhere(issuer: string, stackId: string): Promise<boolean> {
    const row = await this.#db
      .prepare("SELECT 1 AS ok FROM cas_stack_issuer WHERE issuer = ? AND stack_id != ?")
      .bind(issuer, stackId)
      .first<{ ok: number }>();
    return row !== null;
  }

  async commitPutIssuer(plan: ControlPutIssuerPlan): Promise<ControlPutIssuerCommitResult> {
    if (plan.kind === "insert") {
      const statements = [
        ...this.#mutationStatements(plan.audit),
        this.#db.prepare(
          "INSERT INTO cas_stack_issuer (stack_id, issuer, audience, capability_max_lifetime_seconds, revision) VALUES (?, ?, ?, ?, 1)",
        ).bind(plan.stackId, plan.issuer, plan.audience, plan.capabilityMaxLifetimeSeconds),
      ];
      try {
        await this.#db.batch(statements);
        return { kind: "created" };
      } catch (error) {
        if (isIssuerConflict(error)) return { kind: "issuer-conflict" };
        throw error;
      }
    }
    const update = this.#db.prepare(
      "UPDATE cas_stack_issuer SET audience = ?, capability_max_lifetime_seconds = ?, revision = revision + 1 WHERE stack_id = ? AND revision = ?",
    ).bind(plan.audience, plan.capabilityMaxLifetimeSeconds, plan.stackId, plan.expectedRevision);
    const requireUpdated = this.#db.prepare(
      "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('invalid', '$') END AS updated",
    );
    try {
      await this.#db.batch([update, requireUpdated, ...this.#mutationStatements(plan.audit)]);
      return { kind: "updated" };
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      const current = await this.getIssuer(plan.stackId);
      return current ? { kind: "revision-mismatch" } : { kind: "not-found" };
    }
  }

  async createPossessionChallenge(record: ControlPossessionChallengeRecord): Promise<void> {
    await this.#db
      .prepare(
        "INSERT INTO cas_possession_challenges (nonce, stack_id, kid, algorithm, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(record.nonce, record.stackId, record.kid, record.algorithm, record.createdAt, record.expiresAt)
      .run();
  }

  async getUsablePossessionChallenge(nonce: string): Promise<ControlPossessionChallengeRecord | null> {
    const row = await this.#db
      .prepare(
        "SELECT nonce, stack_id, kid, algorithm, created_at, expires_at FROM cas_possession_challenges WHERE nonce = ? AND used_at IS NULL",
      )
      .bind(nonce)
      .first<PossessionChallengeRow>();
    return row ? toPossessionChallenge(row) : null;
  }

  async listIssuerKeys(stackId: string): Promise<readonly ControlIssuerKeyRecord[]> {
    const rows = await this.#db
      .prepare(
        "SELECT stack_id, kid, algorithm, public_jwk, state, revision FROM cas_stack_issuer_keys WHERE stack_id = ? ORDER BY kid",
      )
      .bind(stackId)
      .all<IssuerKeyRow>();
    return (rows.results ?? []).map(toIssuerKey);
  }

  async getIssuerKey(stackId: string, kid: string): Promise<ControlIssuerKeyRecord | null> {
    const row = await this.#db
      .prepare(
        "SELECT stack_id, kid, algorithm, public_jwk, state, revision FROM cas_stack_issuer_keys WHERE stack_id = ? AND kid = ?",
      )
      .bind(stackId, kid)
      .first<IssuerKeyRow>();
    return row ? toIssuerKey(row) : null;
  }

  async hasIssuerKey(stackId: string, kid: string): Promise<boolean> {
    const row = await this.#db
      .prepare("SELECT 1 AS ok FROM cas_stack_issuer_keys WHERE stack_id = ? AND kid = ?")
      .bind(stackId, kid)
      .first<{ ok: number }>();
    return row !== null;
  }

  async commitCreateIssuerKey(plan: ControlCreateIssuerKeyPlan): Promise<ControlCreateIssuerKeyCommitResult> {
    const statements = [
      ...this.#mutationStatements(plan.audit),
      this.#db.prepare(
        "INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state, revision) VALUES (?, ?, ?, ?, 'active', 1)",
      ).bind(plan.key.stackId, plan.key.kid, plan.key.algorithm, JSON.stringify(plan.key.publicJwk)),
      // Atomically consume the one-time challenge; a zero-row update fails the
      // batch so a nonce can never back two keys.
      this.#db.prepare("UPDATE cas_possession_challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL")
        .bind(plan.consumedAt, plan.challengeNonce),
      this.#db.prepare(
        "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('invalid', '$') END AS consumed",
      ),
    ];
    if (plan.idempotency) statements.push(this.#idempotencyStatement(plan.idempotency));
    try {
      await this.#db.batch(statements);
      return { kind: "created" };
    } catch (error) {
      if (plan.idempotency && isUniqueViolation(error, "cas_control_idempotency")) {
        const record = await this.getIdempotency<ControlIssuerKeyRecord>({
          identity: plan.idempotency,
          method: plan.idempotency.method,
          canonicalRoute: plan.idempotency.canonicalRoute,
          key: plan.idempotency.key,
          now: plan.idempotency.createdAt,
        });
        if (record) return { kind: "idempotency-race", record };
      }
      if (isUniqueViolation(error, "cas_stack_issuer_keys")) return { kind: "key-exists" };
      if (isJsonFailure(error)) return { kind: "challenge-unavailable" };
      throw error;
    }
  }

  async commitDeleteIssuerKey(plan: ControlDeleteIssuerKeyPlan): Promise<ControlDeleteIssuerKeyCommitResult> {
    const requirePreconditions = this.#db.prepare(
      plan.enforceLastActive
        ? "SELECT CASE WHEN EXISTS (SELECT 1 FROM cas_stack_issuer_keys WHERE stack_id = ? AND kid = ? AND revision = ?) AND (SELECT COUNT(*) FROM cas_stack_issuer_keys WHERE stack_id = ? AND state = 'active') > 1 THEN 1 ELSE json_extract('invalid', '$') END AS allowed"
        : "SELECT CASE WHEN EXISTS (SELECT 1 FROM cas_stack_issuer_keys WHERE stack_id = ? AND kid = ? AND revision = ?) THEN 1 ELSE json_extract('invalid', '$') END AS allowed",
    ).bind(plan.stackId, plan.kid, plan.expectedRevision, plan.stackId);
    const update = this.#db.prepare(
      "UPDATE cas_stack_issuer_keys SET state = ?, revision = revision + 1 WHERE stack_id = ? AND kid = ? AND revision = ?",
    ).bind(plan.toState, plan.stackId, plan.kid, plan.expectedRevision);
    try {
      await this.#db.batch([requirePreconditions, update, ...this.#mutationStatements(plan.audit)]);
      return { kind: "deleted" };
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      const current = await this.getIssuerKey(plan.stackId, plan.kid);
      if (!current) return { kind: "not-found" };
      if (current.revision !== plan.expectedRevision) return { kind: "revision-mismatch" };
      if (plan.enforceLastActive) {
        const row = await this.#db.prepare(
          "SELECT COUNT(*) AS count FROM cas_stack_issuer_keys WHERE stack_id = ? AND state = 'active'",
        ).bind(plan.stackId).first<{ count: number }>();
        if ((row?.count ?? 0) <= 1) return { kind: "last-active" };
      }
      // Unreachable: the precondition would have passed for this state.
      return { kind: "revision-mismatch" };
    }
  }

  async getAuditEventCreatedAt(stackId: string, eventId: string): Promise<number | null> {
    const row = await this.#db
      .prepare("SELECT created_at FROM cas_control_audit_events WHERE event_id = ? AND stack_id = ?")
      .bind(eventId, stackId)
      .first<{ created_at: number }>();
    return row?.created_at ?? null;
  }

  async listAuditEvents(input: {
    readonly stackId: string;
    readonly afterCreatedAt: number;
    readonly afterEventId: string;
    readonly limit: number;
  }): Promise<readonly ControlAuditRecord[]> {
    const rows = await this.#db
      .prepare(
        "SELECT event_id, stack_id, identity_issuer, subject, action, target, request_id, trace_id, caller_channel, oauth_client_handle, tool_name, created_at FROM cas_control_audit_events WHERE stack_id = ? AND (created_at > ? OR (created_at = ? AND event_id > ?)) ORDER BY created_at, event_id LIMIT ?",
      )
      .bind(input.stackId, input.afterCreatedAt, input.afterCreatedAt, input.afterEventId, input.limit)
      .all<AuditEventRow>();
    return (rows.results ?? []).map(toAuditRecord);
  }

  #mutationStatements(audit: ControlAuditRecord): D1PreparedStatement[] {
    return [
      this.#db.prepare("INSERT OR IGNORE INTO cas_control_meta (key, value) VALUES (?, 0)").bind(SNAPSHOT_KEY),
      this.#db.prepare("UPDATE cas_control_meta SET value = value + 1 WHERE key = ?").bind(SNAPSHOT_KEY),
      this.#auditStatement(audit),
    ];
  }

  #auditStatement(record: ControlAuditRecord): D1PreparedStatement {
    return this.#db.prepare(
      "INSERT INTO cas_control_audit_events (event_id, stack_id, identity_issuer, subject, action, target, request_id, trace_id, caller_channel, oauth_client_handle, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      record.eventId,
      record.stackId,
      record.identityIssuer,
      record.subject,
      record.action,
      record.target,
      record.requestId,
      record.traceId,
      record.callerChannel,
      record.oauthClientHandle,
      record.toolName,
      record.createdAt,
    );
  }

  #idempotencyStatement(record: ControlIdempotencyRecord): D1PreparedStatement {
    return this.#db.prepare(
      "INSERT INTO cas_control_idempotency (identity_issuer, subject, method, canonical_route, idempotency_key, payload_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      record.identityIssuer,
      record.subject,
      record.method,
      record.canonicalRoute,
      record.key,
      record.payloadHash,
      JSON.stringify(record.response),
      record.createdAt,
      record.expiresAt,
    );
  }
}

interface IdentityRow {
  readonly identity_issuer: string;
  readonly subject: string;
  readonly display_name: string | null;
  readonly email_for_display: string | null;
  readonly created_at: number;
}

interface StackRow {
  readonly stack_id: string;
  readonly display_name: string;
  readonly description: string;
  readonly status: string;
  readonly created_at: number;
  readonly revision: number;
}

interface MembershipRow {
  readonly stack_id: string;
  readonly identity_issuer: string;
  readonly subject: string;
  readonly display_name: string | null;
  readonly email_for_display: string | null;
  readonly joined_at: number;
}

interface IdempotencyRow {
  readonly identity_issuer: string;
  readonly subject: string;
  readonly method: string;
  readonly canonical_route: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly response_json: string;
  readonly created_at: number;
  readonly expires_at: number;
}

interface IssuerRow {
  readonly stack_id: string;
  readonly issuer: string;
  readonly audience: string;
  readonly capability_max_lifetime_seconds: number;
  readonly revision: number;
}

interface OAuthIssuerRow {
  readonly stack_id: string;
  readonly issuer: string;
  readonly audience: string;
  readonly metadata_url: string;
  readonly metadata_type: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly registration_endpoint: string | null;
  readonly scopes_supported: string;
  readonly code_challenge_methods_supported: string;
  readonly status: string;
  readonly verified_at: number | null;
  readonly last_refresh_at: number | null;
  readonly last_refresh_error: string | null;
  readonly jwks_digest: string;
  readonly capability_max_lifetime_seconds: number;
  readonly revision: number;
}

interface IssuerKeyRow {
  readonly stack_id: string;
  readonly kid: string;
  readonly algorithm: string;
  readonly public_jwk: string;
  readonly state: string;
  readonly revision: number;
}

interface PossessionChallengeRow {
  readonly nonce: string;
  readonly stack_id: string;
  readonly kid: string;
  readonly algorithm: string;
  readonly created_at: number;
  readonly expires_at: number;
}

interface AuditEventRow {
  readonly event_id: string;
  readonly stack_id: string | null;
  readonly identity_issuer: string;
  readonly subject: string;
  readonly action: string;
  readonly target: string;
  readonly request_id: string | null;
  readonly trace_id: string | null;
  readonly caller_channel: string | null;
  readonly oauth_client_handle: string | null;
  readonly tool_name: string | null;
  readonly created_at: number;
}

interface InvitationRow {
  readonly invitation_id: string;
  readonly stack_id: string;
  readonly status: string;
  readonly email_constraint: string | null;
  readonly token_hash: string;
  readonly expires_at: number;
  readonly created_at: number;
  readonly revision: number;
}

function toIdentity(row: IdentityRow): ControlIdentityRecord {
  return {
    identityIssuer: row.identity_issuer,
    subject: row.subject,
    displayName: row.display_name,
    emailForDisplay: row.email_for_display,
    createdAt: row.created_at,
  };
}

function toStack(row: StackRow): ControlStackRecord {
  return {
    stackId: row.stack_id,
    displayName: row.display_name,
    description: row.description,
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: row.created_at,
    revision: row.revision,
  };
}

function toIssuer(row: IssuerRow): ControlIssuerRecord {
  return {
    stackId: row.stack_id,
    issuer: row.issuer,
    audience: row.audience,
    capabilityMaxLifetimeSeconds: row.capability_max_lifetime_seconds,
    revision: row.revision,
  };
}

function toOAuthIssuer(row: OAuthIssuerRow): ControlOAuthIssuerRecord {
  return {
    stackId: row.stack_id,
    issuer: row.issuer,
    audience: row.audience,
    metadataUrl: row.metadata_url,
    metadataType: row.metadata_type as ControlOAuthIssuerRecord["metadataType"],
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    jwksUri: row.jwks_uri,
    registrationEndpoint: row.registration_endpoint,
    scopesSupported: JSON.parse(row.scopes_supported) as string[],
    codeChallengeMethodsSupported: JSON.parse(row.code_challenge_methods_supported) as string[],
    status: row.status as ControlOAuthIssuerRecord["status"],
    verifiedAt: row.verified_at,
    lastRefreshAt: row.last_refresh_at,
    lastRefreshError: row.last_refresh_error,
    jwksDigest: row.jwks_digest,
    capabilityMaxLifetimeSeconds: row.capability_max_lifetime_seconds,
    revision: row.revision,
  };
}

function toIssuerKey(row: IssuerKeyRow): ControlIssuerKeyRecord {
  return {
    stackId: row.stack_id,
    kid: row.kid,
    algorithm: row.algorithm,
    publicJwk: JSON.parse(row.public_jwk) as Record<string, unknown>,
    state: row.state as ControlIssuerKeyRecord["state"],
    revision: row.revision,
  };
}

function toPossessionChallenge(row: PossessionChallengeRow): ControlPossessionChallengeRecord {
  return {
    nonce: row.nonce,
    stackId: row.stack_id,
    kid: row.kid,
    algorithm: row.algorithm,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toAuditRecord(row: AuditEventRow): ControlAuditRecord {
  return {
    eventId: row.event_id,
    stackId: row.stack_id,
    identityIssuer: row.identity_issuer,
    subject: row.subject,
    action: row.action as ControlAuditRecord["action"],
    target: row.target,
    requestId: row.request_id,
    traceId: row.trace_id,
    callerChannel: row.caller_channel === "admin-webui" || row.caller_channel === "mcp"
      ? row.caller_channel
      : null,
    oauthClientHandle: row.oauth_client_handle,
    toolName: row.tool_name,
    createdAt: row.created_at,
  };
}

function toMembership(row: MembershipRow): ControlMembershipRecord {
  return {
    stackId: row.stack_id,
    identityIssuer: row.identity_issuer,
    subject: row.subject,
    displayName: row.display_name,
    emailForDisplay: row.email_for_display,
    joinedAt: row.joined_at,
  };
}

function toIdempotency<T>(row: IdempotencyRow): ControlIdempotencyRecord<T> {
  return {
    identityIssuer: row.identity_issuer,
    subject: row.subject,
    method: row.method,
    canonicalRoute: row.canonical_route,
    key: row.idempotency_key,
    payloadHash: row.payload_hash,
    response: JSON.parse(row.response_json) as T,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toInvitation(row: InvitationRow): ControlMemberInvitationRecord {
  return {
    invitationId: row.invitation_id,
    stackId: row.stack_id,
    status: row.status as ControlMemberInvitationRecord["status"],
    emailConstraint: row.email_constraint,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revision: row.revision,
  };
}

function isUniqueViolation(error: unknown, table: string): boolean {
  return error instanceof Error
    && error.message.includes("UNIQUE constraint failed")
    && error.message.includes(table);
}

/** Global issuer uniqueness race (UNIQUE index `cas_issuer_by_issuer`). */
function isIssuerConflict(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("UNIQUE constraint failed")
    && (error.message.includes("cas_issuer_by_issuer") || error.message.includes("cas_stack_issuer"));
}

function isJsonFailure(error: unknown): boolean {
  return error instanceof Error && /malformed JSON/i.test(error.message);
}
