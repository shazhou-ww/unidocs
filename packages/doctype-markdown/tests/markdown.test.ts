import { describe, expect, it } from "vitest";
import type { DocumentTypeContext } from "@unidocs/protocol";
import { createMarkdownDocumentType } from "../src/index.js";

describe("createMarkdownDocumentType", () => {
  it("creates an independent document type", async () => {
    const markdown = createMarkdownDocumentType({} as DocumentTypeContext);
    const doc = await markdown.apply([
      { kind: "setContent", payload: { content: "# Hello" } },
      { kind: "appendSection", payload: { heading: "World", content: "Text" } },
    ], await markdown.init());

    await expect(markdown.query({ kind: "getHeadings" }, doc))
      .resolves.toEqual(["Hello", "World"]);

    const bytes = await markdown.formats.markdown.save(doc);
    await expect(markdown.formats.markdown.load(bytes)).resolves.toEqual(doc);
    expect(markdown.defaultFormat).toBe("markdown");
  });
});