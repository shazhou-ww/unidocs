import { JSON_SCHEMA_INPUT_REGISTRY } from "@orpc/zod/zod4";
import { SValueSchemaDialect, type JsonValue } from "@unidocs/protocol";
import { z } from "zod";

export const NonEmptyStringSchema = z.string().min(1);
export const IdSchema = NonEmptyStringSchema;
export const EtagSchema = NonEmptyStringSchema;
export const CursorSchema = NonEmptyStringSchema;
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const SnapshotContractIdxSchema = z.number().int().positive();
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

export const SValueSchemaSchema = z.object({
  $schema: z.literal(SValueSchemaDialect)
    .describe("UniDocs SValue JSON Schema dialect identifier."),
  "x-unidocs-sblob": z.literal(true).optional()
    .describe("When true, this schema node matches an atomic SBlob reference."),
  "x-unidocs-blob-content-types": z.array(NonEmptyStringSchema).readonly().optional()
    .describe("Allowed media types for an SBlob matched at this schema node."),
  "x-unidocs-blob-max-size": z.number().int().nonnegative().optional()
    .describe("Maximum logical SBlob size in bytes at this schema node."),
}).catchall(JsonValueSchema).readonly().meta({ id: "SValueSchema" });

export type SValueSchema = z.infer<typeof SValueSchemaSchema>;

export const AdminErrorDataSchema = z.object({
  requestId: NonEmptyStringSchema,
  details: JsonValueSchema.optional(),
}).readonly().meta({ id: "AdminErrorData" });

export type AdminErrorData = z.infer<typeof AdminErrorDataSchema>;

export const AdminApiErrorSchema = z.object({
  error: z.object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    requestId: NonEmptyStringSchema,
    details: JsonValueSchema.optional(),
  }).readonly(),
}).readonly().meta({ id: "AdminApiError" });

export type AdminApiError = z.infer<typeof AdminApiErrorSchema>;

export const ViewBundleManifestV1Schema = z.object({
  protocol: z.literal("unidocs-view-bundle/v1").describe("View bundle manifest protocol."),
  documentType: NonEmptyStringSchema.describe("Document type implemented by this View."),
  entrypoint: NonEmptyStringSchema.describe("Normalized bundle-relative HTML entrypoint."),
  supportedSnapshotContractIdxs: z.array(SnapshotContractIdxSchema).min(1).readonly()
    .describe("Snapshot Contract revisions this View can render and edit."),
  locationTypes: z.array(NonEmptyStringSchema).readonly()
    .describe("Document location payload types understood by this View."),
}).readonly().meta({ id: "ViewBundleManifestV1" });

export type ViewBundleManifestV1 = z.infer<typeof ViewBundleManifestV1Schema>;

export const ViewBundleRecordSchema = z.object({
  viewBundleId: IdSchema.describe("Immutable content-derived View bundle identity."),
  name: NonEmptyStringSchema.describe("Mutable administrator-visible candidate name."),
  description: z.string().describe("Mutable administrator-visible candidate description."),
  manifest: ViewBundleManifestV1Schema.describe("Validated immutable View manifest."),
  size: z.number().int().nonnegative().describe("Compressed bundle size in bytes."),
  uploadedAt: IsoDateTimeSchema.describe("Time at which the validated bundle was stored."),
  etag: EtagSchema.describe("Current optimistic-concurrency token for mutable metadata."),
}).readonly().meta({ id: "ViewBundleRecord" });

export type ViewBundleRecord = z.infer<typeof ViewBundleRecordSchema>;

export const TypeCardLocaleV1Schema = z.object({
  name: NonEmptyStringSchema.describe("Localized document type display name."),
  description: z.string().describe("Localized document type description."),
  sampleThumbnailAlt: NonEmptyStringSchema.describe("Localized accessible text for the sample thumbnail."),
}).readonly().meta({ id: "TypeCardLocaleV1" });

