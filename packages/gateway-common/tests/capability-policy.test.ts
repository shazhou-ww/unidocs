import { describe, expect, test } from "vitest";
import type { GatewayCasRoute } from "@unidocs/protocol-gateway";
import type { DocOperation } from "@unidocs/protocol-doc";
import {
  casCapabilityPolicy,
  docCapabilityPolicy,
} from "../src/capability-policy.js";

describe("Gateway capability policy", () => {
  test.each([
    // 240 是平台天花板,不是我们挑的数:Consumption 版 ACA 的 ingress 请求
    // 超时固定 240s 且不可调,写更大的值只会让 ingress 先掐断,把一条信息
    // 明确的 502 换成一个 504。lifetime 必须严格大于 deadline —— 相等时
    // 请求最后一刻发出的 CAS 写会撞上刚过期的票据(见 create 那一段注释)。
    ["create", "tenants:t:sessions:create", ["tenants:t:cas:write"], 240, 300],
    ["status", "tenants:t:sessions:create", [], 15, 120],
    ["query", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 60, 120],
    ["export", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 60, 120],
    ["history", "tenants:t:sessions:s:read", [], 30, 120],
    ["commitStatus", "tenants:t:sessions:s:read", [], 30, 120],
    ["commitRecover", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 90, 120],
    ["ir", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 30, 120],
    ["snapshot", "tenants:t:sessions:s:read", ["tenants:t:cas:write"], 60, 120],
    ["apply", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 90, 120],
    ["rollback", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 90, 120],
    // 只有 run 拿长窗口：agent 循环要跑到 30 分钟（spec 5.6）
    ["run", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 1800, 1800],
    ["initFromHash", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 60, 120],
    ["reset", "tenants:t:sessions:s:write", [], 30, 120],
  ] satisfies Array<[DocOperation, string, string[], number, number]>) (
    "%s uses minimum downstream authority",
    (operation, docPermission, delegatedCasPermissions, deadlineSeconds, lifetimeSeconds) => {
      expect(docCapabilityPolicy(operation, "t", "s")).toEqual({
        docPermission,
        delegatedCasPermissions,
        deadlineSeconds,
        lifetimeSeconds,
      });
    },
  );

  test.each([
    ["readContent", "cas:read", false],
    ["readMetadata", "cas:read", false],
    ["lease", "cas:write", false],
    ["usage", "cas:manage", true],
    ["gc", "cas:manage", true],
  ])("maps public CAS %s", (operation, suffix, requiresTenantAdmin) => {
    const route = { operation, tenantId: "t", hash: "h" } as GatewayCasRoute;
    expect(casCapabilityPolicy(route)).toEqual({
      permission: `tenants:t:${suffix}`,
      requiresTenantAdmin,
      lifetimeSeconds: 120,
    });
  });
});