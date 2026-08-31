/**
 * Cloud-neutral CAS control-plane service.
 *
 * Owns every CAS_CONTROL_DB read/write for operator identity, stacks,
 * memberships, invitations, the singleton tenant issuer and its keys, control
 * audit, and creation idempotency. `@unicas/service-cloudflare` is the only
 * deployable that wires a D1 binding into this library.
 *
 * Every resource mutation appends its control-audit event and bumps the
 * control-data snapshot revision in the same atomic D1 batch. Methods return
 * the frozen `@unicas/admin-protocol` response unions; failures are
 * normalized to `CasAdminErrorResponse`. Deployable ingress adapters may bind
 * CAS_CONTROL_DB only to construct this service; they do not issue direct SQL.
 */

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  CasAdminErrorCodes,
  CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
  parseCasAdminETag,
} from "@unicas/admin-protocol";
import type {
  CasAdminAcceptMemberInvitationRequest,
  CasAdminAcceptMemberInvitationResponse,
  CasAdminCreateIssuerKeyRequest,
  CasAdminCreateIssuerKeyResponse,
  CasAdminCreateMemberInvitationRequest,
  CasAdminCreateMemberInvitationResponse,
  CasAdminCreateStackRequest,
  CasAdminCreateStackResponse,
  CasAdminDeleteIssuerKeyRequest,
  CasAdminDeleteIssuerKeyResponse,
  CasAdminDeleteMemberRequest,
  CasAdminDeleteMemberResponse,
  CasAdminErrorResponse,
  CasAdminGetIssuerRequest,
  CasAdminGetIssuerResponse,
  CasAdminGetStackRequest,
  CasAdminGetStackResponse,
  CasAdminListControlAuditEventsRequest,
  CasAdminListControlAuditEventsResponse,
  CasAdminListIssuerKeysRequest,
  CasAdminListIssuerKeysResponse,
  CasAdminListMembersRequest,
  CasAdminListMembersResponse,
  CasAdminListStacksRequest,
  CasAdminListStacksResponse,
  CasAdminMeResponse,
  CasAdminPatchStackRequest,
  CasAdminPatchStackResponse,
  CasAdminPutIssuerRequest,
  CasAdminPutIssuerResponse,
  CasControlAuditEvent,
  CasIssuerKeyState,
  CasMemberInvitation,
  CasOperatorIdentity,
  CasOperatorIdentityKey,
  CasStack,
  CasStackIssuer,
  CasStackIssuerKey,
  CasStackMember,
  CasAdminListCursor,
} from "@unicas/admin-protocol";
import {
  buildPossessionChallenge,
  canonicalJson,
  ControlAuditActions,
  ControlPlaneError,
  decodeControlListCursor,
  DEFAULT_CAPABILITY_MAX_LIFETIME_SECONDS,
  encodeControlListCursor,
  generateEventId,
  generateInvitationId,
  generateInvitationToken,
  generateNonce,
  generateStackId,
  INVITATION_TTL_MS,
  isSupportedKeyAlgorithm,
  normalizeEmailConstraint,
  parsePossessionChallenge,
  parseControlListLimit,
  POSSESSION_CHALLENGE_TTL_MS,
  sha256Hex,
  toAdminError,
  validateAudience,
  validateCapabilityMaxLifetimeSeconds,
  validateDisplayName,
  validateEmailConstraint,
  validateInvitationToken,
  validateIssuer,
  validateKid,
  validatePublicJwk,
  verifyPossessionProof,
} from "@unicas/service";
import type {
  ControlAuditAction,
  SupportedKeyAlgorithm,
} from "@unicas/service";

/** Authenticated caller context supplied by the BFF after OIDC session check. */
export interface ControlPlaneCallContext {
  readonly identity: CasOperatorIdentityKey;
  /** Display metadata from the verified OIDC profile (email is display-only). */
  readonly profile?: {
    readonly displayName: string | null;
    readonly emailForDisplay: string | null;
  };
  readonly requestId?: string;
  readonly traceId?: string;
  readonly caller?: {
    readonly channel: "admin-webui" | "mcp";
    readonly oauthClientHandle?: string;
    readonly toolName?: string;
  };
}

export interface ControlPlaneServiceOptions {
  readonly now?: () => number;
  readonly invitationTtlMs?: number;
  readonly possessionChallengeTtlMs?: number;
  readonly listDefaultLimit?: number;
  readonly listMaxLimit?: number;
}

/** Service-level mutation input: raw precondition headers, parsed by the service. */
export interface ServiceMutationInput {
  /** Raw `If-Match` header value; absent means "no precondition". */
  readonly ifMatch?: string;
  /** Raw `Idempotency-Key` header value for creation endpoints. */
  readonly idempotencyKey?: string;
}

const SNAPSHOT_KEY = "snapshot";

export class ControlPlaneService {
  readonly #db: D1Database;
  readonly #now: () => number;
  readonly #invitationTtlMs: number;
  readonly #possessionChallengeTtlMs: number;
  readonly #listDefaultLimit: number;
  readonly #listMaxLimit: number;

