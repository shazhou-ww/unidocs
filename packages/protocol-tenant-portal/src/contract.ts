import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  AppendCommentRequestSchema,
  CasCapabilityGrantSchema,
  CommentRecordSchema,
  CreateDocumentRequestSchema,
  CreateThreadRequestSchema,
  DocumentContractIdxSchema,
  DocumentContractRecordSchema,
  DocumentRecordSchema,
  DocumentTypeSchema,
  IdempotentMutationHeadersSchema,
  IdSchema,
  ListDocumentAuditEventsResponseSchema,
  ListDocumentsQuerySchema,
  ListDocumentsResponseSchema,
  ListPublicDocumentTypesResponseSchema,
  ListThreadsQuerySchema,
  ListThreadsResponseSchema,
  ListVersionsResponseSchema,
  MoveCurrentVersionRequestSchema,
  MutationHeadersSchema,
  PaginationQuerySchema,
  SnapshotStreamSchema,
  TenantErrorDataSchema,
  ThreadDetailSchema,
  VersionIdxSchema,
  VersionRecordSchema,
} from "./schemas.js";

export const TenantApiV1BasePath = "/api/v1/tenants/{tenantId}";

export const TenantApiErrorMap = {
  INVALID_REQUEST: {
    status: 400,
    message: "The request is invalid",
    data: TenantErrorDataSchema,
  },
  UNAUTHORIZED: {
    status: 401,
    message: "User authentication is required",
    data: TenantErrorDataSchema,
  },
  FORBIDDEN: {
    status: 403,
    message: "The caller is not allowed to perform this operation",
    data: TenantErrorDataSchema,
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested resource was not found",
    data: TenantErrorDataSchema,
  },
  LIMIT_EXCEEDED: {
    status: 413,
    message: "A size or quota limit was exceeded",
    data: TenantErrorDataSchema,
  },
  LOCATION_CONTRACT_VIOLATION: {
    status: 422,
    message: "The location does not satisfy its Document Contract location schema",
    data: TenantErrorDataSchema,
  },
  DOCUMENT_TYPE_DISABLED: {
    status: 409,
    message: "The document type is not enabled for document creation",
    data: TenantErrorDataSchema,
  },
  VERSION_CONFLICT: {
    status: 409,
    message: "The observed current version does not match the current pointer",
    data: TenantErrorDataSchema,
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: "The idempotency key was used with a different request",
    data: TenantErrorDataSchema,
  },
  CONTENT_UNAVAILABLE: {
    status: 409,
    message: "The referenced content is not available",
    data: TenantErrorDataSchema,
  },
  UNAVAILABLE: {
    status: 503,
    message: "The Platform is temporarily unavailable",
    data: TenantErrorDataSchema,
  },
} as const;

const tenantProcedure = oc.errors({
  INVALID_REQUEST: TenantApiErrorMap.INVALID_REQUEST,
  UNAUTHORIZED: TenantApiErrorMap.UNAUTHORIZED,
  FORBIDDEN: TenantApiErrorMap.FORBIDDEN,
  UNAVAILABLE: TenantApiErrorMap.UNAVAILABLE,
});
const resourceReadProcedure = tenantProcedure.errors({
  NOT_FOUND: TenantApiErrorMap.NOT_FOUND,
});
const idempotentMutationProcedure = tenantProcedure.errors({
  IDEMPOTENCY_CONFLICT: TenantApiErrorMap.IDEMPOTENCY_CONFLICT,
});
const messageMutationProcedure = idempotentMutationProcedure.errors({
  NOT_FOUND: TenantApiErrorMap.NOT_FOUND,
  LOCATION_CONTRACT_VIOLATION: TenantApiErrorMap.LOCATION_CONTRACT_VIOLATION,
  LIMIT_EXCEEDED: TenantApiErrorMap.LIMIT_EXCEEDED,
  CONTENT_UNAVAILABLE: TenantApiErrorMap.CONTENT_UNAVAILABLE,
});

