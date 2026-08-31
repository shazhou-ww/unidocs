import { describe, expect, test } from "vitest";
import {
  CasLeaseDurationHeader,
  casRoutes,
  matchCasRoute,
} from "../src/index.js";
import type {
  CasRoute,
  CasUpdateRootRefsRequest,
  CasUpdateRootRefsResponse,
} from "../src/index.js";

const STACK = "stack-a";
const TENANT = "tenant/a";

describe("CAS routes (canonical stack-scoped)", () => {
  test.each([
    ["GET", casRoutes.readContent({ stackId: STACK, tenantId: TENANT, hash: "abc" }), "readContent"],
    ["GET", casRoutes.readMetadata({ stackId: STACK, tenantId: TENANT, hash: "abc" }), "readMetadata"],
    ["POST", casRoutes.lease({ stackId: STACK, tenantId: TENANT, hash: "abc" }), "lease"],
    ["GET", casRoutes.usage({ stackId: STACK, tenantId: TENANT }), "usage"],
    ["POST", casRoutes.gc({ stackId: STACK, tenantId: TENANT }), "gc"],
    ["POST", casRoutes.updateRootRefs({ stackId: STACK, tenantId: TENANT }), "updateRootRefs"],
  ])("matches %s %s", (method, pathname, operation) => {
    expect(matchCasRoute(method, pathname)).toMatchObject({
      operation,
      stackId: STACK,
      tenantId: TENANT,
    });
  });

  test("every tenant service route carries stackId + tenantId", () => {
    const routes: readonly CasRoute[] = [
      { operation: "readContent", stackId: STACK, tenantId: TENANT, hash: "a".repeat(64) },
      { operation: "readMetadata", stackId: STACK, tenantId: TENANT, hash: "a".repeat(64) },
      { operation: "lease", stackId: STACK, tenantId: TENANT, hash: "a".repeat(64) },
      { operation: "usage", stackId: STACK, tenantId: TENANT },
      { operation: "gc", stackId: STACK, tenantId: TENANT },
      { operation: "updateRootRefs", stackId: STACK, tenantId: TENANT },
    ];
    for (const route of routes) {
      expect(route.stackId).toBe(STACK);
      expect(route.tenantId).toBe(TENANT);
    }
  });

  test("freezes encoded stack paths and wire constants", () => {
    expect(casRoutes.readContent({ stackId: "stack/a", tenantId: "tenant/a", hash: "hash value" }))
      .toBe("/stacks/stack%2Fa/tenants/tenant%2Fa/cas/nodes/hash%20value/content");
    expect(casRoutes.updateRootRefs({ stackId: "stack/a", tenantId: "tenant/a" }))
      .toBe("/stacks/stack%2Fa/tenants/tenant%2Fa/root-refs");
    expect(CasLeaseDurationHeader).toBe("X-CAS-Lease-Duration");
    expect(casRoutes.lease({ stackId: STACK, tenantId: TENANT, hash: "abc" }))
      .toBe(`/stacks/${STACK}/tenants/tenant%2Fa/cas/nodes/abc/lease`);
  });

  test("rejects unknown methods and malformed escapes", () => {
    expect(matchCasRoute("PUT", casRoutes.lease({ stackId: STACK, tenantId: "t", hash: "h" }))).toBeNull();
    expect(matchCasRoute("GET", "/stacks/%ZZ/tenants/t/cas/usage")).toBeNull();
  });

  test("never recognizes /admin control-plane paths", () => {
    expect(matchCasRoute("GET", "/admin/me")).toBeNull();
    expect(matchCasRoute("GET", "/admin/stacks")).toBeNull();
    expect(matchCasRoute("POST", "/admin/stacks/s/root-ref-domains/doc/refs")).toBeNull();
    expect(matchCasRoute("GET", "/admin/stacks/s/root-ref-domains/doc/events")).toBeNull();
  });

  test("never recognizes legacy tenant-scoped or internal paths", () => {
    expect(matchCasRoute("GET", "/tenants/t/cas/nodes/h/content")).toBeNull();
    expect(matchCasRoute("POST", "/tenants/t/_internal/root-refs")).toBeNull();
    expect(matchCasRoute("POST", "/tenants/t/_internal/root-assignments")).toBeNull();
    expect(matchCasRoute("GET", "/tenants/t/_internal/nodes/h")).toBeNull();
    expect(matchCasRoute("POST", "/_internal/root-refs")).toBeNull();
    expect(matchCasRoute("GET", "/users/u/cas/gc")).toBeNull();
  });

  test("requires the stacks/tenants path shape", () => {
    expect(matchCasRoute("GET", "/stacks/s/cas/usage")).toBeNull();
    expect(matchCasRoute("GET", "/stacks/s/tenants/")).toBeNull();
    expect(matchCasRoute("GET", "/stacks//tenants/t/cas/usage")).toBeNull();
  });
});

describe("CAS write contract compile fixtures", () => {
  test("updateRootRefs request carries a stack tenant path and the signed update", () => {
    const request: CasUpdateRootRefsRequest = {
      path: { stackId: STACK, tenantId: TENANT },
      body: {
        requestId: "session:s1:commit:8:roots",
        changes: { ["a".repeat(64)]: -1, ["b".repeat(64)]: 2 },
      },
    };
    expect(request.path.stackId).toBe(STACK);
    expect(request.body.changes["a".repeat(64)]).toBe(-1);
  });

  test("updateRootRefs response shape carries revision and idempotency", () => {
    const fresh: CasUpdateRootRefsResponse = { success: true, idempotent: false, revision: 1843 };
    const retry: CasUpdateRootRefsResponse = { success: true, idempotent: true, revision: 1843 };
    const failed: CasUpdateRootRefsResponse = { error: "ROOT_REF_SNAPSHOT_CHANGED" };
    expect(fresh.revision).toBe(1843);
    expect(retry.idempotent).toBe(true);
    expect("error" in failed).toBe(true);
  });
});
