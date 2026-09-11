/**
 * PlatformEndpointContracts 的 13 个 operation 变成可调用方法。
 * 路径模板来自 protocol-platform/src/platform.ts 顶部注释。
 */
import type {
  AppendPingRequest,
  CasCapabilityGrant,
  CreateDocumentRequest,
  CreateThreadRequest,
  DocumentContractIdx,
  DocumentContractRecord,
  DocumentId,
  DocumentRecord,
  DocumentType,
  ListDocumentsQuery,
  ListDocumentsResponse,
  ListPublicDocumentTypesResponse,
  ListThreadsQuery,
  ListThreadsResponse,
  ListVersionsResponse,
  MoveCurrentVersionRequest,
  PageQuery,
  PingRecord,
  TenantId,
  ThreadDetail,
  ThreadId,
  VersionIdx,
  VersionRecord,
} from "@unidocs/protocol-platform";
import { toPlatformError } from "./errors.js";
import type { PlatformRequest, PlatformTransport, QueryValue } from "./transport.js";

export interface TenantPortalClient {
  listPublicDocumentTypes(query?: PageQuery): Promise<ListPublicDocumentTypesResponse>;
  getDocumentContract(documentType: DocumentType, idx: DocumentContractIdx): Promise<DocumentContractRecord>;
  listDocuments(query?: ListDocumentsQuery): Promise<ListDocumentsResponse>;
  createDocument(body: CreateDocumentRequest): Promise<DocumentRecord>;
  getDocument(documentId: DocumentId): Promise<DocumentRecord>;
  listVersions(documentId: DocumentId, query?: PageQuery): Promise<ListVersionsResponse>;
  getVersion(documentId: DocumentId, versionIdx: VersionIdx): Promise<VersionRecord>;
  moveCurrentVersion(documentId: DocumentId, body: MoveCurrentVersionRequest): Promise<DocumentRecord>;
  listThreads(documentId: DocumentId, query?: ListThreadsQuery): Promise<ListThreadsResponse>;
  createThread(documentId: DocumentId, idempotencyKey: string, body: CreateThreadRequest): Promise<ThreadDetail>;
  getThread(documentId: DocumentId, threadId: ThreadId): Promise<ThreadDetail>;
  appendPing(
    documentId: DocumentId,
    threadId: ThreadId,
    idempotencyKey: string,
    body: AppendPingRequest,
  ): Promise<PingRecord>;
  issueCasCapability(): Promise<CasCapabilityGrant>;
}

export function createTenantPortalClient(options: {
  tenantId: TenantId;
  transport: PlatformTransport;
}): TenantPortalClient {
  const { tenantId, transport } = options;
  const base = `/api/v1/tenants/${encodeURIComponent(tenantId)}`;
  const seg = (value: string | number): string => encodeURIComponent(String(value));

  async function send<T>(request: PlatformRequest): Promise<T> {
    const response = await transport(request);
    if (!response.ok) throw toPlatformError(response.error);
    return response.data as T;
  }

  const get = <T>(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<T> =>
    send<T>(query === undefined ? { method: "GET", path } : { method: "GET", path, query });

  const post = <T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> =>
    send<T>(idempotencyKey === undefined
      ? { method: "POST", path, body }
      : { method: "POST", path, body, idempotencyKey });

  const doc = (documentId: DocumentId): string => `${base}/documents/${seg(documentId)}`;

  return {
    listPublicDocumentTypes: (query = {}) =>
      get(`${base}/document-types`, { cursor: query.cursor, limit: query.limit }),

    getDocumentContract: (documentType, idx) =>
      get(`${base}/document-types/${seg(documentType)}/contracts/${seg(idx)}`),

    listDocuments: (query = {}) =>
      get(`${base}/documents`, {
        documentType: query.documentType,
        cursor: query.cursor,
        limit: query.limit,
      }),

    createDocument: (body) => post(`${base}/documents`, body),
    getDocument: (documentId) => get(doc(documentId)),

    listVersions: (documentId, query = {}) =>
      get(`${doc(documentId)}/versions`, { cursor: query.cursor, limit: query.limit }),

    getVersion: (documentId, versionIdx) => get(`${doc(documentId)}/versions/${seg(versionIdx)}`),
    moveCurrentVersion: (documentId, body) => post(`${doc(documentId)}/current-version`, body),

    listThreads: (documentId, query = {}) =>
      get(`${doc(documentId)}/threads`, {
        open: query.open,
        versionIdx: query.versionIdx,
        cursor: query.cursor,
        limit: query.limit,
      }),

    createThread: (documentId, idempotencyKey, body) =>
      post(`${doc(documentId)}/threads`, body, idempotencyKey),

    getThread: (documentId, threadId) => get(`${doc(documentId)}/threads/${seg(threadId)}`),

    appendPing: (documentId, threadId, idempotencyKey, body) =>
      post(`${doc(documentId)}/threads/${seg(threadId)}/pings`, body, idempotencyKey),

    issueCasCapability: () => post(`${base}/cas-capabilities`, {}),
  };
}
