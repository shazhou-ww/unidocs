/**
 * Shared wire primitives, identifiers, pagination, CAS references, locations,
 * message content, and stable error codes used across all Platform contracts.
 * `EndpointContract` gives every HTTP operation one request and response type.
 */
import type { JsonValue } from "@unidocs/protocol";

export type TenantId = string;
export type DocumentId = string;
export type DocumentType = string;
/** Document-type-scoped, monotonically increasing snapshot contract revision. */
export type SnapshotContractIdx = number;
/** Document-scoped, monotonically increasing version record ID. */
export type VersionIdx = number;
export type ThreadId = string;
/** Thread-scoped, monotonically increasing ping record ID. */
export type PingIdx = number;
/** Thread-scoped, monotonically increasing pong record ID. */
export type PongIdx = number;
export type SubmissionId = string;
export type ViewBundleId = string;
export type TypeCardBundleId = string;
export type TypeCardIconRasterSize = 16 | 32 | 64 | 128 | 256;
export type OperatorCandidateId = string;
export type ValidationId = string;
export type Cursor = string;
export type IsoDateTime = string;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: Cursor | null;
}

export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: JsonValue;
  };
}

export interface EndpointContract<TRequest, TResponse> {
  readonly request: TRequest;
  readonly response: TResponse | ApiError;
}

/** Logical blob identity and metadata. */
export interface CasBlobRef {
  readonly blobHash: string;
  readonly size: number;
  readonly contentType: string;
}

/** A position relative to a version supplied by the owning record or context. */
export interface DocumentLocation {
  readonly locationType: string;
  readonly payload: JsonValue;
}

export interface MessageContent {
  readonly text: string | null;
  readonly richContent: CasBlobRef | null;
  readonly attachments: readonly CasBlobRef[];
}

export type PlatformErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "document_type_disabled"
  | "unsupported_content_type"
  | "unsupported_location_type"
  | "upload_expired"
  | "bundle_invalid"
  | "operator_validation_required"
  | "snapshot_contract_conflict"
  | "revision_conflict"
  | "version_conflict"
  | "pong_watermark_conflict"
  | "idempotency_conflict"
  | "content_unavailable"
  | "limit_exceeded"
  | "unavailable";