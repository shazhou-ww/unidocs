import {
  CasAdminErrorCodes,
  CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
  parseCasAdminETag,
} from "@unicas/admin-protocol";
import type {
  CasAdminAcceptMemberInvitationRequest,
  CasAdminAcceptMemberInvitationResponse,
  CasAdminActivateOAuthIssuerRequest,
  CasAdminActivateOAuthIssuerResponse,
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
  CasAdminGetOAuthIssuerRequest,
  CasAdminGetOAuthIssuerResponse,
  CasAdminInspectOAuthIssuerRequest,
  CasAdminInspectOAuthIssuerResponse,
  CasAdminGetStackRequest,
  CasAdminGetStackResponse,
  CasAdminListCursor,
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
  CasOAuthIssuerInspection,
  CasIssuerKeyState,
  CasOperatorIdentity,
  CasOperatorIdentityKey,
  CasStack,
  CasStackIssuer,
  CasStackIssuerKey,
  CasStackMember,
  CasStackOAuthIssuer,
} from "@unicas/admin-protocol";
import { ControlAuditActions, type ControlAuditAction } from "./control-audit.js";
import { decodeControlListCursor, encodeControlListCursor } from "./control-cursor.js";
import { ControlPlaneError, toAdminError } from "./control-errors.js";
import {
  generateEventId,
  generateInvitationId,
  generateInvitationToken,
  generateNonce,
  generateOAuthInspectionId,
  generateStackId,
} from "./control-ids.js";
import {
  buildPossessionChallenge,
  extractJwsPayload,
  extractJwsProtectedHeader,
  parsePossessionChallenge,
  validatePublicJwk,
  verifyCompactJwsProof,
  verifyPossessionProof,
} from "./control-possession.js";
import {
  buildOAuthIssuerInspectionChallenge,
  canonicalizeOAuthIssuer,
  parseOAuthIssuerInspectionChallenge,
  OAUTH_ISSUER_INSPECTION_TTL_MS,
  type DiscoveredOAuthJwk,
  type OAuthDiscoveryPort,
} from "./oauth-discovery.js";
import type {
  ControlPlaneCallContext,
  ServiceMutationInput,
} from "./control-plane.js";
import {
  canonicalJson,
  CONTROL_LIST_DEFAULT_LIMIT,
  CONTROL_LIST_MAX_LIMIT,
  DEFAULT_CAPABILITY_MAX_LIFETIME_SECONDS,
  INVITATION_TTL_MS,
  isSupportedKeyAlgorithm,
  normalizeEmailConstraint,
  parseControlListLimit,
  POSSESSION_CHALLENGE_TTL_MS,
  sha256Hex,
  validateAudience,
  validateCapabilityMaxLifetimeSeconds,
  validateDisplayName,
  validateEmailConstraint,
  validateInvitationToken,
  validateIssuer,
  validateKid,
} from "./control-validation.js";
import type { SupportedKeyAlgorithm } from "./control-validation.js";

export interface ControlIdentityRecord {
  readonly identityIssuer: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly emailForDisplay: string | null;
  readonly createdAt: number;
}

export interface ControlStackRecord {
  readonly stackId: string;
  readonly displayName: string;
  readonly description: string;
  readonly status: "active" | "suspended";
  readonly createdAt: number;
  readonly revision: number;
}

export interface ControlMembershipRecord {
  readonly stackId: string;
  readonly identityIssuer: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly emailForDisplay: string | null;
  readonly joinedAt?: number;
}

export interface ControlAuditRecord {
  readonly eventId: string;
  readonly stackId: string | null;
  readonly identityIssuer: string;
  readonly subject: string;
  readonly action: ControlAuditAction;
  readonly target: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly callerChannel: "admin-webui" | "mcp" | null;
  readonly oauthClientHandle: string | null;
  readonly toolName: string | null;
  readonly createdAt: number;
}

