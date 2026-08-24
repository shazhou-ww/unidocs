import { describe, expect, it } from "vitest";
import { encodeSValueWithRefs } from "@unidocs/doctype-server-common/internal";
import type { SBlob } from "@unidocs/protocol";
import { createTestDocx, type TestDocumentTypeContext } from "./test-context.js";

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const PNG_2x2 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
  0x08, 0x02, 0x00, 0x00, 0x00, 0xfd, 0xd4, 0x9a,
  0x73, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x08, 0x00, 0x01, 0xe5, 0x27, 0xde,
  0xfc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function imageBlob(
  context: TestDocumentTypeContext,
  data: Uint8Array = PNG_1x1,
): Promise<SBlob> {
  return context.makeSBlob({ data, contentType: "image/png" });
}

describe("deleteImage", () => {
  it("deletes an image by index", async () => {
    const { context, docx } = createTestDocx();
    const blob = await imageBlob(context);
    let doc = await docx.apply([
      { kind: "insertImage", payload: { blob, widthPx: 16, altText: "first" } },
      { kind: "insertImage", payload: { blob, widthPx: 32, altText: "second" } },
    ], await docx.init());

    doc = await docx.apply([{ kind: "deleteImage", payload: { index: 0 } }], doc);

    const images = await docx.query({ kind: "getImages" }, doc) as any[];
    expect(images).toHaveLength(1);
    expect(images[0].altText).toBe("second");
  });

  it("throws on out-of-range index", async () => {
    const { docx } = createTestDocx();
    await expect(docx.apply([
      { kind: "deleteImage", payload: { index: 0 } },
    ], await docx.init())).rejects.toThrow(/Image index 0 out of range/);
  });
});

describe("replaceImage", () => {
  it("replaces image bytes and preserves drawing metadata", async () => {
    const { context, docx } = createTestDocx();
    const first = await imageBlob(context);
    const second = await imageBlob(context, PNG_2x2);
    let doc = await docx.apply([
      { kind: "insertImage", payload: { blob: first, widthPx: 16, altText: "original" } },
    ], await docx.init());

    doc = await docx.apply([
      { kind: "replaceImage", payload: { index: 0, blob: second } },
    ], doc);

    const images = await docx.query({ kind: "getImages" }, doc) as any[];
    expect(images).toHaveLength(1);
    expect(images[0].altText).toBe("original");
  });

  it("derives the replacement Blob from the operation SValue", async () => {
    const { context } = createTestDocx();
    const blob = await imageBlob(context, PNG_2x2);
    expect(encodeSValueWithRefs({
      kind: "replaceImage",
      payload: { index: 0, blob },
    }).refs).toEqual([blob.hash]);
  });
});

describe("image metadata operations", () => {
  it("updates both display dimensions", async () => {
    const { context, docx } = createTestDocx();
    const blob = await imageBlob(context);
    let doc = await docx.apply([
      { kind: "insertImage", payload: { blob, widthPx: 1 } },
    ], await docx.init());
    doc = await docx.apply([{
      kind: "setImageSize",
      payload: { index: 0, widthEmu: 952500, heightEmu: 1905000 },
    }], doc);

    const image = (await docx.query({ kind: "getImages" }, doc) as any[])[0];
    expect(image.widthEmu).toBe(952500);
    expect(image.heightEmu).toBe(1905000);
  });

  it("updates only width when height is omitted", async () => {
    const { context, docx } = createTestDocx();
    const blob = await imageBlob(context);
    let doc = await docx.apply([
      { kind: "insertImage", payload: { blob, widthPx: 1 } },
    ], await docx.init());
    const before = (await docx.query({ kind: "getImages" }, doc) as any[])[0];
    doc = await docx.apply([{
      kind: "setImageSize",
      payload: { index: 0, widthEmu: 500000 },
    }], doc);
    const after = (await docx.query({ kind: "getImages" }, doc) as any[])[0];
    expect(after.widthEmu).toBe(500000);
    expect(after.heightEmu).toBe(before.heightEmu);
  });

  it("updates and clears alt text", async () => {
    const { context, docx } = createTestDocx();
    const blob = await imageBlob(context);
    let doc = await docx.apply([
      { kind: "insertImage", payload: { blob, altText: "old" } },
      { kind: "setImageAltText", payload: { index: 0, altText: "new" } },
    ], await docx.init());
    expect((await docx.query({ kind: "getImages" }, doc) as any[])[0].altText).toBe("new");

    doc = await docx.apply([
      { kind: "setImageAltText", payload: { index: 0, altText: "" } },
    ], doc);
    expect((await docx.query({ kind: "getImages" }, doc) as any[])[0].altText).toBe("");
  });
});

describe("image queries", () => {
  it("gets an image by index", async () => {
    const { context, docx } = createTestDocx();
    const blob = await imageBlob(context);
    const doc = await docx.apply([
      { kind: "insertImage", payload: { blob, altText: "img0" } },
      { kind: "insertImage", payload: { blob, altText: "img1" } },
    ], await docx.init());

    const image = await docx.query({ kind: "getImage", payload: { index: 1 } }, doc) as any;
    expect(image).toMatchObject({ index: 1, altText: "img1", format: "png" });

    const content = await docx.query({
      kind: "getImageContent",
      payload: { index: 1 },
    }, doc) as any;
    expect(content.blob).toBe(doc.files[content.partName]);
    expect(content.blob.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws on an out-of-range image query", async () => {
    const { docx } = createTestDocx();
    await expect(docx.query(
      { kind: "getImage", payload: { index: 0 } },
      await docx.init(),
    )).rejects.toThrow(/Image index 0 out of range/);
  });

  it("finds by part name and returns null for an unknown part", async () => {
    const { context, docx } = createTestDocx();
    const blob = await imageBlob(context);
    const doc = await docx.apply([
      { kind: "insertImage", payload: { blob, altText: "found" } },
    ], await docx.init());
    const partName = (await docx.query({ kind: "getImages" }, doc) as any[])[0].partName;

    await expect(docx.query(
      { kind: "getImageByPartName", payload: { partName } },
      doc,
    )).resolves.toMatchObject({ index: 0, altText: "found" });
    await expect(docx.query(
      { kind: "getImageByPartName", payload: { partName: "/word/media/missing.png" } },
      doc,
    )).resolves.toBeNull();
  });
});