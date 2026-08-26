export function docSessionObjectName(tenantId: string, sessionId: string): string {
  if (tenantId.length === 0 || sessionId.length === 0) {
    throw new TypeError("Doc tenant and session IDs must not be empty");
  }
  return `v1:${byteLength(tenantId)}:${tenantId}:${byteLength(sessionId)}:${sessionId}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function docStorageIdentityKey(
  tenantId: string,
  docType: string,
  sessionId: string,
): string {
  if (tenantId.length === 0 || docType.length === 0 || sessionId.length === 0) {
    throw new TypeError("Doc tenant, type, and session IDs must not be empty");
  }
  return ["v1", tenantId, docType, sessionId]
    .map((value, index) => index === 0 ? value : `${byteLength(value)}:${value}`)
    .join(":");
}