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

export const AddressedCommentSchema = z.object({
  threadId: IdSchema.describe("Thread containing the addressed comment."),
  commentIdx: CommentIdxSchema.describe("Addressed comment within that thread."),
  baseVersionIdx: VersionIdxSchema.describe("Version the addressed comment was written against."),
}).readonly().meta({ id: "AddressedComment" });

export const VersionRecordSchema = z.object({
  versionIdx: VersionIdxSchema.describe("Version identity and birth order."),
  parentVersionIdx: VersionIdxSchema.nullable()
    .describe("Current pointer observed at commit; null only for the first version."),
  documentContractIdx: DocumentContractIdxSchema.describe("Paired revision validating this snapshot."),
  authorAgentId: NonEmptyStringSchema.describe("Agent identity that committed this version."),
  submissionId: IdSchema.describe("Submission that created this version."),
  addressedComments: z.array(AddressedCommentSchema).readonly()
    .describe("Comment provenance; empty for the first version."),
  createdAt: IsoDateTimeSchema.describe("Time at which the version was committed."),
}).readonly().meta({ id: "VersionRecord" });

export const ReplyRecordSchema = z.object({
  replyIdx: ReplyIdxSchema.describe("Reply identity within its thread."),
  respondThroughCommentIdx: CommentIdxSchema
    .describe("Cumulative acknowledgement watermark this reply advanced the thread to."),
  content: MessageContentSchema.describe("Agent message body."),
  resultLocations: z.array(DocumentLocationSchema).readonly()
    .describe("Locations in the version created by the same submission."),
  authorAgentId: NonEmptyStringSchema.describe("Agent identity that produced the reply."),
  submissionId: IdSchema.describe("Submission that committed this reply."),
  createdAt: IsoDateTimeSchema.describe("Time at which the reply was committed."),
}).readonly().meta({ id: "ReplyRecord" });

export const SubmissionConflictSchema = z.object({
  currentVersionIdx: VersionIdxSchema.nullable().describe("Current pointer at the time of rejection."),
  availableDocumentContractIdxs: z.array(DocumentContractIdxSchema).readonly()
    .describe("Revisions currently writable for this document type."),
  threads: z.array(z.object({
    threadId: IdSchema,
    acknowledgedCommentIdx: CommentIdxSchema.nullable(),
    latestCommentIdx: CommentIdxSchema,
  }).readonly()).readonly().describe("Present watermarks for the threads the submission addressed."),
}).readonly().meta({ id: "SubmissionConflict" });

export const SubmissionRejectionReasonSchema = z.enum([
  "version_conflict",
  "document_contract_conflict",
  "reply_watermark_conflict",
]);

/**
 * A rejected submission is a successful HTTP response, not a 4xx: the endpoint's
 * response type is this union, and the Agent recomputes from `conflict`.
 */
export const SubmissionReceiptSchema = z.discriminatedUnion("state", [
  z.object({
    submissionId: IdSchema,
    state: z.literal("committed"),
    version: VersionRecordSchema.nullable().describe("Null for a pure reply."),
    replies: z.array(ReplyRecordSchema).readonly(),
    committedAt: IsoDateTimeSchema,
  }).readonly(),
  z.object({
    submissionId: IdSchema,
    state: z.literal("rejected"),
    reason: SubmissionRejectionReasonSchema,
    conflict: SubmissionConflictSchema,
    rejectedAt: IsoDateTimeSchema,
  }).readonly(),
]).meta({ id: "SubmissionReceipt" });

export const OperatorEventReasonSchema = z.enum([
  "document.created",
  "comment.appended",
  "current_version.moved",
]);

/** Delivery is at-least-once, and acceptance does not imply the Agent finished. */
export const OperatorWebhookRequestSchema = z.object({
  protocol: z.literal("unidocs-operator-webhook/v1"),
  eventId: IdSchema.describe("Stable event identity for duplicate suppression."),
  reason: OperatorEventReasonSchema,
  tenantId: IdSchema,
  documentId: IdSchema,
  documentType: NonEmptyStringSchema,
  currentVersionIdx: VersionIdxSchema.nullable()
    .describe("Current pointer at the time of the event; null before the first version."),
  newComments: z.array(z.object({
    threadId: IdSchema,
    commentIdx: CommentIdxSchema,
    acknowledgedCommentIdx: CommentIdxSchema.nullable(),
  }).readonly()).readonly().describe("Work hint, not a transaction boundary."),
  occurredAt: IsoDateTimeSchema,
}).readonly().meta({ id: "OperatorWebhookRequest" });

export const OperatorWebhookResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: IdSchema,
}).readonly().meta({ id: "OperatorWebhookResponse" });
