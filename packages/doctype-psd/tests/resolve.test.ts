import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { PsdDoc, Layer } from "../src/model/types.js";
import type { BlobStore } from "../src/render/pixel-source.js";
import { isRef, resolvePixels, PixelCache } from "../src/render/pixel-source.js";
import { serialize, deserialize } from "../src/psd/ir.js";
import { FaultConcurrency, resolveDoc, resolveLayerPixels } from "../src/resolve.js";
import { apply } from "../src/ops/index.js";
import { save } from "../src/psd/save.js";
import { findLayer } from "../src/model/tree.js";

/** In-memory content-addressed BlobStore. */
function memStore(): BlobStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(bytes: Uint8Array) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    },
    async get(hash: string) {
      return blobs.get(hash) ?? null;
    },
  };
}

const canvas = { width: 2, height: 1, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

/** 2x1 raster: left pixel red, right pixel green — so a horizontal flip is
 *  observable (the two swap). */
function rasterData(): Uint8ClampedArray {
  return new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
}

function buildDoc(): PsdDoc {
  const child: Layer = {
    id: "child-1",
    type: "raster",
    name: "Child",
    bounds: [0, 0, 1, 2],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 2, height: 1, data: rasterData() },
  };
  const group: Layer = {
    id: "group-1",
    type: "group",
    name: "Group",
    bounds: [0, 0, 1, 2],
    opacity: 1,
    blendMode: "pass-through",
    visible: true,
    locked: false,
    clipping: false,
    children: [child],
  };
  const top: Layer = {
    id: "top-1",
    type: "raster",
    name: "Top",
    bounds: [0, 0, 1, 2],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 2, height: 1, data: rasterData() },
  };
  return { canvas, layers: [group, top] };
}

/** serialize → deserialize = a "cold reload": every raster is a lazy PixelRef. */
async function lazyReload(store: BlobStore, doc: PsdDoc): Promise<PsdDoc> {
  const bytes = await serialize(doc, store);
  return deserialize(bytes, store);
}

describe("resolveDoc / resolveLayerPixels (C1/C2 fault-in)", () => {
  it("C1: a lazy (cold-reloaded) doc cannot be saved until resolveDoc faults in its refs", async () => {
    const store = memStore();
    const lazy = await lazyReload(store, buildDoc());

    // Precondition: reload yielded lazy refs.
    expect(isRef(findLayer(lazy.layers, "child-1")!.pixels!)).toBe(true);
    expect(isRef(findLayer(lazy.layers, "top-1")!.pixels!)).toBe(true);

    // Regression the fix prevents: save() throws on an unresolved PixelRef.
    await expect(save(lazy)).rejects.toThrow(/PixelRef/);

    // resolveDoc faults EVERY layer (nested included) to resident, non-mutating
    // the input doc, and the result saves to valid PSD bytes.
    const resolved = await resolveDoc(lazy, store);
    expect(isRef(findLayer(resolved.layers, "child-1")!.pixels!)).toBe(false);
    expect(isRef(findLayer(resolved.layers, "top-1")!.pixels!)).toBe(false);
    // input untouched (resolveDoc returns a new doc)
    expect(isRef(findLayer(lazy.layers, "child-1")!.pixels!)).toBe(true);

    // pixel bytes are byte-identical to the original
    expect([...(findLayer(resolved.layers, "child-1")!.pixels as any).data]).toEqual([...rasterData()]);

    const bytes = await save(resolved);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // PSD magic '8BPS'
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x38, 0x42, 0x50, 0x53]);
  });

  it("resolveLayerPixels faults only the target layer, leaving siblings lazy", async () => {
    const store = memStore();
    const lazy = await lazyReload(store, buildDoc());

    const resolved = await resolveLayerPixels(lazy, "top-1", store);
    expect(isRef(findLayer(resolved.layers, "top-1")!.pixels!)).toBe(false);
    // sibling stays lazy — memory win preserved
    expect(isRef(findLayer(resolved.layers, "child-1")!.pixels!)).toBe(true);
    // input untouched
    expect(isRef(findLayer(lazy.layers, "top-1")!.pixels!)).toBe(true);
  });

  // NOTE: the apply-level flip fault-in pre-step (auto-resolving a lazy target
  // before flipping) was removed while conforming to main's DocumentType
  // interface — apply no longer touches a store. So a flip against a lazy doc
  // now hits geometry-ops' loud PixelRef guard regardless of any ctx. Callers
  // that need a lazy flip must resolveLayerPixels() first (covered above). The
  // apply-level auto-fault path returns with the lazy-pixel stage.
  it("C2: apply([flip], lazyDoc) throws loudly on the lazy ref (pre-resolve deferred)", async () => {
    const store = memStore();
    const flipOp = { kind: "transform", payload: { layerId: "top-1", op: { flip: "h" } } };

    const lazy1 = await lazyReload(store, buildDoc());
    await expect(apply([flipOp], lazy1)).rejects.toThrow(/PixelRef/);

    // A ctx no longer changes this — apply ignores it, the guard still fires.
    const lazy2 = await lazyReload(store, buildDoc());
    await expect(apply([flipOp], lazy2)).rejects.toThrow(/PixelRef/);

    // Manually faulting the target first lets the flip succeed.
    const lazy3 = await lazyReload(store, buildDoc());
    const resolved = await resolveLayerPixels(lazy3, "top-1", store);
    const flipped = await apply([flipOp], resolved);
    const px = findLayer(flipped.layers, "top-1")!.pixels as any;
    expect(isRef(px)).toBe(false);
    // horizontal flip of [red, green] → [green, red]
    expect([...px.data]).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
    // untouched layer stays lazy
    expect(isRef(findLayer(flipped.layers, "child-1")!.pixels!)).toBe(true);
  });

  it("resident-doc apply(flip) is unchanged whether or not a store is passed", async () => {
    const store = memStore();
    const flipOp = { kind: "transform", payload: { layerId: "top-1", op: { flip: "h" } } };

    const a = await apply([flipOp], buildDoc());
    const b = await apply([flipOp], buildDoc(), { store });
    expect([...(findLayer(a.layers, "top-1")!.pixels as any).data]).toEqual(
      [...(findLayer(b.layers, "top-1")!.pixels as any).data],
    );
  });
});

