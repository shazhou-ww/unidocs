import { JSON_SCHEMA_OUTPUT_REGISTRY } from "@orpc/zod/zod4";
import {
  DocumentContentFormatVersion,
  DocumentTypePattern,
  SValueSchemaDialect,
  documentLocationContentType,
  documentSnapshotContentType,
  type JsonValue,
} from "@unidocs/protocol";
import { z } from "zod";

export const NonEmptyStringSchema = z.string().min(1);
export const IdSchema = NonEmptyStringSchema;
export const DocumentTypeSchema = z.string().regex(DocumentTypePattern)
  .describe("MIME-safe document type identifier.");
export const CursorSchema = NonEmptyStringSchema;
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * Every wire field named `*Idx` is a zero-based, monotonically increasing safe
 * integer within its documented scope. `null`, never 0, means "no record yet".
 */
const RecordIdxSchema = z.number().int().nonnegative();
export const DocumentContractIdxSchema = RecordIdxSchema
  .describe("Zero-based paired Document Contract revision within one document type.");
export const VersionIdxSchema = RecordIdxSchema
  .describe("Zero-based version record identity within one document.");
export const CommentIdxSchema = RecordIdxSchema
  .describe("Zero-based comment record identity within one thread.");
export const ReplyIdxSchema = RecordIdxSchema
  .describe("Zero-based reply record identity within one thread.");

export const TypeCardIconRasterSizeSchema = z.union([
  z.literal(16),
  z.literal(32),
  z.literal(64),
  z.literal(128),
  z.literal(256),
]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

function containsBlobMaxSizeKeyword(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsBlobMaxSizeKeyword);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    key === "x-unidocs-blob-max-size" || containsBlobMaxSizeKeyword(child)
  );
}

export const SValueSchemaSchema = z.object({
  $schema: z.literal(SValueSchemaDialect)
    .describe("UniDocs SValue JSON Schema dialect identifier."),
  "x-unidocs-sblob": z.literal(true).optional()
    .describe("When true, this schema node matches an atomic SBlob reference."),
  "x-unidocs-blob-content-types": z.array(NonEmptyStringSchema).readonly().optional()
    .describe("Allowed media types for an SBlob matched at this schema node."),
}).catchall(JsonValueSchema).superRefine((schema, context) => {
  if (containsBlobMaxSizeKeyword(schema)) {
    context.addIssue({
      code: "custom",
      message: "SBlob size limits are enforced by UniCAS and cannot be declared in SValue schemas",
    });
  }
}).readonly().meta({ id: "SValueSchema" });

export type SValueSchema = z.infer<typeof SValueSchemaSchema>;

export const TenantErrorDataSchema = z.object({
  requestId: NonEmptyStringSchema,
  details: JsonValueSchema.optional(),
}).readonly().meta({ id: "TenantErrorData" });

export type TenantErrorData = z.infer<typeof TenantErrorDataSchema>;

export const TenantApiErrorSchema = z.object({
  error: z.object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    requestId: NonEmptyStringSchema,
    details: JsonValueSchema.optional(),
  }).readonly(),
}).readonly().meta({ id: "TenantApiError" });

export type TenantApiError = z.infer<typeof TenantApiErrorSchema>;

/**
 * Logical blob identity. `blobHash` is a blob root that may resolve to a
 * blob-index tree; `size` and `contentType` describe the complete logical blob,
 * never one internal chunk.
 */
export const CasBlobRefSchema = z.object({
  blobHash: NonEmptyStringSchema.describe("UniCAS blob root hash."),
  size: z.number().int().nonnegative().describe("Logical byte length of the complete blob."),
  contentType: NonEmptyStringSchema.describe("Media type of the complete logical blob."),
}).readonly().meta({ id: "CasBlobRef" });

export type CasBlobRef = z.infer<typeof CasBlobRefSchema>;

/**
 * A position inside one version. The owning record or request supplies the
 * version; the location only repeats the contract revision used to validate it.
 */
export const DocumentLocationSchema = z.object({
  documentContractIdx: DocumentContractIdxSchema
    .describe("Paired contract revision whose location schema validates this payload."),
  locationType: NonEmptyStringSchema
    .describe("Document-type-specific location kind, for example unidocs.markdown.text-range/v1."),
  payload: JsonValueSchema.describe("Opaque location payload validated by the location schema."),
}).readonly().meta({ id: "DocumentLocation" });

export type DocumentLocation = z.infer<typeof DocumentLocationSchema>;