export interface ControlIdempotencyRecord<T = unknown> {
  readonly identityIssuer: string;
  readonly subject: string;
  readonly method: string;
  readonly canonicalRoute: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly response: T;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ControlMemberInvitationRecord {
  readonly invitationId: string;
  readonly stackId: string;
  readonly status: "pending" | "accepted" | "expired" | "revoked";
  readonly emailConstraint: string | null;
  readonly tokenHash: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly revision: number;
}

export interface ControlMemberInvitationResponse {
  readonly invitation: Omit<ControlMemberInvitationRecord, "tokenHash">;
  readonly acceptUrl: string;
}

export interface ControlIdentityPlan {
  readonly kind: "insert" | "update";
  readonly identity: ControlIdentityRecord;
  readonly audit: ControlAuditRecord;
}

export interface ControlCreateStackPlan {
  readonly stack: ControlStackRecord;
  readonly membership: ControlMembershipRecord & { readonly joinedAt: number };
  readonly audit: ControlAuditRecord;
  readonly idempotency: ControlIdempotencyRecord | null;
}

export interface ControlPatchStackPlan {
  readonly stackId: string;
  readonly expectedRevision: number;
  readonly displayName: string;
  readonly description: string;
  readonly nextRevision: number;
  readonly audit: ControlAuditRecord;
}

export interface ControlCreateMemberInvitationPlan {
  readonly invitation: ControlMemberInvitationRecord;
  readonly response: ControlMemberInvitationResponse;
  readonly audit: ControlAuditRecord;
  readonly idempotency: ControlIdempotencyRecord<ControlMemberInvitationResponse> | null;
}

export interface ControlDeleteMemberPlan {
  readonly stackId: string;
  readonly expectedRevision: number;
  readonly identity: CasOperatorIdentityKey;
  readonly audit: ControlAuditRecord;
}

export interface ControlAcceptMemberInvitationPlan {
  readonly invitationId: string;
  readonly stackId: string;
  readonly tokenHash: string;
  readonly now: number;
  readonly identity: ControlIdentityRecord;
  readonly membership: ControlMembershipRecord & { readonly joinedAt: number };
  readonly audit: ControlAuditRecord;
}

/** Singleton per-stack issuer configuration (at most one row per stack). */
export interface ControlIssuerRecord {
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly capabilityMaxLifetimeSeconds: number;
  readonly revision: number;
}

export interface ControlOAuthIssuerRecord {
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly metadataUrl: string;
  readonly metadataType: CasStackOAuthIssuer["metadataType"];
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly registrationEndpoint: string | null;
  readonly scopesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
  readonly status: CasStackOAuthIssuer["status"];
  readonly verifiedAt: number | null;
  readonly lastRefreshAt: number | null;
  readonly lastRefreshError: string | null;
  readonly jwksDigest: string;
  readonly capabilityMaxLifetimeSeconds: number;
  readonly revision: number;
}

export interface ControlOAuthIssuerInspectionRecord {
  readonly inspectionId: string;
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly metadataUrl: string;
  readonly metadataType: CasStackOAuthIssuer["metadataType"];
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly registrationEndpoint: string | null;
  readonly scopesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
  readonly metadataDigest: string;
  readonly jwksDigest: string;
  readonly challengeHash: string;
  readonly capabilityMaxLifetimeSeconds: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
  readonly revision: number;
}

export interface ControlInspectOAuthIssuerPlan {
  readonly issuer: ControlOAuthIssuerRecord;
  readonly inspection: ControlOAuthIssuerInspectionRecord;
  readonly keys: readonly DiscoveredOAuthJwk[];
  readonly audit: ControlAuditRecord;
}

export type ControlInspectOAuthIssuerCommitResult =
  | { readonly kind: "created" }
  | { readonly kind: "issuer-conflict" | "revision-mismatch" };

export interface ControlActivateOAuthIssuerPlan {
  readonly stackId: string;
  readonly inspectionId: string;
  readonly expectedIssuerRevision: number;
  readonly activatedAt: number;
  readonly keys: readonly DiscoveredOAuthJwk[];
  readonly audit: ControlAuditRecord;
}

export type ControlActivateOAuthIssuerCommitResult =
  | { readonly kind: "activated" }
  | { readonly kind: "unavailable" | "revision-mismatch" };

export interface ControlPutIssuerPlan {
  readonly kind: "insert" | "update";
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly capabilityMaxLifetimeSeconds: number;
  /** Revision expected for the update path; ignored on insert. */
  readonly expectedRevision: number;
  readonly nextRevision: number;
  readonly audit: ControlAuditRecord;
}

export type ControlPutIssuerCommitResult =
  | { readonly kind: "created" | "updated" }
  | { readonly kind: "not-found" | "revision-mismatch" | "issuer-conflict" };

export interface ControlIssuerKeyRecord {
  readonly stackId: string;
  readonly kid: string;
  readonly algorithm: string;
  readonly publicJwk: Readonly<Record<string, unknown>>;
  readonly state: CasIssuerKeyState;
  readonly revision: number;
}

export interface ControlPossessionChallengeRecord {
  readonly nonce: string;
  readonly stackId: string;
  readonly kid: string;
  readonly algorithm: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ControlCreateIssuerKeyPlan {
  readonly key: ControlIssuerKeyRecord;
  readonly challengeNonce: string;
  readonly consumedAt: number;
  readonly audit: ControlAuditRecord;
  readonly idempotency: ControlIdempotencyRecord<ControlIssuerKeyRecord> | null;
}

export type ControlCreateIssuerKeyCommitResult =
  | { readonly kind: "created" }
  | { readonly kind: "key-exists" | "challenge-unavailable" }
  | { readonly kind: "idempotency-race"; readonly record: ControlIdempotencyRecord<ControlIssuerKeyRecord> };

export interface ControlDeleteIssuerKeyPlan {
  readonly stackId: string;
  readonly kid: string;
  readonly toState: CasIssuerKeyState;
  readonly expectedRevision: number;
  readonly nextRevision: number;
  /** Guards the last active key atomically when the target is active. */
  readonly enforceLastActive: boolean;
  readonly audit: ControlAuditRecord;
}

export type ControlDeleteIssuerKeyCommitResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "not-found" | "revision-mismatch" | "last-active" };

export type ControlCreateStackCommitResult =
  | { readonly kind: "created" }
  | { readonly kind: "idempotency-race"; readonly record: ControlIdempotencyRecord };

export type ControlPatchStackCommitResult =
  | { readonly kind: "updated" }
  | { readonly kind: "not-found" }
  | { readonly kind: "revision-mismatch" };

export type ControlCreateMemberInvitationCommitResult =
  | { readonly kind: "created" }
  | { readonly kind: "idempotency-race"; readonly record: ControlIdempotencyRecord<ControlMemberInvitationResponse> };

export type ControlDeleteMemberCommitResult =
  | { readonly kind: "deleted" | "not-member" }
  | { readonly kind: "stack-not-found" | "revision-mismatch" | "last-member" };

export type ControlAcceptMemberInvitationCommitResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "unavailable" };

/** Semantic persistence port. Implementations own storage syntax and atomic commits. */
export interface ControlPlaneAdminRepository {
  getIdentity(identity: CasOperatorIdentityKey): Promise<ControlIdentityRecord | null>;
  commitIdentity(plan: ControlIdentityPlan): Promise<void>;
  listMemberships(identity: CasOperatorIdentityKey): Promise<readonly ControlMembershipRecord[]>;
  listMembers(input: {
    readonly stackId: string;
    readonly afterSubject: string;
    readonly limit: number;
  }): Promise<readonly ControlMembershipRecord[]>;
  readSnapshot(): Promise<number>;
  listStacks(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly afterStackId: string;
    readonly limit: number;
  }): Promise<readonly ControlStackRecord[]>;
  getStack(stackId: string): Promise<ControlStackRecord | null>;
  hasMembership(identity: CasOperatorIdentityKey, stackId: string): Promise<boolean>;
  getIdempotency<T = unknown>(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly method: string;
    readonly canonicalRoute: string;
    readonly key: string;
    readonly now: number;
  }): Promise<ControlIdempotencyRecord<T> | null>;
  getInvitationByTokenHash(tokenHash: string): Promise<ControlMemberInvitationRecord | null>;
  commitCreateStack(plan: ControlCreateStackPlan): Promise<ControlCreateStackCommitResult>;
  commitPatchStack(plan: ControlPatchStackPlan): Promise<ControlPatchStackCommitResult>;
  commitCreateMemberInvitation(plan: ControlCreateMemberInvitationPlan): Promise<ControlCreateMemberInvitationCommitResult>;
  commitDeleteMember(plan: ControlDeleteMemberPlan): Promise<ControlDeleteMemberCommitResult>;
  commitAcceptMemberInvitation(plan: ControlAcceptMemberInvitationPlan): Promise<ControlAcceptMemberInvitationCommitResult>;
  getIssuer(stackId: string): Promise<ControlIssuerRecord | null>;
  getOAuthIssuer(stackId: string): Promise<ControlOAuthIssuerRecord | null>;
  hasOAuthIssuerElsewhere(issuer: string, stackId: string): Promise<boolean>;
  commitInspectOAuthIssuer(
    plan: ControlInspectOAuthIssuerPlan,
  ): Promise<ControlInspectOAuthIssuerCommitResult>;
  getOAuthIssuerInspection(inspectionId: string): Promise<ControlOAuthIssuerInspectionRecord | null>;
  listOAuthIssuerInspectionKeys(inspectionId: string): Promise<readonly DiscoveredOAuthJwk[]>;
  commitActivateOAuthIssuer(
    plan: ControlActivateOAuthIssuerPlan,
  ): Promise<ControlActivateOAuthIssuerCommitResult>;
  hasIssuerElsewhere(issuer: string, stackId: string): Promise<boolean>;
  commitPutIssuer(plan: ControlPutIssuerPlan): Promise<ControlPutIssuerCommitResult>;
  createPossessionChallenge(record: ControlPossessionChallengeRecord): Promise<void>;
  getUsablePossessionChallenge(nonce: string): Promise<ControlPossessionChallengeRecord | null>;
  listIssuerKeys(stackId: string): Promise<readonly ControlIssuerKeyRecord[]>;
  getIssuerKey(stackId: string, kid: string): Promise<ControlIssuerKeyRecord | null>;
  hasIssuerKey(stackId: string, kid: string): Promise<boolean>;
  commitCreateIssuerKey(plan: ControlCreateIssuerKeyPlan): Promise<ControlCreateIssuerKeyCommitResult>;
  commitDeleteIssuerKey(plan: ControlDeleteIssuerKeyPlan): Promise<ControlDeleteIssuerKeyCommitResult>;
  getAuditEventCreatedAt(stackId: string, eventId: string): Promise<number | null>;
  listAuditEvents(input: {
    readonly stackId: string;
    readonly afterCreatedAt: number;
    readonly afterEventId: string;
    readonly limit: number;
  }): Promise<readonly ControlAuditRecord[]>;
  appendAudit(record: ControlAuditRecord): Promise<void>;
}

