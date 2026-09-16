import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  AddAdministratorMemberRequestSchema,
  AddTenantMemberRequestSchema,
  AppendDocumentContractRequestSchema,
  AdminErrorDataSchema,
  AdministratorMemberAuditActions,
  AdministratorMemberMutationResultSchema,
  AdministratorMemberRecordSchema,
  BundleUploadQuerySchema,
  ConditionalMutationHeadersSchema,
  CreateDocumentTypeRequestSchema,
    DocumentContractIdxSchema,
    DocumentContractAppendResultSchema,
    DocumentContractRecordSchema,
    DocumentTypeAuditActions,
    DocumentTypeMutationResultSchema,
    DocumentTypeSchema,
  CreateOperatorRequestSchema,
  CreateOperatorValidationRequestSchema,
  DocumentTypeRegistrationSchema,
  IdSchema,
  ListAdminAuditEventsQuerySchema,
  ListAdminAuditEventsResponseSchema,
  ListBundlesQuerySchema,
  ListAdministratorMembersResponseSchema,
  ListDocumentTypesQuerySchema,
  ListDocumentTypesResponseSchema,
  ListOperatorsResponseSchema,
  ListDocumentContractsResponseSchema,
  ListTenantMembersQuerySchema,
  ListTenantMembersResponseSchema,
  ListTypeCardBundlesResponseSchema,
  ListViewBundlesResponseSchema,
  MutationHeadersSchema,
  OperatorRecordSchema,
  OperatorMutationResultSchema,
  OperatorValidationSchema,
  PaginationQuerySchema,
  TenantMemberAuditActions,
  TenantMemberMutationResultSchema,
  TypeCardBundleRecordSchema,
  TypeCardBundleMutationResultSchema,
  UpdateCandidateMetadataRequestSchema,
  UpdateDocumentTypeRequestSchema,
  ViewBundleRecordSchema,
  ViewBundleMutationResultSchema,
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
  OPERATOR_VALIDATION_REQUIRED: {
    status: 409,
    message: "A current Operator validation is required",
    data: AdminErrorDataSchema,
  },
  OPERATOR_VALIDATION_FAILED: {
    status: 422,
    message: "The Operator could not be validated",
    data: AdminErrorDataSchema,
  },
  IDEMPOTENCY_CONFLICT: {
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
  BUNDLE_ALREADY_EXISTS: {
    status: 409,
    message: "The content-addressed bundle already exists",
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
  TENANT_MEMBER_EXISTS: {
    status: 409,
    message: "An active tenant membership already exists for this email",
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

const adminProcedure = oc.errors({
  INVALID_REQUEST: AdminApiErrorMap.INVALID_REQUEST,
  UNAUTHORIZED: AdminApiErrorMap.UNAUTHORIZED,
  FORBIDDEN: AdminApiErrorMap.FORBIDDEN,
  INTERNAL_ERROR: AdminApiErrorMap.INTERNAL_ERROR,
});
const resourceReadProcedure = adminProcedure.errors({
  NOT_FOUND: AdminApiErrorMap.NOT_FOUND,
});
const idempotentMutationProcedure = adminProcedure.errors({
  IDEMPOTENCY_CONFLICT: AdminApiErrorMap.IDEMPOTENCY_CONFLICT,
});
const resourceMutationProcedure = idempotentMutationProcedure.errors({
  NOT_FOUND: AdminApiErrorMap.NOT_FOUND,
});
const conditionalMutationProcedure = resourceMutationProcedure.errors({
  PRECONDITION_FAILED: AdminApiErrorMap.PRECONDITION_FAILED,
  PRECONDITION_REQUIRED: AdminApiErrorMap.PRECONDITION_REQUIRED,
});
const bundleUploadProcedure = idempotentMutationProcedure.errors({
  UNSUPPORTED_CONTENT_TYPE: AdminApiErrorMap.UNSUPPORTED_CONTENT_TYPE,
  BUNDLE_INVALID: AdminApiErrorMap.BUNDLE_INVALID,
  BUNDLE_ALREADY_EXISTS: AdminApiErrorMap.BUNDLE_ALREADY_EXISTS,
});

const typeCardBundleIdParams = z.object({ typeCardBundleId: IdSchema }).readonly();
const viewBundleIdParams = z.object({ viewBundleId: IdSchema }).readonly();
const operatorValidationIdParams = z.object({ validationId: IdSchema }).readonly();
const operatorIdParams = z.object({ operatorId: IdSchema }).readonly();
const documentTypeParams = z.object({ documentType: DocumentTypeSchema }).readonly();
const documentContractParams = z.object({
  documentType: DocumentTypeSchema,
  documentContractIdx: DocumentContractIdxSchema,
}).readonly();
const administratorMemberParams = z.object({
  adminId: IdSchema.describe("Administrator membership to remove."),
}).readonly();
const tenantMemberParams = z.object({
  memberId: IdSchema.describe("Tenant membership to address."),
}).readonly();

export const uploadTypeCardBundleContract = bundleUploadProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/type-card-bundles`,
    operationId: "uploadTypeCardBundle",
    summary: "Upload and validate an immutable Type Card bundle",
    description: "Streams an `application/zip` bundle, validates its manifest and assets, and stores it under a content-derived identity. The upload creates initial administrator metadata but does not bind the bundle to a document type. Replaying the same idempotency key returns the original `201` result. Uploading existing content under a different key returns `409` with the existing bundle identity in error details; metadata must be changed explicitly through PATCH.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Type Card bundles"],
  })
  .input(z.object({
    query: BundleUploadQuerySchema,
    headers: MutationHeadersSchema,
    body: ZipBundleStreamSchema,
  }).readonly())
  .output(TypeCardBundleMutationResultSchema);

export const listTypeCardBundlesContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/type-card-bundles`,
    operationId: "listTypeCardBundles",
    summary: "List Type Card bundle candidates for a document type",
    description: "Returns cursor-paginated Type Card bundle summaries for the requested document type. Full manifests are available from the item GET operation.",
    inputStructure: "detailed",
    tags: ["Type Card bundles"],
  })
  .input(z.object({ query: ListBundlesQuerySchema }).readonly())
  .output(ListTypeCardBundlesResponseSchema);

export const getTypeCardBundleContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/type-card-bundles/{typeCardBundleId}`,
    operationId: "getTypeCardBundle",
    summary: "Read a Type Card bundle candidate",
    description: "Returns one validated Type Card bundle record, including its immutable canonical bundle root URL, manifest, content identity, size, administrator metadata, and current ETag.",
    inputStructure: "detailed",
    tags: ["Type Card bundles"],
  })
  .input(z.object({ params: typeCardBundleIdParams }).readonly())
  .output(TypeCardBundleRecordSchema);

export const updateTypeCardBundleMetadataContract = conditionalMutationProcedure
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
  .output(TypeCardBundleMutationResultSchema);

export const uploadViewBundleContract = bundleUploadProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/view-bundles`,
    operationId: "uploadViewBundle",
    summary: "Upload and validate an immutable View bundle",
    description: "Streams an `application/zip` View bundle, validates its manifest and assets, and stores it under a content-derived identity. Uploading does not select the bundle for a document type. Replaying the same idempotency key returns the original `201` result. Uploading existing content under a different key returns `409` with the existing bundle identity in error details; metadata must be changed explicitly through PATCH.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["View bundles"],
  })
  .input(z.object({
    query: BundleUploadQuerySchema,
    headers: MutationHeadersSchema,
    body: ZipBundleStreamSchema,
  }).readonly())
  .output(ViewBundleMutationResultSchema);

