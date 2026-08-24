import { describe, expect, it } from "vitest";
import { Document } from "@ariadng/office/docx";
import { encodeSValueWithRefs } from "@unidocs/doctype-server-common/internal";
import { createTestDocx } from "./test-context.js";

function createDocxDocumentType(_options: Record<string, never>) {
  return createTestDocx().docx;
}

describe("table operations", () => {
  it("adds a table and queries its structure", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "addTable", payload: { rows: 2, cols: 3, style: "TableGrid" } },
    ], doc);

    const tables = await docx.query({ kind: "getTables", payload: undefined }, doc);
    expect(tables).toEqual([
      { index: 0, depth: 0, rowCount: 2, columnCount: 3, styleId: "TableGrid" },
    ]);
  });

  it("adds a table with custom column widths", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.apply([
      {
        kind: "addTable",
        payload: { rows: 1, cols: 2, widthsTwips: [3000, 6000] },
      },
    ], await docx.init());

    const materialized = await Document.open(await docx.formats.docx.save(doc));
    const table = materialized.tables()[0];
    const firstWidth = table.cell(0, 0).element
      .find("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "tcPr")
      ?.find("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "tcW")
      ?.getAttributeNs("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w");
    expect(firstWidth).toBe("3000");
  });

  it("rejects invalid custom column widths", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.init();

    await expect(docx.apply([
      { kind: "addTable", payload: { rows: 1, cols: 2, widthsTwips: [3000] } },
    ], doc)).rejects.toThrow("widthsTwips must contain exactly 2 values");
  });

  it("sets cell text in a table", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "addTable", payload: { rows: 2, cols: 2 } },
      { kind: "setCellText", payload: { tableIndex: 0, row: 0, col: 0, text: "Name" } },
      { kind: "setCellText", payload: { tableIndex: 0, row: 0, col: 1, text: "Value" } },
      { kind: "setCellText", payload: { tableIndex: 0, row: 1, col: 0, text: "A" } },
      { kind: "setCellText", payload: { tableIndex: 0, row: 1, col: 1, text: "42" } },
    ], doc);

    const table = await docx.query({ kind: "getTable", payload: { index: 0 } }, doc) as any;
    expect(table.rows[0].cells[0].text).toBe("Name");
    expect(table.rows[0].cells[1].text).toBe("Value");
    expect(table.rows[1].cells[0].text).toBe("A");
    expect(table.rows[1].cells[1].text).toBe("42");
  });

  it("adds a row to a table", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "addTable", payload: { rows: 1, cols: 2 } },
    ], doc);

    let tables = await docx.query({ kind: "getTables", payload: undefined }, doc) as any;
    expect(tables[0].rowCount).toBe(1);

    doc = await docx.apply([
      { kind: "addTableRow", payload: { tableIndex: 0 } },
    ], doc);

    tables = await docx.query({ kind: "getTables", payload: undefined }, doc) as any;
    expect(tables[0].rowCount).toBe(2);
  });

  it("throws on invalid table index", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.init();

    await expect(docx.apply([
      { kind: "setCellText", payload: { tableIndex: 99, row: 0, col: 0, text: "x" } },
    ], doc)).rejects.toThrow("Table 99 not found");
  });
});

describe("list operations", () => {
  it("adds a bullet list", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "addBulletList", payload: { items: ["Alpha", "Beta", "Gamma"] } },
    ], doc);

    const text = await docx.query({ kind: "getText", payload: undefined }, doc);
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).toContain("Gamma");

    const paragraphs = await docx.query({ kind: "getParagraphs", payload: undefined }, doc) as any;
    expect(paragraphs).toHaveLength(3);

    const list = await docx.query(
      { kind: "getParagraphList", payload: { paragraphIndex: 0 } },
      doc,
    );
    expect(list).toMatchObject({ level: 0, format: "bullet", isBullet: true });
  });

  it("adds a nested bullet list", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      {
        kind: "addBulletList",
        payload: {
          items: ["Top", { text: "Nested", level: 1 }, "Bottom"],
        },
      },
    ], doc);

    const text = await docx.query({ kind: "getText", payload: undefined }, doc);
    expect(text).toContain("Top");
    expect(text).toContain("Nested");
    expect(text).toContain("Bottom");
  });

  it("adds a numbered list", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "addNumberedList", payload: { items: ["First", "Second", "Third"] } },
    ], doc);

    const text = await docx.query({ kind: "getText", payload: undefined }, doc);
    expect(text).toContain("First");
    expect(text).toContain("Second");
    expect(text).toContain("Third");
  });

  it("adds a numbered list with custom format", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      {
        kind: "addNumberedList",
        payload: { items: ["Alpha", "Beta"], format: "lowerLetter" },
      },
    ], doc);

    const text = await docx.query({ kind: "getText", payload: undefined }, doc);
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
  });

  it("skips empty items", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.init();

    const result = await docx.apply([
      { kind: "addBulletList", payload: { items: [] } },
    ], doc);

    const text = await docx.query({ kind: "getText", payload: undefined }, result);
    expect(text).toBe("");
  });
});

