declare const capabilityPermissionBrand: unique symbol;

export type CapabilityPermission = string & {
  readonly [capabilityPermissionBrand]: true;
};

export type CapabilityPermissionKind =
  | "cas:read"
  | "cas:write"
  | "cas:usage:read"
  | "cas:gc:trigger"
  /** Legacy tenant administration permission; retired with the legacy
   *  runtime (Task 10). Kept only for the remaining legacy-compatible
   *  callers until they move to the stack-scoped names below. */
  | "cas:admin"
  | "sessions:create"
  | "sessions:read"
  | "sessions:write";

export type ParsedCapabilityPermission = {
  readonly kind: CapabilityPermissionKind;
  readonly tenantId: string;
  readonly sessionId?: string;
};

export function canonicalPermissionSegment(value: string): string {
  if (value.length === 0) throw new TypeError("Capability resource IDs must not be empty");
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function casReadPermission(tenantId: string): CapabilityPermission {
  return tenantPermission(tenantId, "cas:read");
}

export function casWritePermission(tenantId: string): CapabilityPermission {
  return tenantPermission(tenantId, "cas:write");
}

export function casUsageReadPermission(tenantId: string): CapabilityPermission {
  // Wire format is `cas:<action>`; the parsed kind carries the full semantic.
  return `tenants:${canonicalPermissionSegment(tenantId)}:cas:usage` as CapabilityPermission;
}

export function casGcTriggerPermission(tenantId: string): CapabilityPermission {
  return `tenants:${canonicalPermissionSegment(tenantId)}:cas:gc` as CapabilityPermission;
}

/** @deprecated Legacy tenant CAS administration; retired with the legacy runtime (Task 10). */
export function casAdminPermission(tenantId: string): CapabilityPermission {
  return tenantPermission(tenantId, "cas:admin");
}

export function sessionCreatePermission(tenantId: string): CapabilityPermission {
  return tenantPermission(tenantId, "sessions:create");
}

export function sessionReadPermission(
  tenantId: string,
  sessionId: string,
): CapabilityPermission {
  return sessionPermission(tenantId, sessionId, "read");
}

export function sessionWritePermission(
  tenantId: string,
  sessionId: string,
): CapabilityPermission {
  return sessionPermission(tenantId, sessionId, "write");
}

export function parseCapabilityPermission(
  permission: string,
): ParsedCapabilityPermission | null {
  const parts = permission.split(":");
  if (parts[0] !== "tenants") return null;
  const tenantId = decodeCanonicalSegment(parts[1]);
  if (tenantId === null) return null;

  if (parts.length === 4 && parts[2] === "cas") {
    const action = parts[3];
    if (action === "read" || action === "write") {
      return { kind: `cas:${action}`, tenantId };
    }
    if (action === "usage") {
      return { kind: "cas:usage:read", tenantId };
    }
    if (action === "gc") {
      return { kind: "cas:gc:trigger", tenantId };
    }
    if (action === "admin") {
      return { kind: "cas:admin", tenantId };
    }
    return null;
  }

  if (parts.length === 4 && parts[2] === "sessions" && parts[3] === "create") {
    return { kind: "sessions:create", tenantId };
  }

  if (parts.length === 5 && parts[2] === "sessions") {
    const sessionId = decodeCanonicalSegment(parts[3]);
    const action = parts[4];
    if (sessionId !== null && (action === "read" || action === "write")) {
      return { kind: `sessions:${action}`, tenantId, sessionId };
    }
  }

  return null;
}

export function hasCapabilityPermission(
  permissions: readonly string[],
  expected: CapabilityPermission,
): boolean {
  return permissions.includes(expected);
}

function tenantPermission(
  tenantId: string,
  suffix:
    | "cas:read"
    | "cas:write"
    | "cas:admin"
    | "sessions:create",
): CapabilityPermission {
  return `tenants:${canonicalPermissionSegment(tenantId)}:${suffix}` as CapabilityPermission;
}

function sessionPermission(
  tenantId: string,
  sessionId: string,
  action: "read" | "write",
): CapabilityPermission {
  return `tenants:${canonicalPermissionSegment(tenantId)}:sessions:${canonicalPermissionSegment(sessionId)}:${action}` as CapabilityPermission;
}

function decodeCanonicalSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && canonicalPermissionSegment(decoded) === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}