/**
 * Tests for image operations and queries.
 */

import { describe, expect, it } from "vitest";
import { createDocxDocumentType } from "../src/index.js";

// Minimal 1×1 PNG (67 bytes)
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1×1
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

// Minimal 2×2 PNG (different dimensions for size testing)
const PNG_2x2 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, // 2×2
  0x08, 0x02, 0x00, 0x00, 0x00, 0xfd, 0xd4, 0x9a,
  0x73, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x08, 0x00, 0x01, 0xe5, 0x27, 0xde,
  0xfc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const hash1 = "a".repeat(64);
const hash2 = "b".repeat(64);

function casWith(bytes: Uint8Array, hash: string = hash1) {
  return {
    read: async () => bytes,
    metadata: async () => ({
      hash,
      size: bytes.length,
      contentType: "image/png",
      refs: [] as string[],
    }),
  };
}

function casMulti(entries: { hash: string; bytes: Uint8Array }[]) {
  const map = new Map(entries.map((e) => [e.hash, e.bytes]));
  return {
    read: async (ref: { hash: string }) => {
      const bytes = map.get(ref.hash);
      if (!bytes) throw new Error(`CAS hash not found: ${ref.hash}`);
      return bytes;
    },
    metadata: async (ref: { hash: string }) => {
      const bytes = map.get(ref.hash);
      return {
        hash: ref.hash,
        size: bytes?.length ?? 0,
        contentType: "image/png",
        refs: [] as string[],
      };
    },
  };
}

describe("deleteImage", () => {
  it("deletes an image by index", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    // Insert two images
    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 16, altText: "first" } },
      { kind: "insertImage", payload: { hash: hash1, widthPx: 32, altText: "second" } },
    ], doc, { cas: casWith(PNG_1x1) });

    // Verify we have 2 images
    let images = await docx.query({ kind: "getImages", payload: undefined }, doc) as any[];
    expect(images).toHaveLength(2);
    expect(images[0].altText).toBe("first");
    expect(images[1].altText).toBe("second");

    // Delete the first image
    doc = await docx.apply([
      { kind: "deleteImage", payload: { index: 0 } },
    ], doc);

    // Verify only 1 image remains
    images = await docx.query({ kind: "getImages", payload: undefined }, doc) as any[];
    expect(images).toHaveLength(1);
    expect(images[0].altText).toBe("second");
  });

  it("throws on out-of-range index", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.init();

    await expect(docx.apply([
      { kind: "deleteImage", payload: { index: 0 } },
    ], doc)).rejects.toThrow(/Image index 0 out of range/);
  });
});

describe("replaceImage", () => {
  it("replaces image bytes from CAS", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    // Insert an image
    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 16, altText: "original" } },
    ], doc, { cas: casWith(PNG_1x1) });

    // Replace with new bytes
    doc = await docx.apply([
      { kind: "replaceImage", payload: { index: 0, hash: hash2 } },
    ], doc, { cas: casMulti([{ hash: hash2, bytes: PNG_2x2 }]) });

    // Verify the image is still there
    const images = await docx.query({ kind: "getImages", payload: undefined }, doc) as any[];
    expect(images).toHaveLength(1);
    expect(images[0].altText).toBe("original");
  });

  it("counts replaceImage hash in refsFromOp", () => {
    const docx = createDocxDocumentType({});
    expect(docx.refsFromOp({
      kind: "replaceImage",
      payload: { index: 0, hash: hash2 },
    })).toEqual({ [hash2]: 1 });
  });

  it("rejects invalid hash", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();
    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 16 } },
    ], doc, { cas: casWith(PNG_1x1) });

    await expect(docx.apply([
      { kind: "replaceImage", payload: { index: 0, hash: "invalid" } },
    ], doc, { cas: casWith(PNG_2x2) })).rejects.toThrow(/Hash must be/);
  });
});

describe("setImageSize", () => {
  it("updates image display size", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    // Insert an image with default size (1×1 px = 9525×9525 EMU)
    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 1 } },
    ], doc, { cas: casWith(PNG_1x1) });

    // Set new size (100×200 pixels = 952500×1905000 EMU)
    doc = await docx.apply([
      { kind: "setImageSize", payload: { index: 0, widthEmu: 952500, heightEmu: 1905000 } },
    ], doc);

    // Verify size changed
    const images = await docx.query({ kind: "getImages", payload: undefined }, doc) as any[];
    expect(images[0].widthEmu).toBe(952500);
    expect(images[0].heightEmu).toBe(1905000);
  });

  it("updates only width when height is omitted", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 1 } },
    ], doc, { cas: casWith(PNG_1x1) });

    const before = (await docx.query({ kind: "getImages", payload: undefined }, doc) as any[])[0];

    doc = await docx.apply([
      { kind: "setImageSize", payload: { index: 0, widthEmu: 500000 } },
    ], doc);

    const after = (await docx.query({ kind: "getImages", payload: undefined }, doc) as any[])[0];
    expect(after.widthEmu).toBe(500000);
    expect(after.heightEmu).toBe(before.heightEmu);
  });
});

describe("setImageAltText", () => {
  it("updates alt text", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 16, altText: "old" } },
    ], doc, { cas: casWith(PNG_1x1) });

    doc = await docx.apply([
      { kind: "setImageAltText", payload: { index: 0, altText: "new description" } },
    ], doc);

    const images = await docx.query({ kind: "getImages", payload: undefined }, doc) as any[];
    expect(images[0].altText).toBe("new description");
  });

  it("sets alt text to empty string", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 16, altText: "something" } },
    ], doc, { cas: casWith(PNG_1x1) });

    doc = await docx.apply([
      { kind: "setImageAltText", payload: { index: 0, altText: "" } },
    ], doc);

    const images = await docx.query({ kind: "getImages", payload: undefined }, doc) as any[];
    expect(images[0].altText).toBe("");
  });
});

describe("getImage query", () => {
  it("returns one image by index", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 16, altText: "img0" } },
      { kind: "insertImage", payload: { hash: hash1, widthPx: 32, altText: "img1" } },
    ], doc, { cas: casWith(PNG_1x1) });

    const img = await docx.query({ kind: "getImage", payload: { index: 1 } }, doc) as any;
    expect(img.index).toBe(1);
    expect(img.altText).toBe("img1");
    expect(img.format).toBe("png");
    expect(img.placement).toBe("inline");
  });

  it("throws on out-of-range index", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.init();

    await expect(
      docx.query({ kind: "getImage", payload: { index: 0 } }, doc)
    ).rejects.toThrow(/Image index 0 out of range/);
  });
});

describe("getImageByPartName query", () => {
  it("finds an image by part name", async () => {
    const docx = createDocxDocumentType({});
    let doc = await docx.init();

    doc = await docx.apply([
      { kind: "insertImage", payload: { hash: hash1, widthPx: 16, altText: "found" } },
    ], doc, { cas: casWith(PNG_1x1) });

    // Get the part name from getImages
    const images = await docx.query({ kind: "getImages", payload: undefined }, doc) as any[];
    const partName = images[0].partName;

    const img = await docx.query(
      { kind: "getImageByPartName", payload: { partName } },
      doc,
    ) as any;
    expect(img).not.toBeNull();
    expect(img.altText).toBe("found");
    expect(img.index).toBe(0);
  });

  it("returns null for unknown part name", async () => {
    const docx = createDocxDocumentType({});
    const doc = await docx.init();

    const result = await docx.query(
      { kind: "getImageByPartName", payload: { partName: "/word/media/image99.png" } },
      doc,
    );
    expect(result).toBeNull();
  });
});
