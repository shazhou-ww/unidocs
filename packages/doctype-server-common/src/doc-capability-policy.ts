import type { DocOperation } from "@unidocs/protocol-doc";
import {
  casReadPermission,
  casWritePermission,
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "@unidocs/service-auth";
import type { CapabilityPermission } from "@unidocs/service-auth";

export interface DocEdgeCapabilityRequirements {
  readonly docPermission: CapabilityPermission;
  readonly casPermissions: readonly CapabilityPermission[];
}

export function docEdgeCapabilityRequirements(
  operation: DocOperation,
  tenantId: string,
  sessionId: string,
): DocEdgeCapabilityRequirements {
  switch (operation) {
    case "create":
      return requirements(sessionCreatePermission(tenantId), [casWritePermission(tenantId)]);
    case "status":
      return requirements(sessionCreatePermission(tenantId), []);
    case "query":
    case "export":
      return requirements(sessionReadPermission(tenantId, sessionId), [casReadPermission(tenantId)]);
    case "history":
    case "ir":
      return requirements(sessionReadPermission(tenantId, sessionId), []);
    case "snapshot":
      return requirements(sessionReadPermission(tenantId, sessionId), [casWritePermission(tenantId)]);
    case "apply":
    case "rollback":
    case "run":
      return requirements(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
      );
    case "initFromHash":
      return requirements(sessionWritePermission(tenantId, sessionId), [casWritePermission(tenantId)]);
    case "reset":
      return requirements(sessionWritePermission(tenantId, sessionId), []);
  }
}

function requirements(
  docPermission: CapabilityPermission,
  casPermissions: readonly CapabilityPermission[],
): DocEdgeCapabilityRequirements {
  return Object.freeze({
    docPermission,
    casPermissions: Object.freeze([...casPermissions]),
  });
}