export const listViewBundlesContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/view-bundles`,
    operationId: "listViewBundles",
    summary: "List View bundle candidates for a document type",
    description: "Returns cursor-paginated View bundle summaries and their supported paired Document Contract revisions. Full manifests are available from the item GET operation.",
    inputStructure: "detailed",
    tags: ["View bundles"],
  })
  .input(z.object({ query: ListBundlesQuerySchema }).readonly())
  .output(ListViewBundlesResponseSchema);

export const getViewBundleContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/view-bundles/{viewBundleId}`,
    operationId: "getViewBundle",
    summary: "Read a View bundle candidate",
    description: "Returns one validated View bundle record with its immutable canonical bundle root URL, manifest data, administrator metadata, content size, and current ETag.",
    inputStructure: "detailed",
    tags: ["View bundles"],
  })
  .input(z.object({ params: viewBundleIdParams }).readonly())
  .output(ViewBundleRecordSchema);

export const updateViewBundleMetadataContract = conditionalMutationProcedure
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
  .output(ViewBundleMutationResultSchema);

export const createOperatorValidationContract = idempotentMutationProcedure.errors({
  OPERATOR_VALIDATION_FAILED: AdminApiErrorMap.OPERATOR_VALIDATION_FAILED,
})
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/operator-validations`,
    operationId: "createOperatorValidation",
    summary: "Validate an Operator endpoint",
    description: "Fetches Operator discovery and performs a signed, user-data-free probe without following redirects or allowing private-network targets. Success creates and returns a short-lived immutable validation record; failures are synchronous, create no validation record, and are captured only in audit.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: CreateOperatorValidationRequestSchema,
  }).readonly())
  .output(OperatorValidationSchema);

export const getOperatorValidationContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/operator-validations/{validationId}`,
    operationId: "getOperatorValidation",
    summary: "Read a current Operator validation",
    description: "Returns a successful, unexpired immutable Operator validation record and the discovery descriptor captured at `validatedAt`.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({ params: operatorValidationIdParams }).readonly())
  .output(OperatorValidationSchema);

