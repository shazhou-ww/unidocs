/**
 * @unidocs/cloudflare-sdk — Cloudflare runtime for UniDocs.
 *
 * Provides types and runtime for building document editor/operator pairs.
 */

// Cloud-neutral types
export type {
	DocumentType,
	AgentToolDefinition,
	DocumentTypeFactory,
	QueryPrimitive,
	QueryValue,
} from "@unidocs/core";
export type { HistoryEntry, ApplyResult, RollbackResult, CreateResult } from "./history.js";
export type { DocContext, SnapshotRecord, EditorDOClass, EditorDOInstance } from "./editor-do.js";
export type { OperatorDOClass, OperatorDOInstance } from "./operator-do.js";
export type { BinaryQueryValue, EscapedQueryObject, WireQueryValue } from "./query-value.js";
export type { BlobStore } from "@unidocs/core";

// Runtime
export { createEditorDO, type Env as EditorEnv } from "./editor-do.js";
export { createOperatorDO, type OperatorConfig } from "./operator-do.js";
export { encodeQueryValue } from "./query-value.js";
export { computeHash } from "./content-hash.js";
export { createR2BlobStore } from "./blob-store.js";
