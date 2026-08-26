import type { SValue } from "@unidocs/protocol";
import { isPublicCasRoute, matchCasRoute } from "@unidocs/protocol-cas";
import type {
  CasGcRequest,
  CasGcResponse,
  CasLeaseExistingRequest,
  CasLeaseExistingResponse,
  CasLeaseNodeRequest,
  CasLeaseNodeResponse,
  CasReadContentRequest,
  CasReadContentResponse,
  CasReadMetadataRequest,
  CasReadMetadataResponse,
  CasRoute,
  CasUsageRequest,
  CasUsageResponse,
} from "@unidocs/protocol-cas";
import type {
  DocApplyRequest,
  DocApplyResponse,
  DocCreateRequest,
  DocExportRequest,
  DocExportResponse,
  DocHistoryRequest,
  DocHistoryResponse,
  DocInitFromHashRequest,
  DocIrResponse,
  DocQueryRequest,
  DocQueryResponse,
  DocResetOperatorResponse,
  DocRollbackRequest,
  DocRollbackResponse,
  DocRunOperatorRequest,
  DocRunOperatorResponse,
  DocSnapshotResponse,
  SnapshotRef,
} from "@unidocs/protocol-doc";

export interface GatewayDocumentRecord {
  tenantId: string;
  docId: string;
  docType: string;
  serviceId: string;
  sessionId: string;
  idempotencyKey: string;
  requestedDocId: string | null;
  state: GatewayDocumentState;
  version: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type GatewayDocumentState = "creating" | "ready" | "failed";

export interface GatewayDocumentDirectoryQuery {
  list(tenantId: string, docType: string): Promise<GatewayDocumentRecord[]>;
  snapshots(tenantId: string, docType: string, docId: string): Promise<SnapshotRef[]>;
}

export interface GatewayDocumentCollectionPath {
  tenantId: string;
  docType: string;
}

export interface GatewayDocumentPath extends GatewayDocumentCollectionPath {
  docId: string;
}

export interface GatewayErrorResponse {
  error: string;
}

export interface GatewayListDocumentsRequest {
  path: GatewayDocumentCollectionPath;
}

export type GatewayListDocumentsResponse =
  | {
    success: true;
    data: Array<{
      doc_id: string;
      doc_type: string;
      owner_id: string;
      version: number;
      created_at: number;
      updated_at: number;
    }>;
    count: number;
  }
  | GatewayErrorResponse;

export interface GatewayCreateDocumentRequest {
  path: GatewayDocumentCollectionPath;
  form?: DocCreateRequest["form"];
}
export type GatewayCreateDocumentResponse =
  | {
    success: true;
    docId: string;
    state: "creating" | "ready";
    version?: number;
  }
  | {
    success: false;
    docId: string;
    state: "failed";
    error: string | null;
  }
  | GatewayErrorResponse;

export interface GatewayStatusDocumentRequest {
  path: GatewayDocumentPath;
}

export type GatewayStatusDocumentResponse =
  | {
    success: true;
    data: {
      doc_id: string;
      doc_type: string;
      state: GatewayDocumentState;
      version: number | null;
      created_at: number;
      updated_at: number;
    };
  }
  | GatewayErrorResponse;

export interface GatewayQueryDocumentRequest<TQuery extends SValue = SValue> {
  path: GatewayDocumentPath;
  headers: DocQueryRequest<TQuery>["headers"];
  body: DocQueryRequest<TQuery>["body"];
}
export type GatewayQueryDocumentResponse = DocQueryResponse;

export interface GatewayApplyDocumentRequest<TOp extends SValue = SValue> {
  path: GatewayDocumentPath;
  body: DocApplyRequest<TOp>["body"];
}
export type GatewayApplyDocumentResponse = DocApplyResponse;

export interface GatewayExportDocumentRequest {
  path: GatewayDocumentPath;
  query: DocExportRequest["query"];
}
export type GatewayExportDocumentResponse = DocExportResponse;

export interface GatewayHistoryDocumentRequest {
  path: GatewayDocumentPath;
  headers: DocHistoryRequest["headers"];
  query: DocHistoryRequest["query"];
}
export type GatewayHistoryDocumentResponse<TOp extends SValue = SValue> =
  DocHistoryResponse<TOp>;

export interface GatewayRollbackDocumentRequest {
  path: GatewayDocumentPath;
  body: DocRollbackRequest["body"];
}
export type GatewayRollbackDocumentResponse = DocRollbackResponse;

export interface GatewaySnapshotDocumentRequest { path: GatewayDocumentPath }
export type GatewaySnapshotDocumentResponse = DocSnapshotResponse;
export interface GatewayIrDocumentRequest { path: GatewayDocumentPath }
export type GatewayIrDocumentResponse = DocIrResponse;

export interface GatewayInitFromHashRequest {
  path: GatewayDocumentPath;
  body: DocInitFromHashRequest["body"];
}
export type GatewayInitFromHashResponse =
  | { success: true; docId: string; version: number }
  | GatewayErrorResponse;

export interface GatewayRunOperatorRequest {
  path: GatewayDocumentPath;
  body: DocRunOperatorRequest["body"];
}
export type GatewayRunOperatorResponse = DocRunOperatorResponse;
export interface GatewayResetOperatorRequest { path: GatewayDocumentPath }
export type GatewayResetOperatorResponse = DocResetOperatorResponse;

export type GatewayCasReadContentRequest = CasReadContentRequest;
export type GatewayCasReadContentResponse = CasReadContentResponse;
export type GatewayCasReadMetadataRequest = CasReadMetadataRequest;
export type GatewayCasReadMetadataResponse = CasReadMetadataResponse;
export type GatewayCasLeaseNodeRequest = CasLeaseNodeRequest;
export type GatewayCasLeaseNodeResponse = CasLeaseNodeResponse;
export type GatewayCasLeaseExistingRequest = CasLeaseExistingRequest;
export type GatewayCasLeaseExistingResponse = CasLeaseExistingResponse;
export type GatewayCasUsageRequest = CasUsageRequest;
export type GatewayCasUsageResponse = CasUsageResponse;
export type GatewayCasGcRequest = CasGcRequest;
export type GatewayCasGcResponse = CasGcResponse;

export interface GatewayEndpointContracts {
  listDocuments: {
    request: GatewayListDocumentsRequest;
    response: GatewayListDocumentsResponse;
  };
  createDocument: {
    request: GatewayCreateDocumentRequest;
    response: GatewayCreateDocumentResponse;
  };
  statusDocument: {
    request: GatewayStatusDocumentRequest;
    response: GatewayStatusDocumentResponse;
  };
  queryDocument: {
    request: GatewayQueryDocumentRequest;
    response: GatewayQueryDocumentResponse;
  };
  applyDocument: {
    request: GatewayApplyDocumentRequest;
    response: GatewayApplyDocumentResponse;
  };
  exportDocument: {
    request: GatewayExportDocumentRequest;
    response: GatewayExportDocumentResponse;
  };
  historyDocument: {
    request: GatewayHistoryDocumentRequest;
    response: GatewayHistoryDocumentResponse;
  };
  rollbackDocument: {
    request: GatewayRollbackDocumentRequest;
    response: GatewayRollbackDocumentResponse;
  };
  snapshotDocument: {
    request: GatewaySnapshotDocumentRequest;
    response: GatewaySnapshotDocumentResponse;
  };
  irDocument: {
    request: GatewayIrDocumentRequest;
    response: GatewayIrDocumentResponse;
  };
  initFromHash: {
    request: GatewayInitFromHashRequest;
    response: GatewayInitFromHashResponse;
  };
  runOperator: {
    request: GatewayRunOperatorRequest;
    response: GatewayRunOperatorResponse;
  };
  resetOperator: {
    request: GatewayResetOperatorRequest;
    response: GatewayResetOperatorResponse;
  };
  casReadContent: {
    request: GatewayCasReadContentRequest;
    response: GatewayCasReadContentResponse;
  };
  casReadMetadata: {
    request: GatewayCasReadMetadataRequest;
    response: GatewayCasReadMetadataResponse;
  };
  casLeaseNode: {
    request: GatewayCasLeaseNodeRequest;
    response: GatewayCasLeaseNodeResponse;
  };
  casLeaseExisting: {
    request: GatewayCasLeaseExistingRequest;
    response: GatewayCasLeaseExistingResponse;
  };
  casUsage: { request: GatewayCasUsageRequest; response: GatewayCasUsageResponse };
  casGc: { request: GatewayCasGcRequest; response: GatewayCasGcResponse };
}

export type GatewayDocumentOperation =
  | "listDocuments"
  | "createDocument"
  | "statusDocument"
  | "queryDocument"
  | "applyDocument"
  | "exportDocument"
  | "historyDocument"
  | "rollbackDocument"
  | "snapshotDocument"
  | "irDocument"
  | "initFromHash"
  | "runOperator"
  | "resetOperator";

export type GatewayDocumentRoute = {
  kind: "document";
  operation: GatewayDocumentOperation;
  tenantId: string;
  docType: string;
  docId?: string;
};

export type GatewayRoute =
  | GatewayDocumentRoute
  | { kind: "cas"; route: CasRoute };

const documentOperations = {
  query: { method: "POST", operation: "queryDocument" },
  apply: { method: "POST", operation: "applyDocument" },
  export: { method: "GET", operation: "exportDocument" },
  history: { method: "GET", operation: "historyDocument" },
  rollback: { method: "POST", operation: "rollbackDocument" },
  snapshot: { method: "GET", operation: "snapshotDocument" },
  ir: { method: "GET", operation: "irDocument" },
  init_from_hash: { method: "POST", operation: "initFromHash" },
  run: { method: "POST", operation: "runOperator" },
  reset: { method: "POST", operation: "resetOperator" },
} as const;

function segment(value: string): string {
  return encodeURIComponent(value);
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function collectionPath(path: GatewayDocumentCollectionPath): string {
  return `/tenants/${segment(path.tenantId)}/docs/${segment(path.docType)}/`;
}

function documentPath(path: GatewayDocumentPath): string {
  return `${collectionPath(path)}${segment(path.docId)}`;
}

export const gatewayRoutes = {
  listDocuments: collectionPath,
  createDocument: collectionPath,
  statusDocument: documentPath,
  queryDocument: (path: GatewayDocumentPath) => `${documentPath(path)}/query`,
  applyDocument: (path: GatewayDocumentPath) => `${documentPath(path)}/apply`,
  exportDocument: (path: GatewayDocumentPath) => `${documentPath(path)}/export`,
  historyDocument: (path: GatewayDocumentPath) => `${documentPath(path)}/history`,
  rollbackDocument: (path: GatewayDocumentPath) => `${documentPath(path)}/rollback`,
  snapshotDocument: (path: GatewayDocumentPath) => `${documentPath(path)}/snapshot`,
  irDocument: (path: GatewayDocumentPath) => `${documentPath(path)}/ir`,
  initFromHash: (path: GatewayDocumentPath) => `${documentPath(path)}/init_from_hash`,
  runOperator: (path: GatewayDocumentPath) => `${documentPath(path)}/run`,
  resetOperator: (path: GatewayDocumentPath) => `${documentPath(path)}/reset`,
} as const;

export function isLegacyPublicCasRoute(method: string, pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "users" || parts[2] !== "cas") return false;

  if (parts.length === 4 && parts[3] === "usage") return method === "GET";
  if (parts.length === 5 && parts[3] === "nodes") return method === "POST";
  if (parts.length === 6 && parts[3] === "nodes") {
    if (parts[5] === "content" || parts[5] === "metadata") return method === "GET";
    if (parts[5] === "lease") return method === "POST";
  }
  return false;
}

export function matchGatewayRoute(method: string, pathname: string): GatewayRoute | null {
  if (isPublicCasRoute(method, pathname)) {
    const route = matchCasRoute(method, pathname);
    return route ? { kind: "cas", route } : null;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "tenants" || parts[2] !== "docs") return null;
  const tenantId = decodeSegment(parts[1]);
  const docType = decodeSegment(parts[3]);
  if (tenantId === null || docType === null) return null;

  if (parts.length === 4) {
    if (method === "GET") {
      return { kind: "document", operation: "listDocuments", tenantId, docType };
    }
    if (method === "POST") {
      return { kind: "document", operation: "createDocument", tenantId, docType };
    }
    return null;
  }

  if (parts.length === 5 && parts[4] && method === "GET") {
    const docId = decodeSegment(parts[4]);
    return docId === null
      ? null
      : { kind: "document", operation: "statusDocument", tenantId, docType, docId };
  }

  if (parts.length !== 6 || !parts[4]) return null;
  const docId = decodeSegment(parts[4]);
  const route = documentOperations[parts[5] as keyof typeof documentOperations];
  if (docId === null || !route || route.method !== method) return null;
  return {
    kind: "document",
    operation: route.operation,
    tenantId,
    docType,
    docId,
  };
}