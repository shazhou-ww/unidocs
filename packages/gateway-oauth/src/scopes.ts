import {
  casManagePermission,
  casReadPermission,
  casWritePermission,
} from "@unidocs/service-auth";
import type { CapabilityPermission } from "@unidocs/service-auth";

export const GatewayOAuthScopes = ["cas:read", "cas:write", "cas:manage"] as const;
export type GatewayOAuthScope = (typeof GatewayOAuthScopes)[number];

export function isGatewayOAuthScope(value: string): value is GatewayOAuthScope {
  return (GatewayOAuthScopes as readonly string[]).includes(value);
}

export function gatewayOAuthScopesToCapabilityPermissions(
  tenantId: string,
  scopes: readonly string[],
): readonly CapabilityPermission[] {
  if (tenantId.length === 0) throw new TypeError("Tenant ID must not be empty");
  if (scopes.length === 0) throw new TypeError("OAuth scopes must not be empty");
  const uniqueScopes = new Set<GatewayOAuthScope>();
  for (const scope of scopes) {
    if (!isGatewayOAuthScope(scope)) throw new TypeError(`Unsupported OAuth scope: ${scope}`);
    uniqueScopes.add(scope);
  }
  return Object.freeze([...uniqueScopes].map(scope => {
    switch (scope) {
      case "cas:read": return casReadPermission(tenantId);
      case "cas:write": return casWritePermission(tenantId);
      case "cas:manage": return casManagePermission(tenantId);
    }
  }));
}
