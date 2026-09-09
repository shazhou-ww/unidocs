/**
 * Admin control-plane contracts for type-card and View bundles, document type
 * registration, Operator discovery and validation, and related audit actions.
 *
 * - `POST /admin/api/v1/type-card-bundles`: upload, validate, and store an immutable type-card bundle.
 * - `GET /admin/api/v1/type-card-bundles`: list validated type-card bundles for a document type.
 * - `GET /admin/api/v1/type-card-bundles/{typeCardBundleId}`: read a validated type-card bundle.
 * - `PATCH /admin/api/v1/type-card-bundles/{typeCardBundleId}`: update its Admin name and description.
 * - `POST /admin/api/v1/view-bundles`: upload, validate, and store an immutable View bundle.
 * - `GET /admin/api/v1/view-bundles`: list validated View bundles for a document type.
 * - `GET /admin/api/v1/view-bundles/{viewBundleId}`: read a validated bundle manifest and identity.
 * - `PATCH /admin/api/v1/view-bundles/{viewBundleId}`: update its Admin name and description.
 * - `POST /admin/api/v1/operator-validations`: validate an Operator endpoint and issue a short-lived validation result.
 * - `GET /admin/api/v1/operator-validations/{validationId}`: read an existing Operator validation result.
 * - `POST /admin/api/v1/operator-candidates`: persist a validated Operator with Admin metadata.
 * - `GET /admin/api/v1/operator-candidates`: list Operator candidates for a document type.
 * - `PATCH /admin/api/v1/operator-candidates/{operatorCandidateId}`: update its Admin metadata.
 * - `GET /admin/api/v1/document-types/{documentType}/snapshot-contracts`: list append-only revisions.
 * - `POST /admin/api/v1/document-types/{documentType}/snapshot-contracts`: append the next revision.
 * - `GET /admin/api/v1/document-types`: list and filter registered document types.
 * - `POST /admin/api/v1/document-types`: create a disabled document type draft from an internal name.
 * - `GET /admin/api/v1/document-types/{documentType}`: read one document type registration.
 * - `PATCH /admin/api/v1/document-types/{documentType}`: atomically update its bundle, Operator, or enabled state.
 *
 * `AdminEndpointContracts` maps these operations to path, query, body, and
 * response types.
 */
import type {
  SValueSchema,
} from "@unidocs/protocol";
import type {
  DocumentType,
  EndpointContract,
  IsoDateTime,
  OperatorCandidateId,
  Page,
  SnapshotContractIdx,
  TypeCardBundleId,
  TypeCardIconRasterSize,
  ValidationId,
  ViewBundleId,
} from "./common.js";
import type { SnapshotContractRecord } from "./resources.js";

/**
 * @example
 * ```json
 * {
 *   "protocol": "unidocs-view-bundle/v1",
 *   "documentType": "markdown",
 *   "entrypoint": "index.html",
 *   "supportedSnapshotContractIdxs": [1],
 *   "locationTypes": ["unidocs.markdown.text-range/v1"]
 * }
 * ```
 */
export interface ViewBundleManifestV1 {
  readonly protocol: "unidocs-view-bundle/v1";
  readonly documentType: DocumentType;
  readonly entrypoint: string;
  readonly supportedSnapshotContractIdxs: readonly SnapshotContractIdx[];
  readonly locationTypes: readonly string[];
}

export interface ViewBundleRecord {
  readonly viewBundleId: ViewBundleId;
  readonly name: string;
  readonly description: string;
  readonly manifest: ViewBundleManifestV1;
  readonly size: number;
  readonly uploadedAt: IsoDateTime;
  readonly etag: string;
}

export interface TypeCardLocaleV1 {
  readonly name: string;
  readonly description: string;
  readonly sampleThumbnailAlt: string;
}

export interface TypeCardIconSvgV1 {
  readonly kind: "svg";
  readonly path: string;
}

export interface TypeCardIconPngV1 {
  readonly kind: "png";
  readonly images: Readonly<Record<TypeCardIconRasterSize, string>>;
}

export type TypeCardIconV1 = TypeCardIconSvgV1 | TypeCardIconPngV1;

/**
 * @example
 * ```json
 * {
 *   "protocol": "unidocs-type-card/v1",
 *   "documentType": "markdown",
 *   "locales": {
 *     "en": {
 *       "name": "Markdown",
 *       "description": "Text, notes and structured writing",
 *       "sampleThumbnailAlt": "Example of a Markdown document"
 *     }
 *   },
 *   "icon": { "kind": "svg", "path": "icon.svg" },
 *   "sampleThumbnail": "sample-thumbnail.webp"
 * }
 * ```
 */