export const MessageContentSchema = z.object({
  text: z.string().nullable().describe("Plain-text message body, or null."),
  richContent: CasBlobRefSchema.nullable().describe("Rich message body stored in UniCAS, or null."),
  attachments: z.array(CasBlobRefSchema).readonly().describe("Attachments; they never replace the body."),
}).refine(
  ({ text, richContent }) => (text !== null && text.length > 0) || richContent !== null,
  { message: "At least one of text or richContent must be present" },
).readonly().meta({ id: "MessageContent" });

export type MessageContent = z.infer<typeof MessageContentSchema>;

const DocumentContractRecordObjectSchema = z.object({
  documentType: DocumentTypeSchema.describe("Document type owning this revision."),
  documentContractIdx: DocumentContractIdxSchema.describe("Assigned paired contract revision."),
  formatVersion: z.literal(DocumentContentFormatVersion)
    .describe("Wire encoding version; it is independent from the schema revision."),
  snapshot: z.object({
    contentType: NonEmptyStringSchema.describe("Snapshot media type derived from documentType and formatVersion."),
    schema: SValueSchemaSchema.describe("Schema validating the document SValue."),
    schemaHash: NonEmptyStringSchema.describe("Canonical digest of the snapshot schema."),
  }).readonly(),
  location: z.object({
    contentType: NonEmptyStringSchema.describe("Location media type derived from documentType and formatVersion."),
    schema: SValueSchemaSchema.describe("Schema validating the locationType and payload projection."),
    schemaHash: NonEmptyStringSchema.describe("Canonical digest of the location schema."),
  }).readonly(),
  contractHash: NonEmptyStringSchema.describe("Digest of the canonical paired contract."),
  createdAt: IsoDateTimeSchema.describe("Time at which the revision was appended."),
});

export const DocumentContractRecordSchema = DocumentContractRecordObjectSchema
  .superRefine((record, context) => {
    if (record.snapshot.contentType !== documentSnapshotContentType(record.documentType)) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "contentType"],
        message: "Snapshot content type does not match documentType",
      });
    }
    if (record.location.contentType !== documentLocationContentType(record.documentType)) {
      context.addIssue({
        code: "custom",
        path: ["location", "contentType"],
        message: "Location content type does not match documentType",
      });
    }
  }).readonly().meta({ id: "DocumentContractRecord" });

export type DocumentContractRecord = z.infer<typeof DocumentContractRecordSchema>;

export const PublicTypeCardLocaleSchema = z.object({
  name: NonEmptyStringSchema.describe("Localized document type display name."),
  description: z.string().describe("Localized document type description."),
  sampleThumbnailAlt: NonEmptyStringSchema
    .describe("Localized accessible text for the sample thumbnail."),
}).readonly().meta({ id: "PublicTypeCardLocale" });

export type PublicTypeCardLocale = z.infer<typeof PublicTypeCardLocaleSchema>;

export const PublicTypeCardIconSvgSchema = z.object({
  kind: z.literal("svg"),
  url: z.url().describe("Absolute bundle-origin URL of the size-independent SVG icon."),
}).readonly();

export type PublicTypeCardIconSvg = z.infer<typeof PublicTypeCardIconSvgSchema>;

export const PublicTypeCardIconPngSchema = z.object({
  kind: z.literal("png"),
  imageUrls: z.object({
    16: z.url(),
    32: z.url(),
    64: z.url(),
    128: z.url(),
    256: z.url(),
  }).readonly().describe("Absolute bundle-origin PNG URLs for every required raster size."),
}).readonly();

export type PublicTypeCardIconPng = z.infer<typeof PublicTypeCardIconPngSchema>;

export const PublicTypeCardIconSchema = z.discriminatedUnion("kind", [
  PublicTypeCardIconSvgSchema,
  PublicTypeCardIconPngSchema,
]);

export type PublicTypeCardIcon = z.infer<typeof PublicTypeCardIconSchema>;

/**
 * The Platform projection of the current Type Card manifest: locale copy is
 * preserved, and every asset path is resolved to an absolute bundle-origin URL.
 */
export const PublicTypeCardSchema = z.object({
  locales: z.record(NonEmptyStringSchema, PublicTypeCardLocaleSchema).refine(
    (locales) => locales.en !== undefined,
    { message: "Type Card locales must include en" },
  ).describe("Localized card content keyed by BCP 47 tag; the `en` fallback is required."),
  icon: PublicTypeCardIconSchema.describe("SVG or complete predefined-size PNG icon set."),
  sampleThumbnailUrl: z.url().describe("Absolute bundle-origin URL of the sample thumbnail."),
}).readonly().meta({ id: "PublicTypeCard" });