const TenantParamsObjectSchema = z.object({
  tenantId: IdSchema.describe("Tenant that owns the addressed resources."),
});
const DocumentParamsObjectSchema = TenantParamsObjectSchema.extend({
  documentId: IdSchema.describe("Document within the tenant."),
});

const tenantParams = TenantParamsObjectSchema.readonly();
const documentParams = DocumentParamsObjectSchema.readonly();
const documentContractParams = TenantParamsObjectSchema.extend({
  documentType: DocumentTypeSchema,
  documentContractIdx: DocumentContractIdxSchema,
}).readonly();
const versionParams = DocumentParamsObjectSchema.extend({
  versionIdx: VersionIdxSchema,
}).readonly();
const threadParams = DocumentParamsObjectSchema.extend({
  threadId: IdSchema.describe("Thread within the document."),
}).readonly();

export const listPublicDocumentTypesContract = tenantProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/document-types`,
    operationId: "listPublicDocumentTypes",
    summary: "List document types available for creation",
    description: "Returns the cursor-paginated catalog of enabled document types. Every entry has a current Type Card bundle, a current View bundle, and a non-empty set of contract revisions the View and built-in Operator both support. Type Card asset paths are already resolved to absolute bundle-origin URLs; the caller performs RFC 4647 locale lookup over `typeCard.locales` and finally falls back to `en`.",
    inputStructure: "detailed",
    tags: ["Document types"],
  })
  .input(z.object({
    params: tenantParams,
    query: PaginationQuerySchema.optional(),
  }).readonly())
  .output(ListPublicDocumentTypesResponseSchema);

export const getDocumentContractContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/document-types/{documentType}/document-contracts/{documentContractIdx}`,
    operationId: "getDocumentContract",
    summary: "Read one paired Document Contract revision",
    description: "Returns the immutable revision that validates a given snapshot and its locations, including both schemas, their canonical hashes, and the derived snapshot and location media types. The highest index is not privileged; any revision named by a version or location can be read.",
    inputStructure: "detailed",
    tags: ["Document types"],
  })
  .input(z.object({ params: documentContractParams }).readonly())
  .output(DocumentContractRecordSchema);

export const listDocumentsContract = tenantProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/documents`,
    operationId: "listDocuments",
    summary: "List documents visible to the caller",
    description: "Returns cursor-paginated documents, optionally restricted to one document type. A document whose `currentVersionIdx` is null has not been initialized by its Operator yet and cannot be opened.",
    inputStructure: "detailed",
    tags: ["Documents"],
  })
  .input(z.object({
    params: tenantParams,
    query: ListDocumentsQuerySchema.optional(),
  }).readonly())
  .output(ListDocumentsResponseSchema);

export const createDocumentContract = idempotentMutationProcedure.errors({
  DOCUMENT_TYPE_DISABLED: TenantApiErrorMap.DOCUMENT_TYPE_DISABLED,
  LIMIT_EXCEEDED: TenantApiErrorMap.LIMIT_EXCEEDED,
})
  .route({
    method: "POST",
    path: `${TenantApiV1BasePath}/documents`,
    operationId: "createDocument",
    summary: "Create a document",
    description: "Atomically creates a named document with `currentVersionIdx = null`, then notifies the built-in Operator with `document.created`. No thread or comment is created. The document becomes openable once the Operator commits its first snapshot. Replaying the same idempotency key returns the original `201` result instead of creating a second document.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Documents"],
  })
  .input(z.object({
    params: tenantParams,
    headers: IdempotentMutationHeadersSchema,
    body: CreateDocumentRequestSchema,
  }).readonly())
  .output(DocumentRecordSchema);

export const getDocumentContractOperation = resourceReadProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/documents/{documentId}`,
    operationId: "getDocument",
    summary: "Read a document and its current pointer",
    description: "Returns document identity, name, document type, and the current version pointer. This is the starting point for both the Web Host and an Agent: read `currentVersionIdx`, then query the exact version and open threads.",
    inputStructure: "detailed",
    tags: ["Documents"],
  })
  .input(z.object({ params: documentParams }).readonly())
  .output(DocumentRecordSchema);

