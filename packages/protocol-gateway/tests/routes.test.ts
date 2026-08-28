import { describe, expect, test } from "vitest";
import {
  gatewayCasRoutes,
  gatewayRoutes,
  isGatewayExposedCasRoute,
  matchGatewayRoute,
} from "../src/index.js";

const collection = { tenantId: "tenant/a", docType: "doc type" };
const document = { ...collection, docId: "doc/1" };

describe("Gateway routes", () => {
  test.each([
    ["GET", gatewayRoutes.listDocuments(collection), "listDocuments"],
    ["POST", gatewayRoutes.createDocument(collection), "createDocument"],
    ["GET", gatewayRoutes.statusDocument(document), "statusDocument"],
    ["POST", gatewayRoutes.queryDocument(document), "queryDocument"],
    ["POST", gatewayRoutes.applyDocument(document), "applyDocument"],
    ["GET", gatewayRoutes.exportDocument(document), "exportDocument"],
    ["GET", gatewayRoutes.historyDocument(document), "historyDocument"],
    ["POST", gatewayRoutes.rollbackDocument(document), "rollbackDocument"],
    ["GET", gatewayRoutes.snapshotDocument(document), "snapshotDocument"],
    ["GET", gatewayRoutes.irDocument(document), "irDocument"],
    ["POST", gatewayRoutes.initFromHash(document), "initFromHash"],
    ["POST", gatewayRoutes.runOperator(document), "runOperator"],
    ["POST", gatewayRoutes.resetOperator(document), "resetOperator"],
  ])("matches %s %s", (method, pathname, operation) => {
    expect(matchGatewayRoute(method, pathname)).toEqual({
      kind: "document",
      operation,
      tenantId: collection.tenantId,
      docType: collection.docType,
      ...(operation === "listDocuments" || operation === "createDocument"
        ? {}
        : { docId: document.docId }),
    });
  });

  test.each([
    ["GET", gatewayCasRoutes.readContent({ tenantId: "t", hash: "h" }), "readContent"],
    ["GET", gatewayCasRoutes.readMetadata({ tenantId: "t", hash: "h" }), "readMetadata"],
    ["POST", gatewayCasRoutes.lease({ tenantId: "t", hash: "h" }), "lease"],
    ["GET", gatewayCasRoutes.usage({ tenantId: "t" }), "usage"],
    ["POST", gatewayCasRoutes.gc({ tenantId: "t" }), "gc"],
  ])("matches public CAS %s %s", (method, pathname, operation) => {
    expect(matchGatewayRoute(method, pathname)).toEqual({
      kind: "cas",
      route: expect.objectContaining({ operation, tenantId: "t" }),
    });
  });

  test("rejects private CAS, legacy, and wrong-method routes", () => {
    expect(matchGatewayRoute("POST", "/tenants/t/cas/root-refs")).toBeNull();
    expect(matchGatewayRoute("POST", "/tenants/t/cas/nodes/h")).toBeNull();
    expect(matchGatewayRoute("GET", "/users/u/docs/docx/")).toBeNull();
    expect(matchGatewayRoute("GET", gatewayRoutes.applyDocument(document))).toBeNull();
  });

  test("Gateway exposure policy excludes private writes and audit operations", () => {
    expect(isGatewayExposedCasRoute({ operation: "readContent", tenantId: "t", hash: "h" })).toBe(true);
    expect(isGatewayExposedCasRoute({ operation: "readMetadata", tenantId: "t", hash: "h" })).toBe(true);
    expect(isGatewayExposedCasRoute({ operation: "lease", tenantId: "t", hash: "h" })).toBe(true);
    expect(isGatewayExposedCasRoute({ operation: "usage", tenantId: "t" })).toBe(true);
    expect(isGatewayExposedCasRoute({ operation: "gc", tenantId: "t" })).toBe(true);
    // CAS audit routes are /admin — the gateway's CAS matcher never returns them.
    expect(matchGatewayRoute("GET", "/admin/stacks/s/root-ref-domains/doc/refs")).toBeNull();
    expect(matchGatewayRoute("GET", "/admin/stacks/s/root-ref-domains/doc/events")).toBeNull();
    expect(matchGatewayRoute("POST", "/admin/stacks/s/member-invitations")).toBeNull();
  });

  test("freezes encoded public document paths", () => {
    expect(gatewayRoutes.listDocuments(collection))
      .toBe("/tenants/tenant%2Fa/docs/doc%20type/");
    expect(gatewayRoutes.statusDocument(document))
      .toBe("/tenants/tenant%2Fa/docs/doc%20type/doc%2F1");
    expect(gatewayRoutes.initFromHash(document))
      .toBe("/tenants/tenant%2Fa/docs/doc%20type/doc%2F1/init_from_hash");
  });
});