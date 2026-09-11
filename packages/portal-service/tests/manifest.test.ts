import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { BundleZipError, inspectBundleManifest } from "../src/index.js";

const view = {
  protocol: "unidocs-view-bundle/v1", documentType: "markdown",
  entrypoints: { interactive: "view.html", thumbnail: "thumbnail.html" }, supportedDocumentContractIdxs: [0, 2],
};
const card = {
  protocol: "unidocs-type-card/v1", documentType: "markdown",
  locales: { en: { name: "Markdown", description: "Text", sampleThumbnailAlt: "Example" }, "zh-CN": { name: "Markdown", description: "Text", sampleThumbnailAlt: "Example" } },
  icon: { kind: "svg", path: "icon.svg" }, sampleThumbnail: "sample.webp",
};
type FixtureFile = [string, string | Uint8Array];

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number) {
  const chunk = (type: string, data: Uint8Array) => {
    const bytes = new Uint8Array(12 + data.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(data, 8);
    view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
    return bytes;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6;
  const chunks = [chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())];
  const result = new Uint8Array(8 + chunks.reduce((size, value) => size + value.length, 0));
  result.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  for (const value of chunks) { result.set(value, offset); offset += value.length; }
  return result;
}

function webp(width: number, height: number) {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  view.setUint32(16, 10, true);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes.set([encodedWidth & 0xff, (encodedWidth >>> 8) & 0xff, encodedWidth >>> 16], 24);
  bytes.set([encodedHeight & 0xff, (encodedHeight >>> 8) & 0xff, encodedHeight >>> 16], 27);
  return bytes;
}

const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#123" d="M0 0h1v1z"/></svg>';
const viewFiles: [string, string][] = [["view.html", "<html>View</html>"], ["thumbnail.html", "<html>Thumbnail</html>"], ["app.js", "export {};"]];
const cardFiles: FixtureFile[] = [["icon.svg", validSvg], ["sample.webp", webp(640, 360)]];
const expectedView = { kind: "view" as const, documentType: "markdown", documentContractIdxs: [0, 1, 2] };
const expectedCard = { ...expectedView, kind: "type-card" as const };

async function archive(manifest: unknown, files: FixtureFile[] = viewFiles, kind = "view", pretty = false, reverse = false) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  const entries: FixtureFile[] = [[kind === "view" ? "unidocs-view.json" : "unidocs-type-card.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, pretty ? 2 : undefined)], ...files];
  for (const [path, content] of reverse ? entries.reverse() : entries) {
    await writer.add(path, typeof content === "string" ? new TextReader(content) : new Uint8ArrayReader(content));
  }
  const bytes = await writer.close();
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

describe("bundle manifest and content identity", () => {
  test("validates both View entrypoints and registered paired revisions", async () => {
    const result = await inspectBundleManifest(await archive(view), expectedView);
    expect(result.manifest).toEqual(view);
    expect(result.files).toHaveLength(4);
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("canonical identity ignores ZIP ordering and manifest whitespace/key order", async () => {
    const original = await inspectBundleManifest(await archive(view), expectedView);
    const reordered = { supportedDocumentContractIdxs: [0, 2], entrypoints: { thumbnail: "thumbnail.html", interactive: "view.html" }, documentType: "markdown", protocol: view.protocol };
    const repacked = await inspectBundleManifest(await archive(reordered, viewFiles, "view", true, true), expectedView);
    expect(repacked.contentHash).toBe(original.contentHash);
    expect(repacked.canonicalManifest).toBe(original.canonicalManifest);
    expect(repacked.files).toEqual(original.files);
    expect(repacked.files.find(file => file.path === "unidocs-view.json")).toMatchObject({
      size: new TextEncoder().encode(repacked.canonicalManifest).byteLength,
      sha256: createHash("sha256").update(repacked.canonicalManifest).digest("hex"),
    });
    const changed = await inspectBundleManifest(await archive(view, [...viewFiles, ["new.js", "new content"]]), expectedView);
    expect(changed.contentHash).not.toBe(original.contentHash);
    const revision = await inspectBundleManifest(await archive({ ...view, supportedDocumentContractIdxs: [0] }), expectedView);
    expect(revision.contentHash).not.toBe(original.contentHash);
  });

  test.each([
    { ...view, documentType: "psd" }, { ...view, extra: true },
    { ...view, entrypoints: { interactive: "view.html", thumbnail: "view.html" } },
    { ...view, entrypoints: { interactive: "https://evil.example/view.html", thumbnail: "thumbnail.html" } },
    { ...view, entrypoints: { interactive: "../view.html", thumbnail: "thumbnail.html" } },
    { ...view, entrypoints: { interactive: "missing.html", thumbnail: "thumbnail.html" } },
    { ...view, entrypoints: { interactive: "app.js", thumbnail: "thumbnail.html" } },
    { ...view, supportedDocumentContractIdxs: [0, 0] }, { ...view, supportedDocumentContractIdxs: [3] },
    { ...view, supportedDocumentContractIdxs: [] }, { ...view, supportedDocumentContractIdxs: [-1] },
    { ...view, entrypoints: { ...view.entrypoints, extra: true } },
    "{broken", "null",
  ])("rejects incompatible or malformed View manifest %#", async manifest => {
    await expect(inspectBundleManifest(await archive(manifest), expectedView)).rejects.toBeInstanceOf(BundleZipError);
  });

  test("rejects mixed bundle kinds, missing manifests, empty entries and oversized manifests", async () => {
    await expect(inspectBundleManifest(await archive(view, [...viewFiles, ["unidocs-type-card.json", JSON.stringify(card)]]), expectedView)).rejects.toBeInstanceOf(BundleZipError);
    await expect(inspectBundleManifest(await archive(view, viewFiles, "type-card"), expectedView)).rejects.toBeInstanceOf(BundleZipError);
    await expect(inspectBundleManifest(await archive(view, [["view.html", ""], ["thumbnail.html", "html"]]), expectedView)).rejects.toBeInstanceOf(BundleZipError);
    await expect(inspectBundleManifest(await archive(" ".repeat(65_537) + JSON.stringify(view)), expectedView)).rejects.toBeInstanceOf(BundleZipError);
  });

  test.each([
    JSON.stringify(view).replace('"documentType":"markdown"', '"documentType":"psd","documentType":"markdown"'),
    JSON.stringify(view).replace('"interactive":"view.html"', '"interactive":"evil.html","interact\\u0069ve":"view.html"'),
    JSON.stringify(view).replace('{', '{/* comment */'),
    JSON.stringify(view).replace('"thumbnail":"thumbnail.html"', '"thumbnail":"thumbnail.html",'),
    '\ufeff' + JSON.stringify(view),
    JSON.stringify(view) + '{}',
  ])("rejects ambiguous or non-JSON manifest encoding %#", async text => {
    await expect(inspectBundleManifest(await archive(text), expectedView)).rejects.toBeInstanceOf(BundleZipError);
  });

  test("validates Type Card fallback locale and referenced assets", async () => {
    const result = await inspectBundleManifest(await archive(card, cardFiles, "type-card"), expectedCard);
    expect(result.manifest).toEqual(card);
    expect(result.kind).toBe("type-card");
    expect(result.assets?.map(({ path, contentType, width, height }) => ({ path, contentType, width, height }))).toEqual([
      { path: "icon.svg", contentType: "image/svg+xml", width: null, height: null },
      { path: "sample.webp", contentType: "image/webp", width: 640, height: 360 },
    ]);
    expect(result.assets?.find(asset => asset.path === "sample.webp")?.bytes).toEqual(cardFiles[1][1]);
  });

  test("requires every PNG raster reference to exist", async () => {
    const sizes = [16, 32, 64, 128, 256];
    const manifest = { ...card, icon: { kind: "png", images: Object.fromEntries(sizes.map(size => [size, `icon-${size}.png`])) } };
    const files: FixtureFile[] = [...sizes.map(size => [`icon-${size}.png`, png(size, size)] as FixtureFile), ["sample.webp", webp(640, 360)]];
    const result = await inspectBundleManifest(await archive(manifest, files, "type-card"), expectedCard);
    expect(result.manifest).toEqual(manifest);
    await expect(inspectBundleManifest(await archive(manifest, files.slice(1), "type-card"), expectedCard)).rejects.toBeInstanceOf(BundleZipError);
  });

  test("changing asset bytes or its path changes content identity", async () => {
    const original = await inspectBundleManifest(await archive(card, cardFiles, "type-card"), expectedCard);
    const changedSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="8"/></svg>';
    const changed = await inspectBundleManifest(await archive(card, [["icon.svg", changedSvg], cardFiles[1]], "type-card"), expectedCard);
    const renamed = await inspectBundleManifest(await archive({ ...card, icon: { kind: "svg", path: "other.svg" } }, [["other.svg", validSvg], cardFiles[1]], "type-card"), expectedCard);
    expect(changed.contentHash).not.toBe(original.contentHash);
    expect(renamed.contentHash).not.toBe(original.contentHash);
  });

  test("rejects invalid, incorrectly sized, or unreferenced Type Card assets", async () => {
    await expect(inspectBundleManifest(await archive(card, [["icon.svg", validSvg], ["sample.webp", "not-webp"]], "type-card"), expectedCard)).rejects.toBeInstanceOf(BundleZipError);
    const sizes = [16, 32, 64, 128, 256];
    const manifest = { ...card, icon: { kind: "png", images: Object.fromEntries(sizes.map(size => [size, `icon-${size}.png`])) } };
    const wrongSizeFiles: FixtureFile[] = [...sizes.map(size => [`icon-${size}.png`, png(size === 32 ? 31 : size, size)] as FixtureFile), ["sample.webp", webp(640, 360)]];
    await expect(inspectBundleManifest(await archive(manifest, wrongSizeFiles, "type-card"), expectedCard)).rejects.toBeInstanceOf(BundleZipError);
    await expect(inspectBundleManifest(await archive(card, [...cardFiles, ["run.js", "alert(1)"]], "type-card"), expectedCard)).rejects.toBeInstanceOf(BundleZipError);
  });

  test.each([
    { ...card, locales: { "zh-CN": card.locales.en } },
    { ...card, locales: { en: card.locales.en, "zh-cn": card.locales.en } },
    { ...card, locales: { en: card.locales.en, "not_a_tag": card.locales.en } },
    { ...card, icon: { kind: "svg", path: "missing.svg" } },
    { ...card, icon: { kind: "png", images: { 16: "icon.png" } } },
    { ...card, sampleThumbnail: "icon.svg" },
    { ...card, locales: { en: { ...card.locales.en, extra: true } } },
  ])("rejects incomplete Type Card metadata %#", async manifest => {
    await expect(inspectBundleManifest(await archive(manifest, cardFiles, "type-card"), expectedCard)).rejects.toBeInstanceOf(BundleZipError);
  });
});