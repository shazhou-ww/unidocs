import type { CasRoute } from "@unidocs/protocol-cas";
import type { DocOperation } from "@unidocs/protocol-doc";
import {
  casAdminPermission,
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
  readonly deadlineSeconds: 15 | 30 | 60 | 90;
  readonly lifetimeSeconds: 120;
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
    case "ir":
      return policy(sessionReadPermission(tenantId, sessionId), [], 30);
    case "snapshot":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casWritePermission(tenantId)],
        60,
      );
    case "apply":
    case "rollback":
    case "run":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        90,
      );
    case "initFromHash":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casWritePermission(tenantId)],
        60,
      );
    case "reset":
      return policy(sessionWritePermission(tenantId, sessionId), [], 30);
  }
}

export function casCapabilityPolicy(route: CasRoute): CasCapabilityPolicy {
  switch (route.operation) {
    case "readContent":
    case "readMetadata":
      return {
        permission: casReadPermission(route.tenantId),
        requiresTenantAdmin: false,
        lifetimeSeconds: 120,
      };
    case "leaseNode":
    case "leaseExisting":
      return {
        permission: casWritePermission(route.tenantId),
        requiresTenantAdmin: false,
        lifetimeSeconds: 120,
      };
    case "usage":
    case "gc":
      return {
        permission: casAdminPermission(route.tenantId),
        requiresTenantAdmin: true,
        lifetimeSeconds: 120,
      };
    default:
      throw new TypeError(`CAS operation ${route.operation} is not public`);
  }
}

function policy(
  docPermission: CapabilityPermission,
  delegatedCasPermissions: readonly CapabilityPermission[],
  deadlineSeconds: 15 | 30 | 60 | 90,
): DocCapabilityPolicy {
  return Object.freeze({
    docPermission,
    delegatedCasPermissions: Object.freeze([...delegatedCasPermissions]),
    deadlineSeconds,
    lifetimeSeconds: 120,
  });
}