export const createOperatorContract = idempotentMutationProcedure.errors({
  OPERATOR_VALIDATION_REQUIRED: AdminApiErrorMap.OPERATOR_VALIDATION_REQUIRED,
})
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/operators`,
    operationId: "createOperator",
    summary: "Persist a validated Operator",
    description: "Converts a current validation into a persistent Operator for one document type. The validated base URL and descriptor become immutable while the administrator name and description remain editable.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Operators"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: CreateOperatorRequestSchema,
  }).readonly())
  .output(OperatorMutationResultSchema);

export const listOperatorsContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/operators`,
    operationId: "listOperators",
    summary: "List Operators for a document type",
    description: "Returns cursor-paginated Operator summaries available for explicit binding to the requested document type. Full discovery descriptors are available from the item GET operation.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({ query: ListBundlesQuerySchema }).readonly())
  .output(ListOperatorsResponseSchema);

export const getOperatorContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/operators/{operatorId}`,
    operationId: "getOperator",
    summary: "Read an Operator",
    description: "Returns one persistent Operator with its immutable discovery descriptor, administrator metadata, and current ETag.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({ params: operatorIdParams }).readonly())
  .output(OperatorRecordSchema);

export const updateOperatorMetadataContract = conditionalMutationProcedure
  .route({
    method: "PATCH",
    path: `${AdminApiV1BasePath}/operators/{operatorId}`,
    operationId: "updateOperatorMetadata",
    summary: "Update Operator administrator metadata",
    description: "Changes only the administrator-visible name and description. The validated base URL and discovery descriptor remain unchanged, and `If-Match` enforces optimistic concurrency.",
    inputStructure: "detailed",
    tags: ["Operators"],
  })
  .input(z.object({
    params: operatorIdParams,
    headers: ConditionalMutationHeadersSchema,
    body: UpdateCandidateMetadataRequestSchema,
  }).readonly())
  .output(OperatorMutationResultSchema);

export const listDocumentTypesContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/document-types`,
    operationId: "listDocumentTypes",
    summary: "List registered document types",
    description: "Lists lightweight document type summaries with optional text and enabled-state filters. Full selected resources and the latest Document Contract are available from the item GET operation.",
    inputStructure: "detailed",
    tags: ["Document types"],
  })
  .input(z.object({ query: ListDocumentTypesQuerySchema.optional() }).readonly())
  .output(ListDocumentTypesResponseSchema);

