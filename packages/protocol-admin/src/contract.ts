import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  AddAdministratorMemberRequestSchema,
  AdminErrorDataSchema,
  AdministratorMemberRecordSchema,
  AppendSnapshotContractRequestSchema,
  BundleUploadQuerySchema,
  ConditionalMutationHeadersSchema,
  CreateDocumentTypeRequestSchema,
  CreateOperatorCandidateRequestSchema,
  CreateOperatorValidationRequestSchema,
  DocumentTypeRegistrationSchema,
  IdSchema,
  ListBundlesQuerySchema,
  ListAdministratorMembersResponseSchema,
  ListDocumentTypesQuerySchema,
  ListDocumentTypesResponseSchema,
  ListOperatorCandidatesResponseSchema,
  ListSnapshotContractsResponseSchema,
  ListTypeCardBundlesResponseSchema,
  ListViewBundlesResponseSchema,
  MutationHeadersSchema,
  OperatorCandidateRecordSchema,
  OperatorValidationSchema,
  PaginationQuerySchema,
  SnapshotContractIdxSchema,
  SnapshotContractRecordSchema,
  TypeCardBundleRecordSchema,
  UpdateCandidateMetadataRequestSchema,
  UpdateDocumentTypeRequestSchema,
  ViewBundleRecordSchema,
  ZipBundleStreamSchema,
} from "./schemas.js";

export const AdminApiV1BasePath = "/admin/api/v1";

export const AdminApiErrorMap = {
  INVALID_REQUEST: {
    status: 400,
    message: "The request is invalid",
    data: AdminErrorDataSchema,
  },
  UNAUTHORIZED: {
    status: 401,
    message: "Administrator authentication is required",
    data: AdminErrorDataSchema,
  },
  FORBIDDEN: {
    status: 403,
    message: "The administrator is not allowed to perform this operation",
    data: AdminErrorDataSchema,
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested administrator resource was not found",
    data: AdminErrorDataSchema,
  },
  DOCUMENT_TYPE_DISABLED: {
    status: 409,
    message: "The operation requires a disabled document type",
    data: AdminErrorDataSchema,
  },
  OPERATOR_VALIDATION_REQUIRED: {
    status: 409,
    message: "A current Operator validation is required",
    data: AdminErrorDataSchema,
  },
  SNAPSHOT_CONTRACT_CONFLICT: {
    status: 409,
    message: "The Snapshot Contract revision does not match the latest revision",
    data: AdminErrorDataSchema,
  },
  REVISION_CONFLICT: {
    status: 409,
    message: "The idempotency key was used with a different request",
    data: AdminErrorDataSchema,
  },
  PRECONDITION_FAILED: {
    status: 412,
    message: "The If-Match precondition failed",
    data: AdminErrorDataSchema,
  },
  UNSUPPORTED_CONTENT_TYPE: {
    status: 415,
    message: "The request content type is not supported",
    data: AdminErrorDataSchema,
  },
  BUNDLE_INVALID: {
    status: 422,
    message: "The uploaded bundle is invalid",
    data: AdminErrorDataSchema,
  },
  PRECONDITION_REQUIRED: {
    status: 428,
    message: "The If-Match precondition is required",
    data: AdminErrorDataSchema,
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "The administrator operation failed",
    data: AdminErrorDataSchema,
  },
  ADMINISTRATOR_EXISTS: {
    status: 409,
    message: "An administrator membership already exists for this email",
    data: AdminErrorDataSchema,
  },
  CANNOT_REMOVE_SELF: {
    status: 409,
    message: "An administrator cannot remove their own membership",
    data: AdminErrorDataSchema,
  },
  LAST_ADMINISTRATOR: {
    status: 409,
    message: "The final administrator membership cannot be removed",
    data: AdminErrorDataSchema,
  },
} as const;

const adminProcedure = oc.errors(AdminApiErrorMap);

const typeCardBundleIdParams = z.object({ typeCardBundleId: IdSchema }).readonly();
const viewBundleIdParams = z.object({ viewBundleId: IdSchema }).readonly();
const operatorValidationIdParams = z.object({ validationId: IdSchema }).readonly();
const operatorCandidateIdParams = z.object({ operatorCandidateId: IdSchema }).readonly();
const documentTypeParams = z.object({ documentType: IdSchema }).readonly();
const snapshotContractParams = z.object({
  documentType: IdSchema,
  snapshotContractIdx: SnapshotContractIdxSchema,
}).readonly();
const administratorMemberParams = z.object({
  adminId: IdSchema.describe("Administrator membership to remove."),
}).readonly();