export type TypeCardLocaleV1 = z.infer<typeof TypeCardLocaleV1Schema>;

export const TypeCardIconSvgV1Schema = z.object({
  kind: z.literal("svg"),
  path: NonEmptyStringSchema.describe("Bundle-relative path to the size-independent SVG icon."),
}).readonly();

export type TypeCardIconSvgV1 = z.infer<typeof TypeCardIconSvgV1Schema>;

export const TypeCardIconPngV1Schema = z.object({
  kind: z.literal("png"),
  images: z.object({
    16: NonEmptyStringSchema,
    32: NonEmptyStringSchema,
    64: NonEmptyStringSchema,
    128: NonEmptyStringSchema,
    256: NonEmptyStringSchema,
  }).readonly().describe("Bundle-relative PNG paths for every required raster size."),
}).readonly();

export type TypeCardIconPngV1 = z.infer<typeof TypeCardIconPngV1Schema>;

export const TypeCardIconV1Schema = z.discriminatedUnion("kind", [
  TypeCardIconSvgV1Schema,
  TypeCardIconPngV1Schema,
]);

export type TypeCardIconV1 = z.infer<typeof TypeCardIconV1Schema>;

export const TypeCardBundleManifestV1Schema = z.object({
  protocol: z.literal("unidocs-type-card/v1").describe("Type Card manifest protocol."),
  documentType: NonEmptyStringSchema.describe("Document type presented by this card."),
  locales: z.record(NonEmptyStringSchema, TypeCardLocaleV1Schema).refine(
    (locales) => locales.en !== undefined,
    { message: "Type Card locales must include en" },
  ).describe("Localized card content keyed by locale; the `en` fallback is required."),
  icon: TypeCardIconV1Schema.describe("SVG or complete predefined-size PNG icon set."),
  sampleThumbnail: NonEmptyStringSchema.describe("Bundle-relative path to the sample thumbnail."),
}).readonly().meta({ id: "TypeCardBundleManifestV1" });

export type TypeCardBundleManifestV1 = z.infer<typeof TypeCardBundleManifestV1Schema>;

export const TypeCardBundleRecordSchema = z.object({
  typeCardBundleId: IdSchema.describe("Immutable content-derived Type Card bundle identity."),
  name: NonEmptyStringSchema.describe("Mutable administrator-visible candidate name."),
  description: z.string().describe("Mutable administrator-visible candidate description."),
  manifest: TypeCardBundleManifestV1Schema.describe("Validated immutable Type Card manifest."),
  size: z.number().int().nonnegative().describe("Compressed bundle size in bytes."),
  uploadedAt: IsoDateTimeSchema.describe("Time at which the validated bundle was stored."),
  etag: EtagSchema.describe("Current optimistic-concurrency token for mutable metadata."),
}).readonly().meta({ id: "TypeCardBundleRecord" });

export type TypeCardBundleRecord = z.infer<typeof TypeCardBundleRecordSchema>;

export const OperatorDescriptorSchema = z.object({
  protocol: z.literal("unidocs-operator/v1").describe("Operator discovery protocol."),
  operatorId: NonEmptyStringSchema.describe("Stable identity declared by the Operator."),
  displayName: NonEmptyStringSchema.describe("Operator-provided display name."),
  supportedDocumentTypes: z.array(NonEmptyStringSchema).min(1).readonly()
    .describe("Document types declared by the Operator."),
  supportedSnapshotContracts: z.record(
    NonEmptyStringSchema,
    z.array(SnapshotContractIdxSchema).min(1).readonly(),
  ).describe("Supported Snapshot Contract revisions keyed by document type."),
}).readonly().meta({ id: "OperatorDescriptor" });

export type OperatorDescriptor = z.infer<typeof OperatorDescriptorSchema>;

