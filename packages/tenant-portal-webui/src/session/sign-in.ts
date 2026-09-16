/**
 * 登录入口与登录回跳。登录往返由 portal worker 的 /portal/auth/login 与
 * /portal/auth/callback 完成，这里只负责拼出发链接、读回跳结果。
 */
export type LoginOutcome = {
  readonly kind: "denied" | "failed" | "unavailable";
  readonly requestId: string | null;
};

const LOGIN_PATH = "/portal/auth/login";
const OUTCOMES = new Set(["denied", "failed", "unavailable"]);

/**
 * 服务端只接受以 /portal/ 开头的 returnTo，而外壳只会挂在 /portal、/portal/、
 * /portal/index.html 这三个入口上——其它任何路径 worker 都会 404。所以除了正好是
 * /portal/ 的情况，一律折成 /portal/，不只是排掉 index.html 这一个特例。hash 原样
 * 带上：hash 路由的位置服务端看不到，只能靠这里带过去，登录回来才能回到原来那条评论。
 */
export function loginHref(location: { readonly pathname: string; readonly hash: string }): string {
  const pathname = location.pathname === "/portal/" ? location.pathname : "/portal/";
  return `${LOGIN_PATH}?returnTo=${encodeURIComponent(pathname + location.hash)}`;
}

export function readLoginOutcome(search: string): LoginOutcome | null {
  const params = new URLSearchParams(search);
  const kind = params.get("login");
  if (kind === null || !OUTCOMES.has(kind)) return null;
  return { kind: kind as LoginOutcome["kind"], requestId: params.get("requestId") };
}

/** 展示过一次就从地址栏去掉，刷新时不再重复提示。 */
export function withoutLoginOutcome(location: { readonly pathname: string; readonly search: string; readonly hash: string }): string {
  const params = new URLSearchParams(location.search);
  params.delete("login");
  params.delete("requestId");
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}
