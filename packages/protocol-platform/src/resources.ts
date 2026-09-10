/**
 * Authoritative persisted resource shapes for documents, versions, pings,
 * pongs, and thread query results.
 */
import type {
  DocumentContentFormatVersion,
  DocumentLocationContentType,
  DocumentSnapshotContentType,
  SValue,
  SValueSchema,
} from "@unidocs/protocol";
import type {
  DocumentContractIdx,
  DocumentId,
  DocumentLocation,
  DocumentType,
  IsoDateTime,
  MessageContent,
  PingIdx,
  PongIdx,
  SubmissionId,
  ThreadId,
  VersionIdx,
} from "./common.js";

export interface DocumentContractRecord<TDocumentType extends DocumentType = DocumentType> {
  readonly documentType: TDocumentType;
  readonly documentContractIdx: DocumentContractIdx;
  readonly formatVersion: typeof DocumentContentFormatVersion;
  readonly snapshot: {
    readonly contentType: DocumentSnapshotContentType<TDocumentType>;
    readonly schema: SValueSchema;
    readonly schemaHash: string;
  };
  /** Validates the locationType and payload projection of DocumentLocation. */
  readonly location: {
    readonly contentType: DocumentLocationContentType<TDocumentType>;
    readonly schema: SValueSchema;
    readonly schemaHash: string;
  };
  readonly contractHash: string;
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
  readonly documentContractIdx: DocumentContractIdx;
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