import { describe, expect, it } from "vitest";
import { Document } from "@ariadng/office/docx";
import { RELATIONSHIPS_CONTENT_TYPE } from "@ariadng/office/opc";
import {
  buildOpenXmlPackage,
  CONTENT_TYPES_CONTENT_TYPE,
  extractOpenXmlPackage,
  materializeDocxPackage,
  openDocxPackage,
} from "../src/package-adapter.js";

const MAIN_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

describe("OpenXML package adapter", () => {
  it("extracts every ZIP file with deterministic content types", async () => {
    const bytes = await Document.create().save();
    const opened = await openDocxPackage(bytes);

    expect(opened.document.office.family).toBe("word");
    expect(Object.keys(opened.files)).toEqual(expect.arrayContaining([
      "/[Content_Types].xml",
      "/_rels/.rels",
      "/word/document.xml",
      "/word/_rels/document.xml.rels",
    ]));
    expect(opened.files["/[Content_Types].xml"].contentType)
      .toBe(CONTENT_TYPES_CONTENT_TYPE);
    expect(opened.files["/_rels/.rels"].contentType)
      .toBe(RELATIONSHIPS_CONTENT_TYPE);
    expect(opened.files["/word/document.xml"].contentType)
      .toBe(MAIN_CONTENT_TYPE);
  });

  it("materializes an extracted manifest into a readable document", async () => {
    const original = Document.create();
    original.addParagraph("round trip");
    const files = await extractOpenXmlPackage(await original.save());

    const rebuiltBytes = await buildOpenXmlPackage(files);
    const rebuilt = await Document.open(rebuiltBytes);
    const materialized = await materializeDocxPackage(files);

    expect(rebuilt.text()).toBe("round trip");
    expect(materialized.text()).toBe("round trip");
  });

  it("changes the main XML part while preserving untouched part bytes", async () => {
    const originalBytes = await Document.create().save();
    const originalFiles = await extractOpenXmlPackage(originalBytes);
    const document = await Document.open(originalBytes);
    document.addParagraph("changed");
    const changedFiles = await extractOpenXmlPackage(await document.save());

    expect(bytesEqual(
      originalFiles["/word/document.xml"].data,
      changedFiles["/word/document.xml"].data,
    )).toBe(false);
    expect(bytesEqual(
      originalFiles["/word/styles.xml"].data,
      changedFiles["/word/styles.xml"].data,
    )).toBe(true);
  });

  it("rejects manifest content types that disagree with OPC metadata", async () => {
    const files = await extractOpenXmlPackage(await Document.create().save());
    const invalid = {
      ...files,
      "/word/document.xml": {
        ...files["/word/document.xml"],
        contentType: "application/xml",
      },
    };

    await expect(buildOpenXmlPackage(invalid)).rejects.toThrow(/content type mismatch/);
  });

  it("rejects equivalent paths and configured package limits", async () => {
    const bytes = await Document.create().save();
    const files = await extractOpenXmlPackage(bytes);
    const duplicate = {
      ...files,
      "/WORD/document.xml": files["/word/document.xml"],
    };

    await expect(buildOpenXmlPackage(duplicate)).rejects.toThrow(/Duplicate equivalent/);
    await expect(openDocxPackage(bytes, { maxEntries: 1 })).rejects.toThrow(/ZIP entries/);
    await expect(buildOpenXmlPackage(files, { maxPartBytes: 1 })).rejects.toThrow(/part .* exceeds/);
    await expect(buildOpenXmlPackage({
      ...files,
      "relative.xml": files["/word/document.xml"],
    })).rejects.toThrow(/manifest path must be absolute/);
  });
});