export type PublicTypeCard = z.infer<typeof PublicTypeCardSchema>;

export const PublicDocumentTypeSchema = z.object({
  documentType: DocumentTypeSchema.describe("Stable document type identifier."),
  typeCardBundleId: IdSchema.describe("Currently selected Type Card bundle identity."),
  typeCard: PublicTypeCardSchema.describe("User-facing creation card projected from the current manifest."),
  viewBundleId: IdSchema.describe("Currently selected View bundle identity."),
  availableDocumentContractIdxs: z.array(DocumentContractIdxSchema).min(1).readonly()
    .describe("Revisions the current View and built-in Operator both support; not chosen by index order."),
}).readonly().meta({ id: "PublicDocumentType" });

export type PublicDocumentType = z.infer<typeof PublicDocumentTypeSchema>;

export const DocumentRecordSchema = z.object({
  documentId: IdSchema.describe("Stable document identity within the tenant."),
  name: NonEmptyStringSchema.describe("User-visible document name."),
  documentType: DocumentTypeSchema.describe("Document type of every version in this document."),
  currentVersionIdx: VersionIdxSchema.nullable()
    .describe("Current pointer, or null until the Operator commits the first version."),
  createdAt: IsoDateTimeSchema.describe("Time at which the document was created."),
}).readonly().meta({ id: "DocumentRecord" });

export type DocumentRecord = z.infer<typeof DocumentRecordSchema>;

/**
 * One comment provenance edge: a comment that the owning version responded to, and
 * the version that comment was written against.
 */
export const AddressedCommentSchema = z.object({
  threadId: IdSchema.describe("Thread containing the addressed comment."),
  commentIdx: CommentIdxSchema.describe("Addressed comment within that thread."),
  baseVersionIdx: VersionIdxSchema.describe("Version the addressed comment was written against."),
}).readonly().meta({ id: "AddressedComment" });

export type AddressedComment = z.infer<typeof AddressedCommentSchema>;

/**
 * Version metadata. The snapshot itself is canonical SValue CBOR and is read
 * from the dedicated snapshot operation, because SValue carries atomic SBlob
 * references that have no JSON representation.
 *
 * `parentVersionIdx` records the current pointer observed at commit and is not
 * necessarily `versionIdx - 1`; `addressedComments` is the comment provenance edge
 * set, which is a different graph from the base parent forest.
 */
export const VersionRecordSchema = z.object({
  versionIdx: VersionIdxSchema.describe("Version identity and birth order within the document."),
  parentVersionIdx: VersionIdxSchema.nullable()
    .describe("Current pointer observed at commit; null only for the first version."),
  documentContractIdx: DocumentContractIdxSchema
    .describe("Paired revision validating this snapshot and its result locations."),
  authorAgentId: NonEmptyStringSchema.describe("Agent identity that committed this version."),
  submissionId: IdSchema.describe("Submission that atomically created this version and its replies."),
  addressedComments: z.array(AddressedCommentSchema).readonly()
    .describe("Comment provenance: comments this version responded to; empty for the first version."),
  createdAt: IsoDateTimeSchema.describe("Time at which the version was committed."),
}).readonly().meta({ id: "VersionRecord" });

export type VersionRecord = z.infer<typeof VersionRecordSchema>;

export const CommentRecordSchema = z.object({
  commentIdx: CommentIdxSchema.describe("Comment identity within its thread."),
  baseVersionIdx: VersionIdxSchema.describe("Version this comment was written against."),
  content: MessageContentSchema.describe("User message body and attachments."),
  location: DocumentLocationSchema.nullable()
    .describe("Anchor relative to baseVersionIdx, or null for a document-level comment."),
  authorId: IdSchema.describe("User principal that wrote the comment."),
  createdAt: IsoDateTimeSchema.describe("Time at which the comment was appended."),
}).readonly().meta({ id: "CommentRecord" });

export type CommentRecord = z.infer<typeof CommentRecordSchema>;

