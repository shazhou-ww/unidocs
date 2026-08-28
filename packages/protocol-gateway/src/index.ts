import type { SValue } from "@unidocs/protocol";
import type {
  CasGcResult,
  CasLeaseResult,
  CasNodeMetadata,
  CasUsage,
} from "@unicas/protocol";
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

export interface GatewayCasTenantPath { readonly tenantId: string }
export interface GatewayCasNodePath extends GatewayCasTenantPath { readonly hash: string }
export interface GatewayCasReadContentRequest { readonly path: GatewayCasNodePath }
export type GatewayCasReadContentResponse =
  | { body: ReadableStream<Uint8Array>; headers: { contentType: string; contentLength: number } }
  | GatewayErrorResponse;
export interface GatewayCasReadMetadataRequest { readonly path: GatewayCasNodePath }
export type GatewayCasReadMetadataResponse =
  | { metadata: CasNodeMetadata }
  | GatewayErrorResponse;
export interface GatewayCasLeaseRequest { readonly path: GatewayCasNodePath }
export type GatewayCasLeaseResponse = CasLeaseResult | GatewayErrorResponse;
export interface GatewayCasUsageRequest { readonly path: GatewayCasTenantPath }
export type GatewayCasUsageResponse = CasUsage | GatewayErrorResponse;
export interface GatewayCasGcRequest { readonly path: GatewayCasTenantPath }
export type GatewayCasGcResponse = CasGcResult | GatewayErrorResponse;

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
  casLease: {
    request: GatewayCasLeaseRequest;
    response: GatewayCasLeaseResponse;
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
  | { kind: "cas"; route: GatewayCasRoute };

export type GatewayCasRoute =
  | { operation: "readContent"; tenantId: string; hash: string }
  | { operation: "readMetadata"; tenantId: string; hash: string }
  | { operation: "lease"; tenantId: string; hash: string }
  | { operation: "usage"; tenantId: string }
  | { operation: "gc"; tenantId: string };

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

export const gatewayCasRoutes = {
  readContent: ({ tenantId, hash }: GatewayCasNodePath) =>
    `/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/content`,
  readMetadata: ({ tenantId, hash }: GatewayCasNodePath) =>
    `/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/metadata`,
  lease: ({ tenantId, hash }: GatewayCasNodePath) =>
    `/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/lease`,
  usage: ({ tenantId }: GatewayCasTenantPath) => `/tenants/${segment(tenantId)}/cas/usage`,
  gc: ({ tenantId }: GatewayCasTenantPath) => `/tenants/${segment(tenantId)}/cas/gc`,
} as const;

function matchGatewayCasRoute(method: string, pathname: string): GatewayCasRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "tenants" || !parts[1] || parts[2] !== "cas") return null;
  const tenantId = decodeSegment(parts[1]);
  if (tenantId === null) return null;
  if (parts.length === 4 && parts[3] === "usage" && method === "GET") return { operation: "usage", tenantId };
  if (parts.length === 4 && parts[3] === "gc" && method === "POST") return { operation: "gc", tenantId };
  if (parts.length !== 6 || parts[3] !== "nodes" || !parts[4]) return null;
  const hash = decodeSegment(parts[4]);
  if (hash === null) return null;
  if (parts[5] === "content" && method === "GET") return { operation: "readContent", tenantId, hash };
  if (parts[5] === "metadata" && method === "GET") return { operation: "readMetadata", tenantId, hash };
  if (parts[5] === "lease" && method === "POST") return { operation: "lease", tenantId, hash };
  return null;
}

/**
 * Gateway-owned CAS exposure allowlist. Operates on a matched tenant route —
 * the Gateway decides which CAS operations it exposes, and that decision is
 * not a CAS route property (the canonical `@unicas/protocol` matcher has
 * no exposure concept). Root Refs writes and all CAS audit operations are
 * excluded: `updateRootRefs`/`rootRefs` are private service operations, and
 * audit routes live under `/admin` which the tenant matcher never recognizes.
 */
export function isGatewayExposedCasRoute(_route: GatewayCasRoute): boolean {
  return true;
}

export function matchGatewayRoute(method: string, pathname: string): GatewayRoute | null {
  const casRoute = matchGatewayCasRoute(method, pathname);
  if (casRoute !== null) return { kind: "cas", route: casRoute };

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