/**
 * 一个会记录并发情况的 BlobStore:每次 get 都停一拍(等一个已解决的 Promise
 * 队列排空),这样若干个并发的 get 会真的重叠,串行的则不会。
 */
function tracingStore(): BlobStore & {
  blobs: Map<string, Uint8Array>;
  gets: string[];
  maxConcurrent: number;
} {
  const inner = memStore();
  let live = 0;
  const state = {
    blobs: inner.blobs,
    gets: [] as string[],
    maxConcurrent: 0,
    put: inner.put,
    async get(hash: string) {
      live += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, live);
      state.gets.push(hash);
      // 让出几个微任务,给同批次的其它 get 机会重叠。
      for (let i = 0; i < 5; i++) await Promise.resolve();
      live -= 1;
      return inner.get(hash);
    },
  };
  return state;
}

/** 造一个有 n 个懒引用图层的文档,每层像素各不相同(哈希互不相同)。 */
async function lazyDoc(store: BlobStore, n: number): Promise<PsdDoc> {
  const layers: Layer[] = [];
  for (let i = 0; i < n; i++) {
    const data = new Uint8ClampedArray([i, 0, 0, 255, 0, i, 0, 255]);
    const doc: PsdDoc = {
      canvas,
      layers: [{
        id: `l${i}`, type: "raster", name: `L${i}`, bounds: [0, 0, 1, 2],
        opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
        pixels: { width: 2, height: 1, data },
      }],
    };
    const serialized = await serialize(doc, store);
    layers.push((await deserialize(serialized, store)).layers[0]!);
  }
  return { canvas, layers };
}

describe("resolveDoc 并发拉取", () => {
  // 此前是 `for (…) await …` 的串行循环。生产环境每次 CAS 往返 ~1.3 秒,
  // 于是导出耗时随图层数线性增长,几十层就超过网关 60 秒的截止时间。
  it("并发拉取多个图层,而不是逐层等待", async () => {
    const store = tracingStore();
    const doc = await lazyDoc(store, 12);
    store.gets.length = 0;
    store.maxConcurrent = 0;

    const resolved = await resolveDoc(doc, store);

    expect(store.maxConcurrent).toBeGreaterThan(1);
    expect(resolved.layers.every(l => l.pixels && !isRef(l.pixels))).toBe(true);
  });

  it("并发不超过上限", async () => {
    const store = tracingStore();
    const doc = await lazyDoc(store, 40);
    store.maxConcurrent = 0;

    await resolveDoc(doc, store);

    expect(store.maxConcurrent).toBeLessThanOrEqual(FaultConcurrency);
  });

  // 在途去重是并行化的必要条件:PixelCache 只缓存已完成的结果,并行时多个
  // 共享同一哈希的图层会同时发起请求 —— 既白做一次,又会撞上 CAS 对单个
  // 对象的并发限流(10058)。
  it("共享同一哈希的图层只取一次", async () => {
    const store = tracingStore();
    const base = await lazyDoc(store, 1);
    const shared = base.layers[0]!;
    const doc: PsdDoc = {
      canvas,
      layers: [
        { ...shared, id: "a" },
        { ...shared, id: "b" },
        { ...shared, id: "c" },
      ],
    };
    store.gets.length = 0;

    const resolved = await resolveDoc(doc, store);

    expect(store.gets).toHaveLength(1);
    expect(resolved.layers.every(l => l.pixels && !isRef(l.pixels))).toBe(true);
  });

  it("分组的子层同样被拉取", async () => {
    const store = tracingStore();
    const flat = await lazyDoc(store, 3);
    const doc: PsdDoc = {
      canvas,
      layers: [{
        id: "g", type: "group", name: "G", bounds: [0, 0, 1, 2],
        opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
        children: flat.layers,
      }],
    };

    const resolved = await resolveDoc(doc, store);

    const children = resolved.layers[0]!.children!;
    expect(children).toHaveLength(3);
    expect(children.every(c => c.pixels && !isRef(c.pixels))).toBe(true);
  });
});