export const moveCurrentVersionContract = resourceReadProcedure.errors({
  VERSION_CONFLICT: TenantApiErrorMap.VERSION_CONFLICT,
})
  .route({
    method: "POST",
    path: `${TenantApiV1BasePath}/documents/{documentId}/current-version`,
    operationId: "moveCurrentVersion",
    summary: "Move the current version pointer",
    description: "Points current at an existing version under an equality lock: `observedCurrentVersionIdx` must equal the pointer at commit, otherwise the operation returns `409` with the current value in error details. The move writes a document audit event in the same transaction and notifies the Operator with `current_version.moved`. It needs no idempotency key, because the equality lock already makes a retry safe.",
    inputStructure: "detailed",
    tags: ["Documents"],
  })
  .input(z.object({
    params: documentParams,
    headers: MutationHeadersSchema,
    body: MoveCurrentVersionRequestSchema,
  }).readonly())
  .output(DocumentRecordSchema);

export const listDocumentAuditEventsContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/documents/{documentId}/audit`,
    operationId: "listDocumentAuditEvents",
    summary: "List document audit events",
    description: "Returns immutable document-level audit events in reverse chronological order. Moving the current pointer is auditable because it changes the base of later versions, the resolution of indirect references, and the optimistic-locking baseline for Agent submissions.",
    inputStructure: "detailed",
    tags: ["Audit"],
  })
  .input(z.object({
    params: documentParams,
    query: PaginationQuerySchema.optional(),
  }).readonly())
  .output(ListDocumentAuditEventsResponseSchema);

export const listVersionsContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/documents/{documentId}/versions`,
    operationId: "listVersions",
    summary: "List version metadata in birth order",
    description: "Returns cursor-paginated version metadata without snapshots, which is what a version history panel needs: `parentVersionIdx` draws the base parent forest, and `addressedComments` draws the comment provenance graph. Snapshot bytes are read separately, one version at a time.",
    inputStructure: "detailed",
    tags: ["Versions"],
  })
  .input(z.object({
    params: documentParams,
    query: PaginationQuerySchema.optional(),
  }).readonly())
  .output(ListVersionsResponseSchema);

export const getVersionContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/documents/{documentId}/versions/{versionIdx}`,
    operationId: "getVersion",
    summary: "Read one version's metadata",
    description: "Returns one immutable version record: its parent, the paired contract revision validating it, the committing Agent and submission, and its comment provenance. The snapshot is not embedded, because an SValue carries atomic SBlob references that have no JSON representation.",
    inputStructure: "detailed",
    tags: ["Versions"],
  })
  .input(z.object({ params: versionParams }).readonly())
  .output(VersionRecordSchema);

export const getVersionSnapshotContract = resourceReadProcedure.errors({
  CONTENT_UNAVAILABLE: TenantApiErrorMap.CONTENT_UNAVAILABLE,
})
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/documents/{documentId}/versions/{versionIdx}/snapshot`,
    operationId: "getVersionSnapshot",
    summary: "Read one version's snapshot",
    description: "Returns the canonical SValue CBOR encoding of the version snapshot as `application/vnd.unidocs.{documentType}.snapshot+cbor;version=1`, the media type recorded on the version's Document Contract revision. Large binary values inside the SValue stay as SBlob references; the caller reads those from UniCAS with a tenant capability.",
    inputStructure: "detailed",
    tags: ["Versions"],
  })
  .input(z.object({ params: versionParams }).readonly())
  .output(SnapshotStreamSchema);

