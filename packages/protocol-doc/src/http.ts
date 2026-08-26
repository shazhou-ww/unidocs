import { SValueContentType } from "@unidocs/protocol";
import type { SBlob, SValue } from "@unidocs/protocol";
import type { CasHash } from "@unicas/protocol";

export { SValueContentType };

export type HistoryEntry<TOp extends SValue = SValue> = {
  version: number;
  timestamp: string;
  description: string;
  operations: TOp[];
};

export interface ApplyResult<T = unknown> {
  success: boolean;
  version: number;
  data?: T;
  error?: string;
}

export interface RollbackResult {
  success: boolean;
  version: number;
  error?: string;
}

export interface CreateResult {
  success: boolean;
  sessionId: string;
  version: number;
  error?: string;
}

export interface SnapshotRef {
  version: number;
  hash: string;
}

export interface DocSessionPath {
  tenantId: string;
  sessionId: string;
}

export interface DocErrorResponse {
  success?: false;
  error: string;
  version?: number;
}

export type DocStructuredRequestBody<T extends SValue> =
  | { contentType: "application/json"; value: T }
  | { contentType: typeof SValueContentType; bytes: Uint8Array };

export type DocNegotiatedResponse<T extends SValue> =
  | { contentType: "application/json"; value: T }
  | { contentType: typeof SValueContentType; body: Uint8Array };

export interface DocCreateRequest {
  path: DocSessionPath;
  form?: { file?: File; format?: string };
}

export type DocCreateResponse = CreateResult | DocErrorResponse;

export interface DocQueryRequest<TQuery extends SValue = SValue> {
  path: DocSessionPath;
  headers: { accept?: string };
  body: DocStructuredRequestBody<TQuery>;
}

export type DocQueryResponse =
  | DocNegotiatedResponse<{ success: true; data: SValue; version: number }>
  | DocErrorResponse;

export interface DocApplyRequest<TOp extends SValue = SValue> {
  path: DocSessionPath;
  body: DocStructuredRequestBody<{
    operations: TOp[];
    description: string;
    baseVersion: number;
    opId?: string;
  }>;
}

export type DocApplyResponse = ApplyResult | DocErrorResponse;

export interface DocExportRequest {
  path: DocSessionPath;
  query: { format?: string };
}

export type DocExportResponse =
  | {
    body: Uint8Array;
    headers: { contentType: string; contentDisposition: string };
  }
  | DocErrorResponse;

export interface DocHistoryRequest {
  path: DocSessionPath;
  headers: { accept?: string };
  query: { from?: string; to?: string };
}

export type DocHistoryResponse<TOp extends SValue = SValue> =
  | DocNegotiatedResponse<{
    success: true;
    data: HistoryEntry<TOp>[];
    version: number;
  }>
  | DocErrorResponse;

export interface DocRollbackRequest {
  path: DocSessionPath;
  body: DocStructuredRequestBody<{ version: number }>;
}

export type DocRollbackResponse = RollbackResult | DocErrorResponse;

export interface DocSnapshotRequest {
  path: DocSessionPath;
}

export type DocSnapshotResponse =
  | {
    success: true;
    version: number;
    hash: CasHash;
    docType: string;
  }
  | DocErrorResponse;

export interface DocStatusRequest {
  path: DocSessionPath;
}

export type DocStatusResponse =
  | { exists: boolean; version: number }
  | DocErrorResponse;

export interface DocIrRequest {
  path: DocSessionPath;
}

export type DocIrResponse =
  | {
    body: Uint8Array;
    headers: { contentType: typeof SValueContentType; docVersion: number };
  }
  | DocErrorResponse;

export interface DocInitFromHashRequest {
  path: DocSessionPath;
  body: DocStructuredRequestBody<{ hash: CasHash; sourceVersion: number }>;
}

export type DocInitFromHashResponse = CreateResult | DocErrorResponse;

export interface DocRunOperatorRequest {
  path: DocSessionPath;
  body: { instruction: string };
}

export type DocRunOperatorResponse =
  | { success: true; data: { response: string; iterations: number } }
  | DocErrorResponse;

export interface DocResetOperatorRequest {
  path: DocSessionPath;
}

export type DocResetOperatorResponse = { success: true } | DocErrorResponse;

export interface DocResolveBlobRequest {
  headers: { accept?: string };
  body: DocStructuredRequestBody<{ hash: CasHash }>;
}

export type DocResolveBlobResponse =
  | DocNegotiatedResponse<{ blob: SBlob }>
  | DocErrorResponse;

export interface DocReadBlobRequest {
  body: DocStructuredRequestBody<{ blob: SBlob }>;
}

export type DocReadBlobResponse =
  | {
    body: Uint8Array;
    headers: { contentType: string; sblobHash: string };
  }
  | DocErrorResponse;

export interface DocEndpointContracts {
  create: { request: DocCreateRequest; response: DocCreateResponse };
  query: { request: DocQueryRequest; response: DocQueryResponse };
  apply: { request: DocApplyRequest; response: DocApplyResponse };
  export: { request: DocExportRequest; response: DocExportResponse };
  history: { request: DocHistoryRequest; response: DocHistoryResponse };
  rollback: { request: DocRollbackRequest; response: DocRollbackResponse };
  snapshot: { request: DocSnapshotRequest; response: DocSnapshotResponse };
  status: { request: DocStatusRequest; response: DocStatusResponse };
  ir: { request: DocIrRequest; response: DocIrResponse };
  initFromHash: { request: DocInitFromHashRequest; response: DocInitFromHashResponse };
  run: { request: DocRunOperatorRequest; response: DocRunOperatorResponse };
  reset: { request: DocResetOperatorRequest; response: DocResetOperatorResponse };
}

export interface DocPrivateEndpointContracts {
  resolveBlob: { request: DocResolveBlobRequest; response: DocResolveBlobResponse };
  readBlob: { request: DocReadBlobRequest; response: DocReadBlobResponse };
}