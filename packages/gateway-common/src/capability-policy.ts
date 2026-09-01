import type { GatewayCasRoute } from "@unidocs/protocol-gateway";
import type { DocOperation } from "@unidocs/protocol-doc";
import {
  casManagePermission,
  casReadPermission,
  casWritePermission,
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "@unidocs/service-auth";
import type { CapabilityPermission } from "@unidocs/service-auth";

export interface DocCapabilityPolicy {
  readonly docPermission: CapabilityPermission;
  readonly delegatedCasPermissions: readonly CapabilityPermission[];
  readonly deadlineSeconds: 15 | 30 | 60 | 90 | 180 | 1800;
  readonly lifetimeSeconds: 120 | 180 | 1800;
}

export interface CasCapabilityPolicy {
  readonly permission: CapabilityPermission;
  readonly requiresTenantAdmin: boolean;
  readonly lifetimeSeconds: 120;
}

export function docCapabilityPolicy(
  operation: DocOperation,
  tenantId: string,
  sessionId: string,
): DocCapabilityPolicy {
  switch (operation) {
    case "create":
      return policy(
        sessionCreatePermission(tenantId),
        [casWritePermission(tenantId)],
        90,
      );
    case "status":
      return policy(sessionCreatePermission(tenantId), [], 15);
    case "query":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casReadPermission(tenantId)],
        60,
      );
    // export 曾经和 query 共用 60 秒,但两者的工作量差一个数量级:导出要把懒加载
    // 的 CAS 像素全部拉实、合成整张画布、再写出 PSD。实测 16KB 的样例文件就要
    // 13 秒,真实文档超 60 秒是常态 —— 线上表现为网关中断出站调用、合成一个 502,
    // 浏览器侧就是 "Failed to fetch"(2026-09-01 由 http_call 事件的
    // `status: 0 / TimeoutError` 定位到)。
    //
    // 能力票的有效期必须跟着截止时间一起放宽:导出全程都在用委派的 CAS 读权限,
    // 票在第 120 秒过期会把超时换成一个更难懂的"令牌过期"。180 仍然在
    // Container Apps 入口的 240 秒默认超时之内。
    case "export":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casReadPermission(tenantId)],
        180,
        180,
      );
    case "history":
      return policy(sessionReadPermission(tenantId, sessionId), [], 30);
    // `ir` returns canonical bytes whose SBlob refs the client then reads from
    // CAS, so the editor verifies those refs are live before encoding — that
    // check is a CAS read, not a free operation like `history`.
    case "ir":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casReadPermission(tenantId)],
        30,
      );
    case "snapshot":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casWritePermission(tenantId)],
        60,
      );
    case "apply":
    case "rollback":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        90,
      );
    // `run` 的权限集与 apply 完全相同，长的只有时间。agent 循环全程带着
    // 这里签出的 delegated-cas 凭据调编辑器，凭据过期后续写入就 401，
    // 所以窗口必须覆盖整次 run（spec 5.6.3）。
    case "run":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        1800,
        1800,
      );
    case "initFromHash":
      return policy(
        sessionWritePermission(tenantId, sessionId),
        [casReadPermission(tenantId), casWritePermission(tenantId)],
        60,
      );
    case "reset":
      return policy(sessionWritePermission(tenantId, sessionId), [], 30);
  }
}

export function casCapabilityPolicy(route: GatewayCasRoute): CasCapabilityPolicy {
  switch (route.operation) {
    case "readContent":
    case "readMetadata":
      return {
        permission: casReadPermission(route.tenantId),
        requiresTenantAdmin: false,
        lifetimeSeconds: 120,
      };
    case "lease":
      return {
        permission: casWritePermission(route.tenantId),
        requiresTenantAdmin: false,
        lifetimeSeconds: 120,
      };
    case "usage":
    case "gc":
      return {
        permission: casManagePermission(route.tenantId),
        requiresTenantAdmin: true,
        lifetimeSeconds: 120,
      };
  }
}

function policy(
  docPermission: CapabilityPermission,
  delegatedCasPermissions: readonly CapabilityPermission[],
  deadlineSeconds: 15 | 30 | 60 | 90 | 180 | 1800,
  lifetimeSeconds: 120 | 180 | 1800 = 120,
): DocCapabilityPolicy {
  return Object.freeze({
    docPermission,
    delegatedCasPermissions: Object.freeze([...delegatedCasPermissions]),
    deadlineSeconds,
    lifetimeSeconds,
  });
}