/**
 * Agent data-plane contracts for OAuth scopes, optimistic concurrency,
 * atomic version-and-reply submissions, conflicts, and durable receipts.
 *
 * - `POST /api/v1/tenants/{tenantId}/documents/{documentId}/submissions`:
 *   atomically validate locks, create an optional version, append replies, and persist a receipt.
 * - `GET /api/v1/tenants/{tenantId}/documents/{documentId}/submissions/{submissionId}`:
 *   recover the durable receipt after timeout or retry without repeating work.
 *
 * Agents use the read and CAS endpoints from `PlatformEndpointContracts`.
 */
import type { SValue } from "@unidocs/protocol";
import type {
  DocumentContractIdx,
  DocumentLocation,
  DocumentId,
  EndpointContract,
  IsoDateTime,
  MessageContent,
  CommentIdx,
  SubmissionId,
  ThreadId,
  TenantId,
  VersionIdx,
} from "./common.js";
import type { ReplyRecord, VersionRecord } from "./resources.js";

export type AgentScope =
  | "documents:read"
  | "cas:read"
  | "cas:lease"
  | "comments:read"
  | "comments:reply"
  | "versions:submit";

export interface AgentThreadUpdate {
  readonly threadId: ThreadId;
  readonly observedAcknowledgedCommentIdx: CommentIdx | null;
  readonly respondThroughCommentIdx: CommentIdx;
  readonly content: MessageContent;
  /** Relative to newSnapshot; must be empty when newSnapshot is omitted. */
  readonly resultLocations: readonly DocumentLocation[];
}

export interface AgentSubmissionRequest {
  readonly submissionId: SubmissionId;
  readonly observedCurrentVersionIdx?: VersionIdx | null;
  /** Required with newSnapshot and must name an available paired contract revision. */
  readonly newDocumentContractIdx?: DocumentContractIdx;
  readonly newSnapshot?: SValue;
  readonly threadUpdates: readonly AgentThreadUpdate[];
}

export interface SubmissionConflict {
  readonly currentVersionIdx: VersionIdx | null;
  readonly availableDocumentContractIdxs: readonly DocumentContractIdx[];
  readonly threads: readonly {
    readonly threadId: ThreadId;
    readonly acknowledgedCommentIdx: CommentIdx | null;
    readonly latestCommentIdx: CommentIdx;
  }[];
}

export type SubmissionReceipt =
  | {
    readonly submissionId: SubmissionId;
    readonly state: "committed";
    readonly version: VersionRecord | null;
    readonly replies: readonly ReplyRecord[];
    readonly committedAt: IsoDateTime;
  }
  | {
    readonly submissionId: SubmissionId;
    readonly state: "rejected";
    readonly reason:
      | "version_conflict"
      | "document_contract_conflict"
      | "reply_watermark_conflict";
    readonly conflict: SubmissionConflict;
    readonly rejectedAt: IsoDateTime;
  };

export interface AgentDocumentPath {
  readonly tenantId: TenantId;
  readonly documentId: DocumentId;
}

export interface SubmissionPath extends AgentDocumentPath {
  readonly submissionId: SubmissionId;
}

export interface AgentEndpointContracts {
  readonly createSubmission: EndpointContract<
    { readonly path: AgentDocumentPath; readonly body: AgentSubmissionRequest },
    SubmissionReceipt
  >;
  readonly getSubmission: EndpointContract<
    { readonly path: SubmissionPath },
    SubmissionReceipt
  >;
}