import { JSON_SCHEMA_INPUT_REGISTRY } from "@orpc/zod/zod4";
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
export const EtagSchema = z.string()
  .regex(/^"sha256-[A-Za-z0-9_-]{43}"$/)
  .describe("Strong Platform ETag containing the base64url SHA-256 digest of the canonical resource representation, including the HTTP double quotes. Clients must not parse it.")
  .meta({ examples: ["\"sha256-qpj883GyEC_ISq5zghYn7x9MAjOW27ImPGJamTCcRkA\""] });
export const ExternalEtagSchema = z.string()
  .regex(/^"[\x21\x23-\x7E]+"$/)
  .describe("Strong HTTP entity-tag owned by an external service, including double quotes.")
  .meta({ examples: ["\"operator-config-v3\""] });
export const CursorSchema = NonEmptyStringSchema;
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const DocumentContractIdxSchema = z.number().int().nonnegative();
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

export const DocumentTypeAuditActions = [
  "type_card_bundle.uploaded",
  "type_card_bundle.validation_failed",
  "type_card_bundle.metadata_changed",
  "view_bundle.uploaded",
  "view_bundle.validation_failed",
  "view_bundle.metadata_changed",
  "operator.created",
  "operator.metadata_changed",
  "document_contract.appended",
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

export const AdministratorMemberAuditActions = [
  "administrator.bootstrap",
  "administrator.bound",
  "administrator.added",
  "administrator.removed",
] as const;

export const AdminAuditActionSchema = z.enum([
  ...DocumentTypeAuditActions,
  ...AdministratorMemberAuditActions,
]);

export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;
export type DocumentTypeAuditAction = typeof DocumentTypeAuditActions[number];
export type AdministratorMemberAuditAction = typeof AdministratorMemberAuditActions[number];

export const AdminAuditResourceTypeSchema = z.enum([
  "document_type",
  "document_contract",
  "type_card_bundle",
  "view_bundle",
  "operator",
  "operator_validation",
  "administrator",
]);

export const AdminAuditEventSchema = z.object({
  auditEventId: IdSchema.describe("Stable audit event identity."),
  actorId: IdSchema.describe("Administrator principal that initiated the operation."),
  action: AdminAuditActionSchema.describe("Stable machine-readable audit action."),
  resourceType: AdminAuditResourceTypeSchema.describe("Kind of resource directly affected."),
  resourceId: IdSchema.describe("Stable identity of the resource directly affected."),
  documentType: DocumentTypeSchema.nullable()
    .describe("Related document type, or null for administrator-wide events."),
  occurredAt: IsoDateTimeSchema.describe("Time at which the operation committed or failed."),
  requestId: IdSchema.describe("Request correlation identity."),
  reason: z.string().nullable().describe("Administrator-provided reason when applicable."),
  callerChannel: z.enum(["admin-webui", "mcp"]).optional().describe("Calling channel; legacy producers may omit attribution."),
  oauthClientHandle: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional().describe("SHA-256 of the OAuth client ID, or null for Admin WebUI calls."),
  toolName: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).nullable().optional().describe("MCP tool name, or null for Admin WebUI calls."),
  details: JsonValueSchema.optional().describe("Action-specific non-secret audit details."),
}).readonly().meta({ id: "AdminAuditEvent" });

export type AdminAuditEvent = z.infer<typeof AdminAuditEventSchema>;

export const ViewBundleManifestV1Schema = z.object({
  protocol: z.literal("unidocs-view-bundle/v1").describe("View bundle manifest protocol."),
  documentType: DocumentTypeSchema.describe("Document type implemented by this View."),
  entrypoints: z.object({
    interactive: NonEmptyStringSchema
      .describe("Normalized bundle-relative HTML entrypoint for the full interactive View."),
    thumbnail: NonEmptyStringSchema
      .describe("Normalized bundle-relative HTML entrypoint for deterministic thumbnail rendering."),
  }).refine(
    ({ interactive, thumbnail }) => interactive !== thumbnail,
    { message: "Interactive and thumbnail entrypoints must be different" },
  ).readonly().describe("Dedicated HTML entrypoints for interactive viewing and thumbnail capture."),
  supportedDocumentContractIdxs: z.array(DocumentContractIdxSchema).min(1).readonly()
    .describe("Paired Document Contract revisions this View can render, edit, and locate."),
}).readonly().meta({ id: "ViewBundleManifestV1" });

export type ViewBundleManifestV1 = z.infer<typeof ViewBundleManifestV1Schema>;

