import { describe, expect, test } from "vitest";
import { casRoutes } from "@unidocs/protocol-cas";
import { gatewayRoutes, matchGatewayRoute } from "../src/index.js";

const collection = { tenantId: "tenant/a", docType: "doc type" };
const document = { ...collection, docId: "doc/1" };

describe("Gateway routes", () => {
  test.each([
    ["GET", gatewayRoutes.listDocuments(collection), "listDocuments"],
    ["POST", gatewayRoutes.createDocument(collection), "createDocument"],
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
    ["GET", casRoutes.readContent({ tenantId: "t", hash: "h" }), "readContent"],
    ["GET", casRoutes.readMetadata({ tenantId: "t", hash: "h" }), "readMetadata"],
    ["POST", casRoutes.leaseNode({ tenantId: "t", hash: "h" }), "leaseNode"],
    ["POST", casRoutes.leaseExisting({ tenantId: "t", hash: "h" }), "leaseExisting"],
    ["GET", casRoutes.usage({ tenantId: "t" }), "usage"],
    ["POST", casRoutes.gc({ tenantId: "t" }), "gc"],
  ])("matches public CAS %s %s", (method, pathname, operation) => {
    expect(matchGatewayRoute(method, pathname)).toEqual({
      kind: "cas",
      route: expect.objectContaining({ operation, tenantId: "t" }),
    });
  });

  test("rejects private CAS, legacy, and wrong-method routes", () => {
    expect(matchGatewayRoute("POST", casRoutes.rootRefs({ tenantId: "t" }))).toBeNull();
    expect(matchGatewayRoute("GET", "/users/u/docs/docx/")).toBeNull();
    expect(matchGatewayRoute("GET", gatewayRoutes.applyDocument(document))).toBeNull();
  });
});