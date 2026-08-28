import { describe, expect, it } from "vitest";
import { StaticDocServiceRegistry } from "../src/doc-service-registry.js";

describe("StaticDocServiceRegistry", () => {
  it("resolves deployment-time URL, service ID, and audience", async () => {
    const registry = new StaticDocServiceRegistry(JSON.stringify({
      markdown: {
        serviceId: "markdown-primary",
        url: "https://markdown.internal/",
        audience: "unidocs-doc:markdown",
      },
    }));

    await expect(registry.resolve("markdown")).resolves.toEqual({
      serviceId: "markdown-primary",
      url: "https://markdown.internal",
      audience: "unidocs-doc:markdown",
    });
    await expect(registry.resolve("docx")).resolves.toBeNull();
  });

  it("rejects duplicate service IDs and empty audiences", () => {
    expect(() => new StaticDocServiceRegistry(JSON.stringify({
      markdown: { serviceId: "shared", url: "https://markdown.internal", audience: "unidocs-doc:markdown" },
      docx: { serviceId: "shared", url: "https://docx.internal", audience: "unidocs-doc:docx" },
    }))).toThrow(/Duplicate Doc serviceId/);
    expect(() => new StaticDocServiceRegistry(JSON.stringify({
      markdown: { serviceId: "markdown", url: "https://markdown.internal", audience: "" },
    }))).toThrow(/audience/);
    expect(() => new StaticDocServiceRegistry(JSON.stringify({
      markdown: { serviceId: "markdown", url: "https://markdown.internal" },
    }))).toThrow(/audience/);
  });

  it("supports capability registrations", async () => {
    const registry = new StaticDocServiceRegistry(JSON.stringify({
      markdown: {
        serviceId: "markdown-primary",
        url: "https://markdown.internal",
        audience: "unidocs-doc:markdown",
      },
      docx: {
        serviceId: "docx-primary",
        url: "https://docx.internal",
        audience: "unidocs-doc:docx",
      },
    }));

    const markdown = await registry.resolve("markdown");
    expect(markdown).toMatchObject({ audience: "unidocs-doc:markdown" });
    await expect(registry.resolve("docx")).resolves.toMatchObject({
      audience: "unidocs-doc:docx",
    });
  });
});