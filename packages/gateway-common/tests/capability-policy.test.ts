import { describe, expect, test } from "vitest";
import type { CasRoute } from "@unicas/protocol-legacy";
import type { DocOperation } from "@unidocs/protocol-doc";
import {
  casCapabilityPolicy,
  docCapabilityPolicy,
} from "../src/capability-policy.js";

describe("Gateway capability policy", () => {
  test.each([
    ["create", "tenants:t:sessions:create", ["tenants:t:cas:write"], 90],
    ["status", "tenants:t:sessions:create", [], 15],
    ["query", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 60],
    ["export", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 60],
    ["history", "tenants:t:sessions:s:read", [], 30],
    ["ir", "tenants:t:sessions:s:read", ["tenants:t:cas:read"], 30],
    ["snapshot", "tenants:t:sessions:s:read", ["tenants:t:cas:write"], 60],
    ["apply", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 90],
    ["rollback", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 90],
    ["run", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 90],
    ["initFromHash", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"], 60],
    ["reset", "tenants:t:sessions:s:write", [], 30],
  ] satisfies Array<[DocOperation, string, string[], number]>) (
    "%s uses minimum downstream authority",
    (operation, docPermission, delegatedCasPermissions, deadlineSeconds) => {
      expect(docCapabilityPolicy(operation, "t", "s")).toEqual({
        docPermission,
        delegatedCasPermissions,
        deadlineSeconds,
        lifetimeSeconds: 120,
      });
    },
  );

  test.each([
    ["readContent", "cas:read", false],
    ["readMetadata", "cas:read", false],
    ["leaseNode", "cas:write", false],
    ["leaseExisting", "cas:write", false],
    ["usage", "cas:admin", true],
    ["gc", "cas:admin", true],
  ])("maps public CAS %s", (operation, suffix, requiresTenantAdmin) => {
    const route = { operation, tenantId: "t", hash: "h" } as CasRoute;
    expect(casCapabilityPolicy(route)).toEqual({
      permission: `tenants:t:${suffix}`,
      requiresTenantAdmin,
      lifetimeSeconds: 120,
    });
  });

  test("rejects private CAS operations", () => {
    expect(() => casCapabilityPolicy({ operation: "rootRefs", tenantId: "t" }))
      .toThrow("is not public");
  });
});