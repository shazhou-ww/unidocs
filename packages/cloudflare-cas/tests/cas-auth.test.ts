import { describe, expect, test } from "vitest";
import type { CasRoute } from "@unidocs/protocol-cas";
import {
  CasAuthConfig,
  CasAuthConfigCache,
  routePermission,
} from "../src/cas-auth.js";

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

describe("CAS auth configuration", () => {
  test("fails startup with the missing field name", () => {
    expect(() => new CasAuthConfig({
      INTERNAL_AUTH_MODE: "capability",
      CAPABILITY_ALGORITHM: "ES256",
      CAPABILITY_TTL_SECONDS: "120",
      CAPABILITY_MAX_LIFETIME_SECONDS: "300",
      CAPABILITY_CLOCK_SKEW_SECONDS: "30",
    })).toThrow("CAPABILITY_ISSUER");
  });

  test("caches immutable configuration per runtime environment", () => {
    const bindings = { INTERNAL_AUTH_MODE: "legacy", CAS_ACCESS_KEY: "legacy-key" };
    const cache = new CasAuthConfigCache();
    expect(cache.get(bindings)).toBe(cache.get(bindings));
    expect(cache.get({ ...bindings })).not.toBe(cache.get(bindings));
  });
});