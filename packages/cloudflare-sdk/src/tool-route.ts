import type { AgentToolDefinition } from "@unidocs/core";

/**
 * Resolve how the operator should route a tool call. Prefers explicit `op`
 * metadata on the tool definition; falls back to the legacy `query_`/`apply_`
 * name-prefix convention so doctypes that haven't declared `op` still work.
 * Returns null for an unrecognized tool.
 */
export function resolveToolRoute(
  name: string,
  def?: AgentToolDefinition,
): { mode: "query" | "apply"; kind: string } | null {
  if (def?.op) return { mode: def.op.mode, kind: def.op.kind };
  if (name.startsWith("query_")) return { mode: "query", kind: name.slice(6) };
  if (name.startsWith("apply_")) return { mode: "apply", kind: name.slice(6) };
  return null;
}
