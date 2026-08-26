import { describe, expect, test } from "vitest";
import {
  CasLeaseDurationHeader,
  CasPortableNodeContentType,
  CasRefsHeader,
  casRoutes,
  isPublicCasRoute,
  matchCasRoute,
} from "../src/index.js";

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
    expect([
      isPublicCasRoute("GET", casRoutes.readContent({ tenantId: "t", hash: "h" })),
      isPublicCasRoute("GET", casRoutes.readMetadata({ tenantId: "t", hash: "h" })),
      isPublicCasRoute("POST", casRoutes.leaseNode({ tenantId: "t", hash: "h" })),
      isPublicCasRoute("POST", casRoutes.leaseExisting({ tenantId: "t", hash: "h" })),
      isPublicCasRoute("GET", casRoutes.usage({ tenantId: "t" })),
      isPublicCasRoute("POST", casRoutes.gc({ tenantId: "t" })),
    ]).toEqual([true, true, true, true, true, true]);
    expect(isPublicCasRoute("POST", casRoutes.rootRefs({ tenantId: "t" }))).toBe(false);
    expect(isPublicCasRoute("POST", "/users/u/cas/gc")).toBe(false);
  });

  test("freezes encoded paths and wire constants", () => {
    expect(casRoutes.readContent({ tenantId: "tenant/a", hash: "hash value" }))
      .toBe("/tenants/tenant%2Fa/cas/nodes/hash%20value/content");
    expect(casRoutes.rootAssignments({ tenantId: "tenant/a" }))
      .toBe("/tenants/tenant%2Fa/_internal/root-assignments");
    expect(CasRefsHeader).toBe("X-CAS-Refs");
    expect(CasLeaseDurationHeader).toBe("X-CAS-Lease-Duration");
    expect(CasPortableNodeContentType).toBe("application/vnd.unidocs.cas-node");
  });

  test("rejects unknown methods and malformed escapes", () => {
    expect(matchCasRoute("PUT", casRoutes.leaseNode({ tenantId: "t", hash: "h" }))).toBeNull();
    expect(matchCasRoute("GET", "/tenants/%ZZ/cas/usage")).toBeNull();
  });

  test("does not recognize /admin control-plane paths", () => {
    expect(matchCasRoute("GET", "/admin/me")).toBeNull();
    expect(matchCasRoute("GET", "/admin/stacks")).toBeNull();
    expect(matchCasRoute("POST", "/admin/stacks")).toBeNull();
    expect(matchCasRoute("GET", "/admin/stacks/s/root-ref-domains/doc/refs")).toBeNull();
  });
});