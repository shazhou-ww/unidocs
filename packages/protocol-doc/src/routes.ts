export type DocOperation =
  | "create"
  | "query"
  | "apply"
  | "export"
  | "history"
  | "rollback"
  | "snapshot"
  | "ir"
  | "initFromHash"
  | "run"
  | "reset";

export type DocRoute = {
  operation: DocOperation;
  tenantId: string;
  sessionId: string;
};

export type DocInternalOperation = DocOperation | "resolveBlob" | "readBlob";
export type DocInternalRoute = { operation: DocInternalOperation };

const operationRoutes = {
  query: { method: "POST", segment: "query" },
  apply: { method: "POST", segment: "apply" },
  export: { method: "GET", segment: "export" },
  history: { method: "GET", segment: "history" },
  rollback: { method: "POST", segment: "rollback" },
  snapshot: { method: "GET", segment: "snapshot" },
  ir: { method: "GET", segment: "ir" },
  initFromHash: { method: "POST", segment: "init_from_hash" },
  run: { method: "POST", segment: "run" },
  reset: { method: "POST", segment: "reset" },
} as const;

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

function sessionPath({ tenantId, sessionId }: { tenantId: string; sessionId: string }): string {
  return `/tenants/${segment(tenantId)}/${segment(sessionId)}`;
}

export const docRoutes = {
  create: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/`,
  query: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/query`,
  apply: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/apply`,
  export: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/export`,
  history: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/history`,
  rollback: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/rollback`,
  snapshot: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/snapshot`,
  ir: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/ir`,
  initFromHash: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/init_from_hash`,
  run: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/run`,
  reset: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/reset`,
} as const;

export const docInternalRoutes = {
  create: "/_internal/create",
  query: "/_internal/query",
  apply: "/_internal/apply",
  export: "/_internal/export",
  history: "/_internal/history",
  rollback: "/_internal/rollback",
  snapshot: "/_internal/snapshot",
  ir: "/_internal/ir",
  initFromHash: "/_internal/init_from_hash",
  run: "/_internal/run",
  reset: "/_internal/reset",
  resolveBlob: "/_internal/resolve_blob",
  readBlob: "/_internal/read_blob",
} as const;

export function matchDocRoute(method: string, pathname: string): DocRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "tenants") return null;

  const tenantId = decodeSegment(parts[1]);
  const sessionId = decodeSegment(parts[2]);
  if (tenantId === null || sessionId === null) return null;

  if (parts.length === 3 && method === "POST") {
    return { operation: "create", tenantId, sessionId };
  }
  if (parts.length !== 4) return null;

  for (const [operation, route] of Object.entries(operationRoutes)) {
    if (route.method === method && route.segment === parts[3]) {
      return { operation: operation as keyof typeof operationRoutes, tenantId, sessionId };
    }
  }
  return null;
}

export function matchDocInternalRoute(
  method: string,
  pathname: string,
): DocInternalRoute | null {
  for (const [operation, route] of Object.entries(docInternalRoutes)) {
    if (route !== pathname) continue;
    const publicRoute = operationRoutes[operation as keyof typeof operationRoutes];
    const expectedMethod = operation === "create"
      || operation === "resolveBlob"
      || operation === "readBlob"
      ? "POST"
      : publicRoute?.method;
    return expectedMethod === method
      ? { operation: operation as DocInternalOperation }
      : null;
  }
  return null;
}