/**
 * 取 tenant session、决定 main.tsx 用哪个 tenantId 构造 client。
 *
 * 只信 /portal/auth/session 的响应形状（Task 4 定的：{ tenantId, principalId }），
 * 遇到形状不对的成功响应宁可抛异常，也不猜一个 tenantId 出来（§ task-9 background）。
 */
const SESSION_PATH = "/portal/auth/session";
const CSRF_COOKIE_NAME = "__Host-unidocs_tenant_csrf";

export type TenantSession =
  | { readonly kind: "signed-in"; readonly tenantId: string; readonly principalId: string }
  | { readonly kind: "signed-out" };

/**
 * 任何非 401 的失败——非 2xx、或响应形状不对——都用这个抛，携带 HTTP 状态（如果有）
 * 好让 main.tsx 的连接失败提示里能报出状态码。网络错误（fetch 本身抛出）不会是这个
 * 类型，status 自然是 undefined。
 */
export class TenantSessionError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TenantSessionError";
    this.status = status;
  }
}

function isSessionPayload(value: unknown): value is { tenantId: string; principalId: string } {
  if (typeof value !== "object" || value === null) return false;
  const shape = value as Record<string, unknown>;
  return typeof shape.tenantId === "string" && typeof shape.principalId === "string";
}

export async function loadTenantSession(fetchImpl: typeof fetch = globalThis.fetch): Promise<TenantSession> {
  const response = await fetchImpl(SESSION_PATH, { credentials: "include" });
  // 未登录是唯一「正常」的失败态；其它任何非 2xx 都是意料之外，往上抛，不当作 signed-out。
  if (response.status === 401) return { kind: "signed-out" };
  if (!response.ok) {
    throw new TenantSessionError(`/portal/auth/session responded with HTTP ${response.status}`, response.status);
  }

  const payload: unknown = await response.json();
  if (!isSessionPayload(payload)) {
    throw new TenantSessionError("/portal/auth/session returned an unexpected response shape", response.status);
  }
  return { kind: "signed-in", tenantId: payload.tenantId, principalId: payload.principalId };
}

/**
 * main.tsx 在 bootstrap 失败（403/500/网络错误……）时用这个决定提示文案，抽出来是因为
 * main.tsx 本身不好测（见 tests/session-bootstrap.test.ts）。网络错误等非 TenantSessionError
 * 拿不到 status，就只给通用文案，不瞎猜状态码。
 */
export function describeConnectionFailure(error: unknown): { readonly title: string } {
  const status = error instanceof TenantSessionError ? error.status : undefined;
  return { title: status === undefined ? "无法连接到服务" : `无法连接到服务（HTTP ${status}）` };
}

/** admin-portal-client 的 browserCsrfToken 同款写法（packages/admin-portal-client/src/index.ts:89）。 */
export function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  for (const item of document.cookie.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === CSRF_COOKIE_NAME) return decodeURIComponent(value.join("="));
  }
  return null;
}
