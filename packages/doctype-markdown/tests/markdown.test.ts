import { describe, expect, it } from "vitest";
import { createMarkdownDocumentType } from "../src/index.js";

describe("createMarkdownDocumentType", () => {
  it("creates an independent document type", async () => {
    const markdown = createMarkdownDocumentType({});
    const doc = await markdown.apply([
      { kind: "setContent", payload: { content: "# Hello" } },
      { kind: "appendSection", payload: { heading: "World", content: "Text" } },
    ], await markdown.init());

    await expect(markdown.query({ kind: "getHeadings", payload: undefined }, doc))
      .resolves.toEqual(["Hello", "World"]);
  });
});