import { oc } from "@orpc/contract";
import { JSON_SCHEMA_INPUT_REGISTRY } from "@orpc/zod/zod4";
import { z } from "zod";
import {
  CasGcResultSchema,
  CasHashSchema,
  CasLeaseOperationResultSchema,
  CasNodeMetadataSchema,
  CasNodeStateSchema,
  CasRootRefsPageSchema,
  CasRootRefUpdateSchema,
  CasUsageSchema,
} from "./schemas.js";

export const CasTenantApiBasePath = "/stacks/{stackId}/tenants/{tenantId}";

const CasErrorDataSchema = z.object({ message: z.string().optional() }).readonly();

export const CasApiErrorMap = {
  INVALID_REQUEST: { status: 400, message: "The CAS request is invalid", data: CasErrorDataSchema },
  UNAUTHORIZED: { status: 401, message: "A valid tenant capability is required", data: CasErrorDataSchema },
  FORBIDDEN: { status: 403, message: "The capability does not grant this operation", data: CasErrorDataSchema },
  NOT_FOUND: { status: 404, message: "The requested CAS resource was not found", data: CasErrorDataSchema },
  CONFLICT: { status: 409, message: "The CAS mutation conflicts with current state", data: CasErrorDataSchema },
  PAYLOAD_TOO_LARGE: { status: 413, message: "The CAS payload exceeds the configured limit", data: CasErrorDataSchema },
  INTERNAL_ERROR: { status: 500, message: "The CAS operation failed", data: CasErrorDataSchema },
} as const;

const tenantProcedure = oc.errors(CasApiErrorMap);
const tenantParams = z.object({
  stackId: z.string().min(1).describe("Opaque UniCAS stack identifier that scopes issuer trust and tenant storage."),
  tenantId: z.string().min(1).describe("Tenant storage partition within the stack. The capability must authorize this exact tenant."),
}).readonly();
const nodeParams = tenantParams.unwrap().extend({
  hash: CasHashSchema.describe("Lowercase SHA-256 content digest."),
}).readonly();
const BinaryStreamSchema = z.instanceof(ReadableStream<Uint8Array>);

JSON_SCHEMA_INPUT_REGISTRY.add(BinaryStreamSchema, {
  type: "string",
  contentMediaType: "application/vnd.unidocs.cas-node.v1",
  contentEncoding: "binary",
});

export const readContentContract = tenantProcedure
  .route({
    method: "GET",
    path: `${CasTenantApiBasePath}/cas/nodes/{hash}/content`,
    operationId: "readContent",
    summary: "Read immutable node content",
    description: "Streams the canonical bytes for a ready content-addressed node. The path hash is the SHA-256 digest of those bytes; callers should verify the digest after reading. Metadata and mutable lease/reference state are available from the metadata operation. A missing or not-ready node returns `NOT_FOUND`.",
    inputStructure: "detailed",
    tags: ["Nodes"],
  })
  .input(z.object({ params: nodeParams }).readonly())
  .output(BinaryStreamSchema);

export const readMetadataContract = tenantProcedure
  .route({
    method: "GET",
    path: `${CasTenantApiBasePath}/cas/nodes/{hash}/metadata`,
    operationId: "readMetadata",
    summary: "Read node metadata",
    description: "Returns immutable node metadata together with current lease and reference state. `metadata.refs` describes the stored DAG edges and never changes for a digest. Lease timestamps and reference counts are mutable retention state and must not be included when recomputing the content hash.",
    inputStructure: "detailed",
    tags: ["Nodes"],
  })
  .input(z.object({ params: nodeParams }).readonly())
  .output(z.object({ metadata: CasNodeMetadataSchema, state: CasNodeStateSchema })
    .readonly().meta({ id: "CasReadMetadataResponse" }));

export const leaseContract = tenantProcedure
  .route({
    method: "POST",
    path: `${CasTenantApiBasePath}/cas/nodes/{hash}/lease`,
    operationId: "leaseNode",
    summary: "Lease or upload a node",
    description: "Protects a node from garbage collection while a business transaction is preparing a Root Ref commit. If the node is ready, UniCAS extends its lease and returns `ready: true`. Otherwise it reserves the digest and returns `ready: false` with a short-lived direct `PUT` upload request. Send the returned headers exactly, then retry this operation with the upload identity to finalize readiness. The service chooses the actual lease deadline; clients must renew before it expires when work may run longer.",
    inputStructure: "detailed",
    tags: ["Nodes"],
  })
  .input(z.object({
    params: nodeParams,
    headers: z.object({
      "x-cas-lease-duration": z.number().int().positive().optional()
        .describe("Requested lease duration in milliseconds. UniCAS may grant a later deadline."),
      "x-cas-upload-length": z.number().int().nonnegative().optional()
        .describe("Expected canonical upload length in bytes when reserving missing content."),
      "x-cas-upload-id": z.string().min(1).optional()
        .describe("Opaque upload identity returned by a previous reservation attempt."),
      "content-type": z.literal("application/vnd.unidocs.cas-node.v1").optional()
        .describe("Canonical CAS node media type when node bytes are supplied inline."),
      "content-length": z.number().int().nonnegative().optional()
        .describe("Exact length of an inline canonical node body."),
    }).readonly(),
    body: BinaryStreamSchema.optional(),
  }).readonly())
  .output(CasLeaseOperationResultSchema);

