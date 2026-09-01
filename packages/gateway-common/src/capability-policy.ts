import type { GatewayCasRoute } from "@unidocs/protocol-gateway";
import type { DocOperation } from "@unidocs/protocol-doc";
import {
  casManagePermission,
  casReadPermission,
  casWritePermission,
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "@unidocs/service-auth";
import type { CapabilityPermission } from "@unidocs/service-auth";

export interface DocCapabilityPolicy {
  readonly docPermission: CapabilityPermission;
  readonly delegatedCasPermissions: readonly CapabilityPermission[];
  readonly deadlineSeconds: 15 | 30 | 60 | 90 | 1800;
  readonly lifetimeSeconds: 120 | 1800;
}

export interface CasCapabilityPolicy {
  readonly permission: CapabilityPermission;
  readonly requiresTenantAdmin: boolean;
  readonly lifetimeSeconds: 120;
}

export function docCapabilityPolicy(
  operation: DocOperation,
  tenantId: string,
  sessionId: string,
): DocCapabilityPolicy {
  switch (operation) {
    case "create":
      return policy(
        sessionCreatePermission(tenantId),
        [casWritePermission(tenantId)],
        90,
      );
    case "status":
      return policy(sessionCreatePermission(tenantId), [], 15);
    case "query":
    case "export":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casReadPermission(tenantId)],
        60,
      );
    case "history":
      return policy(sessionReadPermission(tenantId, sessionId), [], 30);
    // `ir` returns canonical bytes whose SBlob refs the client then reads from
    // CAS, so the editor verifies those refs are live before encoding — that
    // check is a CAS read, not a free operation like `history`.
    case "ir":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casReadPermission(tenantId)],
        30,
      );
    case "snapshot":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casWritePermission(tenantId)],
        60,
      );
    case "apply":
    case "rollback":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        90,
      );
    // `run` 的权限集与 apply 完全相同，长的只有时间。agent 循环全程带着
    // 这里签出的 delegated-cas 凭据调编辑器，凭据过期后续写入就 401，
    // 所以窗口必须覆盖整次 run（spec 5.6.3）。
    case "run":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        1800,
        1800,
      );
    case "initFromHash":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        60,
      );
    case "reset":
      return policy(sessionWritePermission(tenantId, sessionId), [], 30);
  }
}

export function casCapabilityPolicy(route: GatewayCasRoute): CasCapabilityPolicy {
  switch (route.operation) {
    case "readContent":
    case "readMetadata":
      return {
        permission: casReadPermission(route.tenantId),
        requiresTenantAdmin: false,
        lifetimeSeconds: 120,
      };
    case "lease":
      return {
        permission: casWritePermission(route.tenantId),
        requiresTenantAdmin: false,
        lifetimeSeconds: 120,
      };
    case "usage":
    case "gc":
      return {
        permission: casManagePermission(route.tenantId),
        requiresTenantAdmin: true,
        lifetimeSeconds: 120,
      };
  }
}

function policy(
  docPermission: CapabilityPermission,
  delegatedCasPermissions: readonly CapabilityPermission[],
  deadlineSeconds: 15 | 30 | 60 | 90 | 1800,
  lifetimeSeconds: 120 | 1800 = 120,
): DocCapabilityPolicy {
  return Object.freeze({
    docPermission,
    delegatedCasPermissions: Object.freeze([...delegatedCasPermissions]),
    deadlineSeconds,
    lifetimeSeconds,
  });
}