  constructor(db: D1Database, options: ControlPlaneServiceOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => Date.now());
    this.#invitationTtlMs = options.invitationTtlMs ?? INVITATION_TTL_MS;
    this.#possessionChallengeTtlMs =
      options.possessionChallengeTtlMs ?? POSSESSION_CHALLENGE_TTL_MS;
    this.#listDefaultLimit = options.listDefaultLimit ?? 50;
    this.#listMaxLimit = options.listMaxLimit ?? 200;
  }

  // ------------------------------------------------------------------
  // Operator identity
  // ------------------------------------------------------------------

  me(
    ctx: ControlPlaneCallContext,
  ): Promise<CasAdminMeResponse | CasAdminErrorResponse> {
    return this.#guard(async () => {
      const now = this.#now();
      const profile = ctx.profile ?? { displayName: null, emailForDisplay: null };
      const existing = await this.#db
        .prepare(
          "SELECT display_name, email_for_display FROM cas_operator_identities WHERE identity_issuer = ? AND subject = ?",
        )
        .bind(ctx.identity.identityIssuer, ctx.identity.subject)
        .first<{ display_name: string | null; email_for_display: string | null }>();
      if (!existing) {
        try {
          await this.#db
            .prepare(
              "INSERT INTO cas_operator_identities (identity_issuer, subject, display_name, email_for_display, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(
              ctx.identity.identityIssuer,
              ctx.identity.subject,
              profile.displayName,
              profile.emailForDisplay,
              now,
            )
            .run();
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
        await this.#recordSessionAudit(
          ctx,
          ControlAuditActions.identityCreated,
          `${ctx.identity.identityIssuer}:${ctx.identity.subject}`,
          null,
        );
      } else if (
        existing.display_name !== profile.displayName
        || existing.email_for_display !== profile.emailForDisplay
      ) {
        await this.#db
          .prepare(
            "UPDATE cas_operator_identities SET display_name = ?, email_for_display = ? WHERE identity_issuer = ? AND subject = ?",
          )
          .bind(profile.displayName, profile.emailForDisplay, ctx.identity.identityIssuer, ctx.identity.subject)
          .run();
        await this.#recordSessionAudit(
          ctx,
          ControlAuditActions.identityUpdated,
          `${ctx.identity.identityIssuer}:${ctx.identity.subject}`,
          null,
        );
      }
      const identity: CasOperatorIdentity = {
        identityIssuer: ctx.identity.identityIssuer,
        subject: ctx.identity.subject,
        displayName: profile.displayName,
        emailForDisplay: profile.emailForDisplay,
      };
      const memberships = await this.#listMemberships(ctx.identity);
      return { identity, memberships };
    });
  }

  // ------------------------------------------------------------------
  // Stacks
  // ------------------------------------------------------------------

  listStacks(
    ctx: ControlPlaneCallContext,
    request: CasAdminListStacksRequest,
  ): Promise<CasAdminListStacksResponse> {
    return this.#guard(async () => {
      if (!this.#validListLimit(request.query?.limit)) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "invalid list limit");
      }
      const cursor = this.#requireCursor(request.query?.cursor);
      const snapshot = await this.#readSnapshot();
      if (cursor && cursor.snapshot !== snapshot) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "cursor is bound to an outdated control snapshot");
      }
      const limit = parseControlListLimit(request.query?.limit) ?? this.#listDefaultLimit;
      const rows = await this.#listStackRows(ctx.identity, cursor?.last, limit + 1);
      await this.#requireStableSnapshot(snapshot);
      const items = rows.slice(0, limit).map(toCasStack);
      const nextCursor: CasAdminListCursor | null =
        rows.length > limit
          ? encodeControlListCursor({ version: 1, snapshot, last: items[items.length - 1]!.stackId })
          : null;
      return { items, nextCursor };
    });
  }

  createStack(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminCreateStackRequest, "headers">,
    mutation: ServiceMutationInput = {},
  ): Promise<CasAdminCreateStackResponse> {
    return this.#guard(() =>
      this.#withCreateIdempotency(
        ctx,
        "POST",
        "/admin/stacks",
        mutation.idempotencyKey,
        canonicalJson({ displayName: request.body.displayName }),
        (batch) => this.#buildCreateStack(ctx, request, batch),
      ));
  }

  getStack(
    ctx: ControlPlaneCallContext,
    request: CasAdminGetStackRequest,
  ): Promise<CasAdminGetStackResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const row = await this.#stackRow(request.path.stackId);
      return toCasStack(row);
    });
  }

  patchStack(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminPatchStackRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminPatchStackResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const row = await this.#stackRow(request.path.stackId);
      this.#requireIfMatch(mutation.ifMatch, row.revision);
      const rawName = request.body.displayName;
      const rawDescription = request.body.description;
      if (rawName === undefined && rawDescription === undefined) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "no change requested");
      }
      if (rawName !== undefined) {
        const nameError = validateDisplayName(rawName);
        if (nameError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, nameError);
      }
      if (rawDescription !== undefined && (typeof rawDescription !== "string" || rawDescription.length > 2_000)) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "description must be a string of at most 2000 characters");
      }
      const newName = rawName?.trim() ?? row.display_name;
      const newDescription = rawDescription?.trim() ?? row.description;
      if (newName === row.display_name && newDescription === row.description) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "no change requested");
      }
      const batch = this.#newMutationBatch(ctx, request.path.stackId, ControlAuditActions.stackPatched, request.path.stackId);
      batch.push(
        this.#db.prepare("UPDATE cas_stacks SET display_name = ?, description = ?, revision = revision + 1 WHERE stack_id = ?")
          .bind(newName, newDescription, request.path.stackId),
      );
      await this.#db.batch(batch);
      return toCasStack({ ...row, display_name: newName, description: newDescription, revision: row.revision + 1 });
    });
  }

  // ------------------------------------------------------------------
  // Members
  // ------------------------------------------------------------------

  listMembers(
    ctx: ControlPlaneCallContext,
    request: CasAdminListMembersRequest,
  ): Promise<CasAdminListMembersResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      if (!this.#validListLimit(request.query?.limit)) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "invalid list limit");
      }
      const cursor = this.#requireCursor(request.query?.cursor);
      const snapshot = await this.#readSnapshot();
      if (cursor && cursor.snapshot !== snapshot) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "cursor is bound to an outdated control snapshot");
      }
      const limit = parseControlListLimit(request.query?.limit) ?? this.#listDefaultLimit;
      const rows = await this.#db
        .prepare(
          "SELECT m.stack_id, m.identity_issuer, m.subject, i.display_name, i.email_for_display FROM cas_stack_members m LEFT JOIN cas_operator_identities i ON i.identity_issuer = m.identity_issuer AND i.subject = m.subject WHERE m.stack_id = ? AND m.subject > ? ORDER BY m.subject LIMIT ?",
        )
        .bind(request.path.stackId, cursor?.last ?? "", limit + 1)
        .all<MemberRow>();
      await this.#requireStableSnapshot(snapshot);
      const results = rows.results ?? [];
      const items = results.slice(0, limit).map(toCasStackMember);
      const nextCursor: CasAdminListCursor | null =
        results.length > limit
          ? encodeControlListCursor({ version: 1, snapshot, last: items[items.length - 1]!.subject })
          : null;
      return { items, nextCursor };
    });
  }

  deleteMember(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminDeleteMemberRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminDeleteMemberResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const stack = await this.#stackRow(request.path.stackId);
      this.#requireIfMatch(mutation.ifMatch, stack.revision);
      const { identityIssuer, subject } = request.query;
      const count = await this.#memberCount(request.path.stackId);
      if (count <= 1) {
        throw new ControlPlaneError(CasAdminErrorCodes.LAST_MEMBER, "a stack must retain at least one member");
      }
      const batch = this.#newMutationBatch(ctx, request.path.stackId, ControlAuditActions.memberRemoved, `${identityIssuer}:${subject}`);
      batch.push(
        this.#db.prepare("DELETE FROM cas_stack_members WHERE stack_id = ? AND identity_issuer = ? AND subject = ?")
          .bind(request.path.stackId, identityIssuer, subject),
      );
      await this.#db.batch(batch);
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------
  // Member invitations
  // ------------------------------------------------------------------

  createMemberInvitation(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminCreateMemberInvitationRequest, "headers">,
    mutation: ServiceMutationInput = {},
  ): Promise<CasAdminCreateMemberInvitationResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const constraintError = validateEmailConstraint(request.body?.emailConstraint);
      if (constraintError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, constraintError);
      const normalized = normalizeEmailConstraint(request.body?.emailConstraint);
      const token = generateInvitationToken();
      const tokenHash = await sha256Hex(token);
      return this.#withCreateIdempotency(
        ctx,
        "POST",
        `/admin/stacks/${request.path.stackId}/member-invitations`,
        mutation.idempotencyKey,
        canonicalJson({ emailConstraint: normalized }),
        (batch) => this.#buildCreateInvitation(ctx, request, normalized, token, tokenHash, batch),
      );
    });
  }

  acceptMemberInvitation(
    ctx: ControlPlaneCallContext,
    request: CasAdminAcceptMemberInvitationRequest,
  ): Promise<CasAdminAcceptMemberInvitationResponse> {
    return this.#guard(async () => {
      const tokenError = validateInvitationToken(request.path.token);
      if (tokenError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, tokenError);
      const tokenHash = await sha256Hex(request.path.token);
      const invitation = await this.#db
        .prepare(
          "SELECT invitation_id, stack_id, status, email_constraint, expires_at FROM cas_stack_member_invitations WHERE token_hash = ?",
        )
        .bind(tokenHash)
        .first<InvitationRow>();
      if (!invitation || invitation.status !== "pending") {
        throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "invitation not found or already used");
      }
      if (invitation.expires_at <= this.#now()) {
        await this.#db
          .prepare("UPDATE cas_stack_member_invitations SET status = 'expired' WHERE invitation_id = ?")
          .bind(invitation.invitation_id)
          .run();
        throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "invitation has expired");
      }
      if (invitation.email_constraint !== null) {
        const email = ctx.profile?.emailForDisplay?.trim().toLowerCase() ?? null;
        if (email !== invitation.email_constraint) {
          throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "invitation is bound to another email");
        }
      }
      const existingMember = await this.#db
        .prepare(
          "SELECT m.stack_id, m.identity_issuer, m.subject, i.display_name, i.email_for_display FROM cas_stack_members m LEFT JOIN cas_operator_identities i ON i.identity_issuer = m.identity_issuer AND i.subject = m.subject WHERE m.stack_id = ? AND m.identity_issuer = ? AND m.subject = ?",
        )
        .bind(invitation.stack_id, ctx.identity.identityIssuer, ctx.identity.subject)
        .first<MemberRow>();
      if (existingMember) return toCasStackMember(existingMember);
      await this.#stackRow(invitation.stack_id);
      const batch = this.#newMutationBatch(ctx, invitation.stack_id, ControlAuditActions.memberInvitationAccepted, invitation.stack_id);
      batch.push(
        this.#db.prepare("INSERT INTO cas_stack_members (stack_id, identity_issuer, subject, joined_at) VALUES (?, ?, ?, ?)")
          .bind(invitation.stack_id, ctx.identity.identityIssuer, ctx.identity.subject, this.#now()),
      );
      batch.push(
        this.#db.prepare("UPDATE cas_stack_member_invitations SET status = 'accepted' WHERE invitation_id = ?")
          .bind(invitation.invitation_id),
      );
      await this.#db.batch(batch);
      return {
        stackId: invitation.stack_id,
        identityIssuer: ctx.identity.identityIssuer,
        subject: ctx.identity.subject,
        displayName: ctx.profile?.displayName ?? null,
        emailForDisplay: ctx.profile?.emailForDisplay ?? null,
      };
    });
  }

  // ------------------------------------------------------------------
  // Issuer
  // ------------------------------------------------------------------

  getIssuer(
    ctx: ControlPlaneCallContext,
    request: CasAdminGetIssuerRequest,
  ): Promise<CasAdminGetIssuerResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const row = await this.#issuerRow(request.path.stackId);
      return toCasStackIssuer(row);
    });
  }

  putIssuer(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminPutIssuerRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminPutIssuerResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const issuerError = validateIssuer(request.body.issuer);
      if (issuerError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, issuerError);
      const audienceError = validateAudience(request.body.audience);
      if (audienceError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, audienceError);
      const lifetimeError = validateCapabilityMaxLifetimeSeconds(request.body.capabilityMaxLifetimeSeconds);
      if (lifetimeError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, lifetimeError);
      const existing = await this.#db
        .prepare("SELECT stack_id, issuer, audience, capability_max_lifetime_seconds, revision FROM cas_stack_issuer WHERE stack_id = ?")
        .bind(request.path.stackId)
        .first<IssuerRow>();
      if (existing) {
        this.#requireIfMatch(mutation.ifMatch, existing.revision);
        if (existing.issuer !== request.body.issuer) {
          throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "issuer value is immutable once configured; create a new stack to change it");
        }
        const nextLifetime = request.body.capabilityMaxLifetimeSeconds
          ?? existing.capability_max_lifetime_seconds;
        const batch = this.#newMutationBatch(ctx, request.path.stackId, ControlAuditActions.issuerPut, request.path.stackId);
        batch.push(
          this.#db.prepare("UPDATE cas_stack_issuer SET audience = ?, capability_max_lifetime_seconds = ?, revision = revision + 1 WHERE stack_id = ?")
            .bind(request.body.audience, nextLifetime, request.path.stackId),
        );
        await this.#db.batch(batch);
        return toCasStackIssuer({
          ...existing,
          audience: request.body.audience,
          capability_max_lifetime_seconds: nextLifetime,
          revision: existing.revision + 1,
        });
      }
      if (mutation.ifMatch !== undefined && mutation.ifMatch.trim() !== "*") {
        throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "issuer does not exist");
      }
      await this.#requireIssuerGloballyUnique(request.body.issuer, request.path.stackId);
      const lifetime = request.body.capabilityMaxLifetimeSeconds
        ?? DEFAULT_CAPABILITY_MAX_LIFETIME_SECONDS;
      const batch = this.#newMutationBatch(ctx, request.path.stackId, ControlAuditActions.issuerPut, request.path.stackId);
      batch.push(
        this.#db.prepare("INSERT INTO cas_stack_issuer (stack_id, issuer, audience, capability_max_lifetime_seconds, revision) VALUES (?, ?, ?, ?, 1)")
          .bind(request.path.stackId, request.body.issuer, request.body.audience, lifetime),
      );
      await this.#db.batch(batch);
      return {
        stackId: request.path.stackId,
        issuer: request.body.issuer,
        audience: request.body.audience,
        capabilityMaxLifetimeSeconds: lifetime,
        revision: 1,
      };
    });
  }

  // ------------------------------------------------------------------
  // Issuer keys + possession challenges
  // ------------------------------------------------------------------

  /** BFF-level route: mint a one-time possession challenge for a new key. */
  createPossessionChallenge(
    ctx: ControlPlaneCallContext,
    request: { readonly stackId: string; readonly kid: string; readonly algorithm: string },
  ): Promise<{ readonly nonce: string; readonly expiresAt: number } | CasAdminErrorResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.stackId);
      const kidError = validateKid(request.kid);
      if (kidError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, kidError);
      const algorithmError = isSupportedKeyAlgorithm(request.algorithm)
        ? null
        : "algorithm is not supported";
      if (algorithmError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, algorithmError);
      await this.#issuerRow(request.stackId);
      const nonce = generateNonce();
      const now = this.#now();
      await this.#db
        .prepare("INSERT INTO cas_possession_challenges (nonce, stack_id, kid, algorithm, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(nonce, request.stackId, request.kid, request.algorithm, now, now + this.#possessionChallengeTtlMs)
        .run();
      return { nonce, expiresAt: now + this.#possessionChallengeTtlMs };
    });
  }

  listIssuerKeys(
    ctx: ControlPlaneCallContext,
    request: CasAdminListIssuerKeysRequest,
  ): Promise<CasAdminListIssuerKeysResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const rows = await this.#db
        .prepare("SELECT stack_id, kid, algorithm, public_jwk, state, revision FROM cas_stack_issuer_keys WHERE stack_id = ? ORDER BY kid")
        .bind(request.path.stackId)
        .all<IssuerKeyRow>();
      return { keys: (rows.results ?? []).map(toCasStackIssuerKey) };
    });
  }

  createIssuerKey(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminCreateIssuerKeyRequest, "headers">,
    mutation: ServiceMutationInput = {},
  ): Promise<CasAdminCreateIssuerKeyResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const kidError = validateKid(request.body.kid);
      if (kidError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, kidError);
      const jwkError = validatePublicJwk(request.body.publicJwk, request.body.algorithm);
      if (jwkError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, jwkError);
      await this.#issuerRow(request.path.stackId);
      // The signed challenge must reference an existing, unused nonce before
      // we even consider the idempotency path.
      const signedChallenge = extractJwsPayload(request.body.possessionProof);
      if (!signedChallenge) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "possessionProof must be a compact JWS");
      }
      const parsed = parsePossessionChallenge(signedChallenge);
      if (!parsed) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "possessionProof challenge is malformed");
      }
      const challengeRow = await this.#db
        .prepare("SELECT nonce, stack_id, kid, algorithm, expires_at FROM cas_possession_challenges WHERE nonce = ? AND used_at IS NULL")
        .bind(parsed.nonce)
        .first<PossessionChallengeRow>();
      if (
        !challengeRow
        || challengeRow.stack_id !== request.path.stackId
        || challengeRow.kid !== request.body.kid
        || challengeRow.algorithm !== request.body.algorithm
        || challengeRow.expires_at <= this.#now()
      ) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "possession challenge is invalid, used, or expired");
      }
      return this.#withCreateIdempotency(
        ctx,
        "POST",
        `/admin/stacks/${request.path.stackId}/issuer/keys`,
        mutation.idempotencyKey,
        canonicalJson({ kid: request.body.kid, algorithm: request.body.algorithm, publicJwk: request.body.publicJwk, possessionProof: request.body.possessionProof }),
        (batch) => this.#buildCreateIssuerKey(ctx, request, challengeRow, batch),
      );
    });
  }

  deleteIssuerKey(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminDeleteIssuerKeyRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminDeleteIssuerKeyResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const row = await this.#db
        .prepare("SELECT stack_id, kid, algorithm, public_jwk, state, revision FROM cas_stack_issuer_keys WHERE stack_id = ? AND kid = ?")
        .bind(request.path.stackId, request.path.kid)
        .first<IssuerKeyRow>();
      if (!row) throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "issuer key not found");
      this.#requireIfMatch(mutation.ifMatch, row.revision);
      const toState: CasIssuerKeyState = request.body?.toState ?? "retiring";
      const fromState = row.state as CasIssuerKeyState;
      if (!isIssuerKeyTransitionAllowed(fromState, toState)) {
        throw new ControlPlaneError(CasAdminErrorCodes.KEY_STATE_CONFLICT, `cannot transition issuer key from ${row.state} to ${toState}`);
      }
      if (fromState === "active") {
        // After the transition check, toState is necessarily retiring|revoked.
        const activeCount = await this.#db
          .prepare("SELECT COUNT(*) AS count FROM cas_stack_issuer_keys WHERE stack_id = ? AND state = 'active'")
          .bind(request.path.stackId)
          .first<{ count: number }>();
        if ((activeCount?.count ?? 0) <= 1) {
          throw new ControlPlaneError(CasAdminErrorCodes.KEY_STATE_CONFLICT, "the last active issuer key cannot be retired or revoked; create a replacement first");
        }
      }
      const batch = this.#newMutationBatch(ctx, request.path.stackId, ControlAuditActions.issuerKeyDeleted, `${request.path.kid} -> ${toState}`);
      batch.push(
        this.#db.prepare("UPDATE cas_stack_issuer_keys SET state = ?, revision = revision + 1 WHERE stack_id = ? AND kid = ?")
          .bind(toState, request.path.stackId, request.path.kid),
      );
      await this.#db.batch(batch);
      return toCasStackIssuerKey({ ...row, state: toState, revision: row.revision + 1 });
    });
  }

  // ------------------------------------------------------------------
  // Control audit
  // ------------------------------------------------------------------

  listControlAuditEvents(
    ctx: ControlPlaneCallContext,
    request: CasAdminListControlAuditEventsRequest,
  ): Promise<CasAdminListControlAuditEventsResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      if (!this.#validListLimit(request.query?.limit)) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "invalid list limit");
      }
      const cursor = this.#requireCursor(request.query?.cursor);
      const after = request.query?.after;
      if (after !== undefined && cursor) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "cursor and after are mutually exclusive");
      }
      const snapshot = await this.#readSnapshot();
      if (cursor && cursor.snapshot !== snapshot) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "cursor is bound to an outdated control snapshot");
      }
      // Continuation point: exclusive (created_at, event_id). Resolve from the
      // `after` event id or from the cursor's last event id.
      let afterEventId = "";
      let afterCreatedAt = 0;
      if (after !== undefined) {
        afterEventId = after;
      } else if (cursor) {
        afterEventId = cursor.last;
      }
      if (afterEventId.length > 0) {
        const afterRow = await this.#db
          .prepare("SELECT created_at FROM cas_control_audit_events WHERE event_id = ? AND stack_id = ?")
          .bind(afterEventId, request.path.stackId)
          .first<{ created_at: number }>();
        if (!afterRow) {
          throw after !== undefined
            ? new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "after references an unknown event")
            : new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "cursor references an unknown event");
        }
        afterCreatedAt = afterRow.created_at;
      }
      const limit = parseControlListLimit(request.query?.limit) ?? this.#listDefaultLimit;
      const rows = await this.#db
        .prepare(
          "SELECT event_id, stack_id, identity_issuer, subject, action, target, request_id, trace_id, caller_channel, oauth_client_handle, tool_name, created_at FROM cas_control_audit_events WHERE stack_id = ? AND (created_at > ? OR (created_at = ? AND event_id > ?)) ORDER BY created_at, event_id LIMIT ?",
        )
        .bind(request.path.stackId, afterCreatedAt, afterCreatedAt, afterEventId, limit + 1)
        .all<AuditEventRow>();
      await this.#requireStableSnapshot(snapshot);
      const results = rows.results ?? [];
      const items = results.slice(0, limit).map(toCasControlAuditEvent);
      const nextCursor: CasAdminListCursor | null =
        results.length > limit
          ? encodeControlListCursor({ version: 1, snapshot, last: items[items.length - 1]!.eventId })
          : null;
      return { items, nextCursor };
    });
  }

  /** Record a non-mutation control event (session login/logout). */
  async recordSessionAudit(
    ctx: ControlPlaneCallContext,
    action: ControlAuditAction,
    target: string,
    stackId: string | null = null,
  ): Promise<void> {
    await this.#recordSessionAudit(ctx, action, target, stackId);
  }

  // ------------------------------------------------------------------
  // Creation builders (append statements; executed atomically by caller)
  // ------------------------------------------------------------------

  #buildCreateStack(
    ctx: ControlPlaneCallContext,
    request: CasAdminCreateStackRequest,
    batch: D1PreparedStatement[],
  ): CasStack {
    const nameError = validateDisplayName(request.body.displayName);
    if (nameError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, nameError);
    const stackId = generateStackId();
    const now = this.#now();
    const displayName = request.body.displayName.trim();
    this.#appendMutationStatements(ctx, batch, stackId, ControlAuditActions.stackCreated, stackId);
    batch.push(
      this.#db.prepare("INSERT INTO cas_stacks (stack_id, display_name, description, status, created_at, revision) VALUES (?, ?, '', 'active', ?, 1)")
        .bind(stackId, displayName, now),
    );
    batch.push(
      this.#db.prepare("INSERT INTO cas_stack_members (stack_id, identity_issuer, subject, joined_at) VALUES (?, ?, ?, ?)")
        .bind(stackId, ctx.identity.identityIssuer, ctx.identity.subject, now),
    );
    return { stackId, displayName, description: "", status: "active", createdAt: now, revision: 1 };
  }

  #buildCreateInvitation(
    ctx: ControlPlaneCallContext,
    request: CasAdminCreateMemberInvitationRequest,
    emailConstraint: string | null,
    token: string,
    tokenHash: string,
    batch: D1PreparedStatement[],
  ): CasAdminCreateMemberInvitationResponse {
    const invitationId = generateInvitationId();
    const now = this.#now();
    this.#appendMutationStatements(ctx, batch, request.path.stackId, ControlAuditActions.memberInvited, invitationId);
    batch.push(
      this.#db.prepare(
        "INSERT INTO cas_stack_member_invitations (invitation_id, stack_id, status, email_constraint, token_hash, expires_at, created_at, revision) VALUES (?, ?, 'pending', ?, ?, ?, ?, 1)",
      ).bind(invitationId, request.path.stackId, emailConstraint, tokenHash, now + this.#invitationTtlMs, now),
    );
    const invitation: CasMemberInvitation = {
      invitationId,
      stackId: request.path.stackId,
      status: "pending",
      emailConstraint,
      expiresAt: now + this.#invitationTtlMs,
      createdAt: now,
      revision: 1,
    };
    return { invitation, acceptUrl: `/admin/invitations/${token}` };
  }

  #buildCreateIssuerKey(
    ctx: ControlPlaneCallContext,
    request: CasAdminCreateIssuerKeyRequest,
    challengeRow: PossessionChallengeRow,
    batch: D1PreparedStatement[],
  ): Promise<CasStackIssuerKey> {
    return (async () => {
      // Re-check under the idempotency-protected build so a retry with a
      // different key or no key cannot insert a duplicate kid.
      const existingKey = await this.#db
        .prepare("SELECT 1 AS ok FROM cas_stack_issuer_keys WHERE stack_id = ? AND kid = ?")
        .bind(request.path.stackId, request.body.kid)
        .first<{ ok: number }>();
      if (existingKey) {
        throw new ControlPlaneError(CasAdminErrorCodes.KEY_STATE_CONFLICT, "issuer key already exists");
      }
      const challenge = buildPossessionChallenge({
        nonce: challengeRow.nonce,
        stackId: challengeRow.stack_id,
        kid: challengeRow.kid,
        algorithm: challengeRow.algorithm as SupportedKeyAlgorithm,
      });
      const verified = await verifyPossessionProof({
        challenge,
        algorithm: challengeRow.algorithm as SupportedKeyAlgorithm,
        publicJwk: request.body.publicJwk,
        possessionProof: request.body.possessionProof,
      });
      if (!verified) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "possession proof does not match the submitted public key");
      }
      const now = this.#now();
      this.#appendMutationStatements(ctx, batch, request.path.stackId, ControlAuditActions.issuerKeyCreated, request.body.kid);
      batch.push(
        this.#db.prepare("INSERT INTO cas_stack_issuer_keys (stack_id, kid, algorithm, public_jwk, state, revision) VALUES (?, ?, ?, ?, 'active', 1)")
          .bind(request.path.stackId, request.body.kid, request.body.algorithm, JSON.stringify(request.body.publicJwk)),
      );
      // Atomically consume the one-time challenge.
      batch.push(
        this.#db.prepare("UPDATE cas_possession_challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL")
          .bind(now, challengeRow.nonce),
      );
      return {
        stackId: request.path.stackId,
        kid: request.body.kid,
        algorithm: request.body.algorithm,
        publicJwk: request.body.publicJwk,
        state: "active",
        revision: 1,
      };
    })();
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  async #guard<T>(
    fn: () => Promise<T>,
  ): Promise<T | CasAdminErrorResponse> {
    try {
      return await fn();
    } catch (error) {
      return toAdminError(error);
    }
  }

  /**
   * Atomic create with Idempotency-Key. The builder appends statements to the
   * batch (including its audit event and snapshot bump); the idempotency row
   * commits in the same batch. A concurrent duplicate key loses the unique
   * race and returns the winner's stored response.
   */
  async #withCreateIdempotency<T>(
    ctx: ControlPlaneCallContext,
    method: string,
    route: string,
    idempotencyKey: string | undefined,
    canonicalPayload: string,
    build: (batch: D1PreparedStatement[]) => T | Promise<T>,
  ): Promise<T> {
    const now = this.#now();
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      const batch: D1PreparedStatement[] = [];
      const response = await build(batch);
      if (isAdminErrorResponse(response)) return response;
      await this.#db.batch(batch);
      return response;
    }
    if (idempotencyKey.length > 128) {
      throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "Idempotency-Key is too long");
    }
    const payloadHash = await sha256Hex(canonicalPayload);
    const existing = await this.#db
      .prepare(
        "SELECT payload_hash, response_json FROM cas_control_idempotency WHERE identity_issuer = ? AND subject = ? AND method = ? AND canonical_route = ? AND idempotency_key = ? AND expires_at > ?",
      )
      .bind(ctx.identity.identityIssuer, ctx.identity.subject, method, route, idempotencyKey, now)
      .first<IdempotencyRow>();
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new ControlPlaneError(CasAdminErrorCodes.IDEMPOTENCY_CONFLICT, "Idempotency-Key reused with a different payload");
      }
      return JSON.parse(existing.response_json) as T;
    }
    const batch: D1PreparedStatement[] = [];
    const response = await build(batch);
    if (isAdminErrorResponse(response)) return response;
    batch.push(
      this.#db.prepare(
        "INSERT INTO cas_control_idempotency (identity_issuer, subject, method, canonical_route, idempotency_key, payload_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        ctx.identity.identityIssuer,
        ctx.identity.subject,
        method,
        route,
        idempotencyKey,
        payloadHash,
        JSON.stringify(response),
        now,
        now + CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
      ),
    );
    try {
      await this.#db.batch(batch);
    } catch (error) {
      if (isUniqueViolation(error, "cas_control_idempotency")) {
        const winner = await this.#db
          .prepare(
            "SELECT payload_hash, response_json FROM cas_control_idempotency WHERE identity_issuer = ? AND subject = ? AND method = ? AND canonical_route = ? AND idempotency_key = ?",
          )
          .bind(ctx.identity.identityIssuer, ctx.identity.subject, method, route, idempotencyKey)
          .first<IdempotencyRow>();
        if (winner && winner.payload_hash === payloadHash) {
          return JSON.parse(winner.response_json) as T;
        }
        throw new ControlPlaneError(CasAdminErrorCodes.IDEMPOTENCY_CONFLICT, "Idempotency-Key reused with a different payload");
      }
      throw error;
    }
    return response;
  }

  #requireMember(identity: CasOperatorIdentityKey, stackId: string): Promise<void> {
    return this.#db
      .prepare("SELECT 1 AS ok FROM cas_stack_members WHERE stack_id = ? AND identity_issuer = ? AND subject = ?")
      .bind(stackId, identity.identityIssuer, identity.subject)
      .first<{ ok: number }>()
      .then((row) => {
        if (!row) throw new ControlPlaneError(CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED, "not a member of this stack");
      });
  }

  async #stackRow(stackId: string): Promise<StackRow> {
    const row = await this.#db
      .prepare("SELECT stack_id, display_name, description, status, created_at, revision FROM cas_stacks WHERE stack_id = ?")
      .bind(stackId)
      .first<StackRow>();
    if (!row) throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "stack not found");
    return row;
  }

  async #issuerRow(stackId: string): Promise<IssuerRow> {
    const row = await this.#db
      .prepare("SELECT stack_id, issuer, audience, capability_max_lifetime_seconds, revision FROM cas_stack_issuer WHERE stack_id = ?")
      .bind(stackId)
      .first<IssuerRow>();
    if (!row) throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "issuer is not configured");
    return row;
  }

  async #requireIssuerGloballyUnique(issuer: string, stackId: string): Promise<void> {
    const row = await this.#db
      .prepare("SELECT 1 AS ok FROM cas_stack_issuer WHERE issuer = ? AND stack_id != ?")
      .bind(issuer, stackId)
      .first<{ ok: number }>();
    if (row) throw new ControlPlaneError(CasAdminErrorCodes.ISSUER_CONFLICT, "issuer is already registered to another stack");
  }

  #requireIfMatch(ifMatch: string | undefined, currentRevision: number): void {
    if (ifMatch === undefined || ifMatch.trim().length === 0) {
      throw new ControlPlaneError(CasAdminErrorCodes.PRECONDITION_REQUIRED, "If-Match header is required");
    }
    const expected = parseCasAdminETag(ifMatch);
    if (expected === null) {
      throw new ControlPlaneError(CasAdminErrorCodes.PRECONDITION_REQUIRED, "If-Match header is malformed");
    }
    if (expected !== currentRevision) {
      throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "resource revision has changed");
    }
  }

  async #memberCount(stackId: string): Promise<number> {
    const row = await this.#db
      .prepare("SELECT COUNT(*) AS count FROM cas_stack_members WHERE stack_id = ?")
      .bind(stackId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async #listMemberships(identity: CasOperatorIdentityKey): Promise<CasStackMember[]> {
    const rows = await this.#db
      .prepare(
        "SELECT m.stack_id, m.identity_issuer, m.subject, i.display_name, i.email_for_display FROM cas_stack_members m LEFT JOIN cas_operator_identities i ON i.identity_issuer = m.identity_issuer AND i.subject = m.subject WHERE m.identity_issuer = ? AND m.subject = ? ORDER BY m.stack_id",
      )
      .bind(identity.identityIssuer, identity.subject)
      .all<MemberRow>();
    return (rows.results ?? []).map(toCasStackMember);
  }

  async #listStackRows(
    identity: CasOperatorIdentityKey,
    afterStackId: string | undefined,
    limit: number,
  ): Promise<StackRow[]> {
    const rows = await this.#db
      .prepare(
        "SELECT s.stack_id, s.display_name, s.description, s.status, s.created_at, s.revision FROM cas_stacks s JOIN cas_stack_members m ON m.stack_id = s.stack_id WHERE m.identity_issuer = ? AND m.subject = ? AND s.stack_id > ? ORDER BY s.stack_id LIMIT ?",
      )
      .bind(identity.identityIssuer, identity.subject, afterStackId ?? "", limit)
      .all<StackRow>();
    return rows.results ?? [];
  }

  async #readSnapshot(): Promise<number> {
    const row = await this.#db
      .prepare("SELECT value FROM cas_control_meta WHERE key = ?")
      .bind(SNAPSHOT_KEY)
      .first<{ value: number }>();
    return row?.value ?? 0;
  }

  async #requireStableSnapshot(before: number): Promise<void> {
    const after = await this.#readSnapshot();
    if (after !== before) {
      throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "control data changed while listing");
    }
  }

  /** Snapshot bump + audit insert for a resource mutation batch. */
  #appendMutationStatements(
    ctx: ControlPlaneCallContext,
    batch: D1PreparedStatement[],
    stackId: string | null,
    action: ControlAuditAction,
    target: string,
  ): void {
    batch.push(
      this.#db.prepare("INSERT OR IGNORE INTO cas_control_meta (key, value) VALUES (?, 0)").bind(SNAPSHOT_KEY),
      this.#db.prepare("UPDATE cas_control_meta SET value = value + 1 WHERE key = ?").bind(SNAPSHOT_KEY),
      this.#db.prepare(
        "INSERT INTO cas_control_audit_events (event_id, stack_id, identity_issuer, subject, action, target, request_id, trace_id, caller_channel, oauth_client_handle, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        generateEventId(),
        stackId,
        ctx.identity.identityIssuer,
        ctx.identity.subject,
        action,
        target,
        ctx.requestId ?? null,
        ctx.traceId ?? null,
        ctx.caller?.channel ?? null,
        ctx.caller?.oauthClientHandle ?? null,
        ctx.caller?.toolName ?? null,
        this.#now(),
      ),
    );
  }

  #newMutationBatch(
    ctx: ControlPlaneCallContext,
    stackId: string | null,
    action: ControlAuditAction,
    target: string,
  ): D1PreparedStatement[] {
    const batch: D1PreparedStatement[] = [];
    this.#appendMutationStatements(ctx, batch, stackId, action, target);
    return batch;
  }

  async #recordSessionAudit(
    ctx: ControlPlaneCallContext,
    action: ControlAuditAction,
    target: string,
    stackId: string | null,
  ): Promise<void> {
    await this.#db
      .prepare(
        "INSERT INTO cas_control_audit_events (event_id, stack_id, identity_issuer, subject, action, target, request_id, trace_id, caller_channel, oauth_client_handle, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        generateEventId(),
        stackId,
        ctx.identity.identityIssuer,
        ctx.identity.subject,
        action,
        target,
        ctx.requestId ?? null,
        ctx.traceId ?? null,
        ctx.caller?.channel ?? null,
        ctx.caller?.oauthClientHandle ?? null,
        ctx.caller?.toolName ?? null,
        this.#now(),
      )
      .run();
  }

  #validListLimit(value: number | undefined): boolean {
    return parseControlListLimit(value) !== null;
  }

  #requireCursor(value: string | undefined): ReturnType<typeof decodeControlListCursor> {
    if (value === undefined) return null;
    const cursor = decodeControlListCursor(value);
    if (!cursor) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "malformed cursor");
    return cursor;
  }
}

