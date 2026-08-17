/**
 * @unidocs/sdk — Universal Docs SDK.
 *
 * Provides types and runtime for building document editor/operator pairs.
 */

// Types
export type { DocumentType, AgentToolDefinition } from "./types.js";
export type { HistoryEntry, ApplyResult, RollbackResult, CreateResult } from "./history.js";

// Runtime
export { createEditorDO } from "./editor-do.js";
export { createOperatorDO, type OperatorConfig } from "./operator-do.js";
