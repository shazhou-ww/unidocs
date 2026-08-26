import { describe, expect, test } from "vitest";
import {
  canonicalPermissionSegment,
  casAdminPermission,
  casReadPermission,
  casWritePermission,
  hasCapabilityPermission,
  parseCapabilityPermission,
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "../src/index.js";

describe("capability permissions", () => {
  test("builds and parses the complete permission vocabulary", () => {
    const permissions = [
      casReadPermission("tenant-1"),
      casWritePermission("tenant-1"),
      casAdminPermission("tenant-1"),
      sessionCreatePermission("tenant-1"),
      sessionReadPermission("tenant-1", "session-1"),
      sessionWritePermission("tenant-1", "session-1"),
    ];

    expect(permissions).toEqual([
      "tenants:tenant-1:cas:read",
      "tenants:tenant-1:cas:write",
      "tenants:tenant-1:cas:admin",
      "tenants:tenant-1:sessions:create",
      "tenants:tenant-1:sessions:session-1:read",
      "tenants:tenant-1:sessions:session-1:write",
    ]);
    expect(permissions.map(parseCapabilityPermission)).toEqual([
      { kind: "cas:read", tenantId: "tenant-1" },
      { kind: "cas:write", tenantId: "tenant-1" },
      { kind: "cas:admin", tenantId: "tenant-1" },
      { kind: "sessions:create", tenantId: "tenant-1" },
      { kind: "sessions:read", tenantId: "tenant-1", sessionId: "session-1" },
      { kind: "sessions:write", tenantId: "tenant-1", sessionId: "session-1" },
    ]);
  });

  test("encodes resource IDs canonically", () => {
    const tenantId = "tenant/a:b %!*'()";
    const sessionId = "session/雪";
    expect(canonicalPermissionSegment(tenantId))
      .toBe("tenant%2Fa%3Ab%20%25%21%2A%27%28%29");

    const permission = sessionWritePermission(tenantId, sessionId);
    expect(permission).toBe(
      "tenants:tenant%2Fa%3Ab%20%25%21%2A%27%28%29:sessions:session%2F%E9%9B%AA:write",
    );
    expect(parseCapabilityPermission(permission)).toEqual({
      kind: "sessions:write",
      tenantId,
      sessionId,
    });
  });

  test.each([
    "tenants::cas:read",
    "tenants:t%2fpath:cas:read",
    "tenants:t%ZZ:cas:read",
    "tenants:t:cas:delete",
    "tenants:t:sessions::read",
    "tenants:t:sessions:s:admin",
    "tenants:t:sessions:s:read:extra",
    "projects:t:cas:read",
  ])("rejects malformed or non-canonical permission %s", (permission) => {
    expect(parseCapabilityPermission(permission)).toBeNull();
  });

  test("matches permissions exactly without implication", () => {
    const permissions = [casAdminPermission("tenant-a"), sessionReadPermission("tenant-a", "s1")];
    expect(hasCapabilityPermission(permissions, casAdminPermission("tenant-a"))).toBe(true);
    expect(hasCapabilityPermission(permissions, casReadPermission("tenant-a"))).toBe(false);
    expect(hasCapabilityPermission(permissions, sessionReadPermission("tenant-a", "s2"))).toBe(false);
    expect(hasCapabilityPermission(permissions, sessionWritePermission("tenant-a", "s1"))).toBe(false);
  });

  test("rejects empty resource IDs at construction", () => {
    expect(() => casReadPermission("")).toThrow("must not be empty");
    expect(() => sessionReadPermission("tenant", "")).toThrow("must not be empty");
  });
});