export const ReplyRecordSchema = z.object({
  replyIdx: ReplyIdxSchema.describe("Reply identity within its thread."),
  respondThroughCommentIdx: CommentIdxSchema
    .describe("Cumulative acknowledgement watermark: this reply answers every comment through this index, so one reply commonly covers several comments."),
  content: MessageContentSchema.describe("Agent message body and attachments."),
  resultLocations: z.array(DocumentLocationSchema).readonly()
    .describe("Locations in the version created by the same submission; empty for a pure reply."),
  authorAgentId: NonEmptyStringSchema.describe("Agent identity that produced the reply."),
  submissionId: IdSchema.describe("Submission that committed this reply."),
  createdAt: IsoDateTimeSchema.describe("Time at which the reply was committed."),
}).readonly().meta({ id: "ReplyRecord" });

export type ReplyRecord = z.infer<typeof ReplyRecordSchema>;

export const ThreadRefSchema = z.object({
  threadId: IdSchema.describe("Stable thread identity."),
}).readonly().meta({ id: "ThreadRef" });

export type ThreadRef = z.infer<typeof ThreadRefSchema>;

/**
 * Both message sequences of one thread. `open` is derived as
 * `latestCommentIdx > acknowledgedCommentIdx` and is never a stored flag, so the
 * detail carries no resolved state of its own.
 */
export const ThreadDetailSchema = z.object({
  threadId: IdSchema.describe("Stable thread identity."),
  comments: z.array(CommentRecordSchema).readonly().describe("Append-only user comment sequence."),
  replies: z.array(ReplyRecordSchema).readonly().describe("Append-only Agent reply sequence; each reply acknowledges a run of comments rather than exactly one."),
}).readonly().meta({ id: "ThreadDetail" });

export type ThreadDetail = z.infer<typeof ThreadDetailSchema>;

export const DocumentAuditActions = [
  "document.created",
  "current_version.moved",
] as const;

export const DocumentAuditActionSchema = z.enum(DocumentAuditActions);

export type DocumentAuditAction = typeof DocumentAuditActions[number];

export const DocumentAuditEventSchema = z.object({
  auditEventId: IdSchema.describe("Stable audit event identity."),
  actorId: IdSchema.describe("Principal that initiated the operation."),
  action: DocumentAuditActionSchema.describe("Stable machine-readable audit action."),
  beforeVersionIdx: VersionIdxSchema.nullable()
    .describe("Current pointer before the event, or null when there was none."),
  afterVersionIdx: VersionIdxSchema.nullable()
    .describe("Current pointer after the event, or null when there is none."),
  reason: z.string().nullable().describe("Actor-supplied reason, when the action requires one."),
  requestId: NonEmptyStringSchema.describe("Correlation identity for the originating request."),
  occurredAt: IsoDateTimeSchema.describe("Time at which the event occurred."),
}).readonly().meta({ id: "DocumentAuditEvent" });

export type DocumentAuditEvent = z.infer<typeof DocumentAuditEventSchema>;

/**
 * Short-lived direct-UniCAS capability. The token stays in caller memory only:
 * never localStorage, a URL, a log, or the sandboxed View iframe.
 */
export const CasCapabilityGrantSchema = z.object({
  baseUrl: z.url().describe("UniCAS tenant data-plane base URL."),
  stackId: NonEmptyStringSchema.describe("UniCAS stack identity."),
  tenantId: IdSchema.describe("Tenant the capability is scoped to."),
  accessToken: NonEmptyStringSchema.describe("Short-lived tenant JWT; it is not a Platform API credential."),
  expiresAt: z.number().int().positive().describe("Expiry as a Unix timestamp in seconds."),
  permissions: z.tuple([z.literal("cas:read"), z.literal("cas:write")]).readonly()
    .describe("Tenant-scoped permissions; never cas:manage or refDomain."),
}).readonly().meta({ id: "CasCapabilityGrant" });

export type CasCapabilityGrant = z.infer<typeof CasCapabilityGrantSchema>;

export const CreateDocumentRequestSchema = z.object({
  documentType: DocumentTypeSchema.describe("Enabled document type to create."),
  name: NonEmptyStringSchema.describe("User-visible document name."),
}).readonly().meta({ id: "CreateDocumentRequest" });

export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

export const MoveCurrentVersionRequestSchema = z.object({
  observedCurrentVersionIdx: VersionIdxSchema.nullable()
    .describe("Equality lock: must equal the current pointer at commit; null means no version yet."),
  targetVersionIdx: VersionIdxSchema.describe("Version to point current at."),
  reason: NonEmptyStringSchema.describe("Audit reason recorded with the move."),
}).readonly().meta({ id: "MoveCurrentVersionRequest" });