export const getDocumentTypeContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/document-types/{documentType}`,
    operationId: "getDocumentType",
    summary: "Read a document type registration",
    description: "Returns the complete administrator view of a document type, including draft completeness, selected immutable candidates, enabled state, highest assigned Document Contract revision, and ETag.",
    inputStructure: "detailed",
    tags: ["Document types"],
  })
  .input(z.object({ params: documentTypeParams }).readonly())
  .output(DocumentTypeRegistrationSchema);

export const createDocumentTypeContract = idempotentMutationProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/document-types`,
    operationId: "createDocumentType",
    summary: "Create a disabled document type draft",
    description: "Creates a new disabled draft from an internal administrator name. A draft may remain incomplete; it cannot be enabled until a paired Document Contract and compatible Type Card, View, and Operator resources are available.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Document types"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: CreateDocumentTypeRequestSchema,
  }).readonly())
  .output(DocumentTypeMutationResultSchema);

export const updateDocumentTypeContract = conditionalMutationProcedure.errors({
  OPERATOR_VALIDATION_REQUIRED: AdminApiErrorMap.OPERATOR_VALIDATION_REQUIRED,
})
  .route({
    method: "PATCH",
    path: `${AdminApiV1BasePath}/document-types/{documentType}`,
    operationId: "updateDocumentType",
    summary: "Atomically update a document type registration",
    description: "Atomically changes the internal name, selected Type Card bundle, selected View bundle, selected Operator, or enabled state. `If-Match` protects the complete registration from lost updates, and enabling validates all required selections together.",
    inputStructure: "detailed",
    tags: ["Document types"],
  })
  .input(z.object({
    params: documentTypeParams,
    headers: ConditionalMutationHeadersSchema,
    body: UpdateDocumentTypeRequestSchema,
  }).readonly())
  .output(DocumentTypeMutationResultSchema);

export const listDocumentContractsContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/document-types/{documentType}/document-contracts`,
    operationId: "listDocumentContracts",
    summary: "List paired Document Contract revisions",
    description: "Returns lightweight immutable paired contract revisions and their hashes in a cursor-paginated list. Full schemas are available from the item GET operation. The highest index is informational and does not make older revisions read-only for new data.",
    inputStructure: "detailed",
    tags: ["Document Contracts"],
  })
  .input(z.object({
    params: documentTypeParams,
    query: PaginationQuerySchema.optional(),
  }).readonly())
  .output(ListDocumentContractsResponseSchema);

export const getDocumentContractContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/document-types/{documentType}/document-contracts/{documentContractIdx}`,
    operationId: "getDocumentContract",
    summary: "Read an immutable Document Contract revision",
    description: "Returns one paired revision, including its format version, snapshot and location schemas, derived media types, canonical schema hashes, contract hash, and creation time.",
    inputStructure: "detailed",
    tags: ["Document Contracts"],
  })
  .input(z.object({ params: documentContractParams }).readonly())
  .output(DocumentContractRecordSchema);

export const appendDocumentContractContract = resourceMutationProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/document-types/{documentType}/document-contracts`,
    operationId: "appendDocumentContract",
    summary: "Append a paired Document Contract revision",
    description: "Accepts one JSON object containing a shared format version plus snapshot and location schemas. Format version 1 derives the standard snapshot CBOR and location JSON media types; clients do not submit free-form content types. The Platform validates both schemas atomically, assigns the next index, and stores their individual canonical hashes plus the paired contract hash. Append is allowed while the document type is enabled, and every existing compatible revision remains available for new snapshots and locations.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Document Contracts"],
  })
  .input(z.object({
    params: documentTypeParams,
    headers: MutationHeadersSchema,
    body: AppendDocumentContractRequestSchema,
  }).readonly())
  .output(DocumentContractAppendResultSchema);

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

export const getAdministratorMemberContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/administrators/{adminId}`,
    operationId: "getAdministratorMember",
    summary: "Read an administrator member",
    description: "Returns one administrator membership with identity-binding status, provenance, and current ETag.",
    inputStructure: "detailed",
    tags: ["Members"],
  })
  .input(z.object({ params: administratorMemberParams }).readonly())
  .output(AdministratorMemberRecordSchema);

export const addAdministratorMemberContract = idempotentMutationProcedure.errors({
  ADMINISTRATOR_EXISTS: AdminApiErrorMap.ADMINISTRATOR_EXISTS,
})
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
  .output(AdministratorMemberMutationResultSchema);

