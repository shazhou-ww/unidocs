import { AdminAccessError } from "../auth/administrator.js";

export const ADMIN_MCP_SCOPES = ["admin:read", "admin:content", "admin:publish", "admin:security"] as const;
export type AdminMcpScope = typeof ADMIN_MCP_SCOPES[number];

function tool<const Scope extends AdminMcpScope>(scope: Scope, destructiveHint = false) {
  return {
    scope,
    annotations: {
      readOnlyHint: scope === "admin:read",
      destructiveHint,
      idempotentHint: true,
      openWorldHint: false,
    },
  } as const;
}

export const ADMIN_MCP_CATALOG = {
  whoami: tool("admin:read"),
  list_document_types: tool("admin:read"),
  get_document_type: tool("admin:read"),
  list_document_contracts: tool("admin:read"),
  get_document_contract: tool("admin:read"),
  list_type_card_bundles: tool("admin:read"),
  get_type_card_bundle: tool("admin:read"),
  list_view_bundles: tool("admin:read"),
  get_view_bundle: tool("admin:read"),
  get_operator_validation: tool("admin:read"),
  list_operators: tool("admin:read"),
  get_operator: tool("admin:read"),
  list_administrators: tool("admin:read"),
  get_administrator: tool("admin:read"),
  list_admin_audit_events: tool("admin:read"),
  append_document_contract: tool("admin:content"),
  upload_type_card_bundle: tool("admin:content"),
  update_type_card_bundle_metadata: tool("admin:content"),
  upload_view_bundle: tool("admin:content"),
  update_view_bundle_metadata: tool("admin:content"),
  create_operator_validation: tool("admin:content"),
  create_operator: tool("admin:content"),
  update_operator_metadata: tool("admin:content"),
  create_document_type: tool("admin:publish"),
  update_document_type: tool("admin:publish", true),
  add_administrator: tool("admin:security"),
  remove_administrator: tool("admin:security", true),
} as const;

export type AdminMcpToolName = keyof typeof ADMIN_MCP_CATALOG;

export interface AdminMcpPolicy {
  readonly enabled: boolean;
  readonly contentMutationsEnabled: boolean;
  readonly publishMutationsEnabled: boolean;
  readonly securityMutationsEnabled: boolean;
}

export function requireAdminMcpToolAccess(
  toolName: AdminMcpToolName,
  scopes: readonly string[],
  policy: AdminMcpPolicy,
): void {
  const scope = ADMIN_MCP_CATALOG[toolName].scope;
  const enabled = scope === "admin:read"
    || (scope === "admin:content" && policy.contentMutationsEnabled === true)
    || (scope === "admin:publish" && policy.publishMutationsEnabled === true)
    || (scope === "admin:security" && policy.securityMutationsEnabled === true);
  if (policy.enabled !== true || !enabled || !scopes.includes(scope)) throw new AdminAccessError("forbidden");
}