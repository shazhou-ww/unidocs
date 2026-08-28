/**
 * @unidocs/cloudflare-sdk — Cloudflare runtime for UniDocs.
 *
 * Provides types and runtime for building document editor/operator pairs.
 */

// Cloud-neutral types
export type {
	AgentContentPart,
	AgentToolResult,
	AgentPlatform,
	AgentTool,
	DocumentAgent,
	DocumentType,
	AgentToolDefinition,
	DocumentFormat,
	DocumentTypeFactory,
	DocumentTypeContext,
	MakeSBlob,
	JsonPrimitive,
	JsonValue,
	SBlob,
	SBlobBytes,
	SBlobHandler,
	SBlobReadRange,
	SBlobSource,
	SPrimitive,
	SValue,
	SValueType,
} from "@unidocs/protocol";
export {
	decodeSValue,
	encodeSValue,
	isSBlob,
} from "@unidocs/svalue-codec";
export { SValueContentType } from "@unidocs/protocol";
export type { HistoryEntry, ApplyResult, RollbackResult, CreateResult } from "./history.js";
export type { EditorDOClass, EditorDOInstance } from "./editor-do.js";
export type { OperatorDOClass, OperatorDOInstance } from "./operator-do.js";

// Runtime
export { createEditorDO, type Env as EditorEnv } from "./editor-do.js";
export {
	createOperatorDO,
	createCloudflareAgentPlatform,
	type CloudflarePlatformDeps,
	type OperatorConfig,
} from "./operator-do.js";
export {
	DoDeltaLog,
	DoSnapshotCache,
	R2BlobCas,
	DirectUnitOfWork,
} from "./ports-cf.js";
export {
	CasClientError,
} from "@unicas/client";
export {
	createSBlobContext,
	SBlobIntegrityError,
} from "./sblob-context.js";
export type {
	SBlobCasAdapter,
	SBlobContextOptions,
} from "./sblob-context.js";
