/**
 * @unidocs/cloudflare-sdk — Cloudflare runtime for UniDocs.
 *
 * Provides types and runtime for building document editor/operator pairs.
 */

// Cloud-neutral types
export type {
	AgentContentPart,
	AgentToolResult,
	DocumentType,
	AgentToolDefinition,
	DocumentAgent,
	DocumentAgentContext,
	DocumentAgentFactory,
	DocumentFormat,
	DocumentTypeFactory,
	DocumentTypeContext,
	MakeSBlob,
	JsonPrimitive,
	JsonValue,
	SBlob,
	SBlobData,
	SPrimitive,
	SValue,
	SValueType,
} from "@unidocs/core";
export {
	decodeSValue,
	encodeSValue,
	isSBlob,
	SValueContentType,
} from "@unidocs/core";
export type { HistoryEntry, ApplyResult, RollbackResult, CreateResult } from "./history.js";
export type { DocContext, SnapshotRecord, EditorDOClass, EditorDOInstance } from "./editor-do.js";
export type { OperatorDOClass, OperatorDOInstance } from "./operator-do.js";

// Runtime
export { createEditorDO, type Env as EditorEnv } from "./editor-do.js";
export {
	createOperatorDO,
	renderDefaultAgentToolResult,
	type AgentToolResultRenderer,
	type AgentToolResultRendererContext,
	type OperatorConfig,
} from "./operator-do.js";
export {
	DoDeltaLog,
	DoSnapshotCache,
	R2BlobCas,
	D1DocIndex,
	D1DocIndexQuery,
	DirectUnitOfWork,
} from "./ports-cf.js";
export {
	CasClient,
	CasClientError,
	type CasClientConfig,
} from "./cas-client.js";
export {
	createSBlobContext,
	SBlobIntegrityError,
} from "./sblob-context.js";
export type {
	SBlobCasAdapter,
	SBlobContextOptions,
} from "./sblob-context.js";