export const uploadTypeCardBundleContract = adminProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/type-card-bundles`,
    operationId: "uploadTypeCardBundle",
    summary: "Upload and validate an immutable Type Card bundle",
    description: "Streams an `application/zip` bundle, validates its manifest and assets, and stores it under a content-derived identity. The upload creates initial administrator metadata but does not bind the bundle to a document type. Repeating the same idempotent request returns the same result.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Type Card bundles"],
  })
  .input(z.object({
    query: BundleUploadQuerySchema,
    headers: MutationHeadersSchema,
    body: ZipBundleStreamSchema,
  }).readonly())
  .output(TypeCardBundleRecordSchema);

export const listTypeCardBundlesContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/type-card-bundles`,
    operationId: "listTypeCardBundles",
    summary: "List Type Card bundle candidates for a document type",
    description: "Returns validated Type Card bundles whose manifest declares the requested document type. Results are cursor-paginated and include mutable administrator metadata alongside immutable manifest data.",
    inputStructure: "detailed",
    tags: ["Type Card bundles"],
  })
  .input(z.object({ query: ListBundlesQuerySchema }).readonly())
  .output(ListTypeCardBundlesResponseSchema);

export const getTypeCardBundleContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/type-card-bundles/{typeCardBundleId}`,
    operationId: "getTypeCardBundle",
    summary: "Read a Type Card bundle candidate",
    description: "Returns one validated Type Card bundle record, including its immutable manifest, content identity, size, administrator metadata, and current ETag.",
    inputStructure: "detailed",
    tags: ["Type Card bundles"],
  })
  .input(z.object({ params: typeCardBundleIdParams }).readonly())
  .output(TypeCardBundleRecordSchema);

export const updateTypeCardBundleMetadataContract = adminProcedure
  .route({
    method: "PATCH",
    path: `${AdminApiV1BasePath}/type-card-bundles/{typeCardBundleId}`,
    operationId: "updateTypeCardBundleMetadata",
    summary: "Update Type Card bundle administrator metadata",
    description: "Changes only the administrator-visible name and description. The content-addressed bundle and manifest remain unchanged. `If-Match` must equal the record's current ETag.",
    inputStructure: "detailed",
    tags: ["Type Card bundles"],
  })
  .input(z.object({
    params: typeCardBundleIdParams,
    headers: ConditionalMutationHeadersSchema,
    body: UpdateCandidateMetadataRequestSchema,
  }).readonly())
  .output(TypeCardBundleRecordSchema);

export const uploadViewBundleContract = adminProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/view-bundles`,
    operationId: "uploadViewBundle",
    summary: "Upload and validate an immutable View bundle",
    description: "Streams an `application/zip` View bundle, validates its manifest and assets, and stores it under a content-derived identity. Uploading does not select the bundle for a document type.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["View bundles"],
  })
  .input(z.object({
    query: BundleUploadQuerySchema,
    headers: MutationHeadersSchema,
    body: ZipBundleStreamSchema,
  }).readonly())
  .output(ViewBundleRecordSchema);

export const listViewBundlesContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/view-bundles`,
    operationId: "listViewBundles",
    summary: "List View bundle candidates for a document type",
    description: "Returns validated View bundles that support the requested document type, including their declared Snapshot Contract revisions and location types.",
    inputStructure: "detailed",
    tags: ["View bundles"],
  })
  .input(z.object({ query: ListBundlesQuerySchema }).readonly())
  .output(ListViewBundlesResponseSchema);

export const getViewBundleContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/view-bundles/{viewBundleId}`,
    operationId: "getViewBundle",
    summary: "Read a View bundle candidate",
    description: "Returns one validated View bundle record with immutable manifest data, administrator metadata, content size, and current ETag.",
    inputStructure: "detailed",
    tags: ["View bundles"],
  })
  .input(z.object({ params: viewBundleIdParams }).readonly())
  .output(ViewBundleRecordSchema);

export const updateViewBundleMetadataContract = adminProcedure
  .route({
    method: "PATCH",
    path: `${AdminApiV1BasePath}/view-bundles/{viewBundleId}`,
    operationId: "updateViewBundleMetadata",
    summary: "Update View bundle administrator metadata",
    description: "Changes only the administrator-visible name and description without changing the bundle identity or manifest. `If-Match` prevents concurrent administrators from overwriting each other.",
    inputStructure: "detailed",
    tags: ["View bundles"],
  })
  .input(z.object({
    params: viewBundleIdParams,
    headers: ConditionalMutationHeadersSchema,
    body: UpdateCandidateMetadataRequestSchema,
  }).readonly())
  .output(ViewBundleRecordSchema);

export const createOperatorValidationContract = adminProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/operator-validations`,
    operationId: "createOperatorValidation",
    summary: "Validate an Operator endpoint",
    description: "Fetches Operator discovery and performs a signed, user-data-free probe without following redirects or allowing private-network targets. A successful response contains a short-lived validation identity; failures are synchronous and create no validation task.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: CreateOperatorValidationRequestSchema,
  }).readonly())
  .output(OperatorValidationSchema);

export const getOperatorValidationContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/operator-validations/{validationId}`,
    operationId: "getOperatorValidation",
    summary: "Read a current Operator validation",
    description: "Returns a successful, unexpired Operator validation and the immutable discovery descriptor captured during validation.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({ params: operatorValidationIdParams }).readonly())
  .output(OperatorValidationSchema);

