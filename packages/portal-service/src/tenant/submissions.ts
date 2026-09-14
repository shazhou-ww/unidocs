import {
  AgentSubmissionRequestSchema, documentSnapshotContentType,
  type AddressedComment, type AgentSubmissionRequest, type AgentThreadUpdate, type CasBlobRef, type SubmissionReceipt, type SValueSchema,
} from "@unidocs/protocol-platform";
import { canonicalJson, schemaHash } from "../identity.js";
import {
  guardCanonicalization, requireIdentifier, requireTenantScope,
  TENANT_LIMITS, TenantAccessError, TenantOperationError, type TenantContext,
} from "./access.js";
import type { DocumentLocationValidator } from "./threads.js";

export type CommittedSubmissionReceipt = Extract<SubmissionReceipt, { readonly state: "committed" }>;
type RejectedSubmissionReceipt = Extract<SubmissionReceipt, { readonly state: "rejected" }>;

export interface SubmissionThreadState {
  readonly threadId: string;
  /** A thread nobody has replied to yet has no watermark; storage's -1 is null here. */
  readonly acknowledgedCommentIdx: number | null;
  readonly latestCommentIdx: number;
  readonly comments: readonly { readonly commentIdx: number; readonly baseVersionIdx: number }[];
}

export interface SubmissionState {
  readonly documentType: string;
  readonly currentVersionIdx: number | null;
  readonly availableDocumentContractIdxs: readonly number[];
  /** Only the threads the request names that exist in the document. */
  readonly threads: ReadonlyMap<string, SubmissionThreadState>;
}

export interface SubmissionContract {
  readonly snapshotSchema: SValueSchema;
  readonly locationSchema: SValueSchema;
}

export interface SubmissionCommitCommand {
  readonly context: TenantContext;
  readonly documentId: string;
  readonly fingerprint: string;
  readonly request: AgentSubmissionRequest;
  /** The state the service read and decided against; the repository re-checks the locks atomically. */
  readonly observed: SubmissionState;
  readonly addressedComments: readonly AddressedComment[];
  readonly now: Date;
}

export type SubmissionCommitOutcome =
  | { readonly kind: "committed"; readonly receipt: CommittedSubmissionReceipt }
  /** A lock failed at the moment of commit; nothing was written. */
  | { readonly kind: "conflict" };

export interface TenantSubmissionRepository {
  findReceipt(context: TenantContext, documentId: string, submissionId: string): Promise<{ fingerprint: string; receipt: CommittedSubmissionReceipt } | null>;
  loadState(context: TenantContext, documentId: string, threadIds: readonly string[]): Promise<SubmissionState | null>;
  loadContract(documentType: string, documentContractIdx: number): Promise<SubmissionContract | null>;
  commit(command: SubmissionCommitCommand): Promise<SubmissionCommitOutcome>;
}

export type SnapshotVerifier = (ref: CasBlobRef, schema: SValueSchema, expectedContentType: string) => Promise<"ok" | "invalid_request" | "content_unavailable" | "unavailable">;

const MAX_THREAD_UPDATES = 50;
const AGENT_SCOPES: readonly string[] = ["documents:read", "cas:read", "cas:lease", "comments:read", "comments:reply", "versions:submit"];

/** Submissions are an Agent bearer operation; a browser session never reaches them (R10). */
function requireScopes(context: TenantContext, required: readonly string[]): void {
  if (context.transport !== "bearer") throw new TenantAccessError("forbidden");
  const granted = context.scopes ?? [];
  if (required.some(scope => !granted.includes(scope))) throw new TenantAccessError("forbidden");
}

/**
 * The same bounds as threads.ts:46 requireBoundedMessage, which is private to
 * that file. The Agent contract has no LIMIT_EXCEEDED, so an oversized reply is
 * invalid_request here rather than limit_exceeded.
 */
async function requireBoundedReply(update: AgentThreadUpdate): Promise<void> {
  if ((update.content.text?.length ?? 0) > TENANT_LIMITS.messageText || update.content.attachments.length > TENANT_LIMITS.attachments) throw new TenantOperationError("invalid_request");
  for (const location of update.resultLocations) {
    const payloadBytes = await guardCanonicalization(() => new TextEncoder().encode(canonicalJson(location.payload)).byteLength);
    if (payloadBytes > TENANT_LIMITS.locationPayloadBytes) throw new TenantOperationError("invalid_request");
  }
}

/** R7: version lock, then contract, then thread locks; the first failure is the reason. */
function lockFailure(request: AgentSubmissionRequest, state: SubmissionState): RejectedSubmissionReceipt["reason"] | null {
  if (request.newSnapshotBlob !== undefined) {
    if (request.observedCurrentVersionIdx !== state.currentVersionIdx) return "version_conflict";
    if (!state.availableDocumentContractIdxs.includes(request.newDocumentContractIdx!)) return "document_contract_conflict";
  }
  if (request.threadUpdates.some(update => update.observedAcknowledgedCommentIdx !== state.threads.get(update.threadId)!.acknowledgedCommentIdx)) return "reply_watermark_conflict";
  return null;
}

/** R6: the comments a new version answers, in thread-update order then ascending comment index. */
function addressedCommentsOf(request: AgentSubmissionRequest, state: SubmissionState): AddressedComment[] {
  if (request.newSnapshotBlob === undefined) return [];
  return request.threadUpdates.flatMap(update => {
    const after = update.observedAcknowledgedCommentIdx ?? -1;
    return state.threads.get(update.threadId)!.comments
      .filter(comment => comment.commentIdx > after && comment.commentIdx <= update.respondThroughCommentIdx)
      .toSorted((a, b) => a.commentIdx - b.commentIdx)
      .map(comment => ({ threadId: update.threadId, commentIdx: comment.commentIdx, baseVersionIdx: comment.baseVersionIdx }));
  });
}

