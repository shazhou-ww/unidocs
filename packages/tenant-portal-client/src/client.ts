/**
 * TenantApiContract 的 15 个 operation 中，14 个变成可调用方法（documents.listAudit /
 * listDocumentAuditEvents 除外，见 README 报告：新增的 operation，本轮未实现）。
 * 路径模板来自 protocol-tenant-portal/src/contract.ts 各 operation 的 .route({ path })。
 */
import type { SValue } from "@unidocs/protocol";
import {
  TenantApiV1BasePath,
  type AppendCommentRequest,
  type CasCapabilityGrant,
  type CommentRecord,
  type CreateDocumentRequest,
  type CreateThreadRequest,
  type DocumentContractRecord,
  type DocumentRecord,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type ListPublicDocumentTypesResponse,
  type ListThreadsQuery,
  type ListThreadsResponse,
  type ListVersionsResponse,
  type MoveCurrentVersionRequest,
  type PaginationQuery,
  type ThreadDetail,
  type VersionRecord,
} from "@unidocs/protocol-tenant-portal";
import { decodeSValue } from "@unidocs/svalue-codec";
import { toPlatformError } from "./errors.js";
import type { DocumentContractIdx, DocumentId, DocumentType, ThreadId, TenantId, VersionIdx } from "./ids.js";
import type { PlatformRequest, PlatformTransport, QueryValue } from "./transport.js";

export interface TenantPortalClient {
  listPublicDocumentTypes(query?: PaginationQuery): Promise<ListPublicDocumentTypesResponse>;
  getDocumentContract(documentType: DocumentType, idx: DocumentContractIdx): Promise<DocumentContractRecord>;
  listDocuments(query?: ListDocumentsQuery): Promise<ListDocumentsResponse>;
  createDocument(idempotencyKey: string, body: CreateDocumentRequest): Promise<DocumentRecord>;
  getDocument(documentId: DocumentId): Promise<DocumentRecord>;
  listVersions(documentId: DocumentId, query?: PaginationQuery): Promise<ListVersionsResponse>;
  getVersion(documentId: DocumentId, versionIdx: VersionIdx): Promise<VersionRecord>;
  /** snapshot 是独立操作，不是 getVersion 的一部分：解码后的 canonical SValue。 */
  getVersionSnapshot(documentId: DocumentId, versionIdx: VersionIdx): Promise<SValue>;
  moveCurrentVersion(documentId: DocumentId, body: MoveCurrentVersionRequest): Promise<DocumentRecord>;
  listThreads(documentId: DocumentId, query?: ListThreadsQuery): Promise<ListThreadsResponse>;
  createThread(documentId: DocumentId, idempotencyKey: string, body: CreateThreadRequest): Promise<ThreadDetail>;
  getThread(documentId: DocumentId, threadId: ThreadId): Promise<ThreadDetail>;
  appendComment(
    documentId: DocumentId,
    threadId: ThreadId,
    idempotencyKey: string,
    body: AppendCommentRequest,
  ): Promise<CommentRecord>;
  issueCasCapability(): Promise<CasCapabilityGrant>;
}

export function createTenantPortalClient(options: {
  tenantId: TenantId;
  transport: PlatformTransport;
}): TenantPortalClient {
  const { tenantId, transport } = options;
  const base = TenantApiV1BasePath.replace("{tenantId}", encodeURIComponent(tenantId));
  const seg = (value: string | number): string => encodeURIComponent(String(value));

  async function send<T>(request: PlatformRequest): Promise<T> {
    const response = await transport(request);
    if (!response.ok) throw toPlatformError(response.error);
    if ("bytes" in response) {
      throw new Error("transport returned bytes for a JSON operation");
    }
    return response.data as T;
  }

  async function sendBytes(request: PlatformRequest): Promise<Uint8Array> {
    const response = await transport({ ...request, accept: "cbor" });
    if (!response.ok) throw toPlatformError(response.error);
    if (!("bytes" in response)) {
      throw new Error("transport returned JSON for a bytes operation");
    }
    return response.bytes;
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
      get(`${base}/document-types/${seg(documentType)}/document-contracts/${seg(idx)}`),

    listDocuments: (query = {}) =>
      get(`${base}/documents`, {
        documentType: query.documentType,
        cursor: query.cursor,
        limit: query.limit,
      }),

    createDocument: (idempotencyKey, body) => post(`${base}/documents`, body, idempotencyKey),
    getDocument: (documentId) => get(doc(documentId)),

    listVersions: (documentId, query = {}) =>
      get(`${doc(documentId)}/versions`, { cursor: query.cursor, limit: query.limit }),

    getVersion: (documentId, versionIdx) => get(`${doc(documentId)}/versions/${seg(versionIdx)}`),

    getVersionSnapshot: async (documentId, versionIdx) => {
      const bytes = await sendBytes({
        method: "GET",
        path: `${doc(documentId)}/versions/${seg(versionIdx)}/snapshot`,
      });
      return decodeSValue(bytes);
    },

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

    appendComment: (documentId, threadId, idempotencyKey, body) =>
      post(`${doc(documentId)}/threads/${seg(threadId)}/comments`, body, idempotencyKey),

    issueCasCapability: () => post(`${base}/cas-capabilities`, {}),
  };
}
