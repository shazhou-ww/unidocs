import { describe, expect, test } from "vitest";
import type { DocOperation } from "@unidocs/protocol-doc";
import { docEdgeCapabilityRequirements } from "../src/doc-capability-policy.js";

describe("Doc edge capability requirements", () => {
  test.each([
    ["create", "tenants:t:sessions:create", ["tenants:t:cas:write"]],
    ["status", "tenants:t:sessions:create", []],
    ["query", "tenants:t:sessions:s:read", ["tenants:t:cas:read"]],
    ["export", "tenants:t:sessions:s:read", ["tenants:t:cas:read"]],
    ["history", "tenants:t:sessions:s:read", []],
    ["ir", "tenants:t:sessions:s:read", ["tenants:t:cas:read"]],
    ["snapshot", "tenants:t:sessions:s:read", ["tenants:t:cas:write"]],
    ["apply", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"]],
    ["rollback", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"]],
    ["run", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"]],
    ["initFromHash", "tenants:t:sessions:s:write", ["tenants:t:cas:read", "tenants:t:cas:write"]],
    ["reset", "tenants:t:sessions:s:write", []],
  ] satisfies Array<[DocOperation, string, string[]]>) (
    "%s uses exact minimum authority",
    (operation, docPermission, casPermissions) => {
      expect(docEdgeCapabilityRequirements(operation, "t", "s")).toEqual({
        docPermission,
        casPermissions,
      });
    },
  );
});