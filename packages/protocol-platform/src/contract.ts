import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  AgentSubmissionRequestSchema,
  IdSchema,
  OperatorWebhookRequestSchema,
  OperatorWebhookResponseSchema,
  SubmissionReceiptSchema,
} from "./schemas.js";

/** Identical to the tenant API base path: an Agent addresses the same resources. */
export const AgentApiV1BasePath = "/api/v1/tenants/{tenantId}";

const ErrorDataSchema = z.object({
  requestId: IdSchema,
}).readonly();

const agentProcedure = oc.errors({
  INVALID_REQUEST: { status: 400, message: "The request is invalid", data: ErrorDataSchema },
  UNAUTHORIZED: { status: 401, message: "Agent authentication is required", data: ErrorDataSchema },
  FORBIDDEN: { status: 403, message: "The Agent is not allowed to perform this operation", data: ErrorDataSchema },
  NOT_FOUND: { status: 404, message: "The requested resource was not found", data: ErrorDataSchema },
  UNAVAILABLE: { status: 503, message: "The Platform is temporarily unavailable", data: ErrorDataSchema },
});

const documentParams = z.object({
  tenantId: IdSchema.describe("Tenant that owns the document."),
  documentId: IdSchema.describe("Document being submitted against."),
}).readonly();

const submissionParams = z.object({
  tenantId: IdSchema,
  documentId: IdSchema,
  submissionId: IdSchema.describe("Submission whose durable receipt is being read."),
}).readonly();

export const createSubmissionContract = agentProcedure
  .errors({
    CONTENT_UNAVAILABLE: { status: 409, message: "The referenced snapshot blob is not readable", data: ErrorDataSchema },
    LOCATION_CONTRACT_VIOLATION: { status: 422, message: "A location does not satisfy its Document Contract location schema", data: ErrorDataSchema },
  })
  .route({
    method: "POST",
    path: `${AgentApiV1BasePath}/documents/{documentId}/submissions`,
    operationId: "createSubmission",
    summary: "Atomically create a version and append replies",
    description: "Validates both optimistic locks, optionally creates a version from a snapshot the Agent already wrote to UniCAS, appends every reply, advances the addressed thread watermarks, and persists a durable receipt. A lock failure is NOT an error status: the response is a rejected receipt carrying the current conflict, because the Agent recomputes from it and resubmits.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Submissions"],
  })
  .input(z.object({
    params: documentParams,
    body: AgentSubmissionRequestSchema,
  }).readonly())
  .output(SubmissionReceiptSchema);

export const getSubmissionContract = agentProcedure
  .route({
    method: "GET",
    path: `${AgentApiV1BasePath}/documents/{documentId}/submissions/{submissionId}`,
    operationId: "getSubmission",
    summary: "Read a durable submission receipt",
    description: "Recovers the receipt after a timeout or retry without repeating the work.",
    inputStructure: "detailed",
    tags: ["Submissions"],
  })
  .input(z.object({ params: submissionParams }).readonly())
  .output(SubmissionReceiptSchema);

export const notifyDocumentContract = oc
  .route({
    method: "POST",
    path: "/tenants/{tenantId}/documents/{documentId}",
    operationId: "notifyDocument",
    summary: "Deliver an incremental Operator work notification",
    description: "At-least-once delivery. Acceptance does not imply the corresponding Agent work has completed; the payload is a work hint, not a transaction boundary.",
    inputStructure: "detailed",
    tags: ["Operator"],
  })
  .input(z.object({
    params: z.object({ tenantId: IdSchema, documentId: IdSchema }).readonly(),
    body: OperatorWebhookRequestSchema,
  }).readonly())
  .output(OperatorWebhookResponseSchema);

export const agentApiContract = {
  submissions: {
    create: createSubmissionContract,
    get: getSubmissionContract,
  },
};

export const operatorWebhookContract = {
  notifyDocument: notifyDocumentContract,
};

export type AgentApiContract = typeof agentApiContract;
export type OperatorWebhookContract = typeof operatorWebhookContract;
