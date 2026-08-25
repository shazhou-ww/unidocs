import { describe, expect, test } from "vitest";
import {
  docInternalRoutes,
  docRoutes,
  matchDocInternalRoute,
  matchDocRoute,
} from "../src/index.js";

const path = { tenantId: "tenant/a", sessionId: "session b" };

describe("Doc routes", () => {
  test.each([
    ["POST", docRoutes.create(path), "create"],
    ["POST", docRoutes.query(path), "query"],
    ["POST", docRoutes.apply(path), "apply"],
    ["GET", docRoutes.export(path), "export"],
    ["GET", docRoutes.history(path), "history"],
    ["POST", docRoutes.rollback(path), "rollback"],
    ["GET", docRoutes.snapshot(path), "snapshot"],
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
        || operation === "ir"
        ? "GET"
        : "POST";
      expect(matchDocInternalRoute(method, route)).toEqual({ operation });
    },
  );

  test("rejects legacy and wrong-method routes", () => {
    expect(matchDocRoute("POST", "/users/u/doc/query")).toBeNull();
    expect(matchDocRoute("GET", docRoutes.apply(path))).toBeNull();
    expect(matchDocInternalRoute("GET", docInternalRoutes.apply)).toBeNull();
  });
});