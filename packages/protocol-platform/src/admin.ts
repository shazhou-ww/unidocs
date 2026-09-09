/**
 * Admin control-plane contracts for View bundles, document type registration,
 * Operator discovery and validation, and related audit actions.
 *
 * - `POST /admin/api/v1/view-bundles`: upload, validate, and store an immutable View bundle.
 * - `GET /admin/api/v1/view-bundles/{viewBundleId}`: read a validated bundle manifest and identity.
 * - `POST /admin/api/v1/operator-validations`: validate an Operator endpoint and issue a short-lived validation result.
 * - `GET /admin/api/v1/operator-validations/{validationId}`: read an existing Operator validation result.
 * - `GET /admin/api/v1/document-types`: list and filter registered document types.
 * - `POST /admin/api/v1/document-types`: register a document type from a bundle and optional Operator binding.
 * - `GET /admin/api/v1/document-types/{documentType}`: read one document type registration.
 * - `PATCH /admin/api/v1/document-types/{documentType}`: atomically update its bundle, Operator, or enabled state.
 *
 * `AdminEndpointContracts` maps these operations to path, query, body, and
 * response types.
 */
import type {
  DocumentType,
  EndpointContract,
  IsoDateTime,
  Page,
  ValidationId,
  ViewBundleId,
} from "./common.js";

export interface ViewBundleManifestV1 {
  readonly protocol: "unidocs-view-bundle/v1";
  readonly documentType: DocumentType;
  readonly displayName: string;
  readonly description: string;
  readonly entrypoint: string;
  readonly hostProtocol: "unidocs-view-host/v1";
  readonly snapshotContentTypes: readonly string[];
  readonly locationTypes: readonly string[];
}

export interface ViewBundleRecord {
  readonly viewBundleId: ViewBundleId;
  readonly manifest: ViewBundleManifestV1;
}

export interface OperatorDescriptor {
  readonly protocol: "unidocs-operator/v1";
  readonly operatorId: string;
  readonly displayName: string;
  readonly supportedDocumentTypes: readonly DocumentType[];
}

export interface OperatorBinding {
  readonly baseUrl: string;
  readonly operatorId: string;
  readonly displayName: string;
}

export interface DocumentTypeRegistration {
  readonly documentType: DocumentType;
  readonly enabled: boolean;
  readonly viewBundle: ViewBundleRecord;
  readonly builtinOperator: OperatorBinding | null;
  readonly etag: string;
}

export interface UploadViewBundleRequest {
  readonly contentType: "application/zip";
  readonly body: ReadableStream<Uint8Array>;
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

export interface CreateDocumentTypeRequest {
  readonly viewBundleId: ViewBundleId;
  readonly builtinOperator: {
    readonly baseUrl: string;
    readonly validationId: ValidationId;
  } | null;
  readonly enabled: boolean;
}

export interface UpdateDocumentTypeRequest {
  readonly viewBundleId?: ViewBundleId;
  readonly builtinOperator?: {
    readonly baseUrl: string;
    readonly validationId: ValidationId;
  } | null;
  readonly enabled?: boolean;
  readonly reason: string;
}

export type ListDocumentTypesResponse = Page<DocumentTypeRegistration>;

export interface AdminViewBundlePath {
  readonly viewBundleId: ViewBundleId;
}

export interface AdminOperatorValidationPath {
  readonly validationId: ValidationId;
}

export interface AdminDocumentTypePath {
  readonly documentType: DocumentType;
}

export interface ListDocumentTypesQuery {
  readonly q?: string;
  readonly enabled?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AdminEndpointContracts {
  readonly uploadViewBundle: EndpointContract<UploadViewBundleRequest, ViewBundleRecord>;
  readonly getViewBundle: EndpointContract<
    { readonly path: AdminViewBundlePath },
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
  readonly listDocumentTypes: EndpointContract<
    { readonly query?: ListDocumentTypesQuery },
    ListDocumentTypesResponse
  >;
  readonly getDocumentType: EndpointContract<
    { readonly path: AdminDocumentTypePath },
    DocumentTypeRegistration
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
  | "view_bundle.uploaded"
  | "view_bundle.validation_failed"
  | "document_type.registered"
  | "document_type.view_bundle_changed"
  | "document_type.operator_changed"
  | "document_type.enabled"
  | "document_type.disabled"
  | "operator.validation_passed"
  | "operator.validation_failed";