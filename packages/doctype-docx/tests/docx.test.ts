import { describe, expect, it } from "vitest";
import { createTestDocx } from "./test-context.js";

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("createDocxDocumentType", () => {
  it("creates, edits, queries, and reloads a DOCX document", async () => {
    const { docx } = createTestDocx();
    const initial = await docx.init();

    expect(docx.formats.docx.mediaTypes).toContain(DOCX_CONTENT_TYPE);
    await expect(docx.query({ kind: "getText" }, initial)).resolves.toBe("");

    const updated = await docx.apply([
      {
        kind: "appendParagraph",
        payload: { text: "Draft", options: { style: "Heading1", bold: true } },
      },
      {
        kind: "setRunText",
        payload: { paragraphIndex: 0, runIndex: 0, text: "Final" },
      },
      {
        kind: "appendParagraph",
        payload: { text: "Body", options: { italic: true } },
      },
    ], initial);

    await expect(docx.query({ kind: "getText" }, initial)).resolves.toBe("");
    await expect(docx.query({ kind: "getParagraphs" }, updated)).resolves.toEqual([
      {
        index: 0,
        text: "Final",
        styleId: "Heading1",
        runs: [{ index: 0, text: "Final", bold: true, italic: false }],
      },
      {
        index: 1,
        text: "Body",
        styleId: null,
        runs: [{ index: 0, text: "Body", bold: false, italic: true }],
      },
    ]);

    const bytes = await docx.formats.docx.save(updated);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);

    const reloaded = await docx.formats.docx.load(bytes);
    await expect(docx.query({ kind: "getText" }, reloaded))
      .resolves.toBe("Final\nBody");
  });

  it("does not mutate the input when an operation batch fails", async () => {
    const { docx } = createTestDocx();
    const baseline = await docx.apply([
      { kind: "appendParagraph", payload: { text: "Existing" } },
    ], await docx.init());
    const before = await docx.formats.docx.save(baseline);

    await expect(docx.apply([
      { kind: "appendParagraph", payload: { text: "Not committed" } },
      {
        kind: "setRunText",
        payload: { paragraphIndex: 99, runIndex: 0, text: "Failure" },
      },
    ], baseline)).rejects.toThrow("Paragraph 99 not found");

    await expect(docx.query({ kind: "getText" }, baseline))
      .resolves.toBe("Existing");
    await expect(docx.formats.docx.save(baseline)).resolves.toEqual(before);
  });
});
