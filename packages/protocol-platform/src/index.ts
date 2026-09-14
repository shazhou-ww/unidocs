/**
 * Public entrypoint for every @unidocs/protocol-platform contract: the type
 * surface, the runtime schemas that mirror it, and the oRPC contracts.
 */
export {
	DocumentContentFormatVersion,
	DocumentTypePattern,
	SValueContentType,
	documentLocationContentType,
	documentSnapshotContentType,
} from "@unidocs/protocol";
export type { DocumentLocationContentType, DocumentSnapshotContentType } from "@unidocs/protocol";
export type { JsonPrimitive, JsonValue, SBlob, SValue, SValueSchema } from "@unidocs/protocol";
export type * from "./agent.js";
export type * from "./common.js";
export type * from "./messages.js";
export type * from "./operator.js";
export type * from "./resources.js";
export type * from "./view.js";
export * from "./schemas.js";
export {
	agentApiContract,
	AgentApiErrorMap,
	AgentApiV1BasePath,
	createSubmissionContract,
	getSubmissionContract,
	notifyDocumentContract,
	operatorWebhookContract,
} from "./contract.js";
export type { AgentApiContract, OperatorWebhookContract } from "./contract.js";