export type MoveCurrentVersionRequest = z.infer<typeof MoveCurrentVersionRequestSchema>;

export const CreateThreadRequestSchema = z.object({
  baseVersionIdx: VersionIdxSchema.describe("Existing version the first comment is written against."),
  content: MessageContentSchema.describe("First comment body and attachments."),
  location: DocumentLocationSchema.nullable()
    .describe("Anchor relative to baseVersionIdx, or null for a document-level thread."),
}).readonly().meta({ id: "CreateThreadRequest" });

export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

export const AppendCommentRequestSchema = z.object({
  baseVersionIdx: VersionIdxSchema.describe("Existing version this comment is written against."),
  content: MessageContentSchema.describe("Comment body and attachments."),
  location: DocumentLocationSchema.nullable()
    .describe("Anchor relative to baseVersionIdx, or null for a document-level comment."),
}).readonly().meta({ id: "AppendCommentRequest" });

export type AppendCommentRequest = z.infer<typeof AppendCommentRequestSchema>;

export const PaginationQuerySchema = z.object({
  cursor: CursorSchema.optional().describe("Opaque cursor returned by the previous page."),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Maximum number of records to return, from 1 through 100."),
}).readonly();

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const ListDocumentsQuerySchema = PaginationQuerySchema.unwrap().extend({
  documentType: DocumentTypeSchema.optional().describe("Restrict results to one document type."),
}).readonly();

export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

export const ListThreadsQuerySchema = PaginationQuerySchema.unwrap().extend({
  open: z.boolean().optional()
    .describe("Filter by derived open state: latest comment beyond the reply watermark."),
  versionIdx: VersionIdxSchema.optional()
    .describe("Restrict to threads whose comments are anchored to this version."),
}).readonly();

export type ListThreadsQuery = z.infer<typeof ListThreadsQuerySchema>;

const CsrfHeaderSchema = NonEmptyStringSchema.optional()
  .describe("Required for session-cookie authentication; omit when authenticating with a Bearer token.");

/** Mutations that only need CSRF protection, because they are already idempotent. */
export const MutationHeadersSchema = z.object({
  "x-csrf-token": CsrfHeaderSchema,
}).readonly();

/** Creation mutations, where a retry would otherwise create a second record. */
export const IdempotentMutationHeadersSchema = z.object({
  "x-csrf-token": CsrfHeaderSchema,
  "idempotency-key": NonEmptyStringSchema
    .describe("Retry identity; reusing a key with a different request is a conflict."),
}).readonly();

function pageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema).readonly(),
    nextCursor: CursorSchema.nullable(),
  }).readonly();
}

export const ListPublicDocumentTypesResponseSchema = pageSchema(PublicDocumentTypeSchema)
  .meta({ id: "ListPublicDocumentTypesResponse" });
export const ListDocumentsResponseSchema = pageSchema(DocumentRecordSchema)
  .meta({ id: "ListDocumentsResponse" });
export const ListVersionsResponseSchema = pageSchema(VersionRecordSchema)
  .meta({ id: "ListVersionsResponse" });
export const ListThreadsResponseSchema = pageSchema(ThreadRefSchema)
  .meta({ id: "ListThreadsResponse" });
export const ListDocumentAuditEventsResponseSchema = pageSchema(DocumentAuditEventSchema)
  .meta({ id: "ListDocumentAuditEventsResponse" });

export type ListPublicDocumentTypesResponse = z.infer<typeof ListPublicDocumentTypesResponseSchema>;
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponseSchema>;
export type ListVersionsResponse = z.infer<typeof ListVersionsResponseSchema>;
export type ListThreadsResponse = z.infer<typeof ListThreadsResponseSchema>;
export type ListDocumentAuditEventsResponse = z.infer<
  typeof ListDocumentAuditEventsResponseSchema
>;

/**
 * A version snapshot on the wire: canonical SValue CBOR bytes.
 *
 * The concrete response `Content-Type` is the document-type-specific
 * `application/vnd.unidocs.{documentType}.snapshot+cbor;version=1` recorded on
 * the version's Document Contract revision, so the schema documents the generic
 * CBOR encoding and the operation documents the exact vendor media type.
 */
export const SnapshotStreamSchema = z.instanceof(ReadableStream<Uint8Array>);

JSON_SCHEMA_OUTPUT_REGISTRY.add(SnapshotStreamSchema, {
  type: "string",
  contentMediaType: "application/cbor",
  contentEncoding: "binary",
});
