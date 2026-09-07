import { describe, expect, test } from "vitest";
import {
  SValueContentType,
  docInternalRoutes,
  docRoutes,
  matchDocInternalRoute,
  matchDocRoute,
} from "../src/index.js";

const path = { tenantId: "tenant/a", sessionId: "session b" };

describe("Doc routes", () => {
  test.each([
    ["PUT", docRoutes.create(path), "create"],
    ["POST", docRoutes.query(path), "query"],
    ["POST", docRoutes.apply(path), "apply"],
    ["POST", docRoutes.commitStatus(path), "commitStatus"],
    ["POST", docRoutes.commitRecover(path), "commitRecover"],
    ["GET", docRoutes.export(path), "export"],
    ["GET", docRoutes.history(path), "history"],
    ["POST", docRoutes.rollback(path), "rollback"],
    ["GET", docRoutes.snapshot(path), "snapshot"],
    ["GET", docRoutes.status(path), "status"],
    ["GET", docRoutes.ir(path), "ir"],
    ["POST", docRoutes.initFromHash(path), "initFromHash"],
    ["POST", docRoutes.run(path), "run"],
    ["POST", docRoutes.reset(path), "reset"],
  ])("matches %s %s", (method, pathname, operation) => {
    expect(matchDocRoute(method, pathname)).toEqual({
      operation,
      tenantId: path.tenantId,
      sessionId: path.sessionId,
    });
  });

  test.each(Object.entries(docInternalRoutes))(
    "matches private %s route",
    (operation, route) => {
      const method = operation === "export"
        || operation === "history"
        || operation === "snapshot"
        || operation === "status"
        || operation === "ir"
        ? "GET"
        : "POST";
      expect(matchDocInternalRoute(method, route)).toEqual({ operation });
    },
  );

  test("rejects legacy and wrong-method routes", () => {
    expect(matchDocRoute("POST", "/users/u/doc/query")).toBeNull();
    expect(matchDocRoute("POST", "/tenants/t/s/query")).toBeNull();
    expect(matchDocRoute("GET", docRoutes.apply(path))).toBeNull();
    expect(matchDocRoute("POST", docRoutes.create(path))).toBeNull();
    expect(matchDocInternalRoute("GET", docInternalRoutes.apply)).toBeNull();
  });

  test("freezes post-P0 service paths and media type", () => {
    expect(docRoutes.create(path)).toBe("/tenants/tenant%2Fa/sessions/session%20b");
    expect(docRoutes.initFromHash(path))
      .toBe("/tenants/tenant%2Fa/sessions/session%20b/init-from-hash");
    expect(docInternalRoutes.initFromHash).toBe("/_internal/init_from_hash");
    expect(docInternalRoutes.status).toBe("/_internal/status");
    expect(SValueContentType).toBe("application/vnd.unidocs.svalue+cbor;version=1");
  });
});