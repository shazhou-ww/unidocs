import { describe, expect, test } from "vitest";
import { prepareReference, references } from "./reference-config.js";

describe("API reference presentation", () => {
  test("keeps renderer-specific grouping outside protocol packages", async () => {
    const admin = references.find((reference) => reference.path === "/reference/admin");
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

  test("consumes both generated OpenAPI documents", async () => {
    const documents = await Promise.all(references.map((reference) => reference.loadDocument()));
    expect(documents.every((document) => document.openapi === "3.1.1")).toBe(true);
  });
});