export const createOperatorCandidateContract = adminProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/operator-candidates`,
    operationId: "createOperatorCandidate",
    summary: "Persist a validated Operator candidate",
    description: "Converts a current validation into a persistent candidate for one document type. The validated base URL and descriptor become immutable while the administrator name and description remain editable.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Operators"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: CreateOperatorCandidateRequestSchema,
  }).readonly())
  .output(OperatorCandidateRecordSchema);

export const listOperatorCandidatesContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/operator-candidates`,
    operationId: "listOperatorCandidates",
    summary: "List Operator candidates for a document type",
    description: "Returns persistent, validated Operator candidates available for explicit binding to the requested document type.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({ query: ListBundlesQuerySchema }).readonly())
  .output(ListOperatorCandidatesResponseSchema);

export const updateOperatorCandidateMetadataContract = adminProcedure
  .route({
    method: "PATCH",
    path: `${AdminApiV1BasePath}/operator-candidates/{operatorCandidateId}`,
    operationId: "updateOperatorCandidateMetadata",
    summary: "Update Operator candidate administrator metadata",
    description: "Changes only the administrator-visible name and description. The validated base URL and discovery descriptor remain unchanged, and `If-Match` enforces optimistic concurrency.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({
    params: operatorCandidateIdParams,
    headers: ConditionalMutationHeadersSchema,
    body: UpdateCandidateMetadataRequestSchema,
  }).readonly())
  .output(OperatorCandidateRecordSchema);

export const listDocumentTypesContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/document-types`,
    operationId: "listDocumentTypes",
    summary: "List registered document types",
    description: "Lists document type drafts and enabled registrations with optional text and enabled-state filters. Each item includes the currently selected bundles, Operator candidate, and latest Snapshot Contract revision.",
    inputStructure: "detailed",
    tags: ["Document types"],
  })
  .input(z.object({ query: ListDocumentTypesQuerySchema.optional() }).readonly())
  .output(ListDocumentTypesResponseSchema);

export const getDocumentTypeContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/document-types/{documentType}`,
    operationId: "getDocumentType",
    summary: "Read a document type registration",
    description: "Returns the complete administrator view of a document type, including draft completeness, selected immutable candidates, enabled state, latest Snapshot Contract, and ETag.",
    inputStructure: "detailed",
    tags: ["Document types"],
  })
  .input(z.object({ params: documentTypeParams }).readonly())
  .output(DocumentTypeRegistrationSchema);

export const createDocumentTypeContract = adminProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/document-types`,
    operationId: "createDocumentType",
    summary: "Create a disabled document type draft",
    description: "Creates a new disabled draft from an internal administrator name. A draft may remain incomplete; it cannot be enabled until the latest Snapshot Contract and compatible Type Card, View, and Operator candidates are selected.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Document types"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: CreateDocumentTypeRequestSchema,
  }).readonly())
  .output(DocumentTypeRegistrationSchema);

export const updateDocumentTypeContract = adminProcedure
  .route({
    method: "PATCH",
    path: `${AdminApiV1BasePath}/document-types/{documentType}`,
    operationId: "updateDocumentType",
    summary: "Atomically update a document type registration",
    description: "Atomically changes the internal name, selected Type Card bundle, selected View bundle, selected Operator candidate, or enabled state. `If-Match` protects the complete registration from lost updates, and enabling validates all required selections together.",
    inputStructure: "detailed",
    tags: ["Document types"],
  })
  .input(z.object({
    params: documentTypeParams,
    headers: ConditionalMutationHeadersSchema,
    body: UpdateDocumentTypeRequestSchema,
  }).readonly())
  .output(DocumentTypeRegistrationSchema);

export const listSnapshotContractsContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/document-types/{documentType}/snapshot-contracts`,
    operationId: "listSnapshotContracts",
    summary: "List append-only Snapshot Contract revisions",
    description: "Returns immutable Snapshot Contract revisions in a cursor-paginated list. The revision with the highest index is always the latest revision.",
    inputStructure: "detailed",
    tags: ["Snapshot Contracts"],
  })
  .input(z.object({
    params: documentTypeParams,
    query: PaginationQuerySchema.optional(),
  }).readonly())
  .output(ListSnapshotContractsResponseSchema);

