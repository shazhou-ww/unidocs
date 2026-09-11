import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
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
const viewFiles: [string, string][] = [["view.html", "<html>View</html>"], ["thumbnail.html", "<html>Thumbnail</html>"], ["app.js", "export {};"]];
const cardFiles: [string, string][] = [["icon.svg", "<svg/>"], ["sample.webp", "fixture-for-reference-check-only"]];
const expectedView = { kind: "view" as const, documentType: "markdown", documentContractIdxs: [0, 1, 2] };
const expectedCard = { ...expectedView, kind: "type-card" as const };

async function archive(manifest: unknown, files = viewFiles, kind = "view", pretty = false, reverse = false) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  const entries: [string, string][] = [[kind === "view" ? "unidocs-view.json" : "unidocs-type-card.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, pretty ? 2 : undefined)], ...files];
  for (const [path, text] of reverse ? entries.reverse() : entries) await writer.add(path, new TextReader(text));
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
  });

  test("requires every PNG raster reference to exist", async () => {
    const sizes = [16, 32, 64, 128, 256];
    const manifest = { ...card, icon: { kind: "png", images: Object.fromEntries(sizes.map(size => [size, `icon-${size}.png`])) } };
    const files: [string, string][] = [...sizes.map(size => [`icon-${size}.png`, "reference-only fixture"] as [string, string]), ["sample.webp", "reference-only fixture"]];
    const result = await inspectBundleManifest(await archive(manifest, files, "type-card"), expectedCard);
    expect(result.manifest).toEqual(manifest);
    await expect(inspectBundleManifest(await archive(manifest, files.slice(1), "type-card"), expectedCard)).rejects.toBeInstanceOf(BundleZipError);
  });

  test("changing asset bytes or its path changes content identity", async () => {
    const original = await inspectBundleManifest(await archive(card, cardFiles, "type-card"), expectedCard);
    const changed = await inspectBundleManifest(await archive(card, [["icon.svg", "<svg><path/></svg>"], cardFiles[1]], "type-card"), expectedCard);
    const renamed = await inspectBundleManifest(await archive({ ...card, icon: { kind: "svg", path: "other.svg" } }, [["other.svg", "<svg/>"], cardFiles[1]], "type-card"), expectedCard);
    expect(changed.contentHash).not.toBe(original.contentHash);
    expect(renamed.contentHash).not.toBe(original.contentHash);
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