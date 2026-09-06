import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { CasOperatorIdentityKey } from "@unicas/admin-protocol";
import type {
  ControlAcceptMemberInvitationCommitResult,
  ControlAcceptMemberInvitationPlan,
  ControlAuditRecord,
  ControlCreateMemberInvitationCommitResult,
  ControlCreateMemberInvitationPlan,
  ControlCreateStackCommitResult,
  ControlCreateStackPlan,
  ControlDeleteMemberCommitResult,
  ControlDeleteMemberPlan,
  ControlIdempotencyRecord,
  ControlIdentityPlan,
  ControlIdentityRecord,
  ControlActivateOAuthIssuerCommitResult,
  ControlActivateOAuthIssuerPlan,
  ControlInspectOAuthIssuerCommitResult,
  ControlInspectOAuthIssuerPlan,
  ControlOAuthIssuerRecord,
  ControlOAuthIssuerInspectionRecord,
  ControlMembershipRecord,
  ControlMemberInvitationRecord,
  ControlPatchStackCommitResult,
  ControlPatchStackPlan,
  ControlPatchManagedIssuerCommitResult,
  ControlPatchManagedIssuerPlan,
  ControlPlaneAdminRepository,
  ControlPlaygroundFileRootRecord,
  ControlStackRecord,
  DiscoveredOAuthJwk,
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

  async listPlaygroundFileRoots(stackId: string, ownerKey: string): Promise<readonly ControlPlaygroundFileRootRecord[]> {
    const rows = await this.#db
      .prepare("SELECT stack_id, owner_key, root_id, name, manifest_hash, revision, created_at, updated_at FROM cas_playground_file_roots WHERE stack_id = ? AND owner_key = ? ORDER BY name, root_id")
      .bind(stackId, ownerKey)
      .all<PlaygroundFileRootRow>();
    return (rows.results ?? []).map(toPlaygroundFileRoot);
  }

  async getPlaygroundFileRoot(stackId: string, ownerKey: string, rootId: string): Promise<ControlPlaygroundFileRootRecord | null> {
    const row = await this.#db
      .prepare("SELECT stack_id, owner_key, root_id, name, manifest_hash, revision, created_at, updated_at FROM cas_playground_file_roots WHERE stack_id = ? AND owner_key = ? AND root_id = ?")
      .bind(stackId, ownerKey, rootId)
      .first<PlaygroundFileRootRow>();
    return row ? toPlaygroundFileRoot(row) : null;
  }

  async createPlaygroundFileRoot(record: ControlPlaygroundFileRootRecord): Promise<"created" | "conflict"> {
    try {
      await this.#db.prepare(
        "INSERT INTO cas_playground_file_roots (stack_id, owner_key, root_id, name, manifest_hash, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(record.stackId, record.ownerKey, record.rootId, record.name, record.manifestHash, record.revision, record.createdAt, record.updatedAt).run();
      return "created";
    } catch (error) {
      if (isUniqueViolation(error, "cas_playground_file_roots")) return "conflict";
      throw error;
    }
  }

  async updatePlaygroundFileRoot(input: {
    readonly stackId: string;
    readonly ownerKey: string;
    readonly rootId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly manifestHash: string;
    readonly updatedAt: number;
  }): Promise<"updated" | "not-found" | "revision-mismatch"> {
    const result = await this.#db.prepare(
      "UPDATE cas_playground_file_roots SET name = ?, manifest_hash = ?, revision = revision + 1, updated_at = ? WHERE stack_id = ? AND owner_key = ? AND root_id = ? AND revision = ?",
    ).bind(input.name, input.manifestHash, input.updatedAt, input.stackId, input.ownerKey, input.rootId, input.expectedRevision).run();
    if ((result.meta.changes ?? 0) === 1) return "updated";
    return await this.getPlaygroundFileRoot(input.stackId, input.ownerKey, input.rootId)
      ? "revision-mismatch"
      : "not-found";
  }

  async deletePlaygroundFileRoot(input: {
    readonly stackId: string;
    readonly ownerKey: string;
    readonly rootId: string;
    readonly expectedRevision: number;
  }): Promise<"deleted" | "not-found" | "revision-mismatch"> {
    const result = await this.#db.prepare(
      "DELETE FROM cas_playground_file_roots WHERE stack_id = ? AND owner_key = ? AND root_id = ? AND revision = ?",
    ).bind(input.stackId, input.ownerKey, input.rootId, input.expectedRevision).run();
    if ((result.meta.changes ?? 0) === 1) return "deleted";
    return await this.getPlaygroundFileRoot(input.stackId, input.ownerKey, input.rootId)
      ? "revision-mismatch"
      : "not-found";
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
    if (plan.managedIssuer) {
      const issuer = plan.managedIssuer;
      statements.push(this.#db.prepare(
        "INSERT INTO cas_stack_managed_issuers (stack_id, issuer, audience, metadata_url, authorization_endpoint, token_endpoint, jwks_uri, scopes_supported, code_challenge_methods_supported, status, verified_at, jwks_digest, capability_max_lifetime_seconds, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
      ).bind(
        issuer.stackId,
        issuer.issuer,
        issuer.audience,
        issuer.metadataUrl,
        issuer.authorizationEndpoint,
        issuer.tokenEndpoint,
        issuer.jwksUri,
        JSON.stringify(issuer.scopesSupported),
        JSON.stringify(issuer.codeChallengeMethodsSupported),
        issuer.verifiedAt,
        issuer.jwksDigest,
        issuer.capabilityMaxLifetimeSeconds,
        issuer.revision,
      ));
    }
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

  async getOAuthIssuer(stackId: string): Promise<ControlOAuthIssuerRecord | null> {
    const row = await this.#db
      .prepare(
        "SELECT stack_id, 'external' AS mode, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, registration_endpoint, scopes_supported, code_challenge_methods_supported, status, verified_at, last_refresh_at, last_refresh_error, jwks_digest, capability_max_lifetime_seconds, revision FROM cas_stack_oauth_issuers WHERE stack_id = ? AND mode = 'external'",
      )
      .bind(stackId)
      .first<OAuthIssuerRow>();
    return row ? toOAuthIssuer(row) : null;
  }

  async getManagedOAuthIssuer(stackId: string): Promise<ControlOAuthIssuerRecord | null> {
    const row = await this.#db.prepare(
      "SELECT stack_id, 'managed' AS mode, issuer, audience, metadata_url, 'oauth' AS metadata_type, authorization_endpoint, token_endpoint, jwks_uri, NULL AS registration_endpoint, scopes_supported, code_challenge_methods_supported, status, verified_at, verified_at AS last_refresh_at, NULL AS last_refresh_error, jwks_digest, capability_max_lifetime_seconds, revision FROM cas_stack_managed_issuers WHERE stack_id = ?",
    ).bind(stackId).first<OAuthIssuerRow>();
    return row ? toOAuthIssuer(row) : null;
  }

  async commitPatchManagedOAuthIssuer(
    plan: ControlPatchManagedIssuerPlan,
  ): Promise<ControlPatchManagedIssuerCommitResult> {
    if (plan.issuer) {
      const issuer = plan.issuer;
      try {
        await this.#db.batch([
          this.#db.prepare(
            "INSERT INTO cas_stack_managed_issuers (stack_id, issuer, audience, metadata_url, authorization_endpoint, token_endpoint, jwks_uri, scopes_supported, code_challenge_methods_supported, status, verified_at, jwks_digest, capability_max_lifetime_seconds, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
          ).bind(
            issuer.stackId, issuer.issuer, issuer.audience, issuer.metadataUrl,
            issuer.authorizationEndpoint, issuer.tokenEndpoint, issuer.jwksUri,
            JSON.stringify(issuer.scopesSupported), JSON.stringify(issuer.codeChallengeMethodsSupported),
            issuer.verifiedAt, issuer.jwksDigest, issuer.capabilityMaxLifetimeSeconds, issuer.revision,
          ),
          ...this.#mutationStatements(plan.audit),
        ]);
        return { kind: "created" };
      } catch (error) {
        if (!isUniqueViolation(error, "cas_stack_managed_issuers")) throw error;
        return await this.getManagedOAuthIssuer(plan.stackId)
          ? { kind: "revision-mismatch" }
          : { kind: "not-found" };
      }
    }
    const update = this.#db.prepare(
      "UPDATE cas_stack_managed_issuers SET status = ?, revision = ? WHERE stack_id = ? AND revision = ?",
    ).bind(plan.enabled ? "active" : "disabled", plan.nextRevision, plan.stackId, plan.expectedRevision);
    const requireUpdated = this.#db.prepare(
      "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('invalid', '$') END AS updated",
    );
    try {
      await this.#db.batch([update, requireUpdated, ...this.#mutationStatements(plan.audit)]);
      return { kind: "updated" };
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      return await this.getManagedOAuthIssuer(plan.stackId)
        ? { kind: "revision-mismatch" }
        : { kind: "not-found" };
    }
  }

  async hasOAuthIssuerElsewhere(issuer: string, stackId: string): Promise<boolean> {
    const row = await this.#db
      .prepare("SELECT 1 AS ok FROM cas_stack_oauth_issuers WHERE issuer = ? AND stack_id != ?")
      .bind(issuer, stackId)
      .first<{ ok: number }>();
    return row !== null;
  }

  async commitInspectOAuthIssuer(
    plan: ControlInspectOAuthIssuerPlan,
  ): Promise<ControlInspectOAuthIssuerCommitResult> {
    const issuer = plan.issuer;
    const inspection = plan.inspection;
    const issuerStatement = issuer.revision === 1
      ? this.#db.prepare(
        "INSERT INTO cas_stack_oauth_issuers (stack_id, mode, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, registration_endpoint, scopes_supported, code_challenge_methods_supported, status, verified_at, last_refresh_at, last_refresh_error, jwks_digest, capability_max_lifetime_seconds, revision) VALUES (?, 'external', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, ?, 1)",
      ).bind(
        issuer.stackId,
        issuer.issuer,
        issuer.audience,
        issuer.metadataUrl,
        issuer.metadataType,
        issuer.authorizationEndpoint,
        issuer.tokenEndpoint,
        issuer.jwksUri,
        issuer.registrationEndpoint,
        JSON.stringify(issuer.scopesSupported),
        JSON.stringify(issuer.codeChallengeMethodsSupported),
        issuer.lastRefreshAt,
        issuer.jwksDigest,
        issuer.capabilityMaxLifetimeSeconds,
      )
      : this.#db.prepare(
        "UPDATE cas_stack_oauth_issuers SET mode = 'external', issuer = ?, audience = ?, metadata_url = ?, metadata_type = ?, authorization_endpoint = ?, token_endpoint = ?, jwks_uri = ?, registration_endpoint = ?, scopes_supported = ?, code_challenge_methods_supported = ?, status = 'pending', verified_at = NULL, last_refresh_at = ?, last_refresh_error = NULL, jwks_digest = ?, capability_max_lifetime_seconds = ?, revision = revision + 1 WHERE stack_id = ? AND revision = ? AND status != 'active'",
      ).bind(
        issuer.issuer,
        issuer.audience,
        issuer.metadataUrl,
        issuer.metadataType,
        issuer.authorizationEndpoint,
        issuer.tokenEndpoint,
        issuer.jwksUri,
        issuer.registrationEndpoint,
        JSON.stringify(issuer.scopesSupported),
        JSON.stringify(issuer.codeChallengeMethodsSupported),
        issuer.lastRefreshAt,
        issuer.jwksDigest,
        issuer.capabilityMaxLifetimeSeconds,
        issuer.stackId,
        issuer.revision - 1,
      );
    const requireIssuer = issuer.revision === 1
      ? []
      : [this.#db.prepare(
        "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('invalid', '$') END AS updated",
      )];
    const insertInspection = this.#db.prepare(
      "INSERT INTO cas_oauth_issuer_inspections (inspection_id, stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, registration_endpoint, scopes_supported, code_challenge_methods_supported, metadata_digest, jwks_digest, challenge_hash, capability_max_lifetime_seconds, created_at, expires_at, used_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
    ).bind(
      inspection.inspectionId,
      inspection.stackId,
      inspection.issuer,
      inspection.audience,
      inspection.metadataUrl,
      inspection.metadataType,
      inspection.authorizationEndpoint,
      inspection.tokenEndpoint,
      inspection.jwksUri,
      inspection.registrationEndpoint,
      JSON.stringify(inspection.scopesSupported),
      JSON.stringify(inspection.codeChallengeMethodsSupported),
      inspection.metadataDigest,
      inspection.jwksDigest,
      inspection.challengeHash,
      inspection.capabilityMaxLifetimeSeconds,
      inspection.createdAt,
      inspection.expiresAt,
    );
    const keyStatements = plan.keys.map((key) => this.#db.prepare(
      "INSERT INTO cas_oauth_issuer_inspection_keys (inspection_id, kid, algorithm, public_jwk) VALUES (?, ?, ?, ?)",
    ).bind(inspection.inspectionId, key.kid, key.algorithm, JSON.stringify(key.publicJwk)));
    try {
      await this.#db.batch([
        issuerStatement,
        ...requireIssuer,
        insertInspection,
        ...keyStatements,
        ...this.#mutationStatements(plan.audit),
      ]);
      return { kind: "created" };
    } catch (error) {
      if (isOAuthIssuerConflict(error)) {
        const current = await this.getOAuthIssuer(issuer.stackId);
        return current?.issuer === issuer.issuer
          ? { kind: "revision-mismatch" }
          : { kind: "issuer-conflict" };
      }
      if (isUniqueViolation(error, "cas_stack_oauth_issuers.stack_id")) {
        return { kind: "revision-mismatch" };
      }
      if (isJsonFailure(error)) return { kind: "revision-mismatch" };
      throw error;
    }
  }

  async getOAuthIssuerInspection(inspectionId: string): Promise<ControlOAuthIssuerInspectionRecord | null> {
    const row = await this.#db.prepare(
      "SELECT * FROM cas_oauth_issuer_inspections WHERE inspection_id = ?",
    ).bind(inspectionId).first<OAuthIssuerInspectionRow>();
    return row ? toOAuthIssuerInspection(row) : null;
  }

  async listOAuthIssuerInspectionKeys(inspectionId: string): Promise<readonly DiscoveredOAuthJwk[]> {
    const rows = await this.#db.prepare(
      "SELECT kid, algorithm, public_jwk FROM cas_oauth_issuer_inspection_keys WHERE inspection_id = ? ORDER BY kid",
    ).bind(inspectionId).all<OAuthIssuerInspectionKeyRow>();
    return (rows.results ?? []).map((row) => ({
      kid: row.kid,
      algorithm: row.algorithm as DiscoveredOAuthJwk["algorithm"],
      publicJwk: JSON.parse(row.public_jwk) as Record<string, unknown>,
    }));
  }

  async commitActivateOAuthIssuer(
    plan: ControlActivateOAuthIssuerPlan,
  ): Promise<ControlActivateOAuthIssuerCommitResult> {
    const activateIssuer = this.#db.prepare(
      "UPDATE cas_stack_oauth_issuers SET status = 'active', verified_at = ?, revision = revision + 1 WHERE stack_id = ? AND revision = ? AND status = 'pending' AND mode = 'external'",
    ).bind(plan.activatedAt, plan.stackId, plan.expectedIssuerRevision);
    const requireIssuer = this.#db.prepare(
      "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('invalid', '$') END AS updated",
    );
    const consumeInspection = this.#db.prepare(
      "UPDATE cas_oauth_issuer_inspections SET used_at = ?, revision = revision + 1 WHERE inspection_id = ? AND stack_id = ? AND used_at IS NULL AND expires_at > ?",
    ).bind(plan.activatedAt, plan.inspectionId, plan.stackId, plan.activatedAt);
    const requireInspection = this.#db.prepare(
      "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('unavailable', '$') END AS consumed",
    );
    try {
      await this.#db.batch([
        activateIssuer,
        requireIssuer,
        consumeInspection,
        requireInspection,
        ...this.#mutationStatements(plan.audit),
      ]);
      return { kind: "activated" };
    } catch (error) {
      if (isJsonFailure(error)) {
        const inspection = await this.getOAuthIssuerInspection(plan.inspectionId);
        if (!inspection || inspection.usedAt !== null || inspection.expiresAt <= plan.activatedAt) {
          return { kind: "unavailable" };
        }
        return { kind: "revision-mismatch" };
      }
      throw error;
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

interface PlaygroundFileRootRow {
  readonly stack_id: string;
  readonly owner_key: string;
  readonly root_id: string;
  readonly name: string;
  readonly manifest_hash: string;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
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

interface OAuthIssuerRow {
  readonly stack_id: string;
  readonly mode: string;
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

interface OAuthIssuerInspectionRow {
  readonly inspection_id: string;
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
  readonly metadata_digest: string;
  readonly jwks_digest: string;
  readonly challenge_hash: string;
  readonly capability_max_lifetime_seconds: number;
  readonly created_at: number;
  readonly expires_at: number;
  readonly used_at: number | null;
  readonly revision: number;
}

interface OAuthIssuerInspectionKeyRow {
  readonly kid: string;
  readonly algorithm: string;
  readonly public_jwk: string;
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

function toOAuthIssuer(row: OAuthIssuerRow): ControlOAuthIssuerRecord {
  return {
    stackId: row.stack_id,
    mode: row.mode === "managed" ? "managed" : "external",
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

function toOAuthIssuerInspection(row: OAuthIssuerInspectionRow): ControlOAuthIssuerInspectionRecord {
  return {
    inspectionId: row.inspection_id,
    stackId: row.stack_id,
    issuer: row.issuer,
    audience: row.audience,
    metadataUrl: row.metadata_url,
    metadataType: row.metadata_type as ControlOAuthIssuerInspectionRecord["metadataType"],
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    jwksUri: row.jwks_uri,
    registrationEndpoint: row.registration_endpoint,
    scopesSupported: JSON.parse(row.scopes_supported) as string[],
    codeChallengeMethodsSupported: JSON.parse(row.code_challenge_methods_supported) as string[],
    metadataDigest: row.metadata_digest,
    jwksDigest: row.jwks_digest,
    challengeHash: row.challenge_hash,
    capabilityMaxLifetimeSeconds: row.capability_max_lifetime_seconds,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revision: row.revision,
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

function toPlaygroundFileRoot(row: PlaygroundFileRootRow): ControlPlaygroundFileRootRecord {
  return {
    stackId: row.stack_id,
    ownerKey: row.owner_key,
    rootId: row.root_id,
    name: row.name,
    manifestHash: row.manifest_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function isJsonFailure(error: unknown): boolean {
  return error instanceof Error && /malformed JSON/i.test(error.message);
}

function isOAuthIssuerConflict(error: unknown): boolean {
  return error instanceof Error
    && ((error.message.includes("UNIQUE constraint failed")
      && (error.message.includes("cas_oauth_issuer_by_issuer")
        || error.message.includes("cas_stack_oauth_issuers.issuer")))
      || error.message.includes("issuer conflict"));
}

