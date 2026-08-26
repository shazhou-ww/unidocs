import { describe, expect, it } from "vitest";
import { StaticDocServiceRegistry } from "../src/doc-service-registry.js";

describe("StaticDocServiceRegistry", () => {
  it("resolves deployment-time URL, service ID, and access key", async () => {
    const registry = new StaticDocServiceRegistry(JSON.stringify({
      markdown: {
        serviceId: "markdown-primary",
        url: "https://markdown.internal/",
        accessKey: "markdown-key",
      },
    }));

    await expect(registry.resolve("markdown")).resolves.toEqual({
      serviceId: "markdown-primary",
      url: "https://markdown.internal",
      accessKey: "markdown-key",
    });
    await expect(registry.resolve("docx")).resolves.toBeNull();
  });

  it("rejects duplicate service IDs and empty credentials", () => {
    expect(() => new StaticDocServiceRegistry(JSON.stringify({
      markdown: { serviceId: "shared", url: "https://markdown.internal", accessKey: "key" },
      docx: { serviceId: "shared", url: "https://docx.internal", accessKey: "key" },
    }))).toThrow(/Duplicate Doc serviceId/);
    expect(() => new StaticDocServiceRegistry(JSON.stringify({
      markdown: { serviceId: "markdown", url: "https://markdown.internal", accessKey: "" },
    }))).toThrow(/accessKey/);
    expect(() => new StaticDocServiceRegistry(JSON.stringify({
      markdown: { serviceId: "markdown", url: "https://markdown.internal" },
    }))).toThrow(/accessKey or audience/);
  });

  it("supports capability-only and dual registrations", async () => {
    const registry = new StaticDocServiceRegistry(JSON.stringify({
      markdown: {
        serviceId: "markdown-primary",
        url: "https://markdown.internal",
        audience: "unidocs-doc:markdown",
      },
      docx: {
        serviceId: "docx-primary",
        url: "https://docx.internal",
        accessKey: "docx-key",
        audience: "unidocs-doc:docx",
      },
    }));

    const markdown = await registry.resolve("markdown");
    expect(markdown).toMatchObject({ audience: "unidocs-doc:markdown" });
    expect(markdown).not.toHaveProperty("accessKey");
    await expect(registry.resolve("docx")).resolves.toMatchObject({
      accessKey: "docx-key",
      audience: "unidocs-doc:docx",
    });
  });
});