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
  readonly deadlineSeconds: 15 | 30 | 60 | 90 | 240 | 1800;
  readonly lifetimeSeconds: 120 | 300 | 1800;
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
    // create 的时长几乎不取决于服务端:网关是流式转发的(`body: request.body`,
    // 不缓冲),所以这块预算主要被**客户端上行**吃掉,而不是被摄取吃掉。线上
    // 实测一次 237 MiB 的 PSD:容器 CPU 全程 ≤0.01/2.0 核在等网络,body 落地
    // 后 CAS lease(并发)加 root-refs 一共只用了约 21 秒,前面 81 秒全是传输。
    //
    // 240 是**平台天花板,不是我们挑的数**:这套 ACA 环境是纯 Consumption
    // (`workloadProfiles: null`),ingress 的 HTTP 请求超时固定 240s 且不可调
    // (放宽要 Premium Ingress + Dedicated workload profile)。写成更大的值不会
    // 更宽容,只会让 ingress 先掐断,把一条信息明确的 502 换成一个 504。
    //
    // lifetime 必须**严格大于** deadline:doc service 全程拿这张票去写 CAS,
    // 票一过期后续写入就是 401。相等的话,请求最后一刻发出的那次 CAS 写正好
    // 撞上刚过期的票据,故障从"超时"变成一条更难查的 401。
    //
    // 这只是把眼前的阻塞解开,不是根治 —— 天花板归平台管,跟这里写多少无关。
    // 文件再大或网络再差照样会撞;真正的解法是浏览器直传存储,让网关不再当
    // 几百 MB 的管子。
    case "create":
      return policy(
        sessionCreatePermission(tenantId),
        [casWritePermission(tenantId)],
        240,
        300,
      );
    case "status":
      return policy(sessionCreatePermission(tenantId), [], 15);
    case "query":
    case "export":
      return policy(
        sessionReadPermission(tenantId, sessionId),
        [casReadPermission(tenantId)],
        60,
      );
    case "history":
    case "commitStatus":
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
    case "commitRecover":
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
  deadlineSeconds: 15 | 30 | 60 | 90 | 240 | 1800,
  lifetimeSeconds: 120 | 300 | 1800 = 120,
): DocCapabilityPolicy {
  return Object.freeze({
    docPermission,
    delegatedCasPermissions: Object.freeze([...delegatedCasPermissions]),
    deadlineSeconds,
    lifetimeSeconds,
  });
}