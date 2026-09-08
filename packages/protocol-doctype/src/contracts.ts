import type { SBlob, SValue, SValueType } from "@unidocs/protocol";
import { SValueContentType } from "@unidocs/protocol";

export const DoctypeProtocol = "unidocs-doctype/2-draft";
export const HmacAlgorithm = "HMAC-SHA-256";
export type ServiceRole = "editor" | "operator";

export interface PlatformRequestAuthentication<TRole extends ServiceRole = ServiceRole> {
  readonly protocol: typeof DoctypeProtocol;
  readonly algorithm: typeof HmacAlgorithm;
  readonly keyId: string;
  readonly platformId: string;
  readonly environment: string;
  readonly serviceId: string;
  readonly role: TRole;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly signature: string;
}

export interface ServiceRequest<TBody, TRole extends ServiceRole> {
  readonly headers: {
    readonly contentType: typeof SValueContentType;
    readonly authentication: PlatformRequestAuthentication<TRole>;
    readonly casAuthorization: string | null;
  };
  readonly body: SValueType<TBody>;
}

export interface Invocation {
  readonly requestId: string;
  readonly actorId: string;
  readonly tenantId: string;
  readonly docId: string;
  readonly docType: string;
}

export interface ChangeSet<TOp = SValue> {
  readonly operations: readonly SValueType<TOp>[];
}

export interface StateSource<TOp = SValue> {
  readonly schemaVersion: string;
  readonly base: SBlob | null;
  readonly changes: readonly ChangeSet<TOp>[];
}

export interface EditorContext {
  readonly contextId: string;
  readonly sequence: number;
}

export const ServiceErrorCodes = [
  "invalid_request", "unauthorized", "forbidden", "replay_detected",
  "unsupported_schema", "unsupported_format", "context_lost",
  "sequence_conflict", "operation_rejected", "resource_unavailable",
  "operator_busy", "operator_session_lost", "limit_exceeded", "unavailable", "internal_error",
] as const;
export type ServiceErrorCode = typeof ServiceErrorCodes[number];

export interface ServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
}

export type ServiceResult<T> =
  | { readonly success: true; readonly data: SValueType<T> }
  | { readonly success: false; readonly error: ServiceError };

export interface ServiceResponse<T> {
  readonly contentType: typeof SValueContentType;
  readonly body: ServiceResult<T>;
}

export interface Endpoint<TRequest, TResult> {
  readonly request: TRequest;
  readonly response: ServiceResponse<TResult>;
}

export type EditorInitRequest<TOp = SValue> = ServiceRequest<{
  readonly invocation: Invocation;
  readonly source: StateSource<TOp>;
}, "editor">;

export type EditorImportRequest = ServiceRequest<{
  readonly invocation: Invocation;
  readonly schemaVersion: string;
  readonly file: SBlob;
  readonly format: string;
}, "editor">;

export type EditorQueryRequest<TQuery = SValue> = ServiceRequest<{
  readonly invocation: Invocation;
  readonly context: EditorContext;
  readonly query: SValueType<TQuery>;
}, "editor">;

export type EditorApplyRequest<TOp = SValue> = ServiceRequest<{
  readonly invocation: Invocation;
  readonly context: EditorContext;
  readonly changeSet: ChangeSet<TOp>;
}, "editor">;

export type EditorSnapshotRequest = ServiceRequest<{
  readonly invocation: Invocation;
  readonly context: EditorContext;
}, "editor">;

export type EditorExportRequest<TOp = SValue> = ServiceRequest<{
  readonly invocation: Invocation;
  readonly source: StateSource<TOp>;
  readonly format: string;
}, "editor">;

export type EditorSummaryRequest<TOp = SValue> = ServiceRequest<{
  readonly invocation: Invocation;
  readonly source: StateSource<TOp>;
  readonly options: { readonly maxExcerptLength: number };
}, "editor">;

export interface ExportedFile {
  readonly file: SBlob;
  readonly mediaType: string;
  readonly filename: string;
}

export interface DocumentSummary {
  readonly suggestedTitle: string;
  readonly excerpt: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
  readonly thumbnail: {
    readonly blob: SBlob;
    readonly mediaType: string;
    readonly width: number;
    readonly height: number;
  } | null;
}

export interface EditorEndpointContracts<TDoc = SValue, TQuery = SValue, TOp = SValue> {
  readonly init: Endpoint<EditorInitRequest<TOp>, EditorContext>;
  readonly import: Endpoint<EditorImportRequest, EditorContext>;
  readonly query: Endpoint<EditorQueryRequest<TQuery>, SValue>;
  readonly apply: Endpoint<EditorApplyRequest<TOp>, EditorContext>;
  readonly snapshot: Endpoint<EditorSnapshotRequest, TDoc>;
  readonly export: Endpoint<EditorExportRequest<TOp>, ExportedFile>;
  readonly summary: Endpoint<EditorSummaryRequest<TOp>, DocumentSummary>;
}

export interface OperatorSession {
  readonly operatorSessionId: string;
  readonly generation: number;
}

export type OperatorRunRequest = ServiceRequest<{
  readonly invocation: Invocation;
  readonly session: OperatorSession;
  readonly taskId: string;
  readonly instruction: string;
}, "operator"> & {
  readonly headers: {
    readonly platformAuthorization: string;
  };
};

export interface OperatorRunResult {
  readonly taskId: string;
  readonly session: OperatorSession;
  readonly response: string;
  readonly iterations: number;
}

export type OperatorResetRequest = ServiceRequest<{
  readonly invocation: Invocation;
  readonly session: OperatorSession;
}, "operator">;

export interface OperatorEndpointContracts {
  readonly run: Endpoint<OperatorRunRequest, OperatorRunResult>;
  readonly reset: Endpoint<OperatorResetRequest, OperatorSession>;
}