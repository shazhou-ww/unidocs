import { describe, expect, test } from "vitest";
import {
  casManagePermission,
  casReadPermission,
  casWritePermission,
} from "@unidocs/service-auth";
import { gatewayOAuthScopesToCapabilityPermissions } from "../src/index.js";

describe("Gateway OAuth scope mapping", () => {
  test("maps canonical OAuth scopes to tenant capability permissions", () => {
    expect(gatewayOAuthScopesToCapabilityPermissions("tenant/a", [
      "cas:read",
      "cas:write",
      "cas:manage",
    ])).toEqual([
      casReadPermission("tenant/a"),
      casWritePermission("tenant/a"),
      casManagePermission("tenant/a"),
    ]);
  });

  test("deduplicates requested scopes and rejects unknown or empty scope sets", () => {
    expect(gatewayOAuthScopesToCapabilityPermissions("tenant", ["cas:read", "cas:read"]))
      .toEqual([casReadPermission("tenant")]);
    expect(() => gatewayOAuthScopesToCapabilityPermissions("tenant", ["openid"]))
      .toThrow("Unsupported OAuth scope: openid");
    expect(() => gatewayOAuthScopesToCapabilityPermissions("tenant", []))
      .toThrow("must not be empty");
  });
});