export interface TypeCardBundleManifestV1 {
  readonly protocol: "unidocs-type-card/v1";
  readonly documentType: DocumentType;
  readonly locales: Readonly<Record<string, TypeCardLocaleV1>>;
  readonly icon: TypeCardIconV1;
  readonly sampleThumbnail: string;
}

export interface TypeCardBundleRecord {
  readonly typeCardBundleId: TypeCardBundleId;
  readonly name: string;
  readonly description: string;
  readonly manifest: TypeCardBundleManifestV1;
  readonly size: number;
  readonly uploadedAt: IsoDateTime;
  readonly etag: string;
}

export interface OperatorDescriptor {
  readonly protocol: "unidocs-operator/v1";
  readonly operatorId: string;
  readonly displayName: string;
  readonly supportedDocumentTypes: readonly DocumentType[];
  readonly supportedSnapshotContracts: Readonly<
    Record<DocumentType, readonly SnapshotContractIdx[]>
  >;
}

export interface OperatorCandidateRecord {
  readonly operatorCandidateId: OperatorCandidateId;
  readonly documentType: DocumentType;
  readonly name: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly descriptor: OperatorDescriptor;
  readonly validatedAt: IsoDateTime;
  readonly etag: string;
}

export interface DocumentTypeRegistration {
  readonly documentType: DocumentType;
  readonly internalName: string;
  readonly enabled: boolean;
  /** Latest is the highest revision; null before the first append. */
  readonly latestSnapshotContract: SnapshotContractRecord | null;
  readonly typeCardBundle: TypeCardBundleRecord | null;
  readonly viewBundle: ViewBundleRecord | null;
  readonly builtinOperator: OperatorCandidateRecord | null;
  readonly etag: string;
  readonly updatedAt: IsoDateTime;
}

export interface UploadTypeCardBundleRequest {
  readonly contentType: "application/zip";
  readonly name: string;
  readonly description: string;
  readonly body: ReadableStream<Uint8Array>;
}

export interface UploadViewBundleRequest {
  readonly contentType: "application/zip";
  readonly name: string;
  readonly description: string;
  readonly body: ReadableStream<Uint8Array>;
}

export interface UpdateCandidateMetadataRequest {
  readonly name: string;
  readonly description: string;
}

export interface CreateOperatorValidationRequest {
  readonly baseUrl: string;
  readonly expectedDocumentType: DocumentType;
  readonly expectedConfigEtag: string | null;
}

export interface OperatorValidation {
  readonly validationId: ValidationId;
  readonly baseUrl: string;
  readonly descriptor: OperatorDescriptor;
  readonly expiresAt: IsoDateTime;
}

export interface CreateOperatorCandidateRequest {
  readonly validationId: ValidationId;
  readonly name: string;
  readonly description: string;
}

export interface CreateDocumentTypeRequest {
  readonly internalName: string;
}

export interface AppendSnapshotContractRequest {
  readonly observedLatestSnapshotContractIdx: SnapshotContractIdx | null;
  readonly contentType: string;
  readonly schema: SValueSchema;
  readonly reason: string;
}

export interface UpdateDocumentTypeRequest {
  readonly internalName?: string;
  readonly typeCardBundleId?: TypeCardBundleId;
  readonly viewBundleId?: ViewBundleId;
  readonly builtinOperatorCandidateId?: OperatorCandidateId | null;
  readonly enabled?: boolean;
  readonly reason?: string;
}

export type ListDocumentTypesResponse = Page<DocumentTypeRegistration>;
export type ListTypeCardBundlesResponse = Page<TypeCardBundleRecord>;
export type ListViewBundlesResponse = Page<ViewBundleRecord>;
export type ListOperatorCandidatesResponse = Page<OperatorCandidateRecord>;
export type ListSnapshotContractsResponse = Page<SnapshotContractRecord>;

export interface AdminViewBundlePath {
  readonly viewBundleId: ViewBundleId;
}

export interface AdminTypeCardBundlePath {
  readonly typeCardBundleId: TypeCardBundleId;
}

export interface AdminOperatorValidationPath {
  readonly validationId: ValidationId;
}

export interface AdminOperatorCandidatePath {
  readonly operatorCandidateId: OperatorCandidateId;
}

export interface AdminDocumentTypePath {
  readonly documentType: DocumentType;
}

