import {
  AdminApiV1BasePath,
  type AddAdministratorMemberRequest,
  type AdministratorMemberMutationResult,
  type AdministratorMemberRecord,
  type AppendDocumentContractRequest,
  type CreateDocumentTypeRequest,
  type DocumentContractAppendResult,
  type DocumentContractRecord,
  type DocumentTypeMutationResult,
  type DocumentTypeRegistration,
  type ListAdministratorMembersResponse,
  type ListAdminAuditEventsQuery,
  type ListAdminAuditEventsResponse,
  type ListDocumentTypesQuery,
  type ListDocumentTypesResponse,
  type ListDocumentContractsResponse,
  type ListTypeCardBundlesResponse,
  type ListViewBundlesResponse,
  type TypeCardBundleMutationResult,
  type TypeCardBundleRecord,
  type UpdateCandidateMetadataRequest,
  type UpdateDocumentTypeRequest,
  type ViewBundleMutationResult,
  type ViewBundleRecord,
} from "@unidocs/protocol-admin-portal";

export interface AdminPortalSession {
  readonly memberId: string;
  readonly email: string;
  readonly authenticatedAt: number | null;
  readonly loginConfirmedAt: number | null;
  readonly loginConfirmation: string | null;
  readonly transport: "session" | "bearer";
}

export class AdminPortalClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId: string | null = null, readonly details?: unknown) {
    super(message);
    this.name = "AdminPortalClientError";
  }
}

export interface AdminPortalClient {
  session(): Promise<AdminPortalSession>;
  logout(): Promise<void>;
  listDocumentTypes(query?: ListDocumentTypesQuery): Promise<ListDocumentTypesResponse>;
  getDocumentType(documentType: string): Promise<DocumentTypeRegistration>;
  createDocumentType(body: CreateDocumentTypeRequest, idempotencyKey?: string): Promise<DocumentTypeMutationResult>;
  updateDocumentType(documentType: string, body: UpdateDocumentTypeRequest, ifMatch: string, idempotencyKey?: string): Promise<DocumentTypeMutationResult>;
  listAdministrators(query?: { readonly limit?: number; readonly cursor?: string }): Promise<ListAdministratorMembersResponse>;
  getAdministrator(adminId: string): Promise<AdministratorMemberRecord>;
  addAdministrator(body: AddAdministratorMemberRequest, idempotencyKey?: string): Promise<AdministratorMemberMutationResult>;
  removeAdministrator(adminId: string, ifMatch: string, idempotencyKey?: string): Promise<void>;
  listAuditEvents(query?: ListAdminAuditEventsQuery): Promise<ListAdminAuditEventsResponse>;
  listDocumentContracts(documentType: string, query?: { readonly limit?: number; readonly cursor?: string }): Promise<ListDocumentContractsResponse>;
  getDocumentContract(documentType: string, documentContractIdx: number): Promise<DocumentContractRecord>;
  appendDocumentContract(documentType: string, body: AppendDocumentContractRequest, idempotencyKey?: string): Promise<DocumentContractAppendResult>;
  uploadTypeCardBundle(file: Blob, metadata: { readonly name: string; readonly description: string }, idempotencyKey?: string): Promise<TypeCardBundleMutationResult>;
  listTypeCardBundles(documentType: string, query?: { readonly limit?: number; readonly cursor?: string }): Promise<ListTypeCardBundlesResponse>;
  getTypeCardBundle(typeCardBundleId: string): Promise<TypeCardBundleRecord>;
  updateTypeCardBundleMetadata(typeCardBundleId: string, body: UpdateCandidateMetadataRequest, ifMatch: string, idempotencyKey?: string): Promise<TypeCardBundleMutationResult>;
  uploadViewBundle(file: Blob, metadata: { readonly name: string; readonly description: string }, idempotencyKey?: string): Promise<ViewBundleMutationResult>;
  listViewBundles(documentType: string, query?: { readonly limit?: number; readonly cursor?: string }): Promise<ListViewBundlesResponse>;
  getViewBundle(viewBundleId: string): Promise<ViewBundleRecord>;
  updateViewBundleMetadata(viewBundleId: string, body: UpdateCandidateMetadataRequest, ifMatch: string, idempotencyKey?: string): Promise<ViewBundleMutationResult>;
}

