/**
 * Session 中途过期（Plan 3 遗留）：页面开着的时候 tenant session 可能到期，之后任何一个
 * 请求都会 401。与其让用户看到一串「登录已失效」，先重新走一遍 /portal/auth/session——
 * 能拿回同一个 tenant 的 session 就把原请求原样重试一次（写请求带着原 idempotency key，
 * 重试不会建出第二份）；拿不回来才交给 onSignedOut 显示登录提示。
 *
 * 做成 transport 包装而不是 client 层：client 的每个方法都经过同一个 transport，
 * 一处包住就覆盖全部 operation，client 包本身也不必知道 session 的存在。
 */
import type { PlatformRequest, PlatformResponse, PlatformTransport } from "@unidocs/tenant-portal-client";
import type { TenantSession } from "./bootstrap.js";

export interface SessionRefreshOptions {
  /** client 绑定的 tenant：新 session 属于别的 tenant 时不能拿旧路径重试。 */
  readonly tenantId: string;
  loadSession(): Promise<TenantSession>;
  onSignedOut(): void;
}

function isUnauthorized(response: PlatformResponse): boolean {
  return !response.ok && response.error.error.code === "unauthorized";
}

export function withSessionRefresh(transport: PlatformTransport, options: SessionRefreshOptions): PlatformTransport {
  // 同时过期的一批请求共用一次刷新，不对 session 端点并发打一串请求：一个请求发出之后
  // 如果已经有别的请求开始了刷新，它就等那一次的结果；只有发出之后没人刷新过，才自己刷新。
  // 按「代」判断而不是按「刷新是否还在进行」，否则快的那次刷新结束得早，慢一步拿到 401
  // 的请求又会再刷新一遍。
  let generation = 0;
  let latest: Promise<boolean> | null = null;

  const refreshSince = (startedAt: number): Promise<boolean> => {
    if (latest === null || generation === startedAt) {
      generation += 1;
      latest = options.loadSession()
        .then((session) => session.kind === "signed-in" && session.tenantId === options.tenantId)
        .catch(() => false);
    }
    return latest;
  };

  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    const startedAt = generation;
    const first = await transport(request);
    if (!isUnauthorized(first)) return first;

    if (!(await refreshSince(startedAt))) {
      options.onSignedOut();
      return first;
    }

    // 只重试一次：刚拿到的 session 仍被拒绝，说明不是过期能解释的，别循环。
    const retried = await transport(request);
    if (isUnauthorized(retried)) options.onSignedOut();
    return retried;
  };
}