export const OperatorCandidateRecordSchema = z.object({
  operatorCandidateId: IdSchema.describe("Persistent Operator candidate identity."),
  documentType: NonEmptyStringSchema.describe("Document type for which this candidate was validated."),
  name: NonEmptyStringSchema.describe("Mutable administrator-visible candidate name."),
  description: z.string().describe("Mutable administrator-visible candidate description."),
  baseUrl: z.url().describe("Validated Operator service base URL."),
  descriptor: OperatorDescriptorSchema.describe("Immutable descriptor captured during validation."),
  validatedAt: IsoDateTimeSchema.describe("Time at which discovery and probe validation succeeded."),
  etag: EtagSchema.describe("Current optimistic-concurrency token for mutable metadata."),
}).readonly().meta({ id: "OperatorCandidateRecord" });

export type OperatorCandidateRecord = z.infer<typeof OperatorCandidateRecordSchema>;

export const OperatorValidationSchema = z.object({
  validationId: IdSchema.describe("Short-lived validation identity used to create a candidate."),
  baseUrl: z.url().describe("Operator base URL that was validated."),
  descriptor: OperatorDescriptorSchema.describe("Descriptor captured during validation."),
  expiresAt: IsoDateTimeSchema.describe("Time after which this validation cannot create a candidate."),
}).readonly().meta({ id: "OperatorValidation" });

export type OperatorValidation = z.infer<typeof OperatorValidationSchema>;

export const SnapshotContractRecordSchema = z.object({
  snapshotContractIdx: SnapshotContractIdxSchema.describe("Document-type-scoped, monotonically increasing revision."),
  contentType: NonEmptyStringSchema.describe("Media type of snapshots governed by this revision."),
  schema: SValueSchemaSchema.describe("Immutable SValue schema for this revision."),
  schemaHash: NonEmptyStringSchema.describe("Digest of the canonically encoded schema."),
  createdAt: IsoDateTimeSchema.describe("Time at which this revision was appended."),
}).readonly().meta({ id: "SnapshotContractRecord" });

export type SnapshotContractRecord = z.infer<typeof SnapshotContractRecordSchema>;

export const DocumentTypeRegistrationSchema = z.object({
  documentType: NonEmptyStringSchema.describe("Stable public document type identifier."),
  internalName: NonEmptyStringSchema.describe("Mutable administrator-only name."),
  enabled: z.boolean().describe("Whether users may create new documents of this type."),
  latestSnapshotContract: SnapshotContractRecordSchema.nullable()
    .describe("Highest Snapshot Contract revision, or null before the first append."),
  typeCardBundle: TypeCardBundleRecordSchema.nullable()
    .describe("Currently selected Type Card bundle, or null while unconfigured."),
  viewBundle: ViewBundleRecordSchema.nullable()
    .describe("Currently selected View bundle, or null while unconfigured."),
  builtinOperator: OperatorCandidateRecordSchema.nullable()
    .describe("Currently selected built-in Operator candidate, or null."),
  etag: EtagSchema.describe("Optimistic-concurrency token for the complete registration."),
  updatedAt: IsoDateTimeSchema.describe("Time of the latest registration change."),
}).readonly().meta({ id: "DocumentTypeRegistration" });

export type DocumentTypeRegistration = z.infer<typeof DocumentTypeRegistrationSchema>;

const AdministratorMemberRecordObjectSchema = z.object({
  adminId: IdSchema.describe("Stable administrator membership identity."),
  email: z.email().describe("Normalized Google account email allowed to administer UniDocs."),
  bound: z.boolean().describe("Whether the member has bound a verified Google identity."),
  addedBy: NonEmptyStringSchema.describe("Administrator identity that added this member, or `bootstrap`."),
  addedAt: IsoDateTimeSchema.describe("Time at which the administrator membership was created."),
  etag: EtagSchema.describe("Optimistic-concurrency token required to remove this member."),
});

export const AdministratorMemberRecordSchema = AdministratorMemberRecordObjectSchema
  .readonly()
  .meta({ id: "AdministratorMemberRecord" });

