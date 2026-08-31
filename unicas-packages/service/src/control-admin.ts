import {
  CasAdminErrorCodes,
  CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
  parseCasAdminETag,
} from "@unicas/admin-protocol";
import type {
  CasAdminAcceptMemberInvitationRequest,
  CasAdminAcceptMemberInvitationResponse,
  CasAdminCreateMemberInvitationRequest,
  CasAdminCreateMemberInvitationResponse,
  CasAdminCreateStackRequest,
  CasAdminCreateStackResponse,
  CasAdminDeleteMemberRequest,
  CasAdminDeleteMemberResponse,
  CasAdminErrorResponse,
  CasAdminGetStackRequest,
  CasAdminGetStackResponse,
  CasAdminListCursor,
  CasAdminListMembersRequest,
  CasAdminListMembersResponse,
  CasAdminListStacksRequest,
  CasAdminListStacksResponse,
  CasAdminMeResponse,
  CasAdminPatchStackRequest,
  CasAdminPatchStackResponse,
  CasOperatorIdentity,
  CasOperatorIdentityKey,
  CasStack,
  CasStackMember,
} from "@unicas/admin-protocol";
import { ControlAuditActions, type ControlAuditAction } from "./control-audit.js";
import { decodeControlListCursor, encodeControlListCursor } from "./control-cursor.js";
import { ControlPlaneError, toAdminError } from "./control-errors.js";
import {
  generateEventId,
  generateInvitationId,
  generateInvitationToken,
  generateStackId,
} from "./control-ids.js";
import type {
  ControlPlaneCallContext,
  ServiceMutationInput,
} from "./control-plane.js";
import {
  canonicalJson,
  CONTROL_LIST_DEFAULT_LIMIT,
  CONTROL_LIST_MAX_LIMIT,
  INVITATION_TTL_MS,
  normalizeEmailConstraint,
  parseControlListLimit,
  sha256Hex,
  validateDisplayName,
  validateEmailConstraint,
  validateInvitationToken,
} from "./control-validation.js";

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
  readonly invitationTtlMs?: number;
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
  readonly #invitationTtlMs: number;

  constructor(repository: ControlPlaneAdminRepository, options: ControlPlaneAdminServiceOptions = {}) {
    this.#repository = repository;
    this.#now = options.now ?? (() => Date.now());
    this.#listDefaultLimit = options.listDefaultLimit ?? CONTROL_LIST_DEFAULT_LIMIT;
    this.#listMaxLimit = options.listMaxLimit ?? CONTROL_LIST_MAX_LIMIT;
    this.#generateStackId = options.generateStackId ?? generateStackId;
    this.#generateEventId = options.generateEventId ?? generateEventId;
    this.#generateInvitationId = options.generateInvitationId ?? generateInvitationId;
    this.#generateInvitationToken = options.generateInvitationToken ?? generateInvitationToken;
    this.#invitationTtlMs = options.invitationTtlMs ?? INVITATION_TTL_MS;
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
