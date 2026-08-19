import { describe, expect, it } from "vitest";
import { createDocxDocumentType } from "../src/index.js";

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

    const table = doc.document.tables()[0];
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

describe("tools and instructions", () => {
  it("exposes all expected tools", async () => {
    const docx = createDocxDocumentType({});

    // Queries
    expect(docx.tools.getText).toBeDefined();
    expect(docx.tools.getParagraphs).toBeDefined();
    expect(docx.tools.getParagraph).toBeDefined();
    expect(docx.tools.getParagraphFormat).toBeDefined();
    expect(docx.tools.getRunFormat).toBeDefined();
    expect(docx.tools.getParagraphList).toBeDefined();
    expect(docx.tools.getTables).toBeDefined();
    expect(docx.tools.getTable).toBeDefined();
    expect(docx.tools.getHeaders).toBeDefined();
    expect(docx.tools.getFooters).toBeDefined();

    // Paragraph operations
    expect(docx.tools.appendParagraph).toBeDefined();
    expect(docx.tools.setRunText).toBeDefined();

    // Table operations
    expect(docx.tools.addTable).toBeDefined();
    expect(docx.tools.setCellText).toBeDefined();
    expect(docx.tools.addTableRow).toBeDefined();

    // List operations
    expect(docx.tools.addBulletList).toBeDefined();
    expect(docx.tools.addNumberedList).toBeDefined();

    // Section operations
    expect(docx.tools.setHeader).toBeDefined();
    expect(docx.tools.setFooter).toBeDefined();
  });

  it("has non-empty instructions", async () => {
    const docx = createDocxDocumentType({});
    expect(docx.instructions).toBeTruthy();
    expect(docx.instructions.length).toBeGreaterThan(100);
  });
});
