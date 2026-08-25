// Diagnostic harness (not an assertion test): measures the PURE CPU cost of
// re-compositing tiles after a layer-visibility toggle, with every layer's
// pixels already resident. No BlobStore, no network — so whatever it reports
// is the floor the browser pays on EVERY toggle, first load or not.
//
// Run: pnpm vitest run packages/doctype-psd/tests/tile-perf.bench.test.ts
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { load } from "../src/psd/load.js";
import { serialize, deserialize } from "../src/psd/ir.js";
import { IncrementalCompositor } from "../src/render/incremental.js";
import { renderCached, renderRegion, DEFAULT_CACHE_BYTES } from "../src/render/composite.js";
import { renderRegionDirect } from "../src/render/region.js";
import { applyOne } from "../src/ops/index.js";
import { PixelCache } from "../src/render/pixel-source.js";
import { tilesForRect } from "../src/render/tile-grid.js";
import type { BlobStore } from "../src/render/pixel-source.js";
import type { RenderCtx } from "../src/render/composite.js";
import type { PsdDoc, Layer, Pixels } from "../src/model/types.js";

const TILE = 256;

function residentLayer(id: string, name: string, w: number, h: number, seed: number): Layer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i + seed) % 256;
    data[i * 4 + 1] = (i * 3 + seed) % 256;
    data[i * 4 + 2] = (i * 7 + seed) % 256;
    data[i * 4 + 3] = 255;
  }
  const pixels: Pixels = { width: w, height: h, data };
  return {
    id, name, type: "raster", opacity: 1, blendMode: "normal", visible: true,
    bounds: [0, 0, h, w], pixels,
  } as unknown as Layer;
}

/** A doc shaped like the reported repro: a big canvas, N full-canvas layers. */
function syntheticDoc(w: number, h: number, n: number): PsdDoc {
  return {
    canvas: { width: w, height: h },
    layers: Array.from({ length: n }, (_, i) => residentLayer(`L${i}`, `layer${i}`, w, h, i * 17)),
  } as unknown as PsdDoc;
}

/** In-memory CAS, mirroring the browser's `CasBlobStore` contract. */
function memStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(bytes: Uint8Array) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    },
    async get(hash: string) { return blobs.get(hash) ?? null; },
  };
}

/**
 * The doc shape the BROWSER actually renders: `serialize` pushes every layer's
 * pixels into the CAS and `deserialize` brings them back as lazy `PixelRef`s,
 * so the resident doc holds only metadata and pixels are faulted in through
 * the `PixelCache` — exactly what `materializePsdDocFromStore` does in the
 * render worker. Cloning this doc (as `applyOne` does per op) copies metadata
 * only, whereas the `load()`-parsed doc used elsewhere here is fully resident.
 */
async function lazyDoc(resident: PsdDoc): Promise<{ doc: PsdDoc; ctx: RenderCtx }> {
  const store = memStore();
  const bytes = await serialize(resident, store);
  const doc = await deserialize(bytes, store);
  return { doc, ctx: { store, cache: new PixelCache(1024 * 1024 * 1024) } };
}

async function measureToggle(doc: PsdDoc, label: string, viewport: { w: number; h: number }, ctx?: RenderCtx): Promise<void> {
  const comp = new IncrementalCompositor(doc, { tileSize: TILE, ctx });
  if (ctx) await comp.prefetch();
  const visible = tilesForRect(doc.canvas, TILE, [0, 0, Math.min(viewport.h, doc.canvas.height), Math.min(viewport.w, doc.canvas.width)]);

  // Warm pass: what the very first paint costs.
  const warmStart = performance.now();
  for (const t of visible) await comp.readTile(t.tx, t.ty);
  const warmMs = performance.now() - warmStart;

  const layers = doc.layers as unknown as Array<{ id: string }>;
  const bottomId = layers[0].id;
  const topId = layers[layers.length - 1].id;

  const run = async (layerId: string, visibleVal: boolean, tag: string): Promise<void> => {
    const applyStart = performance.now();
    await comp.applyOp({ kind: "set_props", payload: { layerId, props: { visible: visibleVal } } } as never);
    const applyMs = performance.now() - applyStart;
    const per: number[] = [];
    const tilesStart = performance.now();
    for (const t of visible) {
      const s = performance.now();
      await comp.readTile(t.tx, t.ty);
      per.push(performance.now() - s);
    }
    const totalMs = performance.now() - tilesStart;
    const worst = per.indexOf(Math.max(...per));
    const sorted = [...per].sort((a, b) => a - b);
    console.log(
      `[bench] ${label} ${tag}: applyOp=${applyMs.toFixed(1)}ms tiles=${visible.length} ` +
      `total=${totalMs.toFixed(0)}ms median=${sorted[sorted.length >> 1].toFixed(1)}ms ` +
      `max=${sorted[sorted.length - 1].toFixed(1)}ms@i=${worst}(${visible[worst].tx},${visible[worst].ty}) ` +
      `first=${per[0].toFixed(1)}ms`,
    );
  };

  console.log(`[bench] ${label}: canvas=${doc.canvas.width}x${doc.canvas.height} layers=${layers.length} visibleTiles=${visible.length} firstPaint=${warmMs.toFixed(0)}ms`);
  await run(bottomId, false, "toggle BOTTOM off (1st)");
  await run(bottomId, true, "toggle BOTTOM on  (2nd, same layer)");
  await run(topId, false, "toggle TOP off");
  await run(topId, true, "toggle TOP on  (2nd, same layer)");
  await run(bottomId, false, "toggle BOTTOM again (layer switched)");
}