export const ViewBundleRecordSchema = z.object({
  viewBundleId: IdSchema.describe("Immutable content-derived View bundle identity."),
  bundleUrl: z.url().describe("Immutable canonical URL of the validated View bundle root.")
    .meta({ examples: ["https://bundles.example/view-bundles/vb_7fa912d40e83c38a/"] }),
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
  documentType: DocumentTypeSchema.describe("Document type presented by this card."),
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
  bundleUrl: z.url().describe("Immutable canonical URL of the validated Type Card bundle root.")
    .meta({ examples: ["https://bundles.example/type-card-bundles/tb_9f1428cd/"] }),
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
  declaredOperatorId: NonEmptyStringSchema.describe("Stable service identity declared by the Operator."),
  displayName: NonEmptyStringSchema.describe("Operator-provided display name."),
  supportedDocumentTypes: z.array(DocumentTypeSchema).min(1).readonly()
    .describe("Document types declared by the Operator."),
  supportedDocumentContracts: z.record(
    DocumentTypeSchema,
    z.array(DocumentContractIdxSchema).min(1).readonly(),
  ).describe("Supported paired Document Contract revisions keyed by document type."),
}).readonly().meta({ id: "OperatorDescriptor" });

export type OperatorDescriptor = z.infer<typeof OperatorDescriptorSchema>;

export const OperatorRecordSchema = z.object({
  operatorId: IdSchema.describe("Persistent Platform Operator resource identity."),
  documentType: DocumentTypeSchema.describe("Document type for which this Operator was validated."),
  name: NonEmptyStringSchema.describe("Mutable administrator-visible Operator name."),
  description: z.string().describe("Mutable administrator-visible Operator description."),
  baseUrl: z.url().describe("Validated Operator service base URL."),
  descriptor: OperatorDescriptorSchema.describe("Immutable descriptor captured during validation."),
  validatedAt: IsoDateTimeSchema.describe("Time at which discovery and probe validation succeeded."),
  etag: EtagSchema.describe("Current optimistic-concurrency token for mutable metadata."),
}).readonly().meta({ id: "OperatorRecord" });

export type OperatorRecord = z.infer<typeof OperatorRecordSchema>;

export const OperatorValidationSchema = z.object({
  validationId: IdSchema.describe("Short-lived validation record identity used to create an Operator."),
  documentType: DocumentTypeSchema.describe("Document type against which the Operator was validated."),
  baseUrl: z.url().describe("Operator base URL that was validated."),
  expectedConfigEtag: ExternalEtagSchema.nullable()
    .describe("External Operator configuration ETag pinned by validation, or null."),
  descriptor: OperatorDescriptorSchema.describe("Descriptor captured during validation."),
  validatedAt: IsoDateTimeSchema.describe("Time at which validation succeeded."),
  expiresAt: IsoDateTimeSchema.describe("Time after which this validation cannot create an Operator."),
}).readonly().meta({ id: "OperatorValidation" });

export type OperatorValidation = z.infer<typeof OperatorValidationSchema>;

const DocumentContractSnapshotSchema = z.object({
  contentType: z.string()
    .regex(/^application\/vnd\.unidocs\.[a-z][a-z0-9-]{0,63}\.snapshot\+cbor;version=1$/)
    .describe("Snapshot media type derived from documentType and formatVersion.")
    .meta({ examples: [documentSnapshotContentType("psd")] }),
  schema: SValueSchemaSchema.describe("SValue schema for snapshots."),
}).readonly();

const DocumentContractLocationSchema = z.object({
  contentType: z.string()
    .regex(/^application\/vnd\.unidocs\.[a-z][a-z0-9-]{0,63}\.location\+json;version=1$/)
    .describe("Location media type derived from documentType and formatVersion.")
    .meta({ examples: [documentLocationContentType("psd")] }),
  schema: SValueSchemaSchema
    .describe("Schema for the locationType and payload projection of a location."),
}).readonly();

export const AppendDocumentContractRequestSchema = z.object({
  formatVersion: z.literal(DocumentContentFormatVersion)
    .describe("Paired snapshot/location wire format version."),
  snapshot: z.object({
    schema: SValueSchemaSchema.unwrap().describe("SValue schema for snapshots."),
  }),
  location: z.object({
    schema: SValueSchemaSchema.unwrap()
      .describe("Schema for the locationType and payload projection of a location."),
  }),
  reason: NonEmptyStringSchema.describe("Administrator-provided audit reason for the revision."),
}).readonly().meta({ id: "AppendDocumentContractRequest" });