export const getUsageContract = tenantProcedure
  .route({
    method: "GET",
    path: `${CasTenantApiBasePath}/cas/usage`,
    operationId: "getUsage",
    summary: "Read tenant CAS usage",
    description: "Returns a current operational accounting snapshot for one tenant: metadata rows, logical and stored ready bytes, pending reservations, not-ready nodes, and active leases. Counters are diagnostic and may change immediately as uploads, leases, Root Refs, and garbage collection progress.",
    inputStructure: "detailed",
    tags: ["Operations"],
  })
  .input(z.object({ params: tenantParams }).readonly())
  .output(CasUsageSchema);

export const runGcContract = tenantProcedure
  .route({
    method: "POST",
    path: `${CasTenantApiBasePath}/cas/gc`,
    operationId: "runGc",
    summary: "Run tenant garbage collection",
    description: "Runs one bounded garbage-collection pass. A node is eligible only when it has no positive root or child references and its lease has expired. Eligibility is rechecked inside the tenant mutation queue before deletion, closing races with concurrent lease and Root Ref operations. Repeated calls are expected until the desired amount of work has been examined.",
    inputStructure: "detailed",
    tags: ["Operations"],
  })
  .input(z.object({
    params: tenantParams,
    body: z.object({
      maxNodes: z.number().int().positive().optional()
        .describe("Optional upper bound on candidate nodes examined by this pass."),
    }).readonly().optional(),
  }).readonly())
  .output(CasGcResultSchema);

export const listRootRefsContract = tenantProcedure
  .route({
    method: "GET",
    path: `${CasTenantApiBasePath}/root-refs`,
    operationId: "listRootRefs",
    summary: "List Root Ref balances",
    description: "Returns a cursor-paginated, revision-stable snapshot of Root Ref balances in the `refDomain` carried by the verified capability. The caller cannot select another refDomain. Pass `nextCursor` unchanged to continue; cursors are opaque and bound to the snapshot and filters.",
    inputStructure: "detailed",
    tags: ["Root Refs"],
  })
  .input(z.object({
    params: tenantParams,
    query: z.object({
      limit: z.number().int().min(1).max(1000).optional()
        .describe("Maximum balances to return, from 1 through 1000."),
      cursor: z.string().min(1).optional()
        .describe("Opaque `nextCursor` from the preceding page. Do not parse or modify it."),
    }).readonly().optional(),
  }).readonly())
  .output(CasRootRefsPageSchema);

export const updateRootRefsContract = tenantProcedure
  .route({
    method: "POST",
    path: `${CasTenantApiBasePath}/root-refs`,
    operationId: "updateRootRefs",
    summary: "Apply signed Root Ref changes",
    description: "Atomically applies the complete set of signed Root Ref deltas in the `refDomain` carried by the verified capability. This is the business commit boundary: positive balances retain committed DAG roots and negative balances release obsolete roots. A positive reference is accepted only for a ready node. Retry an uncertain result with the identical `requestId` and changes; UniCAS returns the original revision with `idempotent: true` instead of applying the delta twice.",
    inputStructure: "detailed",
    tags: ["Root Refs"],
  })
  .input(z.object({ params: tenantParams, body: CasRootRefUpdateSchema }).readonly())
  .output(z.object({
    success: z.literal(true).describe("Always true for a committed or successfully replayed update."),
    idempotent: z.boolean().describe("True when this response replays a previously committed requestId."),
    revision: z.number().int().nonnegative().describe("Root Ref revision assigned to the original atomic commit."),
  }).readonly().meta({ id: "CasUpdateRootRefsResponse" }));

export const casTenantApiContract = {
  nodes: { readContent: readContentContract, readMetadata: readMetadataContract, lease: leaseContract },
  operations: { getUsage: getUsageContract, runGc: runGcContract },
  rootRefs: { list: listRootRefsContract, update: updateRootRefsContract },
};

export type CasTenantApiContract = typeof casTenantApiContract;