import { describe, expect, test } from "vitest";
import type { CasRoute } from "@unidocs/protocol-cas";
import { routePermission } from "../src/cas-auth.js";

describe("CAS capability route policy", () => {
  test.each([
    ["readContent", "cas:read"],
    ["readMetadata", "cas:read"],
    ["readPortableNode", "cas:read"],
    ["leaseNode", "cas:write"],
    ["leaseExisting", "cas:write"],
    ["leasePortableNode", "cas:write"],
    ["rootRefs", "cas:write"],
    ["rootAssignments", "cas:write"],
    ["usage", "cas:admin"],
    ["gc", "cas:admin"],
  ])("maps %s to %s", (operation, suffix) => {
    const route = { operation, tenantId: "tenant-1", hash: "a".repeat(64) } as CasRoute;
    expect(routePermission(route)).toBe(`tenants:tenant-1:${suffix}`);
  });
});