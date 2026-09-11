import { z } from "zod";
import type {
  CasGcResult,
  CasHash,
  CasLeaseOperationResult,
  CasLeaseResult,
  CasNode,
  CasNodeDescriptor,
  CasNodeMetadata,
  CasNodeState,
  CasRefChanges,
  CasReferences,
  CasRootRefBalance,
  CasRootRefsPage,
  CasRootRefUpdate,
  CasUploadRequiredResult,
  CasUsage,
} from "./types.js";

export const CasHashSchema: z.ZodType<CasHash> = z.string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest")
  .describe("Lowercase hexadecimal SHA-256 digest of the canonical node bytes. The digest is the immutable node identity within a tenant.")
  .meta({ id: "CasHash" });

const TimestampSchema = z.number().int().nonnegative()
  .describe("Unix timestamp in milliseconds since 1970-01-01T00:00:00Z.");

export const CasNodeMetadataSchema: z.ZodType<CasNodeMetadata> = z.object({
  hash: CasHashSchema.describe("Digest that identifies this immutable node."),
  size: z.number().int().nonnegative()
    .describe("Logical length of the canonical node content in bytes."),
  contentType: z.string().min(1)
    .describe("Media type recorded for the immutable node content."),
  refs: z.array(CasHashSchema).readonly()
    .describe("Digests of child nodes referenced by this node. Each occurrence contributes one child reference."),
}).readonly().meta({ id: "CasNodeMetadata" });

export const CasNodeStateSchema: z.ZodType<CasNodeState> = z.object({
  leaseStartedAt: TimestampSchema.describe("Start of the current uninterrupted lease period, or 0 when no lease has existed."),
  leaseExpiresAt: TimestampSchema.describe("Guaranteed protection deadline. Garbage collection cannot delete the node before this time."),
  childRefCount: z.number().int().nonnegative()
    .describe("Number of stored parent edges that currently reference this node."),
  rootRefCount: z.number().int()
    .describe("Aggregate business Root Ref balance for this node. Positive balances retain committed state."),
}).readonly().meta({ id: "CasNodeState" });

export const CasNodeDescriptorSchema: z.ZodType<CasNodeDescriptor> = z.object({
  hash: CasHashSchema.describe("Expected digest of the canonical node bytes."),
  size: z.number().int().nonnegative().describe("Expected canonical content length in bytes."),
  contentType: z.string().min(1).describe("Media type to associate with the immutable node."),
  refs: z.array(CasHashSchema).readonly().describe("Expected child-node digest list in canonical order."),
}).readonly().meta({ id: "CasNodeDescriptor" });

export const CasLeaseResultSchema: z.ZodType<CasLeaseResult> = z.object({
  hash: CasHashSchema.describe("Digest of the ready node whose lease is protected."),
  ready: z.literal(true).describe("Always true when canonical content is already available."),
  leaseStartedAt: TimestampSchema.describe("Start of the current uninterrupted lease period."),
  leaseExpiresAt: TimestampSchema.describe("Service-selected protection deadline; it may exceed the requested duration."),
}).readonly().meta({ id: "CasLeaseResult" });

export const CasUploadRequiredResultSchema: z.ZodType<CasUploadRequiredResult> = z.object({
  hash: CasHashSchema.describe("Digest reserved for the pending node upload."),
  ready: z.literal(false).describe("Always false while canonical content still needs to be uploaded."),
  status: z.literal("upload_required").describe("Indicates that the caller must complete the returned direct upload."),
  uploadId: z.string().min(1).describe("Opaque reservation identity used to correlate upload completion."),
  expiresAt: TimestampSchema.describe("Time at which the upload reservation and signed instructions expire."),
  upload: z.object({
    method: z.literal("PUT").describe("HTTP method required by the signed upload target."),
    url: z.url().describe("Short-lived signed URL for uploading the canonical node bytes."),
    headers: z.record(z.string(), z.string()).readonly()
      .describe("Headers that must be sent exactly as returned when uploading content."),
  }).readonly().describe("Direct-upload request that the caller must execute before retrying the lease operation."),
}).readonly().meta({ id: "CasUploadRequiredResult" });

export const CasLeaseOperationResultSchema: z.ZodType<CasLeaseOperationResult> =
  z.union([CasLeaseResultSchema, CasUploadRequiredResultSchema])
    .meta({ id: "CasLeaseOperationResult" });

export const CasReferencesSchema: z.ZodType<CasReferences> =
  z.record(CasHashSchema, z.number().int()).readonly()
    .describe("Reference counts keyed by child node digest.")
    .meta({ id: "CasReferences" });

export const CasRefChangesSchema: z.ZodType<CasRefChanges> =
  z.record(CasHashSchema, z.number().int()).readonly()
    .describe("Signed, non-zero Root Ref deltas keyed by node digest. Positive values acquire references; negative values release them.")
    .meta({ id: "CasRefChanges" });

export const CasRootRefUpdateSchema: z.ZodType<CasRootRefUpdate> = z.object({
  requestId: z.string().min(1)
    .describe("Stable caller-generated idempotency identity. Retrying the same requestId with the same changes returns the original result."),
  changes: CasRefChangesSchema.describe("Complete atomic set of Root Ref balance changes for this commit."),
}).readonly().meta({ id: "CasRootRefUpdate" });

export const CasRootRefBalanceSchema: z.ZodType<CasRootRefBalance> = z.object({
  hash: CasHashSchema.describe("Node whose business Root Ref balance is reported."),
  refCount: z.number().int().describe("Current balance in the capability's refDomain."),
}).readonly().meta({ id: "CasRootRefBalance" });

export const CasRootRefsPageSchema: z.ZodType<CasRootRefsPage> = z.object({
  refDomain: z.string().min(1).describe("Business lifecycle namespace taken from the verified capability, never from caller input."),
  revision: z.number().int().nonnegative().describe("Stable Root Ref snapshot revision represented by this page."),
  items: z.array(CasRootRefBalanceSchema).readonly().describe("Root Ref balances in this page."),
  nextCursor: z.string().min(1).nullable().describe("Opaque cursor for the next page, or null when this snapshot is exhausted."),
}).readonly().meta({ id: "CasRootRefsPage" });

export const CasUsageSchema: z.ZodType<CasUsage> = z.object({
  nodeCount: z.number().int().nonnegative().describe("Total node metadata rows owned by the tenant."),
  readyContentBytes: z.number().int().nonnegative().describe("Logical bytes of nodes whose canonical content is ready."),
  readyStoredBytes: z.number().int().nonnegative().describe("Physical stored bytes attributed to ready node content."),
  reservedBytes: z.number().int().nonnegative().describe("Bytes reserved by incomplete uploads."),
  notReadyNodeCount: z.number().int().nonnegative().describe("Nodes that have metadata or a reservation but no ready content."),
  leasedNodeCount: z.number().int().nonnegative().describe("Nodes currently protected by an unexpired lease."),
}).readonly().meta({ id: "CasUsage" });

export const CasGcResultSchema: z.ZodType<CasGcResult> = z.object({
  examined: z.number().int().nonnegative().describe("Candidate nodes examined during this bounded collection pass."),
  deleted: z.number().int().nonnegative().describe("Eligible node records and content objects deleted by this pass."),
  reclaimedContentBytes: z.number().int().nonnegative().describe("Logical content bytes reclaimed by successful deletions."),
}).readonly().meta({ id: "CasGcResult" });

export const CasNodeSchema: z.ZodType<CasNode> = z.object({
  metadata: CasNodeMetadataSchema,
  content: z.instanceof(ReadableStream<Uint8Array>),
}).readonly().meta({ id: "CasNode" });