// ----------------------------------------------------------------------
// Row mappers and helpers
// ----------------------------------------------------------------------

interface StackRow {
  readonly stack_id: string;
  readonly display_name: string;
  readonly description: string;
  readonly status: string;
  readonly created_at: number;
  readonly revision: number;
}

interface MemberRow {
  readonly stack_id: string;
  readonly identity_issuer: string;
  readonly subject: string;
  readonly display_name: string | null;
  readonly email_for_display: string | null;
}

interface InvitationRow {
  readonly invitation_id: string;
  readonly stack_id: string;
  readonly status: string;
  readonly email_constraint: string | null;
  readonly expires_at: number;
}

interface IssuerRow {
  readonly stack_id: string;
  readonly issuer: string;
  readonly audience: string;
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

interface IdempotencyRow {
  readonly payload_hash: string;
  readonly response_json: string;
}

interface PossessionChallengeRow {
  readonly nonce: string;
  readonly stack_id: string;
  readonly kid: string;
  readonly algorithm: string;
  readonly expires_at: number;
}

function toCasStack(row: StackRow): CasStack {
  return {
    stackId: row.stack_id,
    displayName: row.display_name,
    description: row.description,
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: row.created_at,
    revision: row.revision,
  };
}

function toCasStackMember(row: MemberRow): CasStackMember {
  return {
    stackId: row.stack_id,
    identityIssuer: row.identity_issuer,
    subject: row.subject,
    displayName: row.display_name,
    emailForDisplay: row.email_for_display,
  };
}

function toCasStackIssuer(row: IssuerRow): CasStackIssuer {
  return {
    stackId: row.stack_id,
    issuer: row.issuer,
    audience: row.audience,
    capabilityMaxLifetimeSeconds: row.capability_max_lifetime_seconds,
    revision: row.revision,
  };
}

function toCasStackIssuerKey(row: IssuerKeyRow): CasStackIssuerKey {
  return {
    stackId: row.stack_id,
    kid: row.kid,
    algorithm: row.algorithm,
    publicJwk: JSON.parse(row.public_jwk) as Record<string, unknown>,
    state: row.state as CasIssuerKeyState,
    revision: row.revision,
  };
}

function toCasControlAuditEvent(row: AuditEventRow): CasControlAuditEvent {
  return {
    eventId: row.event_id,
    stackId: row.stack_id,
    actor: { identityIssuer: row.identity_issuer, subject: row.subject },
    action: row.action,
    target: row.target,
    requestId: row.request_id,
    traceId: row.trace_id,
    caller: row.caller_channel === "admin-webui" || row.caller_channel === "mcp"
      ? {
        channel: row.caller_channel,
        oauthClientHandle: row.oauth_client_handle,
        toolName: row.tool_name,
      }
      : null,
    createdAt: row.created_at,
  };
}

function isIssuerKeyTransitionAllowed(
  from: CasIssuerKeyState,
  to: CasIssuerKeyState,
): boolean {
  if (from === to) return false;
  switch (from) {
    case "active":
      return to === "retiring" || to === "revoked";
    case "retiring":
      return to === "revoked";
    case "revoked":
      return false;
  }
}

function isAdminErrorResponse(value: unknown): value is CasAdminErrorResponse {
  return (
    typeof value === "object"
    && value !== null
    && "error" in value
    && typeof (value as { error: unknown }).error === "string"
  );
}

function isUniqueViolation(error: unknown, table?: string): boolean {
  if (!(error instanceof Error)) return false;
  if (!error.message.includes("UNIQUE constraint failed")) return false;
  return table === undefined || error.message.includes(table);
}

/** Decode the payload of a compact JWS (three dot-separated base64url parts). */
function extractJwsPayload(jws: string): string | null {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts[0]!.length === 0 || parts[1]!.length === 0 || parts[2]!.length === 0) {
    return null;
  }
  try {
    const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
