/** Canonical Durable Object names and stack-scoped R2 node keys. */
export function canonicalComposite(stackId: string, component: string): string {
  if (stackId.length === 0 || component.length === 0) {
    throw new TypeError("DO composite parts must not be empty");
  }
  return `${encodeURIComponent(stackId)}|${encodeURIComponent(component)}`;
}

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

export function stackCanonicalNodeKey(stackId: string, tenantId: string, hash: string): string {
  return `stacks/${stackId}/tenants/${tenantId}/nodes-v2/${hash}`;
}
