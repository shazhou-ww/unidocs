import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, test } from "vitest";
import { inspectBundleManifest, storeTypeCardBundleObjects, type BundleObjectWrite } from "../src/index.js";

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';

function webp() {
  return Uint8Array.from(Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));
}

async function inspection() {
  const manifest = {
    protocol: "unidocs-type-card/v1" as const,
    documentType: "markdown",
    locales: { en: { name: "Markdown", description: "Text", sampleThumbnailAlt: "Example" } },
    icon: { kind: "svg" as const, path: "icon.svg" },
    sampleThumbnail: "sample.webp",
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  await writer.add("unidocs-type-card.json", new TextReader(JSON.stringify(manifest, null, 2)));
  await writer.add("icon.svg", new TextReader(svg));
  await writer.add("sample.webp", new Uint8ArrayReader(webp()));
  const archive = await writer.close();
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(archive); controller.close(); } });
  return inspectBundleManifest(source, { kind: "type-card", documentContractIdxs: [] });
}

describe("Type Card immutable object storage", () => {
  test("stores canonical manifest and validated assets under a full content identity", async () => {
    const inspected = await inspection();
    const writes: BundleObjectWrite[] = [];
    const stored = await storeTypeCardBundleObjects(inspected, { async put(object) { writes.push(object); } });
    expect(stored.typeCardBundleId).toMatch(/^tb_[0-9a-f]{64}$/);
    expect(stored.rootKey).toBe(`type-card-bundles/${stored.typeCardBundleId}/`);
    expect(writes.map(write => write.key).sort()).toEqual([
      `${stored.rootKey}icon.svg`,
      `${stored.rootKey}sample.webp`,
      `${stored.rootKey}unidocs-type-card.json`,
    ]);
    const manifest = writes.find(write => write.contentType === "application/json")!;
    expect(new TextDecoder().decode(manifest.bytes)).toBe(inspected.canonicalManifest);
    expect(manifest.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(writes.map(write => write.contentType).sort()).toEqual(["application/json", "image/svg+xml", "image/webp"]);
    expect(writes.every(write => /^[0-9a-f]{64}$/.test(write.sha256))).toBe(true);
  });

  test("does not publish success when an object write fails", async () => {
    const inspected = await inspection();
    await expect(storeTypeCardBundleObjects(inspected, {
      async put(object) {
        if (object.key.endsWith("sample.webp")) throw new Error("R2 unavailable");
      }
    })).rejects.toThrow("R2 unavailable");
  });
});