export type AdministratorMemberRecord = z.infer<typeof AdministratorMemberRecordSchema>;

export const AdministratorMemberListItemSchema = AdministratorMemberRecordObjectSchema.extend({
  isSelf: z.boolean().describe("Whether this membership belongs to the current administrator."),
}).readonly().meta({ id: "AdministratorMemberListItem" });

export type AdministratorMemberListItem = z.infer<typeof AdministratorMemberListItemSchema>;

function pageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema).readonly(),
    nextCursor: CursorSchema.nullable(),
  }).readonly();
}

export const ListTypeCardBundlesResponseSchema = pageSchema(TypeCardBundleRecordSchema)
  .meta({ id: "ListTypeCardBundlesResponse" });
export const ListViewBundlesResponseSchema = pageSchema(ViewBundleRecordSchema)
  .meta({ id: "ListViewBundlesResponse" });
export const ListOperatorCandidatesResponseSchema = pageSchema(OperatorCandidateRecordSchema)
  .meta({ id: "ListOperatorCandidatesResponse" });
export const ListDocumentTypesResponseSchema = pageSchema(DocumentTypeRegistrationSchema)
  .meta({ id: "ListDocumentTypesResponse" });
export const ListSnapshotContractsResponseSchema = pageSchema(SnapshotContractRecordSchema)
  .meta({ id: "ListSnapshotContractsResponse" });
export const ListAdministratorMembersResponseSchema = pageSchema(AdministratorMemberListItemSchema)
  .meta({ id: "ListAdministratorMembersResponse" });

export type ListTypeCardBundlesResponse = z.infer<typeof ListTypeCardBundlesResponseSchema>;
export type ListViewBundlesResponse = z.infer<typeof ListViewBundlesResponseSchema>;
export type ListOperatorCandidatesResponse = z.infer<typeof ListOperatorCandidatesResponseSchema>;
export type ListDocumentTypesResponse = z.infer<typeof ListDocumentTypesResponseSchema>;
export type ListSnapshotContractsResponse = z.infer<typeof ListSnapshotContractsResponseSchema>;
export type ListAdministratorMembersResponse = z.infer<
  typeof ListAdministratorMembersResponseSchema
>;

export const PaginationQuerySchema = z.object({
  cursor: CursorSchema.optional().describe("Opaque cursor returned by the previous page."),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Maximum number of records to return, from 1 through 100."),
}).readonly();

export const ListBundlesQuerySchema = PaginationQuerySchema.unwrap().extend({
  documentType: NonEmptyStringSchema.describe("Document type declared by candidate manifests."),
}).readonly();

export type ListBundlesQuery = z.infer<typeof ListBundlesQuerySchema>;

export const ListDocumentTypesQuerySchema = PaginationQuerySchema.unwrap().extend({
  q: z.string().optional().describe("Case-insensitive administrator search text."),
  enabled: z.boolean().optional().describe("Restrict results to enabled or disabled registrations."),
}).readonly();

export type ListDocumentTypesQuery = z.infer<typeof ListDocumentTypesQuerySchema>;

export const BundleUploadQuerySchema = z.object({
  name: NonEmptyStringSchema.describe("Initial administrator-visible candidate name."),
  description: z.string().describe("Initial administrator-visible candidate description."),
}).readonly();

const MutationHeadersObjectSchema = z.object({
  "x-csrf-token": NonEmptyStringSchema.describe("CSRF token associated with the administrator session."),
  "idempotency-key": NonEmptyStringSchema.describe("Retry identity; reusing a key with a different request is a conflict."),
});

export const MutationHeadersSchema = MutationHeadersObjectSchema.readonly();
export const ConditionalMutationHeadersSchema = MutationHeadersObjectSchema.extend({
  "if-match": EtagSchema.describe("Current resource ETag required for optimistic concurrency."),
}).readonly();

