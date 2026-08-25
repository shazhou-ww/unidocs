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
  DocCreateResponse,
  DocExportRequest,
  DocExportResponse,
  DocHistoryRequest,
  DocHistoryResponse,
  DocInitFromHashRequest,
  DocInitFromHashResponse,
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
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface GatewayDocumentDirectoryQuery {
  list(tenantId: string, docType: string): Promise<GatewayDocumentRecord[]>;
  snapshots(docType: string, docId: string): Promise<SnapshotRef[]>;
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
export type GatewayCreateDocumentResponse = DocCreateResponse;

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
export type GatewayInitFromHashResponse = DocInitFromHashResponse;

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

export type GatewayDocumentOperation =
  | "listDocuments"
  | "createDocument"
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