describe("effective formatting queries", () => {
  it("resolves paragraph and run formatting", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.apply([
      {
        kind: "appendParagraph",
        payload: { text: "Heading", options: { style: "Heading1", bold: true } },
      },
    ], await docx.init());

    const paragraphFormat = await docx.query(
      { kind: "getParagraphFormat", payload: { paragraphIndex: 0 } },
      doc,
    );
    expect(paragraphFormat).toMatchObject({ styleId: "Heading1" });

    const runFormat = await docx.query(
      { kind: "getRunFormat", payload: { paragraphIndex: 0, runIndex: 0 } },
      doc,
    );
    expect(runFormat).toMatchObject({ bold: true });
  });

  it("returns null list metadata for a normal paragraph", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.apply([
      { kind: "appendParagraph", payload: { text: "Body" } },
    ], await docx.init());

    await expect(docx.query(
      { kind: "getParagraphList", payload: { paragraphIndex: 0 } },
      doc,
    )).resolves.toBeNull();
  });
});

describe("section operations", () => {
  it("sets a default header", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "setHeader", payload: { text: "Company Name" } },
    ], doc);

    const headers = await docx.query({ kind: "getHeaders", payload: undefined }, doc) as any;
    expect(headers).toHaveLength(1);
    expect(headers[0].text).toBe("Company Name");
    expect(headers[0].type).toBe("default");
  });

  it("sets a first-page header", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "setHeader", payload: { text: "Cover Page", type: "first" } },
    ], doc);

    const headers = await docx.query({ kind: "getHeaders", payload: undefined }, doc) as any;
    expect(headers[0].type).toBe("first");
    expect(headers[0].text).toBe("Cover Page");
  });

  it("sets a footer", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "setFooter", payload: { text: "Page footer" } },
    ], doc);

    const footers = await docx.query({ kind: "getFooters", payload: undefined }, doc) as any;
    expect(footers).toHaveLength(1);
    expect(footers[0].text).toBe("Page footer");
    expect(footers[0].type).toBe("default");
  });

  it("replaces an existing header", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "setHeader", payload: { text: "First" } },
    ], doc);

    doc = await docx.apply([
      { kind: "setHeader", payload: { text: "Second" } },
    ], doc);

    const headers = await docx.query({ kind: "getHeaders", payload: undefined }, doc) as any;
    expect(headers).toHaveLength(1);
    expect(headers[0].text).toBe("Second");
  });
});

const PNG_1x1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe("insertImage and getImages", () => {
  it("derives insertImage refs from the SValue operation", async () => {
    const { context } = createTestDocx();
    const blob = await context.makeSBlob({ data: PNG_1x1, contentType: "image/png" });

    expect(encodeSValueWithRefs({
      kind: "insertImage",
      payload: { blob, widthPx: 16 },
    }).refs).toEqual([blob.hash]);
    expect(encodeSValueWithRefs({
      kind: "appendParagraph",
      payload: { text: "x" },
    }).refs).toEqual([]);
  });

  it("inserts a PNG from SBlob storage and lists it", async () => {
    const { context, docx } = createTestDocx();
    const blob = await context.makeSBlob({ data: PNG_1x1, contentType: "image/png" });
    const initial = await docx.init();
    const updated = await docx.apply([
      { kind: "insertImage", payload: { blob, widthPx: 16, altText: "dot" } },
    ], initial);

    const images = await docx.query({ kind: "getImages", payload: undefined }, updated);
    expect(images).toEqual([
      expect.objectContaining({
        index: 0,
        format: "png",
        altText: "dot",
        placement: "inline",
      }),
    ]);
    expect((images as { partName: string }[])[0].partName).toMatch(/image1\.png$/);
  });

});

