/**
 * Agent data-plane contracts for OAuth scopes, optimistic concurrency,
 * atomic version-and-pong submissions, conflicts, and durable receipts.
 *
 * - `POST /api/v1/tenants/{tenantId}/documents/{documentId}/submissions`:
 *   atomically validate locks, create an optional version, append pongs, and persist a receipt.
 * - `GET /api/v1/tenants/{tenantId}/documents/{documentId}/submissions/{submissionId}`:
 *   recover the durable receipt after timeout or retry without repeating work.
 *
 * Agents use the read and CAS endpoints from `PlatformEndpointContracts`.
 */
import type { SValue } from "@unidocs/protocol";
import type {
  DocumentLocation,
  DocumentId,
  EndpointContract,
  IsoDateTime,
  MessageContent,
  PingIdx,
  SnapshotContractIdx,
  SubmissionId,
  ThreadId,
  TenantId,
  VersionIdx,
} from "./common.js";
import type { PongRecord, VersionRecord } from "./resources.js";

export type AgentScope =
  | "documents:read"
  | "cas:read"
  | "cas:lease"
  | "comments:read"
  | "comments:pong"
  | "versions:submit";

export interface AgentThreadUpdate {
  readonly threadId: ThreadId;
  readonly observedAcknowledgedPingIdx: PingIdx | null;
  readonly respondThroughPingIdx: PingIdx;
  readonly content: MessageContent;
  /** Relative to newSnapshot; must be empty when newSnapshot is omitted. */
  readonly resultLocations: readonly DocumentLocation[];
}

export interface AgentSubmissionRequest {
  readonly submissionId: SubmissionId;
  readonly observedCurrentVersionIdx?: VersionIdx | null;
  /** Required with newSnapshot and must equal the document type's latest revision. */
  readonly newSnapshotContractIdx?: SnapshotContractIdx;
  readonly newSnapshot?: SValue;
  readonly threadUpdates: readonly AgentThreadUpdate[];
}

export interface SubmissionConflict {
  readonly currentVersionIdx: VersionIdx | null;
  readonly latestSnapshotContractIdx: SnapshotContractIdx;
  readonly threads: readonly {
    readonly threadId: ThreadId;
    readonly acknowledgedPingIdx: PingIdx | null;
    readonly latestPingIdx: PingIdx;
  }[];
}

export type SubmissionReceipt =
  | {
    readonly submissionId: SubmissionId;
    readonly state: "committed";
    readonly version: VersionRecord | null;
    readonly pongs: readonly PongRecord[];
    readonly committedAt: IsoDateTime;
  }
  | {
    readonly submissionId: SubmissionId;
    readonly state: "rejected";
    readonly reason:
      | "version_conflict"
      | "snapshot_contract_conflict"
      | "pong_watermark_conflict";
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