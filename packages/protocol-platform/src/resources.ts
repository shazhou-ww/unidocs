/**
 * Authoritative persisted resource shapes for documents, versions, pings,
 * pongs, and thread query results.
 */
import type {
  DocumentContentFormatVersion,
  DocumentLocationContentType,
  DocumentSnapshotContentType,
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

/** One comment provenance edge recorded by the version that responded to it. */
export interface AddressedPing {
  readonly threadId: ThreadId;
  readonly pingIdx: PingIdx;
  readonly baseVersionIdx: VersionIdx;
}

/**
 * Version metadata. The snapshot is not part of this record: an SValue carries
 * atomic SBlob references that have no JSON representation, so it crosses the
 * wire separately as canonical SValue CBOR.
 *
 * `parentVersionIdx` is the base parent forest; `addressedPings` is comment
 * provenance. They are different graphs and neither substitutes for the other.
 */
export interface VersionRecord {
  readonly versionIdx: VersionIdx;
  readonly parentVersionIdx: VersionIdx | null;
  readonly documentContractIdx: DocumentContractIdx;
  readonly authorAgentId: string;
  readonly submissionId: SubmissionId;
  /** Pings this version responded to; empty for the first version. */
  readonly addressedPings: readonly AddressedPing[];
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