export interface AdminSnapshotContractPath extends AdminDocumentTypePath {
  readonly snapshotContractIdx: SnapshotContractIdx;
}

export interface ListDocumentTypesQuery {
  readonly q?: string;
  readonly enabled?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListBundlesQuery {
  readonly documentType: DocumentType;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AdminEndpointContracts {
  readonly uploadTypeCardBundle: EndpointContract<
    UploadTypeCardBundleRequest,
    TypeCardBundleRecord
  >;
  readonly listTypeCardBundles: EndpointContract<
    { readonly query: ListBundlesQuery },
    ListTypeCardBundlesResponse
  >;
  readonly getTypeCardBundle: EndpointContract<
    { readonly path: AdminTypeCardBundlePath },
    TypeCardBundleRecord
  >;
  readonly updateTypeCardBundleMetadata: EndpointContract<
    {
      readonly path: AdminTypeCardBundlePath;
      readonly headers: { readonly ifMatch: string };
      readonly body: UpdateCandidateMetadataRequest;
    },
    TypeCardBundleRecord
  >;
  readonly uploadViewBundle: EndpointContract<UploadViewBundleRequest, ViewBundleRecord>;
  readonly listViewBundles: EndpointContract<
    { readonly query: ListBundlesQuery },
    ListViewBundlesResponse
  >;
  readonly getViewBundle: EndpointContract<
    { readonly path: AdminViewBundlePath },
    ViewBundleRecord
  >;
  readonly updateViewBundleMetadata: EndpointContract<
    {
      readonly path: AdminViewBundlePath;
      readonly headers: { readonly ifMatch: string };
      readonly body: UpdateCandidateMetadataRequest;
    },
    ViewBundleRecord
  >;
  readonly createOperatorValidation: EndpointContract<
    { readonly body: CreateOperatorValidationRequest },
    OperatorValidation
  >;
  readonly getOperatorValidation: EndpointContract<
    { readonly path: AdminOperatorValidationPath },
    OperatorValidation
  >;
  readonly createOperatorCandidate: EndpointContract<
    { readonly body: CreateOperatorCandidateRequest },
    OperatorCandidateRecord
  >;
  readonly listOperatorCandidates: EndpointContract<
    { readonly query: ListBundlesQuery },
    ListOperatorCandidatesResponse
  >;
  readonly updateOperatorCandidateMetadata: EndpointContract<
    {
      readonly path: AdminOperatorCandidatePath;
      readonly headers: { readonly ifMatch: string };
      readonly body: UpdateCandidateMetadataRequest;
    },
    OperatorCandidateRecord
  >;
  readonly listDocumentTypes: EndpointContract<
    { readonly query?: ListDocumentTypesQuery },
    ListDocumentTypesResponse
  >;
  readonly getDocumentType: EndpointContract<
    { readonly path: AdminDocumentTypePath },
    DocumentTypeRegistration
  >;
  readonly listSnapshotContracts: EndpointContract<
    { readonly path: AdminDocumentTypePath; readonly query?: { readonly cursor?: string; readonly limit?: number } },
    ListSnapshotContractsResponse
  >;
  readonly getSnapshotContract: EndpointContract<
    { readonly path: AdminSnapshotContractPath },
    SnapshotContractRecord
  >;
  readonly appendSnapshotContract: EndpointContract<
    { readonly path: AdminDocumentTypePath; readonly body: AppendSnapshotContractRequest },
    SnapshotContractRecord
  >;
  readonly createDocumentType: EndpointContract<
    { readonly body: CreateDocumentTypeRequest },
    DocumentTypeRegistration
  >;
  readonly updateDocumentType: EndpointContract<
    {
      readonly path: AdminDocumentTypePath;
      readonly headers: { readonly ifMatch: string };
      readonly body: UpdateDocumentTypeRequest;
    },
    DocumentTypeRegistration
  >;
}

export type DocumentTypeAuditAction =
  | "type_card_bundle.uploaded"
  | "type_card_bundle.validation_failed"
  | "type_card_bundle.metadata_changed"
  | "view_bundle.uploaded"
  | "view_bundle.validation_failed"
  | "view_bundle.metadata_changed"
  | "operator_candidate.created"
  | "operator_candidate.metadata_changed"
  | "snapshot_contract.appended"
  | "document_type.registered"
  | "document_type.internal_name_changed"
  | "document_type.type_card_bundle_changed"
  | "document_type.view_bundle_changed"
  | "document_type.operator_changed"
  | "document_type.enabled"
  | "document_type.disabled"
  | "operator.validation_passed"
  | "operator.validation_failed";