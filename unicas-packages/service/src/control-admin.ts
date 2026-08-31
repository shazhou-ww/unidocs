import {
  CasAdminErrorCodes,
  CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
  parseCasAdminETag,
} from "@unicas/admin-protocol";
import type {
  CasAdminCreateStackRequest,
  CasAdminCreateStackResponse,
  CasAdminErrorResponse,
  CasAdminGetStackRequest,
  CasAdminGetStackResponse,
  CasAdminListCursor,
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
import { generateEventId, generateStackId } from "./control-ids.js";
import type {
  ControlPlaneCallContext,
  ServiceMutationInput,
} from "./control-plane.js";
import {
  canonicalJson,
  CONTROL_LIST_DEFAULT_LIMIT,
  CONTROL_LIST_MAX_LIMIT,
  parseControlListLimit,
  sha256Hex,
  validateDisplayName,
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

export interface ControlIdempotencyRecord {
  readonly identityIssuer: string;
  readonly subject: string;
  readonly method: string;
  readonly canonicalRoute: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly response: ControlStackRecord;
  readonly createdAt: number;
  readonly expiresAt: number;
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

export type ControlCreateStackCommitResult =
  | { readonly kind: "created" }
  | { readonly kind: "idempotency-race"; readonly record: ControlIdempotencyRecord };

export type ControlPatchStackCommitResult =
  | { readonly kind: "updated" }
  | { readonly kind: "not-found" }
  | { readonly kind: "revision-mismatch" };

/** Semantic persistence port. Implementations own storage syntax and atomic commits. */
export interface ControlPlaneAdminRepository {
  getIdentity(identity: CasOperatorIdentityKey): Promise<ControlIdentityRecord | null>;
  commitIdentity(plan: ControlIdentityPlan): Promise<void>;
  listMemberships(identity: CasOperatorIdentityKey): Promise<readonly ControlMembershipRecord[]>;
  readSnapshot(): Promise<number>;
  listStacks(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly afterStackId: string;
    readonly limit: number;
  }): Promise<readonly ControlStackRecord[]>;
  getStack(stackId: string): Promise<ControlStackRecord | null>;
  hasMembership(identity: CasOperatorIdentityKey, stackId: string): Promise<boolean>;
  getIdempotency(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly method: string;
    readonly canonicalRoute: string;
    readonly key: string;
    readonly now: number;
  }): Promise<ControlIdempotencyRecord | null>;
  commitCreateStack(plan: ControlCreateStackPlan): Promise<ControlCreateStackCommitResult>;
  commitPatchStack(plan: ControlPatchStackPlan): Promise<ControlPatchStackCommitResult>;
  appendAudit(record: ControlAuditRecord): Promise<void>;
}

export interface ControlPlaneAdminServiceOptions {
  readonly now?: () => number;
  readonly listDefaultLimit?: number;
  readonly listMaxLimit?: number;
  readonly generateStackId?: () => string;
  readonly generateEventId?: () => string;
}

/** Cloud-neutral business service for identity, stack administration, and session audit. */
export class ControlPlaneAdminService {
  readonly #repository: ControlPlaneAdminRepository;
  readonly #now: () => number;
  readonly #listDefaultLimit: number;
  readonly #listMaxLimit: number;
  readonly #generateStackId: () => string;
  readonly #generateEventId: () => string;

  constructor(repository: ControlPlaneAdminRepository, options: ControlPlaneAdminServiceOptions = {}) {
    this.#repository = repository;
    this.#now = options.now ?? (() => Date.now());
    this.#listDefaultLimit = options.listDefaultLimit ?? CONTROL_LIST_DEFAULT_LIMIT;
    this.#listMaxLimit = options.listMaxLimit ?? CONTROL_LIST_MAX_LIMIT;
    this.#generateStackId = options.generateStackId ?? generateStackId;
    this.#generateEventId = options.generateEventId ?? generateEventId;
  }

  me(ctx: ControlPlaneCallContext): Promise<CasAdminMeResponse | CasAdminErrorResponse> {
    return this.#guard(async () => {
      const profile = ctx.profile ?? { displayName: null, emailForDisplay: null };
      const existing = await this.#repository.getIdentity(ctx.identity);
      if (!existing) {
        const identity: ControlIdentityRecord = {
          ...ctx.identity,
          displayName: profile.displayName,
          emailForDisplay: profile.emailForDisplay,
          createdAt: this.#now(),
        };
        await this.#repository.commitIdentity({
          kind: "insert",
          identity,
          audit: this.#audit(ctx, ControlAuditActions.identityCreated, identityTarget(ctx.identity), null),
        });
      } else if (
        existing.displayName !== profile.displayName
        || existing.emailForDisplay !== profile.emailForDisplay
      ) {
        await this.#repository.commitIdentity({
          kind: "update",
          identity: { ...existing, displayName: profile.displayName, emailForDisplay: profile.emailForDisplay },
          audit: this.#audit(ctx, ControlAuditActions.identityUpdated, identityTarget(ctx.identity), null),
        });
      }
      const identity: CasOperatorIdentity = {
        ...ctx.identity,
        displayName: profile.displayName,
        emailForDisplay: profile.emailForDisplay,
      };
      const memberships = (await this.#repository.listMemberships(ctx.identity)).map(toCasStackMember);
      return { identity, memberships };
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
    return toCasStack(record.response);
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
