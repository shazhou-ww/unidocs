import { ADMIN_MCP_CATALOG, AdminAccessError, type AdminContext } from "@unidocs/portal-service";

export function auditAttribution(context: AdminContext): readonly [string, string | null, string | null] {
  const caller = context.caller;
  if (caller === undefined || caller.channel === "admin-webui") return ["admin-webui", null, null];
  if (caller.channel !== "mcp" || context.transport !== "bearer"
    || !/^[a-f0-9]{64}$/.test(caller.oauthClientHandle)
    || !Object.hasOwn(ADMIN_MCP_CATALOG, caller.toolName)) throw new AdminAccessError("forbidden");
  return ["mcp", caller.oauthClientHandle, caller.toolName];
}