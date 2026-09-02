import type { PsdDoc, Layer } from "./model/types.js";
import { findLayer } from "./model/tree.js";
import { type BlobStore, PixelCache, resolvePixels, isRef } from "./render/pixel-source.js";
import type { PixelRef } from "./render/pixel-source.js";
import type { Pixels } from "./model/types.js";

/** Faults a single layer's pixels to resident if it is a lazy PixelRef; a
 *  no-op for already-resident (or pixel-less) layers. Mutates `layer` in place
 *  — callers pass a layer inside an already-cloned doc. */
async function faultLayer(layer: Layer, store: BlobStore, cache: PixelCache): Promise<void> {
  if (layer.pixels && isRef(layer.pixels)) {
    layer.pixels = await resolvePixels(layer.pixels, store, cache);
  }
}

/**
 * 一次 fault 的并发上限。
 *
 * 上限不是"越大越好":CAS 是内容寻址的,同一个哈希在不同租户/文档间是同一个
 * 对象,而 Cloudflare 对单个对象的并发操作有限流(错误 10058
 * "Reduce your concurrent request rate for the same object")。把并发放得太
 * 高,只会把"慢"换成"间歇性失败"。8 是一个既能把串行等待压掉一个数量级、
 * 又不至于逼近那条限流的取值。
 */
export const FaultConcurrency = 8;

/** 收集所有还是懒引用、需要拉取的图层(含分组子层),保持文档顺序。 */
function collectLazyLayers(layers: Layer[], out: Layer[] = []): Layer[] {
  for (const l of layers) {
    if (l.pixels && isRef(l.pixels)) out.push(l);
    if (l.children) collectLazyLayers(l.children, out);
  }
  return out;
}

/**
 * Faults every raster layer (recursively, groups included) in `layers`.
 *
 * 并发拉取,不是逐层 await。这条路径此前是一个 `for (…) await …` 的串行循环,
 * 而每一次 CAS 往返在生产环境要 ~1.3 秒(doc service 在 Azure southeastasia,
 * CAS 是 Cloudflare Worker,跨云;再经过 per-(stack,tenant) 的 Durable Object)。
 * 于是导出耗时 ≈ 图层数 × 每层块数 × 往返延迟 —— 与文件体积几乎无关,却随
 * 图层数线性增长:16KB 的样例文件导出就要 12.6 秒,几十个图层的真实文档轻松
 * 超过网关 60 秒的截止时间,表现为浏览器侧的 `Failed to fetch`。
 *
 * 在途去重是并行化的必要条件,不是优化:`PixelCache` 只缓存**已完成**的结果,
 * 串行时天然不会重复取,并行时多个共享同一哈希的图层会同时发起请求 —— 既白做
 * 一次,又正好命中上面说的那条同对象限流。
 */
async function faultAll(
  layers: Layer[],
  store: BlobStore,
  cache: PixelCache,
  concurrency: number = FaultConcurrency,
): Promise<void> {
  const pending = collectLazyLayers(layers);
  if (pending.length === 0) return;

  const inflight = new Map<string, Promise<Pixels>>();
  const resolveOnce = (ref: PixelRef): Promise<Pixels> => {
    const existing = inflight.get(ref.hash);
    if (existing) return existing;
    const started = resolvePixels(ref, store, cache);
    inflight.set(ref.hash, started);
    return started;
  };

  // 固定数量的 worker 从共享游标取任务:比一次性 Promise.all(全部) 多一层
  // 并发约束,也比按批切分好 —— 一个慢请求不会拖住整批。
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), pending.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= pending.length) return;
        const layer = pending[index]!;
        layer.pixels = await resolveOnce(layer.pixels as PixelRef);
      }
    },
  );
  await Promise.all(workers);
}

/** Resolve ONE layer's pixels (and its descendants, if it's a group) to
 *  resident, returning a NEW doc. Used by the pixel-mutating op path (flip) so
 *  the op sees resident pixels while sibling layers stay lazy — preserving the
 *  bounded-memory win. No-op if the target is already resident or not found. */
export async function resolveLayerPixels(doc: PsdDoc, layerId: string, store: BlobStore): Promise<PsdDoc> {
  const next = structuredClone(doc);
  const layer = findLayer(next.layers, layerId);
  if (!layer) return next;
  const cache = new PixelCache(Infinity);
  await faultLayer(layer, store, cache);
  if (layer.children) await faultAll(layer.children, store, cache);
  return next;
}

/** Resolve ALL layers' pixels to resident, returning a NEW doc. Used for full
 *  materialization (export/save), where every layer's bytes are needed anyway;
 *  the resolved doc is transient. Masks are already resident after deserialize
 *  and are left untouched. */
export async function resolveDoc(doc: PsdDoc, store: BlobStore): Promise<PsdDoc> {
  const next = structuredClone(doc);
  const cache = new PixelCache(Infinity);
  await faultAll(next.layers, store, cache);
  return next;
}