export const UpdateCandidateMetadataRequestSchema = z.object({
  name: NonEmptyStringSchema.describe("Replacement administrator-visible candidate name."),
  description: z.string().describe("Replacement administrator-visible candidate description."),
}).readonly().meta({ id: "UpdateCandidateMetadataRequest" });

export type UpdateCandidateMetadataRequest = z.infer<
  typeof UpdateCandidateMetadataRequestSchema
>;

export const CreateOperatorValidationRequestSchema = z.object({
  baseUrl: z.url().describe("Operator base URL to discover and probe."),
  expectedDocumentType: NonEmptyStringSchema.describe("Document type the Operator must declare support for."),
  expectedConfigEtag: EtagSchema.nullable().describe("Expected Operator configuration ETag, or null when not pinned."),
}).readonly().meta({ id: "CreateOperatorValidationRequest" });

export type CreateOperatorValidationRequest = z.infer<
  typeof CreateOperatorValidationRequestSchema
>;

export const CreateOperatorCandidateRequestSchema = z.object({
  validationId: IdSchema.describe("Current successful validation to persist."),
  name: NonEmptyStringSchema.describe("Initial administrator-visible candidate name."),
  description: z.string().describe("Initial administrator-visible candidate description."),
}).readonly().meta({ id: "CreateOperatorCandidateRequest" });

export type CreateOperatorCandidateRequest = z.infer<
  typeof CreateOperatorCandidateRequestSchema
>;

export const CreateDocumentTypeRequestSchema = z.object({
  internalName: NonEmptyStringSchema.describe("Administrator-only name for the new disabled draft."),
}).readonly().meta({ id: "CreateDocumentTypeRequest" });

export type CreateDocumentTypeRequest = z.infer<typeof CreateDocumentTypeRequestSchema>;

export const AddAdministratorMemberRequestSchema = z.object({
  email: z.email().describe("Google account email to add to the administrator allowlist."),
}).readonly().meta({ id: "AddAdministratorMemberRequest" });

export type AddAdministratorMemberRequest = z.infer<
  typeof AddAdministratorMemberRequestSchema
>;

export const AppendSnapshotContractRequestSchema = z.object({
  observedLatestSnapshotContractIdx: SnapshotContractIdxSchema.nullable()
    .describe("Latest revision observed by the administrator, or null before the first revision."),
  contentType: NonEmptyStringSchema.describe("Media type of snapshots governed by the new revision."),
  schema: SValueSchemaSchema.describe("SValue schema to canonically encode and append."),
  reason: NonEmptyStringSchema.describe("Administrator-provided audit reason for the revision."),
}).readonly().meta({ id: "AppendSnapshotContractRequest" });

export type AppendSnapshotContractRequest = z.infer<
  typeof AppendSnapshotContractRequestSchema
>;

export const UpdateDocumentTypeRequestSchema = z.object({
  internalName: NonEmptyStringSchema.optional().describe("Replacement administrator-only name."),
  typeCardBundleId: IdSchema.optional().describe("Type Card bundle to select."),
  viewBundleId: IdSchema.optional().describe("View bundle to select."),
  builtinOperatorCandidateId: IdSchema.nullable().optional()
    .describe("Operator candidate to select, or null to clear the selection."),
  enabled: z.boolean().optional().describe("Replacement enabled state."),
  reason: z.string().optional().describe("Administrator-provided audit reason."),
}).refine(
  (request) => Object.keys(request).some((key) => key !== "reason"),
  { message: "At least one document type setting must be updated" },
).readonly().meta({ id: "UpdateDocumentTypeRequest" });

export type UpdateDocumentTypeRequest = z.infer<typeof UpdateDocumentTypeRequestSchema>;

export const ZipBundleStreamSchema = z.instanceof(ReadableStream<Uint8Array>);

JSON_SCHEMA_INPUT_REGISTRY.add(ZipBundleStreamSchema, {
  type: "string",
  contentMediaType: "application/zip",
  contentEncoding: "binary",
});
