/**
 * Canonical Durable Object name partitioning.
 *
 * DO names are built from two components with unambiguous encoding — each
 * component is URL-encoded and joined by `|`, which cannot appear inside an
 * encoded segment. The same composite function serves the tenant DO
 * (stackId, tenantId) and the Root Ref domain DO (stackId, refDomain);
 * separate DO class namespaces keep the names apart.
 */

export function canonicalComposite(stackId: string, component: string): string {
  if (stackId.length === 0 || component.length === 0) {
    throw new TypeError("DO composite parts must not be empty");
  }
  return `${encodeURIComponent(stackId)}|${encodeURIComponent(component)}`;
}

/** Decode a composite produced by `canonicalComposite`; null when malformed. */
export function decodeComposite(name: string): { stackId: string; component: string } | null {
  const separator = name.indexOf("|");
  if (separator === -1) return null;
  try {
    const stackId = decodeURIComponent(name.slice(0, separator));
    const component = decodeURIComponent(name.slice(separator + 1));
    if (stackId.length === 0 || component.length === 0) return null;
    if (canonicalComposite(stackId, component) !== name) return null;
    return { stackId, component };
  } catch {
    return null;
  }
}

/** R2 object key for tenant node content. */
export function stackNodeKey(stackId: string, tenantId: string, hash: string): string {
  return `stacks/${stackId}/tenants/${tenantId}/nodes/${hash}`;
}
