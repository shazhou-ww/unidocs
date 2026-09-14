/**
 * Runtime schemas for the Platform contracts. The interfaces in common.ts,
 * agent.ts and operator.ts stay the public type surface; these schemas give the
 * same shapes a runtime, which a plain TypeScript interface cannot do.
 */
import type { JsonValue } from "@unidocs/protocol";
import { z } from "zod";

export const NonEmptyStringSchema = z.string().min(1);
export const IdSchema = NonEmptyStringSchema;
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

const RecordIdxSchema = z.number().int().nonnegative();
export const DocumentContractIdxSchema = RecordIdxSchema
  .describe("Zero-based paired Document Contract revision.");
export const VersionIdxSchema = RecordIdxSchema
  .describe("Zero-based, document-scoped version record ID.");
export const CommentIdxSchema = RecordIdxSchema
  .describe("Zero-based, thread-scoped comment record ID.");
export const ReplyIdxSchema = RecordIdxSchema
  .describe("Zero-based, thread-scoped reply record ID.");

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

export const CasBlobRefSchema = z.object({
  blobHash: NonEmptyStringSchema.describe("UniCAS blob root hash."),
  size: z.number().int().nonnegative().describe("Logical byte length of the complete blob."),
  contentType: NonEmptyStringSchema.describe("Media type of the complete logical blob."),
}).readonly().meta({ id: "CasBlobRef" });

export const DocumentLocationSchema = z.object({
  documentContractIdx: DocumentContractIdxSchema
    .describe("Paired contract revision whose location schema validates this payload."),
  locationType: NonEmptyStringSchema.describe("Document-type-specific location kind."),
  payload: JsonValueSchema.describe("Opaque location payload."),
}).readonly().meta({ id: "DocumentLocation" });

export const MessageContentSchema = z.object({
  text: z.string().nullable().describe("Plain-text message body, or null."),
  richContent: CasBlobRefSchema.nullable().describe("Rich message body stored in UniCAS, or null."),
  attachments: z.array(CasBlobRefSchema).readonly().describe("Attachments; they never replace the body."),
}).refine(
  ({ text, richContent }) => (text !== null && text.length > 0) || richContent !== null,
  { message: "At least one of text or richContent must be present" },
).readonly().meta({ id: "MessageContent" });

export const AgentThreadUpdateSchema = z.object({
  threadId: IdSchema.describe("Thread this update answers."),
  observedAcknowledgedCommentIdx: CommentIdxSchema.nullable()
    .describe("Thread lock: the acknowledgement watermark observed when the Agent froze its work."),
  respondThroughCommentIdx: CommentIdxSchema
    .describe("Cumulative acknowledgement watermark this reply advances the thread to."),
  content: MessageContentSchema.describe("Agent reply body."),
  resultLocations: z.array(DocumentLocationSchema).readonly()
    .describe("Locations in the version created by this same submission; empty for a pure reply."),
}).readonly().meta({ id: "AgentThreadUpdate" });

/**
 * The two structural rules come from
 * docs/design/platform-v0/agent-mediated-document-collaboration.md §7.1 and
 * cannot be expressed by the optional fields alone.
 */
export const AgentSubmissionRequestSchema = z.object({
  submissionId: IdSchema.describe("Caller-assigned idempotency identity for this submission."),
  observedCurrentVersionIdx: VersionIdxSchema.nullable().optional()
    .describe("Version lock: the current pointer observed at commit. Null means the document had no version."),
  newDocumentContractIdx: DocumentContractIdxSchema.optional()
    .describe("Paired revision validating newSnapshotBlob; required alongside it."),
  newSnapshotBlob: CasBlobRefSchema.optional()
    .describe("Snapshot the Agent already wrote to UniCAS, referenced rather than inlined."),
  threadUpdates: z.array(AgentThreadUpdateSchema).readonly()
    .describe("Replies to commit atomically with the optional new version."),
}).superRefine((request, context) => {
  const hasSnapshot = request.newSnapshotBlob !== undefined;
  if (request.threadUpdates.some(update => update.resultLocations.length > 0) && !hasSnapshot) {
    context.addIssue({
      code: "custom",
      path: ["threadUpdates"],
      message: "resultLocations are relative to a new version, so newSnapshotBlob is required",
    });
  }
  if (hasSnapshot && request.observedCurrentVersionIdx === undefined) {
    context.addIssue({
      code: "custom",
      path: ["observedCurrentVersionIdx"],
      message: "Creating a version requires the observed current pointer as an equality lock",
    });
  }
  if (hasSnapshot && request.newDocumentContractIdx === undefined) {
    context.addIssue({
      code: "custom",
      path: ["newDocumentContractIdx"],
      message: "A new snapshot must name the paired contract revision that validates it",
    });
  }
}).readonly().meta({ id: "AgentSubmissionRequest" });
