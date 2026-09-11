import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, test } from "vitest";
import { canonicalJson, contractHash, resourceEtag, schemaHash } from "../../../packages/portal-service/src/index.ts";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "../../../packages/portal-service/node_modules/@zip.js/zip.js/index.js";

test("Portal identities agree between Node and the Workers runtime", async () => {
  const built = await build({
    stdin: {
      contents: `import { canonicalJson, contractHash, resourceEtag, schemaHash } from './packages/portal-service/src/index.ts';
        export default { async fetch(request) {
          const { value, contract } = await request.json();
          return Response.json({ canonical: canonicalJson(value), schema: await schemaHash(value),
            etag: await resourceEtag(value), contract: await contractHash(contract) });
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
  });
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{ name: "portal-identity", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-08-18" }],
  }));
  try {
    for (const value of [
      {},
      { numbers: [333333333.33333329, 1e30, -0, 1e-27], "\ud83d\ude00": "\u20ac\n", "\ufb33": true },
      { enabled: false, etag: "not-hashed", schema: { type: "object", properties: { title: { type: "string" } } } },
    ]) {
      const contract = { documentType: "markdown", formatVersion: 1, snapshot: { schema: value }, location: { schema: { type: "null" } } };
      const response = await miniflare.dispatchFetch("https://portal.test/", { method: "POST", body: JSON.stringify({ value, contract }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ canonical: canonicalJson(value), schema: await schemaHash(value), etag: await resourceEtag(value), contract: await contractHash(contract) });
    }
  } finally {
    await miniflare.dispose();
  }
});

test("Portal ZIP inspection validates deflate and rejects damaged content inside workerd", async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true });
  await writer.add("view.html", new TextReader("<html>View</html>"));
  await writer.add("app.js", new TextReader("export {};"), { level: 0 });
  const archive = await writer.close();
  const built = await build({
    stdin: {
      contents: `import { inspectBundleZip } from './packages/portal-service/src/index.ts';
        export default { async fetch(request) {
          try { return Response.json(await inspectBundleZip(request.body)); }
          catch (error) { if (error.code === 'bundle_invalid') return new Response('bundle_invalid', { status: 422 }); throw error; }
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
  });
  const miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "portal-zip", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-08-18" }] }));
  try {
    const response = await miniflare.dispatchFetch("https://portal.test/", { method: "POST", body: archive });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ path: "app.js", size: 10 }, { path: "view.html", size: 17 }]);
    const damaged = archive.slice();
    const stored = new TextEncoder().encode("export {};");
    const offset = damaged.findIndex((_, index) => stored.every((byte, position) => damaged[index + position] === byte));
    expect(offset).toBeGreaterThan(0);
    damaged[offset] ^= 1;
    expect((await miniflare.dispatchFetch("https://portal.test/", { method: "POST", body: damaged })).status).toBe(422);
  } finally {
    await miniflare.dispose();
  }
});

test("Portal manifest validation and canonical bundle identity agree in Node and workerd", async () => {
  const { inspectBundleManifest } = await import("../../../packages/portal-service/src/index.ts");
  const manifest = { protocol: "unidocs-view-bundle/v1", documentType: "markdown", entrypoints: { interactive: "view.html", thumbnail: "thumbnail.html" }, supportedDocumentContractIdxs: [0] };
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  await writer.add("unidocs-view.json", new TextReader(JSON.stringify(manifest, null, 2)));
  await writer.add("view.html", new TextReader("<html>View</html>"));
  await writer.add("thumbnail.html", new TextReader("<html>Thumbnail</html>"));
  const archive = await writer.close();
  const expected = { kind: "view", documentType: "markdown", documentContractIdxs: [0] };
  const result = await inspectBundleManifest(new ReadableStream({ start(controller) { controller.enqueue(archive); controller.close(); } }), expected);
  const built = await build({
    stdin: {
      contents: `import { inspectBundleManifest } from './packages/portal-service/src/index.ts';
        export default { async fetch(request) {
          try { return Response.json(await inspectBundleManifest(request.body, { kind: 'view', documentType: 'markdown', documentContractIdxs: [0] })); }
          catch (error) { if (error.code === 'bundle_invalid') return new Response('bundle_invalid', { status: 422 }); throw error; }
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
  });
  const miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "portal-bundle-manifest", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-08-18" }] }));
  try {
    const response = await miniflare.dispatchFetch("https://portal.test/", { method: "POST", body: archive });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  } finally {
    await miniflare.dispose();
  }
});