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