export interface ControlPlaneAdminServiceOptions {
  readonly now?: () => number;
  readonly listDefaultLimit?: number;
  readonly listMaxLimit?: number;
  readonly generateStackId?: () => string;
  readonly generateEventId?: () => string;
  readonly generateInvitationId?: () => string;
  readonly generateInvitationToken?: () => string;
  readonly generateNonce?: () => string;
  readonly invitationTtlMs?: number;
  readonly possessionChallengeTtlMs?: number;
  readonly oauthDiscovery?: OAuthDiscoveryPort;
  readonly oauthInspectionTtlMs?: number;
  readonly generateOAuthInspectionId?: () => string;
}

/** Cloud-neutral business service for identity, stack administration, and session audit. */
export class ControlPlaneAdminService {
  readonly #repository: ControlPlaneAdminRepository;
  readonly #now: () => number;
  readonly #listDefaultLimit: number;
  readonly #listMaxLimit: number;
  readonly #generateStackId: () => string;
  readonly #generateEventId: () => string;
  readonly #generateInvitationId: () => string;
  readonly #generateInvitationToken: () => string;
  readonly #generateNonce: () => string;
  readonly #invitationTtlMs: number;
  readonly #possessionChallengeTtlMs: number;
  readonly #oauthDiscovery: OAuthDiscoveryPort | null;
  readonly #oauthInspectionTtlMs: number;
  readonly #generateOAuthInspectionId: () => string;

  constructor(repository: ControlPlaneAdminRepository, options: ControlPlaneAdminServiceOptions = {}) {
    this.#repository = repository;
    this.#now = options.now ?? (() => Date.now());
    this.#listDefaultLimit = options.listDefaultLimit ?? CONTROL_LIST_DEFAULT_LIMIT;
    this.#listMaxLimit = options.listMaxLimit ?? CONTROL_LIST_MAX_LIMIT;
    this.#generateStackId = options.generateStackId ?? generateStackId;
    this.#generateEventId = options.generateEventId ?? generateEventId;
    this.#generateInvitationId = options.generateInvitationId ?? generateInvitationId;
    this.#generateInvitationToken = options.generateInvitationToken ?? generateInvitationToken;
    this.#generateNonce = options.generateNonce ?? generateNonce;
    this.#invitationTtlMs = options.invitationTtlMs ?? INVITATION_TTL_MS;
    this.#possessionChallengeTtlMs = options.possessionChallengeTtlMs ?? POSSESSION_CHALLENGE_TTL_MS;
    this.#oauthDiscovery = options.oauthDiscovery ?? null;
    this.#oauthInspectionTtlMs = options.oauthInspectionTtlMs ?? OAUTH_ISSUER_INSPECTION_TTL_MS;
    this.#generateOAuthInspectionId = options.generateOAuthInspectionId ?? generateOAuthInspectionId;
  }