export type AppendDocumentContractRequest = z.infer<
  typeof AppendDocumentContractRequestSchema
>;

const DocumentContractRecordObjectSchema = z.object({
  documentType: DocumentTypeSchema,
  documentContractIdx: DocumentContractIdxSchema
    .describe("Document-type-scoped, monotonically increasing paired revision."),
  formatVersion: z.literal(DocumentContentFormatVersion)
    .describe("Paired snapshot/location wire format version."),
  snapshot: DocumentContractSnapshotSchema.unwrap().extend({
    schemaHash: NonEmptyStringSchema.describe("Digest of the canonical snapshot schema."),
  }).readonly(),
  location: DocumentContractLocationSchema.unwrap().extend({
    schemaHash: NonEmptyStringSchema.describe("Digest of the canonical location schema."),
  }).readonly(),
  contractHash: NonEmptyStringSchema.describe("Digest of the canonical paired contract."),
  createdAt: IsoDateTimeSchema.describe("Time at which this revision was appended."),
});

export const DocumentContractRecordSchema = DocumentContractRecordObjectSchema
  .superRefine((record, context) => {
  if (record.snapshot.contentType !== documentSnapshotContentType(record.documentType)) {
    context.addIssue({ code: "custom", path: ["snapshot", "contentType"], message: "Snapshot content type does not match documentType" });
  }
  if (record.location.contentType !== documentLocationContentType(record.documentType)) {
    context.addIssue({ code: "custom", path: ["location", "contentType"], message: "Location content type does not match documentType" });
  }
  }).readonly().meta({ id: "DocumentContractRecord" });

export type DocumentContractRecord = z.infer<typeof DocumentContractRecordSchema>;

export const TypeCardBundleMutationResultSchema = z.object({
  typeCardBundleId: IdSchema.describe("Created or updated Type Card bundle identity."),
  etag: EtagSchema.describe("Current metadata ETag."),
}).readonly().meta({ id: "TypeCardBundleMutationResult" });

export const ViewBundleMutationResultSchema = z.object({
  viewBundleId: IdSchema.describe("Created or updated View bundle identity."),
  etag: EtagSchema.describe("Current metadata ETag."),
}).readonly().meta({ id: "ViewBundleMutationResult" });

export const OperatorMutationResultSchema = z.object({
  operatorId: IdSchema.describe("Created or updated Operator identity."),
  etag: EtagSchema.describe("Current metadata ETag."),
}).readonly().meta({ id: "OperatorMutationResult" });

export const DocumentTypeMutationResultSchema = z.object({
  documentType: DocumentTypeSchema.describe("Created or updated document type identity."),
  etag: EtagSchema.describe("Current registration ETag."),
}).readonly().meta({ id: "DocumentTypeMutationResult" });

export const DocumentContractAppendResultSchema = z.object({
  documentContractIdx: DocumentContractIdxSchema.describe("Assigned paired contract revision."),
  contractHash: NonEmptyStringSchema.describe("Digest of the canonical paired contract."),
}).readonly().meta({ id: "DocumentContractAppendResult" });

export const AdministratorMemberMutationResultSchema = z.object({
  adminId: IdSchema.describe("Created administrator membership identity."),
  etag: EtagSchema.describe("Current membership ETag."),
}).readonly().meta({ id: "AdministratorMemberMutationResult" });

export type TypeCardBundleMutationResult = z.infer<
  typeof TypeCardBundleMutationResultSchema
>;
export type ViewBundleMutationResult = z.infer<typeof ViewBundleMutationResultSchema>;
export type OperatorMutationResult = z.infer<
  typeof OperatorMutationResultSchema
>;
export type DocumentTypeMutationResult = z.infer<typeof DocumentTypeMutationResultSchema>;
export type DocumentContractAppendResult = z.infer<
  typeof DocumentContractAppendResultSchema
>;
export type AdministratorMemberMutationResult = z.infer<
  typeof AdministratorMemberMutationResultSchema
>;

