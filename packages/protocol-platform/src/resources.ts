/**
 * Authoritative persisted resource shapes for documents, versions, pings,
 * pongs, and thread query results.
 */
import type { SValue, SValueSchema } from "@unidocs/protocol";
import type {
  DocumentId,
  DocumentLocation,
  DocumentType,
  IsoDateTime,
  MessageContent,
  PingIdx,
  PongIdx,
  SnapshotContractIdx,
  SubmissionId,
  ThreadId,
  VersionIdx,
} from "./common.js";

export interface SnapshotContractRecord {
  readonly snapshotContractIdx: SnapshotContractIdx;
  readonly contentType: string;
  readonly schema: SValueSchema;
  readonly schemaHash: string;
  readonly createdAt: IsoDateTime;
}

export interface DocumentRecord {
  readonly documentId: DocumentId;
  readonly name: string;
  readonly documentType: DocumentType;
  readonly currentVersionIdx: VersionIdx | null;
  readonly createdAt: IsoDateTime;
}

export interface VersionRecord {
  readonly versionIdx: VersionIdx;
  readonly parentVersionIdx: VersionIdx | null;
  readonly snapshotContractIdx: SnapshotContractIdx;
  /** Logical document state; large binary values are represented by SBlob. */
  readonly snapshot: SValue;
  readonly authorAgentId: string;
  readonly createdAt: IsoDateTime;
}

export interface PingRecord {
  readonly pingIdx: PingIdx;
  readonly baseVersionIdx: VersionIdx;
  readonly content: MessageContent;
  readonly location: DocumentLocation | null;
  readonly authorId: string;
  readonly createdAt: IsoDateTime;
}

export interface PongRecord {
  readonly pongIdx: PongIdx;
  readonly respondThroughPingIdx: PingIdx;
  readonly content: MessageContent;
  /** Relative to the new version created by this pong's submission. */
  readonly resultLocations: readonly DocumentLocation[];
  readonly authorAgentId: string;
  readonly submissionId: SubmissionId;
  readonly createdAt: IsoDateTime;
}

export interface ThreadRef {
  readonly threadId: ThreadId;
}

export interface ThreadDetail {
  readonly threadId: ThreadId;
  readonly pings: readonly PingRecord[];
  readonly pongs: readonly PongRecord[];
}