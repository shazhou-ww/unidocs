/**
 * Canonical stack-scoped CAS tenant route matcher.
 *
 * Matches only `/stacks/{stackId}/tenants/{tenantId}/...` service routes and
 * never `/admin`. Every `CasRoute` variant carries `stackId + tenantId`.
 * Gateway exposure policy is NOT a property of this matcher — the Gateway
 * owns its allowlist (`isGatewayExposedCasRoute` in @unidocs/protocol-gateway).
 */

export type CasRoute =
  | { operation: "readContent"; stackId: string; tenantId: string; hash: string }
  | { operation: "readMetadata"; stackId: string; tenantId: string; hash: string }
  | { operation: "lease"; stackId: string; tenantId: string; hash: string }
  | { operation: "usage"; stackId: string; tenantId: string }
  | { operation: "gc"; stackId: string; tenantId: string }
  | { operation: "listRootRefs"; stackId: string; tenantId: string }
  | { operation: "updateRootRefs"; stackId: string; tenantId: string };

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
  readContent: ({ stackId, tenantId, hash }: { stackId: string; tenantId: string; hash: string }) =>
    `/stacks/${segment(stackId)}/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/content`,
  readMetadata: ({ stackId, tenantId, hash }: { stackId: string; tenantId: string; hash: string }) =>
    `/stacks/${segment(stackId)}/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/metadata`,
  lease: ({ stackId, tenantId, hash }: { stackId: string; tenantId: string; hash: string }) =>
    `/stacks/${segment(stackId)}/tenants/${segment(tenantId)}/cas/nodes/${segment(hash)}/lease`,
  usage: ({ stackId, tenantId }: { stackId: string; tenantId: string }) =>
    `/stacks/${segment(stackId)}/tenants/${segment(tenantId)}/cas/usage`,
  gc: ({ stackId, tenantId }: { stackId: string; tenantId: string }) =>
    `/stacks/${segment(stackId)}/tenants/${segment(tenantId)}/cas/gc`,
  updateRootRefs: ({ stackId, tenantId }: { stackId: string; tenantId: string }) =>
    `/stacks/${segment(stackId)}/tenants/${segment(tenantId)}/root-refs`,
  listRootRefs: (
    { stackId, tenantId }: { stackId: string; tenantId: string },
    query: { readonly limit?: number; readonly cursor?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const suffix = params.size === 0 ? "" : `?${params}`;
    return `/stacks/${segment(stackId)}/tenants/${segment(tenantId)}/root-refs${suffix}`;
  },
} as const;

/** Matches only stack-and-tenant service routes. Never /admin. */
export function matchCasRoute(method: string, pathname: string): CasRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "stacks" || !parts[1] || parts[2] !== "tenants" || !parts[3]) {
    return null;
  }

  const stackId = decodeSegment(parts[1]);
  const tenantId = decodeSegment(parts[3]);
  if (stackId === null || tenantId === null) return null;

  if (parts.length === 5 && parts[4] === "root-refs") {
    if (method === "GET") return { operation: "listRootRefs", stackId, tenantId };
    if (method === "POST") return { operation: "updateRootRefs", stackId, tenantId };
    return null;
  }

  if (parts[4] !== "cas") return null;
  if (parts.length === 6 && parts[5] === "usage" && method === "GET") {
    return { operation: "usage", stackId, tenantId };
  }
  if (parts.length === 6 && parts[5] === "gc" && method === "POST") {
    return { operation: "gc", stackId, tenantId };
  }
  if (parts[5] !== "nodes" || !parts[6]) return null;

  const hash = decodeSegment(parts[6]);
  if (hash === null) return null;
  if (parts.length !== 8) return null;
  if (parts[7] === "content" && method === "GET") {
    return { operation: "readContent", stackId, tenantId, hash };
  }
  if (parts[7] === "metadata" && method === "GET") {
    return { operation: "readMetadata", stackId, tenantId, hash };
  }
  if (parts[7] === "lease" && method === "POST") {
    return { operation: "lease", stackId, tenantId, hash };
  }
  return null;
}
