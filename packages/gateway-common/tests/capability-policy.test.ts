import { describe, expect, test } from "vitest";
import type { GatewayCasRoute } from "@unidocs/protocol-gateway";
import type { DocOperation } from "@unidocs/protocol-doc";
import {
  casCapabilityPolicy,
  docCapabilityPolicy,
} from "../src/capability-policy.js";

describe("Gateway capability policy", () => {
  test.each([
    ["create", "tenants:t:sessions:create", ["tenants:t:cas:write"], 90, 120],
    ["status", "tenants:t:sessions:create", [], 15, 120],
    ["query", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 60, 120],
    ["export", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 60, 120],
    ["history", "tenants:t:sessions:s:read", [], 30, 120],
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
    ["usage", "cas:admin", true],
    ["gc", "cas:admin", true],
  ])("maps public CAS %s", (operation, suffix, requiresTenantAdmin) => {
    const route = { operation, tenantId: "t", hash: "h" } as GatewayCasRoute;
    expect(casCapabilityPolicy(route)).toEqual({
      permission: `tenants:t:${suffix}`,
      requiresTenantAdmin,
      lifetimeSeconds: 120,
    });
  });
});