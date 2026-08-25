import { describe, expect, test } from "vitest";
import { casRoutes, isPublicCasRoute, matchCasRoute } from "../src/index.js";

describe("CAS routes", () => {
  test.each([
    ["GET", casRoutes.readContent({ tenantId: "tenant/a", hash: "abc" }), "readContent"],
    ["GET", casRoutes.readMetadata({ tenantId: "tenant/a", hash: "abc" }), "readMetadata"],
    ["POST", casRoutes.leaseNode({ tenantId: "tenant/a", hash: "abc" }), "leaseNode"],
    ["POST", casRoutes.leaseExisting({ tenantId: "tenant/a", hash: "abc" }), "leaseExisting"],
    ["GET", casRoutes.usage({ tenantId: "tenant/a" }), "usage"],
    ["POST", casRoutes.gc({ tenantId: "tenant/a" }), "gc"],
    ["POST", casRoutes.rootRefs({ tenantId: "tenant/a" }), "rootRefs"],
    ["POST", casRoutes.rootAssignments({ tenantId: "tenant/a" }), "rootAssignments"],
    ["GET", casRoutes.portableNode({ tenantId: "tenant/a", hash: "abc" }), "readPortableNode"],
    ["POST", casRoutes.portableNode({ tenantId: "tenant/a", hash: "abc" }), "leasePortableNode"],
  ])("matches %s %s", (method, pathname, operation) => {
    expect(matchCasRoute(method, pathname)).toMatchObject({
      operation,
      tenantId: "tenant/a",
    });
  });

  test("allowlists only the six public operations", () => {
    expect(isPublicCasRoute("GET", casRoutes.readContent({ tenantId: "t", hash: "h" }))).toBe(true);
    expect(isPublicCasRoute("POST", casRoutes.rootRefs({ tenantId: "t" }))).toBe(false);
    expect(isPublicCasRoute("POST", "/users/u/cas/gc")).toBe(false);
  });

  test("rejects unknown methods and malformed escapes", () => {
    expect(matchCasRoute("PUT", casRoutes.leaseNode({ tenantId: "t", hash: "h" }))).toBeNull();
    expect(matchCasRoute("GET", "/tenants/%ZZ/cas/usage")).toBeNull();
  });
});