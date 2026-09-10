/**
 * User-facing Platform HTTP contracts for the public type catalog, documents,
 * versions, threads, pings, current pointers, and direct-CAS capability grants.
 *
 * - `GET /api/v1/tenants/{tenantId}/document-types`: list enabled types available for document creation.
 * - `GET /api/v1/tenants/{tenantId}/documents`: list documents visible to the current user.
 * - `POST /api/v1/tenants/{tenantId}/documents`: create a named document and trigger initialization.
 * - `GET /api/v1/tenants/{tenantId}/documents/{documentId}`: read document metadata and its current version pointer.
 * - `GET /api/v1/tenants/{tenantId}/documents/{documentId}/versions`: list immutable versions in birth order.
 * - `GET /api/v1/tenants/{tenantId}/documents/{documentId}/versions/{versionIdx}`: read one version and snapshot.
 * - `POST /api/v1/tenants/{tenantId}/documents/{documentId}/current-version`: move the current pointer with an equality lock.
 * - `GET /api/v1/tenants/{tenantId}/documents/{documentId}/threads`: list thread identities with optional version/open filters.
 * - `POST /api/v1/tenants/{tenantId}/documents/{documentId}/threads`: create a thread containing its first ping.
 * - `GET /api/v1/tenants/{tenantId}/documents/{documentId}/threads/{threadId}`: read complete ping and pong sequences.
 * - `POST /api/v1/tenants/{tenantId}/documents/{documentId}/threads/{threadId}/pings`: append an idempotent user ping.
 * - `POST /api/v1/tenants/{tenantId}/cas-capabilities`: issue a short-lived
 *   tenant-scoped JWT for direct UniCAS reads and leases.
 *
 * `PlatformEndpointContracts` binds each operation to its path, query, body,
 * headers, and response type. Agent-only submissions are in `agent.ts`.
 */
import type {
  Cursor,
  DocumentContractIdx,
  DocumentId,
  DocumentLocation,
  DocumentType,
  EndpointContract,
  MessageContent,
  Page,
  TenantId,
  ThreadId,
  TypeCardBundleId,
  TypeCardIconRasterSize,
  VersionIdx,
  ViewBundleId,
} from "./common.js";
import type {
  DocumentContractRecord,
  DocumentRecord,
  PingRecord,
  ThreadDetail,
  ThreadRef,
  VersionRecord,
} from "./resources.js";

export interface PublicTypeCardLocale {
  readonly name: string;
  readonly description: string;
  readonly sampleThumbnailAlt: string;
}

export interface PublicTypeCardIconSvg {
  readonly kind: "svg";
  readonly url: string;
}

export interface PublicTypeCardIconPng {
  readonly kind: "png";
  readonly imageUrls: Readonly<Record<TypeCardIconRasterSize, string>>;
}

export type PublicTypeCardIcon = PublicTypeCardIconSvg | PublicTypeCardIconPng;

export interface PublicTypeCard {
  readonly locales: Readonly<Record<string, PublicTypeCardLocale>>;
  readonly icon: PublicTypeCardIcon;
  readonly sampleThumbnailUrl: string;
}

export interface PublicDocumentType {
  readonly documentType: DocumentType;
  readonly typeCardBundleId: TypeCardBundleId;
  readonly typeCard: PublicTypeCard;
  readonly viewBundleId: ViewBundleId;
  readonly availableDocumentContractIdxs: readonly DocumentContractIdx[];
}

export interface CreateDocumentRequest {
  readonly documentType: DocumentType;
  readonly name: string;
}

export interface MoveCurrentVersionRequest {
  readonly observedCurrentVersionIdx: VersionIdx | null;
  readonly targetVersionIdx: VersionIdx;
  readonly reason: string;
}

export type ListPublicDocumentTypesResponse = Page<PublicDocumentType>;
export type ListDocumentsResponse = Page<DocumentRecord>;
export type ListVersionsResponse = Page<VersionRecord>;

export interface CreateThreadRequest {
  readonly baseVersionIdx: VersionIdx;
  readonly content: MessageContent;
  readonly location: DocumentLocation | null;
}

export interface AppendPingRequest {
  readonly baseVersionIdx: VersionIdx;
  readonly content: MessageContent;
  readonly location: DocumentLocation | null;
}

export type ListThreadsResponse = Page<ThreadRef>;

export interface CasCapabilityGrant {
  readonly baseUrl: string;
  readonly stackId: string;
  readonly tenantId: TenantId;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly permissions: readonly ["cas:read", "cas:write"];
}

export interface TenantPath {
  readonly tenantId: TenantId;
}

export interface DocumentPath extends TenantPath {
  readonly documentId: DocumentId;
}

export interface DocumentTypePath extends TenantPath {
  readonly documentType: DocumentType;
}

export interface DocumentContractPath extends DocumentTypePath {
  readonly documentContractIdx: DocumentContractIdx;
}

export interface VersionPath extends DocumentPath {
  readonly versionIdx: VersionIdx;
}

export interface ThreadPath extends DocumentPath {
  readonly threadId: ThreadId;
}

export interface PageQuery {
  readonly cursor?: Cursor;
  readonly limit?: number;
}

export interface ListDocumentsQuery extends PageQuery {
  readonly documentType?: DocumentType;
}

export interface ListThreadsQuery extends PageQuery {
  readonly open?: boolean;
  readonly versionIdx?: VersionIdx;
}

export interface PlatformEndpointContracts {
  readonly listPublicDocumentTypes: EndpointContract<
    { readonly path: TenantPath; readonly query?: PageQuery },
    ListPublicDocumentTypesResponse
  >;
  readonly getDocumentContract: EndpointContract<
    { readonly path: DocumentContractPath },
    DocumentContractRecord
  >;
  readonly listDocuments: EndpointContract<
    { readonly path: TenantPath; readonly query?: ListDocumentsQuery },
    ListDocumentsResponse
  >;
  readonly createDocument: EndpointContract<
    { readonly path: TenantPath; readonly body: CreateDocumentRequest },
    DocumentRecord
  >;
  readonly getDocument: EndpointContract<{ readonly path: DocumentPath }, DocumentRecord>;
  readonly listVersions: EndpointContract<
    { readonly path: DocumentPath; readonly query?: PageQuery },
    ListVersionsResponse
  >;
  readonly getVersion: EndpointContract<{ readonly path: VersionPath }, VersionRecord>;
  readonly moveCurrentVersion: EndpointContract<
    { readonly path: DocumentPath; readonly body: MoveCurrentVersionRequest },
    DocumentRecord
  >;
  readonly listThreads: EndpointContract<
    { readonly path: DocumentPath; readonly query?: ListThreadsQuery },
    ListThreadsResponse
  >;
  readonly createThread: EndpointContract<
    {
      readonly path: DocumentPath;
      readonly headers: { readonly idempotencyKey: string };
      readonly body: CreateThreadRequest;
    },
    ThreadDetail
  >;
  readonly getThread: EndpointContract<{ readonly path: ThreadPath }, ThreadDetail>;
  readonly appendPing: EndpointContract<
    {
      readonly path: ThreadPath;
      readonly headers: { readonly idempotencyKey: string };
      readonly body: AppendPingRequest;
    },
    PingRecord
  >;
  readonly issueCasCapability: EndpointContract<
    { readonly path: TenantPath },
    CasCapabilityGrant
  >;
}