export const DocumentTypeRegistrationSchema = z.object({
  documentType: DocumentTypeSchema.describe("Stable public document type identifier."),
  internalName: NonEmptyStringSchema.describe("Mutable administrator-only name."),
  enabled: z.boolean().describe("Whether users may create new documents of this type."),
  latestDocumentContract: DocumentContractRecordSchema.nullable()
    .describe("Highest assigned Document Contract revision, or null before the first upload; this is not the only writable revision."),
  typeCardBundle: TypeCardBundleRecordSchema.nullable()
    .describe("Currently selected Type Card bundle, or null while unconfigured."),
  viewBundle: ViewBundleRecordSchema.nullable()
    .describe("Currently selected View bundle, or null while unconfigured."),
  builtinOperator: OperatorRecordSchema.nullable()
    .describe("Currently selected built-in Operator, or null."),
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

export const TypeCardBundleListItemSchema = TypeCardBundleRecordSchema.unwrap().omit({
  manifest: true,
}).extend({
  documentType: DocumentTypeSchema.describe("Document type declared by the omitted manifest."),
}).readonly().meta({ id: "TypeCardBundleListItem" });

export const ViewBundleListItemSchema = ViewBundleRecordSchema.unwrap().omit({
  manifest: true,
}).extend({
  documentType: DocumentTypeSchema.describe("Document type declared by the omitted manifest."),
  supportedDocumentContractIdxs: z.array(DocumentContractIdxSchema).readonly()
    .describe("Paired Document Contract revisions declared by the omitted manifest."),
}).readonly().meta({ id: "ViewBundleListItem" });

export const OperatorListItemSchema = OperatorRecordSchema.unwrap().omit({
  descriptor: true,
}).extend({
  supportedDocumentContractIdxs: z.array(DocumentContractIdxSchema).readonly()
    .describe("Paired Document Contract revisions declared for this document type."),
}).readonly().meta({ id: "OperatorListItem" });

export const DocumentContractListItemSchema = DocumentContractRecordObjectSchema.omit({
  snapshot: true,
  location: true,
}).extend({
  snapshotSchemaHash: NonEmptyStringSchema.describe("Digest of the omitted snapshot schema."),
  locationSchemaHash: NonEmptyStringSchema.describe("Digest of the omitted location schema."),
}).readonly().meta({ id: "DocumentContractListItem" });

const SelectedTypeCardBundleSummarySchema = z.object({
  typeCardBundleId: IdSchema,
  name: NonEmptyStringSchema,
}).readonly();

const SelectedViewBundleSummarySchema = z.object({
  viewBundleId: IdSchema,
  name: NonEmptyStringSchema,
}).readonly();

const SelectedOperatorSummarySchema = z.object({
  operatorId: IdSchema,
  name: NonEmptyStringSchema,
}).readonly();

export const DocumentTypeListItemSchema = z.object({
  documentType: DocumentTypeSchema.describe("Stable public document type identifier."),
  internalName: NonEmptyStringSchema.describe("Mutable administrator-only name."),
  enabled: z.boolean().describe("Whether users may create new documents of this type."),
  latestDocumentContractIdx: DocumentContractIdxSchema.nullable(),
  typeCardBundle: SelectedTypeCardBundleSummarySchema.nullable(),
  viewBundle: SelectedViewBundleSummarySchema.nullable(),
  builtinOperator: SelectedOperatorSummarySchema.nullable(),
  etag: EtagSchema,
  updatedAt: IsoDateTimeSchema,
}).readonly().meta({ id: "DocumentTypeListItem" });

export type TypeCardBundleListItem = z.infer<typeof TypeCardBundleListItemSchema>;
export type ViewBundleListItem = z.infer<typeof ViewBundleListItemSchema>;
export type OperatorListItem = z.infer<typeof OperatorListItemSchema>;
export type DocumentContractListItem = z.infer<typeof DocumentContractListItemSchema>;
export type DocumentTypeListItem = z.infer<typeof DocumentTypeListItemSchema>;

function pageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema).readonly(),
    nextCursor: CursorSchema.nullable(),
  }).readonly();
}

export const ListTypeCardBundlesResponseSchema = pageSchema(TypeCardBundleListItemSchema)
  .meta({ id: "ListTypeCardBundlesResponse" });
export const ListViewBundlesResponseSchema = pageSchema(ViewBundleListItemSchema)
  .meta({ id: "ListViewBundlesResponse" });
export const ListOperatorsResponseSchema = pageSchema(OperatorListItemSchema)
  .meta({ id: "ListOperatorsResponse" });
export const ListDocumentTypesResponseSchema = pageSchema(DocumentTypeListItemSchema)
  .meta({ id: "ListDocumentTypesResponse" });
export const ListDocumentContractsResponseSchema = pageSchema(DocumentContractListItemSchema)
  .meta({ id: "ListDocumentContractsResponse" });
export const ListAdministratorMembersResponseSchema = pageSchema(AdministratorMemberListItemSchema)
  .meta({ id: "ListAdministratorMembersResponse" });
