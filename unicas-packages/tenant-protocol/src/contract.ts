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
  stackId: z.string().min(1).describe("CAS stack identifier."),
  tenantId: z.string().min(1).describe("Tenant identifier within the stack."),
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
    description: "Streams the canonical bytes for a ready content-addressed node.",
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
    description: "Returns immutable node metadata together with current lease and reference state.",
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
    description: "Extends a ready node lease, or reserves an upload and returns upload instructions.",
    inputStructure: "detailed",
    tags: ["Nodes"],
  })
  .input(z.object({
    params: nodeParams,
    headers: z.object({
      "x-cas-lease-duration": z.number().int().positive().optional(),
      "x-cas-upload-length": z.number().int().nonnegative().optional(),
      "x-cas-upload-id": z.string().min(1).optional(),
      "content-type": z.literal("application/vnd.unidocs.cas-node.v1").optional(),
      "content-length": z.number().int().nonnegative().optional(),
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
    description: "Returns node, content-byte, reservation, and lease counters for one tenant.",
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
    description: "Examines unreferenced, unleased nodes and reclaims eligible stored content.",
    inputStructure: "detailed",
    tags: ["Operations"],
  })
  .input(z.object({
    params: tenantParams,
    body: z.object({ maxNodes: z.number().int().positive().optional() }).readonly().optional(),
  }).readonly())
  .output(CasGcResultSchema);

export const listRootRefsContract = tenantProcedure
  .route({
    method: "GET",
    path: `${CasTenantApiBasePath}/root-refs`,
    operationId: "listRootRefs",
    summary: "List Root Ref balances",
    description: "Returns a cursor-paginated snapshot of balances in the capability's refDomain.",
    inputStructure: "detailed",
    tags: ["Root Refs"],
  })
  .input(z.object({
    params: tenantParams,
    query: z.object({
      limit: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().min(1).optional(),
    }).readonly().optional(),
  }).readonly())
  .output(CasRootRefsPageSchema);

export const updateRootRefsContract = tenantProcedure
  .route({
    method: "POST",
    path: `${CasTenantApiBasePath}/root-refs`,
    operationId: "updateRootRefs",
    summary: "Apply signed Root Ref changes",
    description: "Atomically applies idempotent balance changes in the capability's refDomain.",
    inputStructure: "detailed",
    tags: ["Root Refs"],
  })
  .input(z.object({ params: tenantParams, body: CasRootRefUpdateSchema }).readonly())
  .output(z.object({
    success: z.literal(true),
    idempotent: z.boolean(),
    revision: z.number().int().nonnegative(),
  }).readonly().meta({ id: "CasUpdateRootRefsResponse" }));

export const casTenantApiContract = {
  nodes: { readContent: readContentContract, readMetadata: readMetadataContract, lease: leaseContract },
  operations: { getUsage: getUsageContract, runGc: runGcContract },
  rootRefs: { list: listRootRefsContract, update: updateRootRefsContract },
};

export type CasTenantApiContract = typeof casTenantApiContract;