export const getSnapshotContractContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/document-types/{documentType}/snapshot-contracts/{snapshotContractIdx}`,
    operationId: "getSnapshotContract",
    summary: "Read an immutable Snapshot Contract revision",
    description: "Returns one historical or latest Snapshot Contract revision, including the SValue schema, canonical schema hash, content type, and creation time.",
    inputStructure: "detailed",
    tags: ["Snapshot Contracts"],
  })
  .input(z.object({ params: snapshotContractParams }).readonly())
  .output(SnapshotContractRecordSchema);

export const appendSnapshotContractContract = adminProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/document-types/{documentType}/snapshot-contracts`,
    operationId: "appendSnapshotContract",
    summary: "Append the next Snapshot Contract revision",
    description: "Appends exactly one revision while the document type is disabled. `observedLatestSnapshotContractIdx` must equal the current latest index; the Platform assigns the next index, canonically encodes the schema, and computes its hash. Revisions cannot be patched, deleted, or manually selected as latest.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Snapshot Contracts"],
  })
  .input(z.object({
    params: documentTypeParams,
    headers: MutationHeadersSchema,
    body: AppendSnapshotContractRequestSchema,
  }).readonly())
  .output(SnapshotContractRecordSchema);

export const listAdministratorMembersContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/administrators`,
    operationId: "listAdministratorMembers",
    summary: "List administrator members",
    description: "Returns the Google-account administrator allowlist, identity-binding status, provenance, current ETag, and whether each row represents the current administrator.",
    inputStructure: "detailed",
    tags: ["Members"],
  })
  .input(z.object({ query: PaginationQuerySchema.optional() }).readonly())
  .output(ListAdministratorMembersResponseSchema);

export const addAdministratorMemberContract = adminProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/administrators`,
    operationId: "addAdministratorMember",
    summary: "Add an administrator member",
    description: "Adds a normalized Google account email to the administrator allowlist. The identity remains unbound until that account completes administrator sign-in. Reusing an existing email returns a conflict.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Members"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: AddAdministratorMemberRequestSchema,
  }).readonly())
  .output(AdministratorMemberRecordSchema);

export const removeAdministratorMemberContract = adminProcedure
  .route({
    method: "DELETE",
    path: `${AdminApiV1BasePath}/administrators/{adminId}`,
    operationId: "removeAdministratorMember",
    summary: "Remove an administrator member",
    description: "Removes one administrator membership under its current ETag. An administrator cannot remove their own membership, and the final administrator cannot be removed.",
    inputStructure: "detailed",
    successStatus: 204,
    tags: ["Members"],
  })
  .input(z.object({
    params: administratorMemberParams,
    headers: ConditionalMutationHeadersSchema,
  }).readonly())
  .output(z.undefined());

export const adminApiContract = {
  documentTypes: {
    list: listDocumentTypesContract,
    get: getDocumentTypeContract,
    create: createDocumentTypeContract,
    update: updateDocumentTypeContract,
    snapshotContracts: {
      list: listSnapshotContractsContract,
      get: getSnapshotContractContract,
      append: appendSnapshotContractContract,
    },
  },
  typeCardBundles: {
    upload: uploadTypeCardBundleContract,
    list: listTypeCardBundlesContract,
    get: getTypeCardBundleContract,
    updateMetadata: updateTypeCardBundleMetadataContract,
  },
  viewBundles: {
    upload: uploadViewBundleContract,
    list: listViewBundlesContract,
    get: getViewBundleContract,
    updateMetadata: updateViewBundleMetadataContract,
  },
  operatorValidations: {
    create: createOperatorValidationContract,
    get: getOperatorValidationContract,
  },
  operatorCandidates: {
    create: createOperatorCandidateContract,
    list: listOperatorCandidatesContract,
    updateMetadata: updateOperatorCandidateMetadataContract,
  },
  members: {
    list: listAdministratorMembersContract,
    add: addAdministratorMemberContract,
    remove: removeAdministratorMemberContract,
  },
};

export type AdminApiContract = typeof adminApiContract;

export const DocumentTypeAuditActions = [
  "type_card_bundle.uploaded",
  "type_card_bundle.validation_failed",
  "type_card_bundle.metadata_changed",
  "view_bundle.uploaded",
  "view_bundle.validation_failed",
  "view_bundle.metadata_changed",
  "operator_candidate.created",
  "operator_candidate.metadata_changed",
  "snapshot_contract.appended",
  "document_type.registered",
  "document_type.internal_name_changed",
  "document_type.type_card_bundle_changed",
  "document_type.view_bundle_changed",
  "document_type.operator_changed",
  "document_type.enabled",
  "document_type.disabled",
  "operator.validation_passed",
  "operator.validation_failed",
] as const;

export type DocumentTypeAuditAction = typeof DocumentTypeAuditActions[number];

export const AdministratorMemberAuditActions = [
  "administrator.bootstrap",
  "administrator.bound",
  "administrator.added",
  "administrator.removed",
] as const;

export type AdministratorMemberAuditAction = typeof AdministratorMemberAuditActions[number];