export const ListAdminAuditEventsResponseSchema = pageSchema(AdminAuditEventSchema)
  .meta({ id: "ListAdminAuditEventsResponse" });

export type ListTypeCardBundlesResponse = z.infer<typeof ListTypeCardBundlesResponseSchema>;
export type ListViewBundlesResponse = z.infer<typeof ListViewBundlesResponseSchema>;
export type ListOperatorsResponse = z.infer<typeof ListOperatorsResponseSchema>;
export type ListDocumentTypesResponse = z.infer<typeof ListDocumentTypesResponseSchema>;
export type ListDocumentContractsResponse = z.infer<typeof ListDocumentContractsResponseSchema>;
export type ListAdministratorMembersResponse = z.infer<
  typeof ListAdministratorMembersResponseSchema
>;
export type ListAdminAuditEventsResponse = z.infer<typeof ListAdminAuditEventsResponseSchema>;

export const PaginationQuerySchema = z.object({
  cursor: CursorSchema.optional().describe("Opaque cursor returned by the previous page."),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Maximum number of records to return, from 1 through 100."),
}).readonly();

export const ListBundlesQuerySchema = PaginationQuerySchema.unwrap().extend({
  documentType: DocumentTypeSchema.describe("Document type declared by candidate manifests."),
}).readonly();

export type ListBundlesQuery = z.infer<typeof ListBundlesQuerySchema>;

export const ListDocumentTypesQuerySchema = PaginationQuerySchema.unwrap().extend({
  q: z.string().optional().describe("Case-insensitive administrator search text."),
  enabled: z.boolean().optional().describe("Restrict results to enabled or disabled registrations."),
}).readonly();

export type ListDocumentTypesQuery = z.infer<typeof ListDocumentTypesQuerySchema>;

export const ListAdminAuditEventsQuerySchema = PaginationQuerySchema.unwrap().extend({
  callerChannel: z.enum(["admin-webui", "mcp"]).optional().describe("Restrict events to one calling channel."),
  toolName: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).optional().describe("Restrict events to one MCP tool name."),
  actorId: IdSchema.optional().describe("Restrict events to one administrator principal."),
  action: AdminAuditActionSchema.optional().describe("Restrict events to one audit action."),
  resourceType: AdminAuditResourceTypeSchema.optional()
    .describe("Restrict events to one resource kind."),
  documentType: DocumentTypeSchema.optional().describe("Restrict events related to one document type."),
  occurredFrom: IsoDateTimeSchema.optional().describe("Include events at or after this time."),
  occurredTo: IsoDateTimeSchema.optional().describe("Include events before this time."),
}).readonly();

export type ListAdminAuditEventsQuery = z.infer<typeof ListAdminAuditEventsQuerySchema>;

export const BundleUploadQuerySchema = z.object({
  name: NonEmptyStringSchema.describe("Initial administrator-visible candidate name."),
  description: z.string().describe("Initial administrator-visible candidate description."),
}).readonly();

const MutationHeadersObjectSchema = z.object({
  "x-csrf-token": NonEmptyStringSchema.optional()
    .describe("Required for session-cookie authentication; omit when authenticating with a Bearer token."),
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
  expectedDocumentType: DocumentTypeSchema.describe("Document type the Operator must declare support for."),
  expectedConfigEtag: ExternalEtagSchema.nullable()
    .describe("Expected Operator configuration ETag, or null when not pinned."),
}).readonly().meta({ id: "CreateOperatorValidationRequest" });

export type CreateOperatorValidationRequest = z.infer<
  typeof CreateOperatorValidationRequestSchema
>;

export const CreateOperatorRequestSchema = z.object({
  validationId: IdSchema.describe("Current successful validation to persist."),
  name: NonEmptyStringSchema.describe("Initial administrator-visible Operator name."),
  description: z.string().describe("Initial administrator-visible Operator description."),
}).readonly().meta({ id: "CreateOperatorRequest" });

export type CreateOperatorRequest = z.infer<
  typeof CreateOperatorRequestSchema
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

export const UpdateDocumentTypeRequestSchema = z.object({
  internalName: NonEmptyStringSchema.optional().describe("Replacement administrator-only name."),
  typeCardBundleId: IdSchema.optional().describe("Type Card bundle to select."),
  viewBundleId: IdSchema.optional().describe("View bundle to select."),
  builtinOperatorId: IdSchema.nullable().optional()
    .describe("Operator to select, or null to clear the selection."),
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
