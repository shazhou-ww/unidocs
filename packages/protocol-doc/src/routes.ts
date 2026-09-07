export type DocOperation =
  | "create"
  | "query"
  | "apply"
  | "commitStatus"
  | "commitRecover"
  | "export"
  | "history"
  | "rollback"
  | "snapshot"
  | "status"
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
  commitStatus: { method: "POST", segment: "commit-status" },
  commitRecover: { method: "POST", segment: "commit-recover" },
  export: { method: "GET", segment: "export" },
  history: { method: "GET", segment: "history" },
  rollback: { method: "POST", segment: "rollback" },
  snapshot: { method: "GET", segment: "snapshot" },
  status: { method: "GET", segment: "status" },
  ir: { method: "GET", segment: "ir" },
  initFromHash: { method: "POST", segment: "init-from-hash" },
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
  return `/tenants/${segment(tenantId)}/sessions/${segment(sessionId)}`;
}

export const docRoutes = {
  create: sessionPath,
  query: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/query`,
  apply: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/apply`,
  commitStatus: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/commit-status`,
  commitRecover: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/commit-recover`,
  export: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/export`,
  history: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/history`,
  rollback: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/rollback`,
  snapshot: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/snapshot`,
  status: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/status`,
  ir: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/ir`,
  initFromHash: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/init-from-hash`,
  run: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/run`,
  reset: (path: { tenantId: string; sessionId: string }) => `${sessionPath(path)}/reset`,
} as const;

export const docInternalRoutes = {
  create: "/_internal/create",
  query: "/_internal/query",
  apply: "/_internal/apply",
  commitStatus: "/_internal/commit_status",
  commitRecover: "/_internal/commit_recover",
  export: "/_internal/export",
  history: "/_internal/history",
  rollback: "/_internal/rollback",
  snapshot: "/_internal/snapshot",
  status: "/_internal/status",
  ir: "/_internal/ir",
  initFromHash: "/_internal/init_from_hash",
  run: "/_internal/run",
  reset: "/_internal/reset",
  resolveBlob: "/_internal/resolve_blob",
  readBlob: "/_internal/read_blob",
} as const;

export function matchDocRoute(method: string, pathname: string): DocRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "tenants" || parts[2] !== "sessions") return null;

  const tenantId = decodeSegment(parts[1]);
  const sessionId = decodeSegment(parts[3]);
  if (tenantId === null || sessionId === null) return null;

  if (parts.length === 4 && method === "PUT") {
    return { operation: "create", tenantId, sessionId };
  }
  if (parts.length !== 5) return null;

  for (const [operation, route] of Object.entries(operationRoutes)) {
    if (route.method === method && route.segment === parts[4]) {
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

/**
 * 租户级路由,与 matchDocRoute 平行。
 *
 * 后者硬性要求 parts[2] === "sessions",只认会话级路径 —— 这就是租户级端点
 * 在中立层没有落脚点、当初只能在 cloudflare-psd 里自建一套的原因。
 *
 * 只按路径匹配,不按方法:方法不认识时由字体处理器回 405,而不是在这里返回
 * null —— 返回 null 会落回 createDocTypeHandler,那边不认识这条路径,答的是
 * 404 "Unknown Doc endpoint",把"方法用错了"说成"这个端点不存在"。
 */
export interface FontsRoute {
  readonly tenantId: string;
}

/** 租户级 operation。**刻意不并入 DocOperation**:后者喂给网关的
 *  docCapabilityPolicy 是个无 default 的穷尽 switch,加成员会强迫为两个根本
 *  不走网关的操作编一套 deadline 策略。 */
export type TenantOperation = "listFonts" | "registerFont";

export function matchFontsRoute(pathname: string): FontsRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "tenants" || parts[2] !== "fonts") return null;
  let tenantId: string;
  try {
    tenantId = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  return tenantId.length === 0 ? null : { tenantId };
}