const REAL = "/Users/yanjiayi/Downloads/landing-page-capture-yourself-theme/4414025.psd";

// Diagnostic only — it measures, it doesn't assert, and the large-doc cases
// take ~40s. Off by default; run with PSD_TILE_BENCH=1 to get the numbers.
describe.skipIf(!process.env.PSD_TILE_BENCH)("tile recomposite cost (diagnostic)", () => {
  it("real sample.psd", async () => {
    const bytes = readFileSync(fileURLToPath(new URL("./fixtures/sample.psd", import.meta.url)));
    const doc = await load(new Uint8Array(bytes));
    await measureToggle(doc, "sample.psd", { w: 1600, h: 1000 });
  }, 120_000);

  const realRun = existsSync(REAL) ? it : it.skip;
  realRun("real landing.psd (the reported repro)", async () => {
    const doc = await load(new Uint8Array(readFileSync(REAL)));
    const describeLayer = (l: any, depth = 0): void => {
      const px = l.pixels ? `${l.pixels.width}x${l.pixels.height}` : "-";
      const fx = [l.stroke && "stroke", l.dropShadow && "dropShadow", l.colorOverlay && "colorOverlay", l.mask && "mask", l.clipping && "clipping"].filter(Boolean).join(",");
      console.log(`[layers] ${"  ".repeat(depth)}${l.type} "${l.name}" px=${px} bounds=[${l.bounds}] ${fx ? "fx=" + fx : ""}`);
      for (const c of l.children ?? []) describeLayer(c, depth + 1);
    };
    for (const l of doc.layers as any[]) describeLayer(l);
    await measureToggle(doc, "landing.psd RESIDENT", { w: 1600, h: 1000 });
  }, 600_000);

  realRun("real landing.psd — LAZY doc (what the browser worker renders)", async () => {
    const resident = await load(new Uint8Array(readFileSync(REAL)));
    const { doc, ctx } = await lazyDoc(resident);
    await measureToggle(doc, "landing.psd LAZY", { w: 1600, h: 1000 }, ctx);
  }, 600_000);

  // Mirrors what queries.ts `getPreview` does per request: a FRESH
  // PixelCache(DEFAULT_CACHE_BYTES) is constructed on every call, and
  // renderRegion composites the whole canvas before cropping.
  realRun("server getPreview path (fresh PixelCache per request)", async () => {
    const resident = await load(new Uint8Array(readFileSync(REAL)));
    const { doc: lazy, ctx } = await lazyDoc(resident);
    const store = ctx.store;
    const freshCtx = (): RenderCtx => ({ store, cache: new PixelCache(DEFAULT_CACHE_BYTES) });

    const t = async (tag: string, fn: () => Promise<unknown>): Promise<void> => {
      const s = performance.now();
      await fn();
      console.log(`[server] ${tag}: ${(performance.now() - s).toFixed(0)}ms`);
    };

    await t("getPreview #1 (cold)", () => renderCached(lazy, freshCtx()));
    await t("getPreview #2 (same doc, framebuffer hit)", () => renderCached(lazy, freshCtx()));
    const edited = applyOne(lazy, { kind: "set_props", payload: { layerId: (lazy.layers[0] as any).id, props: { visible: false } } } as never);
    await t("getPreview #3 (after 1 edit -> new doc)", () => renderCached(edited, freshCtx()));
    await t("getPreview #4 (after edit, repeat)", () => renderCached(edited, freshCtx()));
    await t("renderRegion 256x256 rect", () => renderRegion(edited, [0, 0, 256, 256], freshCtx()));
    const edited2 = applyOne(edited, { kind: "set_props", payload: { layerId: (lazy.layers[0] as any).id, props: { visible: true } } } as never);
    await t("renderRegion 256x256 after edit", () => renderRegion(edited2, [0, 0, 256, 256], freshCtx()));
    // What getPreview COULD use: composite straight into the region buffer.
    const edited3 = applyOne(edited2, { kind: "set_props", payload: { layerId: (lazy.layers[0] as any).id, props: { visible: false } } } as never);
    await t("renderRegionDirect 256x256 after edit", () => renderRegionDirect(edited3, [0, 0, 256, 256], freshCtx()));
    const edited4 = applyOne(edited3, { kind: "set_props", payload: { layerId: (lazy.layers[0] as any).id, props: { visible: true } } } as never);
    await t("renderRegionDirect 1024x1024 after edit", () => renderRegionDirect(edited4, [0, 0, 1024, 1024], freshCtx()));
  }, 600_000);

  it("synthetic large doc (big background, many layers)", async () => {
    await measureToggle(syntheticDoc(3000, 2000, 12), "3000x2000 x12 layers", { w: 1600, h: 1000 });
  }, 300_000);
});