  me(ctx: ControlPlaneCallContext): Promise<CasAdminMeResponse | CasAdminErrorResponse> {
    return this.#guard(async () => {
      await this.#synchronizeIdentity(ctx);
      const profile = ctx.profile ?? { displayName: null, emailForDisplay: null };
      const identity: CasOperatorIdentity = {
        ...ctx.identity,
        displayName: profile.displayName,
        emailForDisplay: profile.emailForDisplay,
      };
      const memberships = (await this.#repository.listMemberships(ctx.identity)).map(toCasStackMember);
      return { identity, memberships };
    });
  }

  listMembers(
    ctx: ControlPlaneCallContext,
    request: CasAdminListMembersRequest,
  ): Promise<CasAdminListMembersResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const limit = this.#listLimit(request.query?.limit);
      const cursor = this.#cursor(request.query?.cursor);
      const snapshot = await this.#repository.readSnapshot();
      if (cursor && cursor.snapshot !== snapshot) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "cursor is bound to an outdated control snapshot");
      }
      const rows = await this.#repository.listMembers({
        stackId: request.path.stackId,
        afterSubject: cursor?.last ?? "",
        limit: limit + 1,
      });
      if (await this.#repository.readSnapshot() !== snapshot) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "control data changed while listing");
      }
      const items = rows.slice(0, limit).map(toCasStackMember);
      const nextCursor = rows.length > limit
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
      const stack = await this.#requireStack(request.path.stackId);
      this.#requireIfMatch(mutation.ifMatch, stack.revision);
      const result = await this.#repository.commitDeleteMember({
        stackId: stack.stackId,
        expectedRevision: stack.revision,
        identity: request.query,
        audit: this.#audit(ctx, ControlAuditActions.memberRemoved, identityTarget(request.query), stack.stackId),
      });
      if (result.kind === "stack-not-found") throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "stack not found");
      if (result.kind === "revision-mismatch") throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "resource revision has changed");
      if (result.kind === "last-member") throw new ControlPlaneError(CasAdminErrorCodes.LAST_MEMBER, "a stack must retain at least one member");
      return { ok: true };
    });
  }

  createMemberInvitation(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminCreateMemberInvitationRequest, "headers">,
    mutation: ServiceMutationInput = {},
  ): Promise<CasAdminCreateMemberInvitationResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const constraintError = validateEmailConstraint(request.body?.emailConstraint);
      if (constraintError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, constraintError);
      const key = this.#idempotencyKey(mutation.idempotencyKey);
      const emailConstraint = normalizeEmailConstraint(request.body?.emailConstraint);
      const now = this.#now();
      const method = "POST";
      const canonicalRoute = `/admin/stacks/${request.path.stackId}/member-invitations`;
      const payloadHash = await sha256Hex(canonicalJson({ emailConstraint }));
      if (key !== undefined) {
        const existing = await this.#repository.getIdempotency<ControlMemberInvitationResponse>({
          identity: ctx.identity, method, canonicalRoute, key, now,
        });
        if (existing) return this.#resolveInvitationIdempotency(existing, payloadHash);
      }
      const token = this.#generateInvitationToken();
      const invitation: ControlMemberInvitationRecord = {
        invitationId: this.#generateInvitationId(),
        stackId: request.path.stackId,
        status: "pending",
        emailConstraint,
        tokenHash: await sha256Hex(token),
        expiresAt: now + this.#invitationTtlMs,
        createdAt: now,
        revision: 1,
      };
      const response: ControlMemberInvitationResponse = {
        invitation: withoutTokenHash(invitation),
        acceptUrl: `/admin/invitations/${token}`,
      };
      const idempotency = key === undefined ? null : {
        ...ctx.identity, method, canonicalRoute, key, payloadHash, response,
        createdAt: now, expiresAt: now + CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
      };
      const result = await this.#repository.commitCreateMemberInvitation({
        invitation,
        response,
        audit: this.#audit(ctx, ControlAuditActions.memberInvited, invitation.invitationId, invitation.stackId),
        idempotency,
      });
      return result.kind === "idempotency-race"
        ? this.#resolveInvitationIdempotency(result.record, payloadHash)
        : response;
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
      const invitation = await this.#repository.getInvitationByTokenHash(tokenHash);
      const now = this.#now();
      if (!invitation || invitation.status !== "pending" || invitation.expiresAt <= now) {
        throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "invitation not found, expired, or already used");
      }
      const profile = ctx.profile ?? { displayName: null, emailForDisplay: null };
      if (invitation.emailConstraint !== null
        && profile.emailForDisplay?.trim().toLowerCase() !== invitation.emailConstraint) {
        throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "invitation is bound to another email");
      }
      const existingIdentity = await this.#repository.getIdentity(ctx.identity);
      const identity: ControlIdentityRecord = {
        ...ctx.identity,
        displayName: profile.displayName,
        emailForDisplay: profile.emailForDisplay,
        createdAt: existingIdentity?.createdAt ?? now,
      };
      const membership = { stackId: invitation.stackId, ...identity, joinedAt: now };
      const result = await this.#repository.commitAcceptMemberInvitation({
        invitationId: invitation.invitationId,
        stackId: invitation.stackId,
        tokenHash,
        now,
        identity,
        membership,
        audit: this.#audit(ctx, ControlAuditActions.memberInvitationAccepted, invitation.stackId, invitation.stackId),
      });
      if (result.kind === "unavailable") {
        throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "invitation not found, expired, or already used");
      }
      return toCasStackMember(membership);
    });
  }

  getIssuer(
    ctx: ControlPlaneCallContext,
    request: CasAdminGetIssuerRequest,
  ): Promise<CasAdminGetIssuerResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      return toCasStackIssuer(await this.#requireIssuer(request.path.stackId));
    });
  }

  getOAuthIssuer(
    ctx: ControlPlaneCallContext,
    request: CasAdminGetOAuthIssuerRequest,
  ): Promise<CasAdminGetOAuthIssuerResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const issuer = await this.#repository.getOAuthIssuer(request.path.stackId);
      if (!issuer) {
        throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "OAuth issuer is not configured");
      }
      return toCasStackOAuthIssuer(issuer);
    });
  }

  inspectOAuthIssuer(
    ctx: ControlPlaneCallContext,
    request: CasAdminInspectOAuthIssuerRequest,
  ): Promise<CasAdminInspectOAuthIssuerResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      if (!this.#oauthDiscovery) {
        throw new ControlPlaneError(CasAdminErrorCodes.SERVICE_UNAVAILABLE, "OAuth discovery is not configured");
      }
      let issuer: string;
      try {
        issuer = canonicalizeOAuthIssuer(request.body.issuer);
      } catch (error) {
        throw new ControlPlaneError(
          CasAdminErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "invalid issuer",
        );
      }
      const audienceError = validateAudience(request.body.audience);
      if (audienceError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, audienceError);
      const lifetimeError = validateCapabilityMaxLifetimeSeconds(request.body.capabilityMaxLifetimeSeconds);
      if (lifetimeError) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, lifetimeError);
      if (await this.#repository.hasIssuerElsewhere(issuer, request.path.stackId)
        || await this.#repository.hasOAuthIssuerElsewhere(issuer, request.path.stackId)) {
        throw new ControlPlaneError(CasAdminErrorCodes.ISSUER_CONFLICT, "issuer is already registered to another stack");
      }
      const existing = await this.#repository.getOAuthIssuer(request.path.stackId);
      if (existing?.status === "active") {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "active OAuth issuer must be refreshed, not reinspected");
      }

      let discovered: Awaited<ReturnType<OAuthDiscoveryPort["inspectIssuer"]>>;
      try {
        discovered = await this.#oauthDiscovery.inspectIssuer({ issuer });
      } catch (error) {
        throw new ControlPlaneError(
          error instanceof TypeError ? CasAdminErrorCodes.INVALID_REQUEST : CasAdminErrorCodes.SERVICE_UNAVAILABLE,
          error instanceof Error ? error.message : "OAuth discovery failed",
        );
      }
      const now = this.#now();
      const expiresAt = now + this.#oauthInspectionTtlMs;
      const inspectionId = this.#generateOAuthInspectionId();
      const nonce = this.#generateNonce();
      const lifetime = request.body.capabilityMaxLifetimeSeconds
        ?? DEFAULT_CAPABILITY_MAX_LIFETIME_SECONDS;
      const challenge = buildOAuthIssuerInspectionChallenge({
        nonce,
        inspectionId,
        stackId: request.path.stackId,
        issuer,
        audience: request.body.audience,
        metadataDigest: discovered.metadataDigest,
        jwksDigest: discovered.jwksDigest,
        capabilityMaxLifetimeSeconds: lifetime,
        expiresAt,
      });
      const revision = (existing?.revision ?? 0) + 1;
      const issuerRecord: ControlOAuthIssuerRecord = {
        stackId: request.path.stackId,
        ...discovered.metadata,
        audience: request.body.audience,
        status: "pending",
        verifiedAt: null,
        lastRefreshAt: now,
        lastRefreshError: null,
        jwksDigest: discovered.jwksDigest,
        capabilityMaxLifetimeSeconds: lifetime,
        revision,
      };
      const inspection: ControlOAuthIssuerInspectionRecord = {
        inspectionId,
        stackId: request.path.stackId,
        ...discovered.metadata,
        audience: request.body.audience,
        metadataDigest: discovered.metadataDigest,
        jwksDigest: discovered.jwksDigest,
        challengeHash: await sha256Hex(challenge),
        capabilityMaxLifetimeSeconds: lifetime,
        createdAt: now,
        expiresAt,
        usedAt: null,
        revision: 1,
      };
      const result = await this.#repository.commitInspectOAuthIssuer({
        issuer: issuerRecord,
        inspection,
        keys: discovered.keys,
        audit: this.#audit(ctx, ControlAuditActions.oauthIssuerInspected, issuer, request.path.stackId),
      });
      if (result.kind === "issuer-conflict") {
        throw new ControlPlaneError(CasAdminErrorCodes.ISSUER_CONFLICT, "issuer is already registered to another stack");
      }
      if (result.kind === "revision-mismatch") {
        throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "OAuth issuer resource revision has changed");
      }
      const response: CasOAuthIssuerInspection = {
        inspectionId,
        stackId: request.path.stackId,
        ...discovered.metadata,
        audience: request.body.audience,
        metadataDigest: discovered.metadataDigest,
        jwksDigest: discovered.jwksDigest,
        capabilityMaxLifetimeSeconds: lifetime,
        challenge,
        expiresAt,
        keys: discovered.keys,
        revision,
      };
      return response;
    });
  }

  activateOAuthIssuer(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminActivateOAuthIssuerRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminActivateOAuthIssuerResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const current = await this.#repository.getOAuthIssuer(request.path.stackId);
      if (!current || current.status !== "pending") {
        throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "pending OAuth issuer is not configured");
      }
      this.#requireIfMatch(mutation.ifMatch, current.revision);
      const inspection = await this.#repository.getOAuthIssuerInspection(request.body.inspectionId);
      const now = this.#now();
      if (!inspection || inspection.stackId !== request.path.stackId || inspection.usedAt !== null || inspection.expiresAt <= now) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "OAuth issuer inspection is unavailable");
      }
      if (inspection.issuer !== current.issuer
        || inspection.audience !== current.audience
        || inspection.metadataUrl !== current.metadataUrl
        || inspection.metadataType !== current.metadataType
        || inspection.authorizationEndpoint !== current.authorizationEndpoint
        || inspection.tokenEndpoint !== current.tokenEndpoint
        || inspection.jwksUri !== current.jwksUri
        || inspection.registrationEndpoint !== current.registrationEndpoint
        || !sameStrings(inspection.scopesSupported, current.scopesSupported)
        || !sameStrings(inspection.codeChallengeMethodsSupported, current.codeChallengeMethodsSupported)
        || inspection.jwksDigest !== current.jwksDigest
        || inspection.capabilityMaxLifetimeSeconds !== current.capabilityMaxLifetimeSeconds) {
        throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "OAuth issuer inspection is no longer current");
      }
      const challenge = extractJwsPayload(request.body.activationProof);
      const parsed = challenge === null ? null : parseOAuthIssuerInspectionChallenge(challenge);
      if (!challenge || !parsed || await sha256Hex(challenge) !== inspection.challengeHash
        || parsed.inspectionId !== inspection.inspectionId
        || parsed.stackId !== inspection.stackId
        || parsed.issuer !== inspection.issuer
        || parsed.audience !== inspection.audience
        || parsed.metadataDigest !== inspection.metadataDigest
        || parsed.jwksDigest !== inspection.jwksDigest
        || parsed.capabilityMaxLifetimeSeconds !== inspection.capabilityMaxLifetimeSeconds
        || parsed.expiresAt !== inspection.expiresAt) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "activation proof challenge is invalid");
      }
      const header = extractJwsProtectedHeader(request.body.activationProof);
      const keys = await this.#repository.listOAuthIssuerInspectionKeys(inspection.inspectionId);
      const key = header === null ? undefined : keys.find((candidate) => candidate.kid === header.kid);
      if (!header || !key || header.alg !== key.algorithm
        || !await verifyCompactJwsProof({
          challenge,
          algorithm: key.algorithm,
          publicJwk: key.publicJwk as Record<string, unknown>,
          proof: request.body.activationProof,
        })) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "activation proof signature is invalid");
      }
      const result = await this.#repository.commitActivateOAuthIssuer({
        stackId: request.path.stackId,
        inspectionId: inspection.inspectionId,
        expectedIssuerRevision: current.revision,
        activatedAt: now,
        keys,
        audit: this.#audit(ctx, ControlAuditActions.oauthIssuerActivated, current.issuer, request.path.stackId),
      });
      if (result.kind === "unavailable") {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "OAuth issuer inspection is unavailable");
      }
      if (result.kind === "revision-mismatch") {
        throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "OAuth issuer resource revision has changed");
      }
      return toCasStackOAuthIssuer({
        ...current,
        status: "active",
        verifiedAt: now,
        revision: current.revision + 1,
      });
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
      if (await this.#repository.hasOAuthIssuerElsewhere(request.body.issuer, request.path.stackId)) {
        throw new ControlPlaneError(CasAdminErrorCodes.ISSUER_CONFLICT, "issuer is already registered to another stack");
      }
      const existing = await this.#repository.getIssuer(request.path.stackId);
      if (existing) {
        this.#requireIfMatch(mutation.ifMatch, existing.revision);
        if (existing.issuer !== request.body.issuer) {
          throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "issuer value is immutable once configured; create a new stack to change it");
        }
        const nextLifetime = request.body.capabilityMaxLifetimeSeconds
          ?? existing.capabilityMaxLifetimeSeconds;
        const result = await this.#repository.commitPutIssuer({
          kind: "update",
          stackId: request.path.stackId,
          issuer: existing.issuer,
          audience: request.body.audience,
          capabilityMaxLifetimeSeconds: nextLifetime,
          expectedRevision: existing.revision,
          nextRevision: existing.revision + 1,
          audit: this.#audit(ctx, ControlAuditActions.issuerPut, request.path.stackId, request.path.stackId),
        });
        if (result.kind === "not-found") throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "issuer is not configured");
        if (result.kind === "revision-mismatch") throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "resource revision has changed");
        return toCasStackIssuer({
          ...existing,
          audience: request.body.audience,
          capabilityMaxLifetimeSeconds: nextLifetime,
          revision: existing.revision + 1,
        });
      }
      if (mutation.ifMatch !== undefined && mutation.ifMatch.trim() !== "*") {
        throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "issuer does not exist");
      }
      if (await this.#repository.hasIssuerElsewhere(request.body.issuer, request.path.stackId)) {
        throw new ControlPlaneError(CasAdminErrorCodes.ISSUER_CONFLICT, "issuer is already registered to another stack");
      }
      const lifetime = request.body.capabilityMaxLifetimeSeconds
        ?? DEFAULT_CAPABILITY_MAX_LIFETIME_SECONDS;
      const result = await this.#repository.commitPutIssuer({
        kind: "insert",
        stackId: request.path.stackId,
        issuer: request.body.issuer,
        audience: request.body.audience,
        capabilityMaxLifetimeSeconds: lifetime,
        expectedRevision: 0,
        nextRevision: 1,
        audit: this.#audit(ctx, ControlAuditActions.issuerPut, request.path.stackId, request.path.stackId),
      });
      if (result.kind === "issuer-conflict") {
        throw new ControlPlaneError(CasAdminErrorCodes.ISSUER_CONFLICT, "issuer is already registered to another stack");
      }
      return {
        stackId: request.path.stackId,
        issuer: request.body.issuer,
        audience: request.body.audience,
        capabilityMaxLifetimeSeconds: lifetime,
        revision: 1,
      };
    });
  }

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
      await this.#requireIssuer(request.stackId);
      const nonce = this.#generateNonce();
      const now = this.#now();
      await this.#repository.createPossessionChallenge({
        nonce,
        stackId: request.stackId,
        kid: request.kid,
        algorithm: request.algorithm,
        createdAt: now,
        expiresAt: now + this.#possessionChallengeTtlMs,
      });
      return { nonce, expiresAt: now + this.#possessionChallengeTtlMs };
    });
  }

  listIssuerKeys(
    ctx: ControlPlaneCallContext,
    request: CasAdminListIssuerKeysRequest,
  ): Promise<CasAdminListIssuerKeysResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const keys = await this.#repository.listIssuerKeys(request.path.stackId);
      return { keys: keys.map(toCasStackIssuerKey) };
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
      await this.#requireIssuer(request.path.stackId);
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
      const challenge = await this.#repository.getUsablePossessionChallenge(parsed.nonce);
      if (
        !challenge
        || challenge.stackId !== request.path.stackId
        || challenge.kid !== request.body.kid
        || challenge.algorithm !== request.body.algorithm
        || challenge.expiresAt <= this.#now()
      ) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "possession challenge is invalid, used, or expired");
      }
      if (await this.#repository.hasIssuerKey(request.path.stackId, request.body.kid)) {
        throw new ControlPlaneError(CasAdminErrorCodes.KEY_STATE_CONFLICT, "issuer key already exists");
      }
      const challengeString = buildPossessionChallenge({
        nonce: challenge.nonce,
        stackId: challenge.stackId,
        kid: challenge.kid,
        algorithm: challenge.algorithm as SupportedKeyAlgorithm,
      });
      const verified = await verifyPossessionProof({
        challenge: challengeString,
        algorithm: challenge.algorithm as SupportedKeyAlgorithm,
        publicJwk: request.body.publicJwk,
        possessionProof: request.body.possessionProof,
      });
      if (!verified) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "possession proof does not match the submitted public key");
      }
      const now = this.#now();
      const method = "POST";
      const canonicalRoute = `/admin/stacks/${request.path.stackId}/issuer/keys`;
      const payloadHash = await sha256Hex(canonicalJson({
        kid: request.body.kid,
        algorithm: request.body.algorithm,
        publicJwk: request.body.publicJwk,
        possessionProof: request.body.possessionProof,
      }));
      const key = this.#idempotencyKey(mutation.idempotencyKey);
      if (key !== undefined) {
        const existing = await this.#repository.getIdempotency<ControlIssuerKeyRecord>({
          identity: ctx.identity, method, canonicalRoute, key, now,
        });
        if (existing) return this.#resolveIssuerKeyIdempotency(existing, payloadHash);
      }
      const record: ControlIssuerKeyRecord = {
        stackId: request.path.stackId,
        kid: request.body.kid,
        algorithm: request.body.algorithm,
        publicJwk: request.body.publicJwk,
        state: "active",
        revision: 1,
      };
      const idempotency: ControlIdempotencyRecord<ControlIssuerKeyRecord> | null = key === undefined ? null : {
        ...ctx.identity,
        method,
        canonicalRoute,
        key,
        payloadHash,
        response: record,
        createdAt: now,
        expiresAt: now + CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
      };
      const result = await this.#repository.commitCreateIssuerKey({
        key: record,
        challengeNonce: challenge.nonce,
        consumedAt: now,
        audit: this.#audit(ctx, ControlAuditActions.issuerKeyCreated, request.body.kid, request.path.stackId),
        idempotency,
      });
      if (result.kind === "idempotency-race") return this.#resolveIssuerKeyIdempotency(result.record, payloadHash);
      if (result.kind === "key-exists") {
        throw new ControlPlaneError(CasAdminErrorCodes.KEY_STATE_CONFLICT, "issuer key already exists");
      }
      if (result.kind === "challenge-unavailable") {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "possession challenge is invalid, used, or expired");
      }
      return toCasStackIssuerKey(record);
    });
  }

  deleteIssuerKey(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminDeleteIssuerKeyRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminDeleteIssuerKeyResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const row = await this.#repository.getIssuerKey(request.path.stackId, request.path.kid);
      if (!row) throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "issuer key not found");
      this.#requireIfMatch(mutation.ifMatch, row.revision);
      const toState: CasIssuerKeyState = request.body?.toState ?? "retiring";
      const fromState = row.state;
      if (!isIssuerKeyTransitionAllowed(fromState, toState)) {
        throw new ControlPlaneError(CasAdminErrorCodes.KEY_STATE_CONFLICT, `cannot transition issuer key from ${row.state} to ${toState}`);
      }
      const result = await this.#repository.commitDeleteIssuerKey({
        stackId: request.path.stackId,
        kid: request.path.kid,
        toState,
        expectedRevision: row.revision,
        nextRevision: row.revision + 1,
        enforceLastActive: fromState === "active",
        audit: this.#audit(ctx, ControlAuditActions.issuerKeyDeleted, `${request.path.kid} -> ${toState}`, request.path.stackId),
      });
      if (result.kind === "not-found") throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "issuer key not found");
      if (result.kind === "revision-mismatch") throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "resource revision has changed");
      if (result.kind === "last-active") {
        throw new ControlPlaneError(CasAdminErrorCodes.KEY_STATE_CONFLICT, "the last active issuer key cannot be retired or revoked; create a replacement first");
      }
      return toCasStackIssuerKey({ ...row, state: toState, revision: row.revision + 1 });
    });
  }

  listControlAuditEvents(
    ctx: ControlPlaneCallContext,
    request: CasAdminListControlAuditEventsRequest,
  ): Promise<CasAdminListControlAuditEventsResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const limit = this.#listLimit(request.query?.limit);
      const cursor = this.#cursor(request.query?.cursor);
      const after = request.query?.after;
      if (after !== undefined && cursor) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "cursor and after are mutually exclusive");
      }
      const snapshot = await this.#repository.readSnapshot();
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
        const createdAt = await this.#repository.getAuditEventCreatedAt(request.path.stackId, afterEventId);
        if (createdAt === null) {
          throw after !== undefined
            ? new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "after references an unknown event")
            : new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "cursor references an unknown event");
        }
        afterCreatedAt = createdAt;
      }
      const rows = await this.#repository.listAuditEvents({
        stackId: request.path.stackId,
        afterCreatedAt,
        afterEventId,
        limit: limit + 1,
      });
      if (await this.#repository.readSnapshot() !== snapshot) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "control data changed while listing");
      }
      const items = rows.slice(0, limit).map(toCasControlAuditEvent);
      const nextCursor: CasAdminListCursor | null = rows.length > limit
        ? encodeControlListCursor({ version: 1, snapshot, last: items[items.length - 1]!.eventId })
        : null;
      return { items, nextCursor };
    });
  }

  listStacks(
    ctx: ControlPlaneCallContext,
    request: CasAdminListStacksRequest,
  ): Promise<CasAdminListStacksResponse> {
    return this.#guard(async () => {
      const limit = this.#listLimit(request.query?.limit);
      const cursor = this.#cursor(request.query?.cursor);
      const snapshot = await this.#repository.readSnapshot();
      if (cursor && cursor.snapshot !== snapshot) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "cursor is bound to an outdated control snapshot");
      }
      const rows = await this.#repository.listStacks({
        identity: ctx.identity,
        afterStackId: cursor?.last ?? "",
        limit: limit + 1,
      });
      if (await this.#repository.readSnapshot() !== snapshot) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "control data changed while listing");
      }
      const items = rows.slice(0, limit).map(toCasStack);
      const nextCursor: CasAdminListCursor | null = rows.length > limit
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
    return this.#guard(async () => {
      const error = validateDisplayName(request.body.displayName);
      if (error) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, error);
      const key = mutation.idempotencyKey;
      if (key !== undefined && (key.length === 0 || key.length > 128)) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, key.length === 0
          ? "Idempotency-Key must not be empty"
          : "Idempotency-Key is too long");
      }
      const now = this.#now();
      const method = "POST";
      const canonicalRoute = "/admin/stacks";
      const payloadHash = await sha256Hex(canonicalJson({ displayName: request.body.displayName }));
      if (key !== undefined) {
        const existing = await this.#repository.getIdempotency({
          identity: ctx.identity, method, canonicalRoute, key, now,
        });
        if (existing) return this.#resolveIdempotency(existing, payloadHash);
      }
      const stack: ControlStackRecord = {
        stackId: this.#generateStackId(),
        displayName: request.body.displayName.trim(),
        description: "",
        status: "active",
        createdAt: now,
        revision: 1,
      };
      const idempotency: ControlIdempotencyRecord | null = key === undefined ? null : {
        ...ctx.identity,
        method,
        canonicalRoute,
        key,
        payloadHash,
        response: stack,
        createdAt: now,
        expiresAt: now + CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
      };
      const result = await this.#repository.commitCreateStack({
        stack,
        membership: { ...ctx.identity, stackId: stack.stackId, displayName: null, emailForDisplay: null, joinedAt: now },
        audit: this.#audit(ctx, ControlAuditActions.stackCreated, stack.stackId, stack.stackId),
        idempotency,
      });
      if (result.kind === "idempotency-race") return this.#resolveIdempotency(result.record, payloadHash);
      return toCasStack(stack);
    });
  }

  getStack(
    ctx: ControlPlaneCallContext,
    request: CasAdminGetStackRequest,
  ): Promise<CasAdminGetStackResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      return toCasStack(await this.#requireStack(request.path.stackId));
    });
  }

  patchStack(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminPatchStackRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminPatchStackResponse> {
    return this.#guard(async () => {
      await this.#requireMember(ctx.identity, request.path.stackId);
      const stack = await this.#requireStack(request.path.stackId);
      this.#requireIfMatch(mutation.ifMatch, stack.revision);
      const rawName = request.body.displayName;
      const rawDescription = request.body.description;
      if (rawName === undefined && rawDescription === undefined) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "no change requested");
      }
      if (rawName !== undefined) {
        const error = validateDisplayName(rawName);
        if (error) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, error);
      }
      if (rawDescription !== undefined && (typeof rawDescription !== "string" || rawDescription.length > 2_000)) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "description must be a string of at most 2000 characters");
      }
      const displayName = rawName?.trim() ?? stack.displayName;
      const description = rawDescription?.trim() ?? stack.description;
      if (displayName === stack.displayName && description === stack.description) {
        throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "no change requested");
      }
      const result = await this.#repository.commitPatchStack({
        stackId: stack.stackId,
        expectedRevision: stack.revision,
        displayName,
        description,
        nextRevision: stack.revision + 1,
        audit: this.#audit(ctx, ControlAuditActions.stackPatched, stack.stackId, stack.stackId),
      });
      if (result.kind === "not-found") throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "stack not found");
      if (result.kind === "revision-mismatch") {
        throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "resource revision has changed");
      }
      return toCasStack({ ...stack, displayName, description, revision: stack.revision + 1 });
    });
  }

  recordSessionAudit(
    ctx: ControlPlaneCallContext,
    action: ControlAuditAction,
    target: string,
    stackId: string | null = null,
  ): Promise<void> {
    return this.#repository.appendAudit(this.#audit(ctx, action, target, stackId));
  }

  async #requireMember(identity: CasOperatorIdentityKey, stackId: string): Promise<void> {
    if (!await this.#repository.hasMembership(identity, stackId)) {
      throw new ControlPlaneError(CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED, "not a member of this stack");
    }
  }

  async #requireStack(stackId: string): Promise<ControlStackRecord> {
    const stack = await this.#repository.getStack(stackId);
    if (!stack) throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "stack not found");
    return stack;
  }

  async #requireIssuer(stackId: string): Promise<ControlIssuerRecord> {
    const issuer = await this.#repository.getIssuer(stackId);
    if (!issuer) throw new ControlPlaneError(CasAdminErrorCodes.NOT_FOUND, "issuer is not configured");
    return issuer;
  }

  #requireIfMatch(ifMatch: string | undefined, revision: number): void {
    if (ifMatch === undefined || ifMatch.trim().length === 0) {
      throw new ControlPlaneError(CasAdminErrorCodes.PRECONDITION_REQUIRED, "If-Match header is required");
    }
    const expected = parseCasAdminETag(ifMatch);
    if (expected === null) {
      throw new ControlPlaneError(CasAdminErrorCodes.PRECONDITION_REQUIRED, "If-Match header is malformed");
    }
    if (expected !== revision) {
      throw new ControlPlaneError(CasAdminErrorCodes.REVISION_MISMATCH, "resource revision has changed");
    }
  }

  #listLimit(value: number | undefined): number {
    if (value === undefined) return this.#listDefaultLimit;
    const parsed = parseControlListLimit(value);
    if (parsed === null || parsed > this.#listMaxLimit) {
      throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, "invalid list limit");
    }
    return parsed;
  }

  #cursor(value: string | undefined): ReturnType<typeof decodeControlListCursor> {
    if (value === undefined) return null;
    const cursor = decodeControlListCursor(value);
    if (!cursor) throw new ControlPlaneError(CasAdminErrorCodes.INVALID_CURSOR, "malformed cursor");
    return cursor;
  }

  #resolveIdempotency(record: ControlIdempotencyRecord, payloadHash: string): CasStack {
    if (record.payloadHash !== payloadHash) {
      throw new ControlPlaneError(CasAdminErrorCodes.IDEMPOTENCY_CONFLICT, "Idempotency-Key reused with a different payload");
    }
    return toCasStack(record.response as ControlStackRecord);
  }

  #resolveInvitationIdempotency(
    record: ControlIdempotencyRecord<ControlMemberInvitationResponse>,
    payloadHash: string,
  ): ControlMemberInvitationResponse {
    if (record.payloadHash !== payloadHash) {
      throw new ControlPlaneError(CasAdminErrorCodes.IDEMPOTENCY_CONFLICT, "Idempotency-Key reused with a different payload");
    }
    return record.response;
  }

  #resolveIssuerKeyIdempotency(
    record: ControlIdempotencyRecord<ControlIssuerKeyRecord>,
    payloadHash: string,
  ): ControlIssuerKeyRecord {
    if (record.payloadHash !== payloadHash) {
      throw new ControlPlaneError(CasAdminErrorCodes.IDEMPOTENCY_CONFLICT, "Idempotency-Key reused with a different payload");
    }
    return record.response;
  }

  #idempotencyKey(key: string | undefined): string | undefined {
    if (key === undefined) return undefined;
    if (key.length === 0 || key.length > 128) {
      throw new ControlPlaneError(CasAdminErrorCodes.INVALID_REQUEST, key.length === 0
        ? "Idempotency-Key must not be empty"
        : "Idempotency-Key is too long");
    }
    return key;
  }

  async #synchronizeIdentity(ctx: ControlPlaneCallContext): Promise<ControlIdentityRecord> {
    const profile = ctx.profile ?? { displayName: null, emailForDisplay: null };
    const existing = await this.#repository.getIdentity(ctx.identity);
    const identity: ControlIdentityRecord = {
      ...ctx.identity,
      displayName: profile.displayName,
      emailForDisplay: profile.emailForDisplay,
      createdAt: existing?.createdAt ?? this.#now(),
    };
    if (!existing || existing.displayName !== identity.displayName || existing.emailForDisplay !== identity.emailForDisplay) {
      await this.#repository.commitIdentity({
        kind: existing ? "update" : "insert",
        identity,
        audit: this.#audit(
          ctx,
          existing ? ControlAuditActions.identityUpdated : ControlAuditActions.identityCreated,
          identityTarget(ctx.identity),
          null,
        ),
      });
    }
    return identity;
  }

  #audit(
    ctx: ControlPlaneCallContext,
    action: ControlAuditAction,
    target: string,
    stackId: string | null,
  ): ControlAuditRecord {
    return {
      eventId: this.#generateEventId(),
      stackId,
      ...ctx.identity,
      action,
      target,
      requestId: ctx.requestId ?? null,
      traceId: ctx.traceId ?? null,
      callerChannel: ctx.caller?.channel ?? null,
      oauthClientHandle: ctx.caller?.oauthClientHandle ?? null,
      toolName: ctx.caller?.toolName ?? null,
      createdAt: this.#now(),
    };
  }

  async #guard<T>(fn: () => Promise<T>): Promise<T | CasAdminErrorResponse> {
    try {
      return await fn();
    } catch (error) {
      return toAdminError(error);
    }
  }
}

