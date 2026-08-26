/**
 * MIGRATION-ONLY legacy package — see ./types.ts header. Verbatim snapshot of
 * the tenant-scoped CAS route matcher including isPublicCasRoute.
 */

export type CasRoute =
  | { operation: "readContent"; tenantId: string; hash: string }
  | { operation: "readMetadata"; tenantId: string; hash: string }
  | { operation: "leaseNode"; tenantId: string; hash: string }
  | { operation: "leaseExisting"; tenantId: string; hash: string }
  | { operation: "usage"; tenantId: string }
  | { operation: "gc"; tenantId: string }
  | { operation: "rootRefs"; tenantId: string }
  | { operation: "rootAssignments"; tenantId: string }
  | { operation: "readPortableNode"; tenantId: string; hash: string }
  | { operation: "leasePortableNode"; tenantId: string; hash: string };

function segment(value: string): string {
  return encodeURIComponent(value);
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export const casRoutes = {
  readContent: ({ tenantId, hash }: { tenantId: string; hash: string }) =>
    `/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/content`,
  readMetadata: ({ tenantId, hash }: { tenantId: string; hash: string }) =>
    `/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/metadata`,
  leaseNode: ({ tenantId, hash }: { tenantId: string; hash: string }) =>
    `/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}`,
  leaseExisting: ({ tenantId, hash }: { tenantId: string; hash: string }) =>
    `/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/lease`,
  usage: ({ tenantId }: { tenantId: string }) =>
    `/tenants/${segment(tenantId)}/cas/usage`,
  gc: ({ tenantId }: { tenantId: string }) =>
    `/tenants/${segment(tenantId)}/cas/gc`,
  rootRefs: ({ tenantId }: { tenantId: string }) =>
    `/tenants/${segment(tenantId)}/_internal/root-refs`,
  rootAssignments: ({ tenantId }: { tenantId: string }) =>
    `/tenants/${segment(tenantId)}/_internal/root-assignments`,
  portableNode: ({ tenantId, hash }: { tenantId: string; hash: string }) =>
    `/tenants/${segment(tenantId)}/_internal/nodes/${segment(hash)}`,
} as const;

export function matchCasRoute(method: string, pathname: string): CasRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "tenants" || !parts[1]) return null;

  const tenantId = decodeSegment(parts[1]);
  if (tenantId === null) return null;

  if (parts[2] === "cas") {
    if (parts.length === 4 && parts[3] === "usage" && method === "GET") {
      return { operation: "usage", tenantId };
    }
    if (parts.length === 4 && parts[3] === "gc" && method === "POST") {
      return { operation: "gc", tenantId };
    }
    if (parts[3] !== "nodes" || !parts[4]) return null;

    const hash = decodeSegment(parts[4]);
    if (hash === null) return null;
    if (parts.length === 5 && method === "POST") {
      return { operation: "leaseNode", tenantId, hash };
    }
    if (parts.length !== 6) return null;
    if (parts[5] === "content" && method === "GET") {
      return { operation: "readContent", tenantId, hash };
    }
    if (parts[5] === "metadata" && method === "GET") {
      return { operation: "readMetadata", tenantId, hash };
    }
    if (parts[5] === "lease" && method === "POST") {
      return { operation: "leaseExisting", tenantId, hash };
    }
    return null;
  }

  if (parts[2] !== "_internal") return null;
  if (parts.length === 4 && parts[3] === "root-refs" && method === "POST") {
    return { operation: "rootRefs", tenantId };
  }
  if (parts.length === 4 && parts[3] === "root-assignments" && method === "POST") {
    return { operation: "rootAssignments", tenantId };
  }
  if (parts.length === 5 && parts[3] === "nodes" && parts[4]) {
    const hash = decodeSegment(parts[4]);
    if (hash === null) return null;
    if (method === "GET") return { operation: "readPortableNode", tenantId, hash };
    if (method === "POST") return { operation: "leasePortableNode", tenantId, hash };
  }
  return null;
}

export function isPublicCasRoute(method: string, pathname: string): boolean {
  const route = matchCasRoute(method, pathname);
  return route !== null && (
    route.operation === "readContent"
    || route.operation === "readMetadata"
    || route.operation === "leaseNode"
    || route.operation === "leaseExisting"
    || route.operation === "usage"
    || route.operation === "gc"
  );
}
