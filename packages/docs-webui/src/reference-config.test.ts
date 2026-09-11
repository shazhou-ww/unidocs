import { describe, expect, test } from "vitest";
import { guides } from "./content.js";
import { prepareReference, references } from "./reference-config.js";

describe("API reference presentation", () => {
  test("keeps renderer-specific grouping outside protocol packages", async () => {
    const admin = references.find((reference) => reference.path === "/unicas/reference/admin");
    expect(admin).toBeDefined();
    const sourceDocument = await admin!.loadDocument();
    expect(await prepareReference(admin!)).toHaveProperty("x-tagGroups", [
      { name: "Stack Administration", tags: ["Identity", "Stacks", "Members"] },
      { name: "Capability Configuration", tags: ["OAuth Issuer", "Managed Issuer"] },
      { name: "Application Workflow", tags: ["Playground"] },
      { name: "Audit & Diagnostics", tags: ["Audit", "Root Ref Audit"] },
    ]);
    expect(sourceDocument).not.toHaveProperty("x-tagGroups");
  });

  test("consumes every generated OpenAPI document", async () => {
    const documents = await Promise.all(references.map((reference) => reference.loadDocument()));
    expect(documents.every((document) => document.openapi === "3.1.1")).toBe(true);
  });

  test("keeps every page under its product prefix", () => {
    expect([...guides, ...references].every((entry) => entry.path.startsWith(`/${entry.product}/`))).toBe(true);
  });

  test("groups the UniDocs Admin contract without modifying protocol output", async () => {
    const admin = references.find((reference) => reference.path === "/unidocs/reference/admin");
    expect(admin).toBeDefined();
    const sourceDocument = await admin!.loadDocument();
    expect(sourceDocument).not.toHaveProperty("x-tagGroups");
    expect(await prepareReference(admin!)).toHaveProperty("x-tagGroups", [
      { name: "Document Type Configuration", tags: ["Document types", "Document Contracts"] },
      { name: "Presentation Bundles", tags: ["Type Card bundles", "View bundles"] },
      { name: "Processing", tags: ["Operators"] },
      { name: "Administration", tags: ["Members", "Audit"] },
    ]);
    const paths = sourceDocument.paths as Record<string, unknown>;
    expect(Object.keys(paths)).toHaveLength(15);
    expect(admin?.operationOrder).toHaveLength(26);
  });
});