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
  .meta({ id: "CasHash" });

const TimestampSchema = z.number().int().nonnegative();

export const CasNodeMetadataSchema: z.ZodType<CasNodeMetadata> = z.object({
  hash: CasHashSchema,
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  refs: z.array(CasHashSchema).readonly(),
}).readonly().meta({ id: "CasNodeMetadata" });

export const CasNodeStateSchema: z.ZodType<CasNodeState> = z.object({
  leaseStartedAt: TimestampSchema,
  leaseExpiresAt: TimestampSchema,
  childRefCount: z.number().int().nonnegative(),
  rootRefCount: z.number().int(),
}).readonly().meta({ id: "CasNodeState" });

export const CasNodeDescriptorSchema: z.ZodType<CasNodeDescriptor> = z.object({
  hash: CasHashSchema,
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  refs: z.array(CasHashSchema).readonly(),
}).readonly().meta({ id: "CasNodeDescriptor" });

export const CasLeaseResultSchema: z.ZodType<CasLeaseResult> = z.object({
  hash: CasHashSchema,
  ready: z.literal(true),
  leaseStartedAt: TimestampSchema,
  leaseExpiresAt: TimestampSchema,
}).readonly().meta({ id: "CasLeaseResult" });

export const CasUploadRequiredResultSchema: z.ZodType<CasUploadRequiredResult> = z.object({
  hash: CasHashSchema,
  ready: z.literal(false),
  status: z.literal("upload_required"),
  uploadId: z.string().min(1),
  expiresAt: TimestampSchema,
  upload: z.object({
    method: z.literal("PUT"),
    url: z.url(),
    headers: z.record(z.string(), z.string()).readonly(),
  }).readonly(),
}).readonly().meta({ id: "CasUploadRequiredResult" });

export const CasLeaseOperationResultSchema: z.ZodType<CasLeaseOperationResult> =
  z.union([CasLeaseResultSchema, CasUploadRequiredResultSchema])
    .meta({ id: "CasLeaseOperationResult" });

export const CasReferencesSchema: z.ZodType<CasReferences> =
  z.record(CasHashSchema, z.number().int()).readonly().meta({ id: "CasReferences" });

export const CasRefChangesSchema: z.ZodType<CasRefChanges> =
  z.record(CasHashSchema, z.number().int()).readonly().meta({ id: "CasRefChanges" });

export const CasRootRefUpdateSchema: z.ZodType<CasRootRefUpdate> = z.object({
  requestId: z.string().min(1),
  changes: CasRefChangesSchema,
}).readonly().meta({ id: "CasRootRefUpdate" });

export const CasRootRefBalanceSchema: z.ZodType<CasRootRefBalance> = z.object({
  hash: CasHashSchema,
  refCount: z.number().int(),
}).readonly().meta({ id: "CasRootRefBalance" });

export const CasRootRefsPageSchema: z.ZodType<CasRootRefsPage> = z.object({
  refDomain: z.string().min(1),
  revision: z.number().int().nonnegative(),
  items: z.array(CasRootRefBalanceSchema).readonly(),
  nextCursor: z.string().min(1).nullable(),
}).readonly().meta({ id: "CasRootRefsPage" });

export const CasUsageSchema: z.ZodType<CasUsage> = z.object({
  nodeCount: z.number().int().nonnegative(),
  readyContentBytes: z.number().int().nonnegative(),
  readyStoredBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative(),
  notReadyNodeCount: z.number().int().nonnegative(),
  leasedNodeCount: z.number().int().nonnegative(),
}).readonly().meta({ id: "CasUsage" });

export const CasGcResultSchema: z.ZodType<CasGcResult> = z.object({
  examined: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  reclaimedContentBytes: z.number().int().nonnegative(),
}).readonly().meta({ id: "CasGcResult" });

export const CasNodeSchema: z.ZodType<CasNode> = z.object({
  metadata: CasNodeMetadataSchema,
  content: z.instanceof(ReadableStream<Uint8Array>),
}).readonly().meta({ id: "CasNode" });