export const listThreadsContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/documents/{documentId}/threads`,
    operationId: "listThreads",
    summary: "List thread identities",
    description: "Returns cursor-paginated thread references only. `open` is derived server-side by the same rule the caller would use, `latestCommentIdx > acknowledgedCommentIdx`; it is not a stored, togglable flag, so there is no resolve or reopen operation anywhere in this API. Full comment and reply sequences come from the item GET operation.",
    inputStructure: "detailed",
    tags: ["Threads"],
  })
  .input(z.object({
    params: documentParams,
    query: ListThreadsQuerySchema.optional(),
  }).readonly())
  .output(ListThreadsResponseSchema);

export const createThreadContract = messageMutationProcedure
  .route({
    method: "POST",
    path: `${TenantApiV1BasePath}/documents/{documentId}/threads`,
    operationId: "createThread",
    summary: "Create a thread with its first comment",
    description: "Creates a position-anchored thread containing one comment. `baseVersionIdx` must name an existing version of this document, and any location is relative to that version and must carry its `documentContractIdx` and pass that revision's location schema. A comment does not have to be based on current; the Operator decides whether an older comment still applies.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Threads"],
  })
  .input(z.object({
    params: documentParams,
    headers: IdempotentMutationHeadersSchema,
    body: CreateThreadRequestSchema,
  }).readonly())
  .output(ThreadDetailSchema);

export const getThreadContract = resourceReadProcedure
  .route({
    method: "GET",
    path: `${TenantApiV1BasePath}/documents/{documentId}/threads/{threadId}`,
    operationId: "getThread",
    summary: "Read both message sequences of a thread",
    description: "Returns the complete append-only comment and reply sequences. One reply acknowledges every comment through `respondThroughCommentIdx`, so the thread's open state and each comment's handled state are computed from these two sequences rather than stored.",
    inputStructure: "detailed",
    tags: ["Threads"],
  })
  .input(z.object({ params: threadParams }).readonly())
  .output(ThreadDetailSchema);

export const appendCommentContract = messageMutationProcedure
  .route({
    method: "POST",
    path: `${TenantApiV1BasePath}/documents/{documentId}/threads/{threadId}/comments`,
    operationId: "appendComment",
    summary: "Append a comment to a thread",
    description: "Appends one user message to an existing thread and returns the stored record with its assigned `commentIdx`. Appending past the reply watermark re-opens the thread, which is the only way a discussion is reopened. Comments are immutable: there is no edit, delete, or withdraw operation, so a correction is a new comment on the same thread.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Threads"],
  })
  .input(z.object({
    params: threadParams,
    headers: IdempotentMutationHeadersSchema,
    body: AppendCommentRequestSchema,
  }).readonly())
  .output(CommentRecordSchema);

export const issueCasCapabilityContract = tenantProcedure
  .route({
    method: "POST",
    path: `${TenantApiV1BasePath}/cas-capabilities`,
    operationId: "issueCasCapability",
    summary: "Issue a short-lived direct-UniCAS capability",
    description: "Returns connection details and a short-lived tenant JWT with `cas:read` and `cas:write` only. The Platform does not proxy CAS node traffic; the caller builds a tenant blob client and reads or writes UniCAS directly. The token is not a Platform API credential, is held in caller memory only, and is never passed into a sandboxed View iframe, which uses Host RPC instead.",
    inputStructure: "detailed",
    tags: ["CAS"],
  })
  .input(z.object({
    params: tenantParams,
    headers: MutationHeadersSchema,
  }).readonly())
  .output(CasCapabilityGrantSchema);

export const tenantApiContract = {
  documentTypes: {
    list: listPublicDocumentTypesContract,
    getDocumentContract: getDocumentContractContract,
  },
  documents: {
    list: listDocumentsContract,
    create: createDocumentContract,
    get: getDocumentContractOperation,
    moveCurrentVersion: moveCurrentVersionContract,
    listAudit: listDocumentAuditEventsContract,
  },
  versions: {
    list: listVersionsContract,
    get: getVersionContract,
    getSnapshot: getVersionSnapshotContract,
  },
  threads: {
    list: listThreadsContract,
    create: createThreadContract,
    get: getThreadContract,
    appendComment: appendCommentContract,
  },
  cas: {
    issueCapability: issueCasCapabilityContract,
  },
};

export type TenantApiContract = typeof tenantApiContract;