export const removeAdministratorMemberContract = conditionalMutationProcedure.errors({
  CANNOT_REMOVE_SELF: AdminApiErrorMap.CANNOT_REMOVE_SELF,
  LAST_ADMINISTRATOR: AdminApiErrorMap.LAST_ADMINISTRATOR,
})
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

export const listTenantMembersContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/tenant-members`,
    operationId: "listTenantMembers",
    summary: "List tenant members",
    description: "Returns active tenant memberships, optionally for one tenant, with identity-binding status and current ETag.",
    inputStructure: "detailed",
    tags: ["Members"],
  })
  .input(z.object({ query: ListTenantMembersQuerySchema.optional() }).readonly())
  .output(ListTenantMembersResponseSchema);

export const addTenantMemberContract = idempotentMutationProcedure.errors({
  TENANT_MEMBER_EXISTS: AdminApiErrorMap.TENANT_MEMBER_EXISTS,
})
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/tenant-members`,
    operationId: "addTenantMember",
    summary: "Add a tenant member",
    description: "Adds a normalized Google account email to one tenant and generates its principal. The identity stays unbound until that account signs in to the tenant console. An email can be an active member of only one tenant.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Members"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: AddTenantMemberRequestSchema,
  }).readonly())
  .output(TenantMemberMutationResultSchema);

export const removeTenantMemberContract = conditionalMutationProcedure
  .route({
    method: "DELETE",
    path: `${AdminApiV1BasePath}/tenant-members/{memberId}`,
    operationId: "removeTenantMember",
    summary: "Remove a tenant member",
    description: "Deactivates one tenant membership under its current ETag and ends all of its sessions. The row is kept; adding the email again creates a new principal.",
    inputStructure: "detailed",
    successStatus: 204,
    tags: ["Members"],
  })
  .input(z.object({
    params: tenantMemberParams,
    headers: ConditionalMutationHeadersSchema,
  }).readonly())
  .output(z.undefined());

export const revokeTenantMemberSessionsContract = resourceMutationProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/tenant-members/{memberId}/session-revocations`,
    operationId: "revokeTenantMemberSessions",
    summary: "End every session of a tenant member",
    description: "Signs the member out on every device without removing the membership, for example when an account may be compromised.",
    inputStructure: "detailed",
    successStatus: 204,
    tags: ["Members"],
  })
  .input(z.object({
    params: tenantMemberParams,
    headers: MutationHeadersSchema,
  }).readonly())
  .output(z.undefined());

export const listAdminAuditEventsContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/audit-events`,
    operationId: "listAdminAuditEvents",
    summary: "List administrator audit events",
    description: "Returns immutable administrator control-plane audit events in reverse chronological order. Results may be filtered by actor, action, resource kind, related document type, and occurrence time.",
    inputStructure: "detailed",
    tags: ["Audit"],
  })
  .input(z.object({ query: ListAdminAuditEventsQuerySchema.optional() }).readonly())
  .output(ListAdminAuditEventsResponseSchema);

export const adminApiContract = {
  documentTypes: {
    list: listDocumentTypesContract,
    get: getDocumentTypeContract,
    create: createDocumentTypeContract,
    update: updateDocumentTypeContract,
    documentContracts: {
      list: listDocumentContractsContract,
      get: getDocumentContractContract,
      append: appendDocumentContractContract,
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
  operators: {
    create: createOperatorContract,
    list: listOperatorsContract,
    get: getOperatorContract,
    updateMetadata: updateOperatorMetadataContract,
  },
  members: {
    list: listAdministratorMembersContract,
    get: getAdministratorMemberContract,
    add: addAdministratorMemberContract,
    remove: removeAdministratorMemberContract,
  },
  tenantMembers: {
    list: listTenantMembersContract,
    add: addTenantMemberContract,
    remove: removeTenantMemberContract,
    revokeSessions: revokeTenantMemberSessionsContract,
  },
  audit: {
    list: listAdminAuditEventsContract,
  },
};

export type AdminApiContract = typeof adminApiContract;

export { AdministratorMemberAuditActions, DocumentTypeAuditActions, TenantMemberAuditActions };
export type {
  AdministratorMemberAuditAction,
  DocumentTypeAuditAction,
  TenantMemberAuditAction,
} from "./schemas.js";