export interface AdminPortalClientConfig {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly getCsrfToken?: () => string | null;
  readonly createIdempotencyKey?: () => string;
  readonly onUnauthorized?: (error: AdminPortalClientError) => void;
}

function browserCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  for (const item of document.cookie.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === "__Host-unidocs_admin_csrf") return decodeURIComponent(value.join("="));
  }
  return null;
}

export function createAdminPortalClient(config: AdminPortalClientConfig = {}): AdminPortalClient {
  const baseUrl = (config.baseUrl ?? "").replace(/\/$/, "");
  const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
  const getCsrfToken = config.getCsrfToken ?? browserCsrfToken;
  const createIdempotencyKey = config.createIdempotencyKey ?? (() => crypto.randomUUID());

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, { ...init, credentials: "include" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } } | null;
      const error = payload?.error;
      const clientError = new AdminPortalClientError(response.status, typeof error?.code === "string" ? error.code : `http_${response.status}`,
        typeof error?.message === "string" ? error.message : "Administrator request failed", typeof error?.requestId === "string" ? error.requestId : response.headers.get("x-request-id"), error?.details);
      if (response.status === 401) config.onUnauthorized?.(clientError);
      throw clientError;
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  function mutationHeaders(extra: Record<string, string> = {}): Headers {
    const csrfToken = getCsrfToken();
    if (!csrfToken) throw new AdminPortalClientError(0, "csrf_unavailable", "The administrator session is unavailable");
    return new Headers({ "content-type": "application/json", "x-csrf-token": csrfToken, ...extra });
  }

  return {
    session: () => request<AdminPortalSession>("/admin/auth/session"),
    logout: () => {
      const csrfToken = getCsrfToken();
      return request<void>("/admin/auth/logout", { method: "POST", headers: csrfToken ? { "x-csrf-token": csrfToken } : undefined });
    },
    listDocumentTypes(query = {}) {
      const params = new URLSearchParams();
      if (query.q !== undefined) params.set("q", query.q);
      if (query.enabled !== undefined) params.set("enabled", String(query.enabled));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      const encoded = params.toString();
      return request<ListDocumentTypesResponse>(`${AdminApiV1BasePath}/document-types${encoded ? `?${encoded}` : ""}`);
    },
    getDocumentType: documentType => request<DocumentTypeRegistration>(`${AdminApiV1BasePath}/document-types/${encodeURIComponent(documentType)}`),
    createDocumentType: (body, idempotencyKey = createIdempotencyKey()) => request<DocumentTypeMutationResult>(`${AdminApiV1BasePath}/document-types`, {
      method: "POST", headers: mutationHeaders({ "idempotency-key": idempotencyKey }), body: JSON.stringify(body),
    }),
    updateDocumentType: (documentType, body, ifMatch, idempotencyKey = createIdempotencyKey()) => request<DocumentTypeMutationResult>(`${AdminApiV1BasePath}/document-types/${encodeURIComponent(documentType)}`, {
      method: "PATCH", headers: mutationHeaders({ "idempotency-key": idempotencyKey, "if-match": ifMatch }), body: JSON.stringify(body),
    }),
    listAdministrators(query = {}) {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      const encoded = params.toString();
      return request<ListAdministratorMembersResponse>(`${AdminApiV1BasePath}/administrators${encoded ? `?${encoded}` : ""}`);
    },
    getAdministrator: adminId => request<AdministratorMemberRecord>(`${AdminApiV1BasePath}/administrators/${encodeURIComponent(adminId)}`),
    addAdministrator: (body, idempotencyKey = createIdempotencyKey()) => request<AdministratorMemberMutationResult>(`${AdminApiV1BasePath}/administrators`, {
      method: "POST", headers: mutationHeaders({ "idempotency-key": idempotencyKey }), body: JSON.stringify(body),
    }),
    removeAdministrator: (adminId, ifMatch, idempotencyKey = createIdempotencyKey()) => request<void>(`${AdminApiV1BasePath}/administrators/${encodeURIComponent(adminId)}`, {
      method: "DELETE", headers: mutationHeaders({ "idempotency-key": idempotencyKey, "if-match": ifMatch }),
    }),
    listAuditEvents(query = {}) {
      const params = new URLSearchParams();
      if (query.actorId !== undefined) params.set("actorId", query.actorId);
      if (query.action !== undefined) params.set("action", query.action);
      if (query.resourceType !== undefined) params.set("resourceType", query.resourceType);
      if (query.documentType !== undefined) params.set("documentType", query.documentType);
      if (query.occurredFrom !== undefined) params.set("occurredFrom", query.occurredFrom);
      if (query.occurredTo !== undefined) params.set("occurredTo", query.occurredTo);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      const encoded = params.toString();
      return request<ListAdminAuditEventsResponse>(`${AdminApiV1BasePath}/audit-events${encoded ? `?${encoded}` : ""}`);
    },
    listDocumentContracts(documentType, query = {}) {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      const encoded = params.toString();
      return request<ListDocumentContractsResponse>(`${AdminApiV1BasePath}/document-types/${encodeURIComponent(documentType)}/document-contracts${encoded ? `?${encoded}` : ""}`);
    },
    getDocumentContract: (documentType, documentContractIdx) => request<DocumentContractRecord>(`${AdminApiV1BasePath}/document-types/${encodeURIComponent(documentType)}/document-contracts/${documentContractIdx}`),
    appendDocumentContract: (documentType, body, idempotencyKey = createIdempotencyKey()) => request<DocumentContractAppendResult>(`${AdminApiV1BasePath}/document-types/${encodeURIComponent(documentType)}/document-contracts`, {
      method: "POST", headers: mutationHeaders({ "idempotency-key": idempotencyKey }), body: JSON.stringify(body),
    }),
    uploadTypeCardBundle(file, metadata, idempotencyKey = createIdempotencyKey()) {
      const params = new URLSearchParams({ name: metadata.name, description: metadata.description });
      const headers = mutationHeaders({ "content-type": "application/zip", "idempotency-key": idempotencyKey });
      return request<TypeCardBundleMutationResult>(`${AdminApiV1BasePath}/type-card-bundles?${params}`, { method: "POST", headers, body: file });
    },
    listTypeCardBundles(documentType, query = {}) {
      const params = new URLSearchParams({ documentType });
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      return request<ListTypeCardBundlesResponse>(`${AdminApiV1BasePath}/type-card-bundles?${params}`);
    },
    getTypeCardBundle: typeCardBundleId => request<TypeCardBundleRecord>(`${AdminApiV1BasePath}/type-card-bundles/${encodeURIComponent(typeCardBundleId)}`),
    updateTypeCardBundleMetadata: (typeCardBundleId, body, ifMatch, idempotencyKey = createIdempotencyKey()) => request<TypeCardBundleMutationResult>(`${AdminApiV1BasePath}/type-card-bundles/${encodeURIComponent(typeCardBundleId)}`, {
      method: "PATCH", headers: mutationHeaders({ "idempotency-key": idempotencyKey, "if-match": ifMatch }), body: JSON.stringify(body),
    }),
    uploadViewBundle(file, metadata, idempotencyKey = createIdempotencyKey()) {
      const params = new URLSearchParams({ name: metadata.name, description: metadata.description });
      const headers = mutationHeaders({ "content-type": "application/zip", "idempotency-key": idempotencyKey });
      return request<ViewBundleMutationResult>(`${AdminApiV1BasePath}/view-bundles?${params}`, { method: "POST", headers, body: file });
    },
    listViewBundles(documentType, query = {}) {
      const params = new URLSearchParams({ documentType });
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      return request<ListViewBundlesResponse>(`${AdminApiV1BasePath}/view-bundles?${params}`);
    },
    getViewBundle: viewBundleId => request<ViewBundleRecord>(`${AdminApiV1BasePath}/view-bundles/${encodeURIComponent(viewBundleId)}`),
    updateViewBundleMetadata: (viewBundleId, body, ifMatch, idempotencyKey = createIdempotencyKey()) => request<ViewBundleMutationResult>(`${AdminApiV1BasePath}/view-bundles/${encodeURIComponent(viewBundleId)}`, {
      method: "PATCH", headers: mutationHeaders({ "idempotency-key": idempotencyKey, "if-match": ifMatch }), body: JSON.stringify(body),
    }),
  };
}