export function createTenantSubmissionService(repository: TenantSubmissionRepository, options: {
  readonly validateLocation: DocumentLocationValidator;
  readonly verifySnapshot: SnapshotVerifier;
  readonly now?: () => Date;
}) {
  const clock = options.now ?? (() => new Date());

  async function requireState(context: TenantContext, documentId: string, request: AgentSubmissionRequest): Promise<SubmissionState> {
    const state = await repository.loadState(context, documentId, request.threadUpdates.map(update => update.threadId));
    if (!state) throw new TenantOperationError("not_found");
    if (request.threadUpdates.some(update => !state.threads.has(update.threadId))) throw new TenantOperationError("not_found");
    return state;
  }

  function rejected(request: AgentSubmissionRequest, state: SubmissionState, reason: RejectedSubmissionReceipt["reason"]): RejectedSubmissionReceipt {
    return {
      submissionId: request.submissionId, state: "rejected", reason, rejectedAt: clock().toISOString(),
      conflict: {
        currentVersionIdx: state.currentVersionIdx,
        availableDocumentContractIdxs: [...state.availableDocumentContractIdxs],
        threads: request.threadUpdates.map(update => {
          const thread = state.threads.get(update.threadId)!;
          return { threadId: thread.threadId, acknowledgedCommentIdx: thread.acknowledgedCommentIdx, latestCommentIdx: thread.latestCommentIdx };
        }),
      },
    };
  }

  /** Steps 5–12 of one decision. `retry` means the commit conflicted with every lock still holding on reread. */
  async function decide(context: TenantContext, documentId: string, request: AgentSubmissionRequest, fingerprint: string): Promise<SubmissionReceipt | { readonly retry: true }> {
    const stored = await repository.findReceipt(context, documentId, request.submissionId);
    if (stored) {
      if (stored.fingerprint !== fingerprint) throw new TenantOperationError("invalid_request");
      return stored.receipt;
    }

    const state = await requireState(context, documentId, request);
    const reason = lockFailure(request, state);
    if (reason) return rejected(request, state, reason);

    for (const update of request.threadUpdates) {
      const thread = state.threads.get(update.threadId)!;
      const after = update.observedAcknowledgedCommentIdx ?? -1;
      if (update.respondThroughCommentIdx <= after || update.respondThroughCommentIdx > thread.latestCommentIdx) throw new TenantOperationError("invalid_request");
    }

    const snapshot = request.newSnapshotBlob;
    if (snapshot !== undefined) {
      const contractIdx = request.newDocumentContractIdx!;
      const contract = await repository.loadContract(state.documentType, contractIdx);
      if (!contract) throw new TenantOperationError("unavailable");
      const expectedContentType = documentSnapshotContentType(state.documentType);
      if (snapshot.contentType !== expectedContentType) throw new TenantOperationError("invalid_request");
      const verdict = await options.verifySnapshot(snapshot, contract.snapshotSchema, expectedContentType);
      if (verdict !== "ok") throw new TenantOperationError(verdict);
      for (const location of request.threadUpdates.flatMap(update => update.resultLocations)) {
        if (location.documentContractIdx !== contractIdx || !options.validateLocation(location, contract.locationSchema)) throw new TenantOperationError("location_contract_violation");
      }
    }

    const outcome = await repository.commit({
      context, documentId, fingerprint, request, observed: state, addressedComments: addressedCommentsOf(request, state), now: clock(),
    });
    if (outcome.kind === "committed") return outcome.receipt;

    const reread = await requireState(context, documentId, request);
    const rereadReason = lockFailure(request, reread);
    if (rereadReason) return rejected(request, reread, rereadReason);
    return { retry: true };
  }

  return {
    async create(context: TenantContext, tenantId: string, documentId: string, body: AgentSubmissionRequest): Promise<SubmissionReceipt> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const parsed = AgentSubmissionRequestSchema.safeParse(body);
      if (!parsed.success) throw new TenantOperationError("invalid_request");
      const request = parsed.data;
      requireIdentifier(request.submissionId);
      for (const update of request.threadUpdates) requireIdentifier(update.threadId);

      const hasSnapshot = request.newSnapshotBlob !== undefined;
      requireScopes(context, [...(hasSnapshot ? ["versions:submit"] : []), ...(request.threadUpdates.length > 0 ? ["comments:reply"] : [])]);

      if (!hasSnapshot && request.threadUpdates.length === 0) throw new TenantOperationError("invalid_request");
      if (request.threadUpdates.length > MAX_THREAD_UPDATES) throw new TenantOperationError("invalid_request");
      if (new Set(request.threadUpdates.map(update => update.threadId)).size !== request.threadUpdates.length) throw new TenantOperationError("invalid_request");
      for (const update of request.threadUpdates) await requireBoundedReply(update);

      const fingerprint = await guardCanonicalization(() => schemaHash({ operation: "createSubmission", documentId: document, body: request }));

      // One retry absorbs a commit conflict whose reread shows every lock holding (a race the reread cannot explain).
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const decision = await decide(context, document, request, fingerprint);
        if (!("retry" in decision)) return decision;
      }
      throw new TenantOperationError("unavailable");
    },

    async get(context: TenantContext, tenantId: string, documentId: string, submissionId: string): Promise<CommittedSubmissionReceipt> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const submission = requireIdentifier(submissionId);
      if (context.transport !== "bearer" || !(context.scopes ?? []).some(scope => AGENT_SCOPES.includes(scope))) throw new TenantAccessError("forbidden");
      const stored = await repository.findReceipt(context, document, submission);
      if (!stored) throw new TenantOperationError("not_found");
      return stored.receipt;
    },
  };
}