function identityTarget(identity: CasOperatorIdentityKey): string {
  return `${identity.identityIssuer}:${identity.subject}`;
}

function toCasStack(record: ControlStackRecord): CasStack {
  return { ...record };
}

function toCasStackIssuer(record: ControlIssuerRecord): CasStackIssuer {
  return { ...record };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toCasStackOAuthIssuer(record: ControlOAuthIssuerRecord): CasStackOAuthIssuer {
  return { ...record };
}

function toCasStackIssuerKey(record: ControlIssuerKeyRecord): CasStackIssuerKey {
  return { ...record };
}

function toCasControlAuditEvent(record: ControlAuditRecord): CasControlAuditEvent {
  return {
    eventId: record.eventId,
    stackId: record.stackId,
    actor: { identityIssuer: record.identityIssuer, subject: record.subject },
    action: record.action,
    target: record.target,
    requestId: record.requestId,
    traceId: record.traceId,
    caller: record.callerChannel === "admin-webui" || record.callerChannel === "mcp"
      ? {
        channel: record.callerChannel,
        oauthClientHandle: record.oauthClientHandle,
        toolName: record.toolName,
      }
      : null,
    createdAt: record.createdAt,
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

function toCasStackMember(record: ControlMembershipRecord): CasStackMember {
  return {
    stackId: record.stackId,
    identityIssuer: record.identityIssuer,
    subject: record.subject,
    displayName: record.displayName,
    emailForDisplay: record.emailForDisplay,
  };
}

function withoutTokenHash(record: ControlMemberInvitationRecord): Omit<ControlMemberInvitationRecord, "tokenHash"> {
  const { tokenHash: _, ...invitation } = record;
  return invitation;
}
