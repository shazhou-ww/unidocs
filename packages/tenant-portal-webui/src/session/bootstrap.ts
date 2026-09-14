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

function isSessionPayload(value: unknown): value is { tenantId: string; principalId: string } {
  if (typeof value !== "object" || value === null) return false;
  const shape = value as Record<string, unknown>;
  return typeof shape.tenantId === "string" && typeof shape.principalId === "string";
}

export async function loadTenantSession(fetchImpl: typeof fetch = globalThis.fetch): Promise<TenantSession> {
  const response = await fetchImpl(SESSION_PATH, { credentials: "include" });
  // 未登录是唯一「正常」的失败态；其它任何非 2xx 都是意料之外，往上抛，不当作 signed-out。
  if (response.status === 401) return { kind: "signed-out" };
  if (!response.ok) throw new Error(`/portal/auth/session responded with HTTP ${response.status}`);

  const payload: unknown = await response.json();
  if (!isSessionPayload(payload)) throw new Error("/portal/auth/session returned an unexpected response shape");
  return { kind: "signed-in", tenantId: payload.tenantId, principalId: payload.principalId };
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
