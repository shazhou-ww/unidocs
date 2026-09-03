# PSD 区域编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `editPixels` 只重绘用户指定的矩形，而不是整个图层 —— 矩形之外的像素逐字节保持原样。

**Architecture:** 模型把 `rect` 作为工具参数传下来（不改跨包协议）。矩形向外扩一圈给模型上下文，但只有原矩形被贴回。裁剪发生在查询侧（`renderRegionDirect` 只把落在区域里的东西合成进区域大小的缓冲），合成发生在 effect 侧。新图层的 bounds 就是矩形，所以"矩形之外不变"是几何事实，不依赖任何阈值。

**Tech Stack:** TypeScript 5.9（ESM，相对 import 必须带 `.js`）、vitest 3、fast-png。

**Spec:** `docs/superpowers/specs/2026-09-01-psd-region-edit-design.md`

## Global Constraints

- Node >= 24，pnpm >= 11，TypeScript 5.9，vitest 3。
- ESM：所有相对 import 必须带 `.js` 扩展名。
- `packages/doctype-psd` 是 cloud-neutral：`src/` 下只用标准 web/ES API，禁止 Cloudflare / Azure / Node 专有模块（测试文件可以用 `node:`）。
- 不新增运行时依赖。
- `Rect` 在这个包里的既有做法是**每个文件本地声明** `type Rect = [number, number, number, number]`（`render/region.ts:4`、`render/composite.ts:31`、`render/dirty-rect.ts:5`、`render/doc-render-state.ts:11` 各有一份）。新文件跟着来，不要去造共享导出。
- 坐标一律**画布坐标**，`[top, left, bottom, right]`。
- 提交信息格式 `type(scope): 中文描述`。
- **不要为猜出来的常量写"正确性"测试。** `PAD_RATIO` 是待验证的起点，测试只钉算术。

---

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `packages/doctype-psd/src/image/geometry.ts` | 纯函数：rect 解析/校验、外扩、求交、按 rect 裁像素、边界覆盖度统计 |
| `packages/doctype-psd/src/testing/grainy-pixels.ts` | 带颗粒的确定性 fixture 生成器 |

**修改**

| 文件 | 改什么 |
|---|---|
| `packages/doctype-psd/src/render/composite.ts` | 导出 `isolateForLayer`（把"adjustment 层不可孤立"这条规则收成一处） |
| `packages/doctype-psd/src/render/region.ts` | 新增 `renderLayerRegion` —— 只渲染某图层的某个矩形 |
| `packages/doctype-psd/src/queries.ts` | `getLayerPixels` 接受 `rect`，返回值增加实际渲染的 `rect` |
| `packages/doctype-psd/src/image/edit-pixels.ts` | `rect` 参数、扩边、裁回、按 rect 落地、边界被切的回报、空蒙版短路 |
| `packages/doctype-psd/src/tools.ts` | `editPixelsInstructions` 强调给 rect |
| `packages/doctype-psd/tests/edit-pixels-e2e.test.ts` | 增加区域编辑的端到端用例 |

**依赖顺序：** 1 → 2 → 5；3、4 可与 1/2 并行；5 依赖 1-4；6 依赖 5。

---

### Task 1: `renderLayerRegion` —— 只渲染图层的一个矩形

**Files:**
- Modify: `packages/doctype-psd/src/render/composite.ts`（导出 `isolateForLayer`，并让 `renderLayer` 用它）
- Modify: `packages/doctype-psd/src/render/region.ts`（新增 `renderLayerRegion`）
- Test: `packages/doctype-psd/tests/render-layer-region.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `isolateForLayer(doc: PsdDoc, layer: Layer, context?: boolean): PsdDoc`（`composite.ts` 导出）
  - `renderLayerRegion(doc: PsdDoc, layerId: string, rect: Rect, ctx?: RenderCtx): Promise<Pixels>`（`region.ts` 导出）

**为什么不给 `renderLayer` 加参数：** `region.ts` 已经 import 了 `composite.ts`，反过来 import 会成环。所以新函数放在 `region.ts`（`renderRegionDirect` 的旁边），而把两者共用的孤立规则从 `composite.ts` 导出。

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-psd/tests/render-layer-region.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Layer, PsdDoc } from "../src/model/types.js";
import { renderLayer } from "../src/render/index.js";
import { renderLayerRegion } from "../src/render/region.js";

const W = 40, H = 30;
const px = (w: number, h: number, f: (x: number, y: number) => number[]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set(f(i % w, (i / w) | 0), i * 4);
  return { width: w, height: h, data: d };
};

const doc = (): PsdDoc => ({
  canvas: { width: W, height: H, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [{
    id: "L", type: "raster", name: "L", bounds: [0, 0, H, W], opacity: 1,
    blendMode: "normal", visible: true, locked: false, clipping: false,
    // 每个像素带上自己的坐标，裁错位置一眼就能看出来
    pixels: px(W, H, (x, y) => [x * 6, y * 8, 128, 255]),
  } as Layer],
});

describe("renderLayerRegion", () => {
  it("返回区域大小的缓冲，不是整层大小", async () => {
    const out = await renderLayerRegion(doc(), "L", [10, 8, 22, 30]);
    expect([out.width, out.height]).toEqual([22, 12]); // right-left, bottom-top
    expect(out.data.length).toBe(22 * 12 * 4);
  });

  it("与整层渲染后再裁出同一块，逐字节相同", async () => {
    const rect: [number, number, number, number] = [10, 8, 22, 30];
    const region = await renderLayerRegion(doc(), "L", rect);
    const full = await renderLayer(doc(), "L", {});
    for (let y = 0; y < region.height; y++) {
      for (let x = 0; x < region.width; x++) {
        const ri = (y * region.width + x) * 4;
        const fi = ((rect[0] + y) * full.width + (rect[1] + x)) * 4;
        expect(Array.from(region.data.slice(ri, ri + 4)),
          `(${x},${y}) 与整层渲染不一致`).toEqual(Array.from(full.data.slice(fi, fi + 4)));
      }
    }
  });

  it("区域超出画布时被截断", async () => {
    const out = await renderLayerRegion(doc(), "L", [-5, -5, H + 10, W + 10]);
    expect([out.width, out.height]).toEqual([W, H]);
  });

  it("图层不存在时报出图层 id", async () => {
    await expect(renderLayerRegion(doc(), "nope", [0, 0, 5, 5])).rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/render-layer-region.test.ts`
Expected: FAIL —— `renderLayerRegion` 不存在。

- [ ] **Step 3: 从 composite.ts 导出孤立规则**

`packages/doctype-psd/src/render/composite.ts`，在 `renderLayer` 之前加：

```ts
/**
 * 渲染单个图层时要不要把它从文档里孤立出来。
 *
 * adjustment 图层没有自己的像素，它作用在下方的东西上 —— 孤立出来渲染只会
 * 得到空白，所以必须带着整个文档。`context: true` 是调用方主动要求带上下文。
 *
 * 导出是为了让 region.ts 的 renderLayerRegion 用同一条规则：这个判断只该有
 * 一处，两处早晚会分叉。
 */
export function isolateForLayer(doc: PsdDoc, layer: Layer, context = false): PsdDoc {
  const isolatable = layer.type !== "adjustment" && !context;
  return isolatable ? { canvas: doc.canvas, layers: [layer] } : doc;
}
```

并把 `renderLayer` 改成用它（行为不变）：

```ts
export async function renderLayer(doc: PsdDoc, layerId: string, opts: { context?: boolean } = {}, ctx?: RenderCtx): Promise<Pixels> {
  const layer = findLayer(doc.layers, layerId);
  if (!layer) throw new Error(`layer not found: ${layerId}`);
  return renderRegion(isolateForLayer(doc, layer, opts.context), layer.bounds, ctx);
}
```

- [ ] **Step 4: 在 region.ts 实现 `renderLayerRegion`**

`packages/doctype-psd/src/render/region.ts`，import 补上 `isolateForLayer` 与 `findLayer`：

```ts
import { compositeInto, defaultRenderCtx, isolateForLayer, type RenderCtx } from "./composite.js";
import { findLayer } from "../model/tree.js";
```

文件末尾追加：

```ts
/**
 * 只渲染某个图层落在 `rect` 里的部分，缓冲就是区域大小。
 *
 * 与 `renderLayer(doc, id).然后裁 rect` 逐字节相同，区别只在内存：`renderLayer`
 * 走 `renderRegion`，而后者第一行是 `renderCached(doc, ctx)` —— **先渲染整张
 * 画布再裁**。对 3556x2000 的画布那是 28 MB，区域再小也省不掉。区域编辑要的
 * 正是"内存正比于区域"，所以这里走 `renderRegionDirect`。
 */
export async function renderLayerRegion(
  doc: PsdDoc,
  layerId: string,
  rect: Rect,
  ctx?: RenderCtx,
): Promise<Pixels> {
  const layer = findLayer(doc.layers, layerId);
  if (!layer) throw new Error(`layer not found: ${layerId}`);
  return renderRegionDirect(isolateForLayer(doc, layer), rect, ctx);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test`（整个包 —— `renderLayer` 被改动了，既有的 render/preview 测试必须仍然全绿）
Run: `pnpm --filter @unidocs/doctype-psd typecheck`

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/render/composite.ts packages/doctype-psd/src/render/region.ts \
        packages/doctype-psd/tests/render-layer-region.test.ts
git commit -m "feat(psd): renderLayerRegion —— 只渲染图层的一个矩形，内存正比于区域"
```

---

### Task 2: `getLayerPixels` 接受 `rect`

**Files:**
- Modify: `packages/doctype-psd/src/queries.ts`
- Test: `packages/doctype-psd/tests/query-layer-pixels.test.ts`（扩展）

**Interfaces:**
- Consumes: `renderLayerRegion`（Task 1）。
- Produces: `PsdQuery` 的 `getLayerPixels` payload 变成 `{ layerId: string; rect?: Rect; maxPixels?: number }`；返回值增加 `rect` 字段 —— **实际渲染的区域**（不给 rect 时等于图层 bounds，给了则是求交后的结果）。

- [ ] **Step 1: 写失败的测试**

在 `packages/doctype-psd/tests/query-layer-pixels.test.ts` 里，`"图层不存在时报出图层 id"` 之前插入：

```ts
  it("给了 rect 就只渲染那一块，并回报实际渲染的区域", async () => {
    const ctx = memCas();
    const r = await runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait", rect: [100, 200, 400, 700] } },
      doc(), ctx.ctx,
    ) as any;
    expect([r.width, r.height]).toEqual([500, 300]);   // right-left, bottom-top
    expect(r.rect).toEqual([100, 200, 400, 700]);
    // bounds 仍是图层的真实位置，调用方靠它决定落地位置
    expect(r.bounds).toEqual([0, 0, 1200, 1600]);
    const png = decode(ctx.nodes.get(r.image.hash)!);
    expect([png.width, png.height]).toEqual([500, 300]);
  });

  it("rect 超出图层时求交，回报截断后的区域", async () => {
    const ctx = memCas();
    const r = await runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait", rect: [-50, -50, 100, 100] } },
      doc(), ctx.ctx,
    ) as any;
    expect(r.rect).toEqual([0, 0, 100, 100]);
    expect([r.width, r.height]).toEqual([100, 100]);
  });

  it("rect 与图层完全不相交时拒绝，并报出图层的真实 bounds", async () => {
    await expect(runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait", rect: [5000, 5000, 5100, 5100] } },
      doc(), memCas().ctx,
    )).rejects.toThrow(/does not intersect.*0,0,1200,1600|0, 0, 1200, 1600/);
  });

  it("不给 rect 时，回报的区域就是图层 bounds", async () => {
    const ctx = memCas();
    const r = await runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait" } }, doc(), ctx.ctx,
    ) as any;
    expect(r.rect).toEqual(r.bounds);
  });

  it("像素上限量的是请求的区域，不是整层 —— 错误信息里报的是区域尺寸", async () => {
    // 不去造一个 bounds 与 pixels 不一致的巨型图层（那种图层的合成行为没有
    // 定义，测试会去依赖一个不该依赖的东西）。改为断言**上限读的是哪个尺寸**：
    // 请求一个超过上限的区域，错误信息里出现的必须是区域的尺寸。
    await expect(runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait", rect: [0, 0, 4000, 4000] } },
      doc(), memCas().ctx,
    )).rejects.toThrow(/1600x1200|region is too large/);
    // 注：rect 会先与图层 bounds 求交，所以 4000x4000 被截成整层的 1600x1200，
    // 而 1600x1200 = 1.92 Mpx 并不超过 8 Mpx 的上限 —— 因此这一条实际验证的是
    // 「求交发生在上限检查之前」。若实现把顺序写反，未截断的 16 Mpx 会触发
    // 拒绝，这条就会红。
  });

  it("小区域落在大图层上时正常返回 —— 上限不该按整层算", async () => {
    const ctx = memCas();
    const r = await runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait", rect: [0, 0, 200, 200] } },
      doc(), ctx.ctx,
    ) as any;
    expect([r.width, r.height]).toEqual([200, 200]);
    expect(r.rect).toEqual([0, 0, 200, 200]);
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/query-layer-pixels.test.ts`
Expected: FAIL —— payload 不接受 `rect`，返回值里没有 `rect`。

- [ ] **Step 3: 实现**

`packages/doctype-psd/src/queries.ts`：

1. import 补 `renderLayerRegion`：
   ```ts
   import { renderLayerRegion } from "./render/region.js";
   ```
2. `PsdQuery` 的那一支改成：
   ```ts
     | { kind: "getLayerPixels"; payload: { layerId: string; rect?: [number, number, number, number]; maxPixels?: number } };
   ```
3. `getLayerPixels` 分支整体替换为：

```ts
      const { layerId, rect, maxPixels } = q.payload;
      const l = findLayer(doc.layers, layerId);
      if (!l) throw new Error(`layer not found: ${layerId}`);

      // 请求的区域：不给 rect 就是整层。上限作用在**这个区域**上而不是整层，
      // 所以一个很大的图层只要选一小块仍然编辑得动。
      const region: [number, number, number, number] = rect
        ? [Math.max(rect[0], l.bounds[0]), Math.max(rect[1], l.bounds[1]),
           Math.min(rect[2], l.bounds[2]), Math.min(rect[3], l.bounds[3])]
        : l.bounds;
      const w = region[3] - region[1];
      const h = region[2] - region[0];
      if (w <= 0 || h <= 0) {
        throw new Error(
          `rect [${rect}] does not intersect layer ${layerId} bounds [${l.bounds}]`,
        );
      }
      if (w * h > MAX_EDIT_SOURCE_PIXELS) {
        throw new Error(`layer ${layerId} region is too large to edit: ${w}x${h} > ${MAX_EDIT_SOURCE_PIXELS} px`);
      }
      const c = requireCtx(ctx, "getLayerPixels");
      const rc: RenderCtx | undefined = render
        ? render.ctx
        : { store: casBlobStore(c), cache: new PixelCache(DEFAULT_CACHE_BYTES) };
      // 只渲染这一块：renderLayerRegion 走 renderRegionDirect，缓冲就是区域
      // 大小；renderLayer 会先渲染整张画布再裁（见 region.ts 的注释）。
      const rendered = await renderLayerRegion(doc, layerId, region, rc);
      const px = maxPixels && rendered.width * rendered.height > maxPixels
        ? (() => {
          const fit = fitPixelBudget(rendered.width, rendered.height, 1, maxPixels);
          return resample(rendered, fit.width, fit.height);
        })()
        : rendered;
      const image = await c.makeSBlob({ data: pngOf(px), contentType: "image/png" });
      return {
        image,
        width: px.width,
        height: px.height,
        // 实际渲染的区域。调用方按 maxPixels 缩过之后要靠它缩回去。
        rect: region,
        bounds: l.bounds,
        parentId: findParentId(doc.layers, layerId),
        index: findParentList(doc.layers, layerId)?.index ?? 0,
      } as unknown as QueryValue;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test && pnpm --filter @unidocs/doctype-psd typecheck`
Expected: PASS。既有的 `getLayerPixels` 用例（不给 rect）行为不变。

- [ ] **Step 5: 提交**

```bash
git add packages/doctype-psd/src/queries.ts packages/doctype-psd/tests/query-layer-pixels.test.ts
git commit -m "feat(psd): getLayerPixels 接受 rect —— 只渲染请求的区域，上限也按区域算"
```

---

### Task 3: rect 几何纯函数

**Files:**
- Create: `packages/doctype-psd/src/image/geometry.ts`
- Test: `packages/doctype-psd/tests/image-geometry.test.ts`

**Interfaces:**
- Consumes: `Pixels`（`src/model/types.js`）、`Coverage`（`src/image/editor.js`）。
- Produces:
  - `type RectParse = { ok: true; rect: Rect } | { ok: false; error: string }`
  - `parseRect(value: unknown): RectParse`
  - `expandRect(r: Rect, ratio: number): Rect`
  - `cropPixels(px: Pixels, from: Rect, to: Rect): Pixels`
  - `cropCoverage(cov: Coverage, from: Rect, to: Rect): Coverage`
  - `edgeCoverage(cov: Coverage, band: number): { top: number; left: number; bottom: number; right: number }`

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-psd/tests/image-geometry.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Pixels } from "../src/model/types.js";
import { cropCoverage, cropPixels, edgeCoverage, expandRect, parseRect } from "../src/image/geometry.js";

describe("parseRect", () => {
  it("接受四个数的 [top,left,bottom,right]", () => {
    expect(parseRect([10, 20, 30, 40])).toEqual({ ok: true, rect: [10, 20, 30, 40] });
  });
  it("不是数组、长度不对、含非数字 —— 都说清楚是形状问题", () => {
    for (const bad of [null, "x", [1, 2, 3], [1, 2, 3, 4, 5], [1, 2, "3", 4], [1, 2, NaN, 4]]) {
      const r = parseRect(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/four numbers/i);
    }
  });
  it("上下反了要拒绝，且不自动交换 —— 自动纠正会把语义错变成静默改错地方", () => {
    const r = parseRect([30, 20, 10, 40]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/top.*bottom|\[top, ?left, ?bottom, ?right\]/i);
  });
  it("左右反了要拒绝", () => {
    const r = parseRect([10, 40, 30, 20]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/left.*right|\[top, ?left, ?bottom, ?right\]/i);
  });
  it("零面积要拒绝", () => {
    expect(parseRect([10, 20, 10, 40]).ok).toBe(false);
    expect(parseRect([10, 20, 30, 20]).ok).toBe(false);
  });
});

describe("expandRect", () => {
  it("每边各扩该维度的 ratio 倍，所以宽高各涨 1+2*ratio", () => {
    // 100 宽 x 200 高，ratio 0.25 → 每边横向 25、纵向 50
    expect(expandRect([0, 0, 200, 100], 0.25)).toEqual([-50, -25, 250, 125]);
  });
  it("ratio 为 0 时原样返回", () => {
    expect(expandRect([10, 20, 30, 40], 0)).toEqual([10, 20, 30, 40]);
  });
  it("扩出画布是允许的 —— 求交是调用方的事", () => {
    expect(expandRect([0, 0, 10, 10], 1)).toEqual([-10, -10, 20, 20]);
  });
});

const px = (w: number, h: number, f: (x: number, y: number) => number[]): Pixels => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set(f(i % w, (i / w) | 0), i * 4);
  return { width: w, height: h, data: d };
};

describe("cropPixels", () => {
  it("按 from/to 的偏移取出子矩形", () => {
    // from 覆盖 [10,10,20,20]（10x10），取 to=[12,13,15,17]（4 宽 3 高）
    const src = px(10, 10, (x, y) => [x, y, 0, 255]);
    const out = cropPixels(src, [10, 10, 20, 20], [12, 13, 15, 17]);
    expect([out.width, out.height]).toEqual([4, 3]);
    // to 的左上角在 from 里的偏移是 (13-10, 12-10) = (3,2)
    expect(Array.from(out.data.slice(0, 4))).toEqual([3, 2, 0, 255]);
  });
  it("to 等于 from 时是一次拷贝，不是别名", () => {
    const src = px(4, 4, () => [1, 2, 3, 4]);
    const out = cropPixels(src, [0, 0, 4, 4], [0, 0, 4, 4]);
    expect(out.data.buffer).not.toBe(src.data.buffer);
    out.data[0] = 99;
    expect(src.data[0]).toBe(1);
  });
  it("to 超出 from 时抛错 —— 这是调用方的 bug，不该悄悄兜住", () => {
    const src = px(4, 4, () => [0, 0, 0, 255]);
    expect(() => cropPixels(src, [0, 0, 4, 4], [0, 0, 5, 5])).toThrow(/outside|contain/i);
  });
});

describe("cropCoverage", () => {
  it("单通道按同样的偏移裁", () => {
    const cov = { width: 4, height: 4, data: new Uint8ClampedArray(16).map((_, i) => i * 10) };
    const out = cropCoverage(cov, [0, 0, 4, 4], [1, 1, 3, 3]);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(Array.from(out.data)).toEqual([50, 60, 90, 100]);
  });
});

describe("edgeCoverage", () => {
  it("统计四条边上带内被判为改动的像素比例", () => {
    const w = 10, h = 10;
    const data = new Uint8ClampedArray(w * h);
    // 只把右边缘那一列涂满
    for (let y = 0; y < h; y++) data[y * w + (w - 1)] = 255;
    const e = edgeCoverage({ width: w, height: h, data }, 1);
    expect(e.right).toBeCloseTo(1, 5);
    expect(e.left).toBe(0);
    expect(e.top).toBeCloseTo(0.1, 5);   // 带内 10 个像素里有 1 个（右上角）
    expect(e.bottom).toBeCloseTo(0.1, 5);
  });
  it("全黑时四条边都是 0", () => {
    const e = edgeCoverage({ width: 8, height: 8, data: new Uint8ClampedArray(64) }, 2);
    expect([e.top, e.left, e.bottom, e.right]).toEqual([0, 0, 0, 0]);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/image-geometry.test.ts`
Expected: FAIL —— `Cannot find module '../src/image/geometry.js'`。

- [ ] **Step 3: 实现**

新建 `packages/doctype-psd/src/image/geometry.ts`：

```ts
import type { Pixels } from "../model/types.js";
import type { Coverage } from "./editor.js";

/** [top, left, bottom, right]，画布坐标。本地声明，与 render/ 下四个文件同一做法。 */
type Rect = [number, number, number, number];

export type RectParse = { ok: true; rect: Rect } | { ok: false; error: string };

/**
 * 校验模型给的 rect。
 *
 * **反了不自动交换。** 模型很可能把 `[left,top,right,bottom]` 写成我们要的
 * `[top,left,bottom,right]`，而自动纠正会把一个语义错误变成"语义正确但位置
 * 完全错"的矩形，然后静默地去改错地方。宁可拒绝并说清期望的顺序。
 */
export function parseRect(value: unknown): RectParse {
  if (!Array.isArray(value) || value.length !== 4
    || !value.every(n => typeof n === "number" && Number.isFinite(n))) {
    return { ok: false, error: "rect must be four numbers [top, left, bottom, right] in canvas pixels" };
  }
  const [top, left, bottom, right] = value as Rect;
  if (top >= bottom) {
    return { ok: false, error: `rect top (${top}) must be less than bottom (${bottom}) — the order is [top, left, bottom, right]` };
  }
  if (left >= right) {
    return { ok: false, error: `rect left (${left}) must be less than right (${right}) — the order is [top, left, bottom, right]` };
  }
  return { ok: true, rect: [top, left, bottom, right] };
}

/** 每条边各外扩该维度的 `ratio` 倍，所以宽高各涨 `1 + 2*ratio`。不做截断 —— 求交是调用方的事。 */
export function expandRect(r: Rect, ratio: number): Rect {
  const dy = Math.round((r[2] - r[0]) * ratio);
  const dx = Math.round((r[3] - r[1]) * ratio);
  return [r[0] - dy, r[1] - dx, r[2] + dy, r[3] + dx];
}

const requireContains = (from: Rect, to: Rect): void => {
  if (to[0] < from[0] || to[1] < from[1] || to[2] > from[2] || to[3] > from[3]) {
    throw new Error(`crop target [${to}] falls outside the source region [${from}] — the source must contain it`);
  }
};

/** 从覆盖 `from` 的像素里取出 `to` 那一块。返回新缓冲，不是别名。 */
export function cropPixels(px: Pixels, from: Rect, to: Rect): Pixels {
  requireContains(from, to);
  const width = to[3] - to[1], height = to[2] - to[0];
  const ox = to[1] - from[1], oy = to[0] - from[0];
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = ((oy + y) * px.width + ox) * 4;
    data.set(px.data.subarray(src, src + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** cropPixels 的单通道版本。 */
export function cropCoverage(cov: Coverage, from: Rect, to: Rect): Coverage {
  requireContains(from, to);
  const width = to[3] - to[1], height = to[2] - to[0];
  const ox = to[1] - from[1], oy = to[0] - from[0];
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const src = (oy + y) * cov.width + ox;
    data.set(cov.data.subarray(src, src + width), y * width);
  }
  return { width, height, data };
}

/**
 * 四条边各自 `band` 像素宽的带子里，被判为"改动"的像素占比。
 *
 * 用来判断改动是不是被矩形边界切断了 —— 是的话结果会有硬边，而成因是 rect
 * 给小了。这个数字如实回给模型，比默默羽化诚实：羽化只是把证据盖掉。
 */
export function edgeCoverage(
  cov: Coverage,
  band: number,
): { top: number; left: number; bottom: number; right: number } {
  const { width: w, height: h, data } = cov;
  const b = Math.max(1, Math.min(band, Math.floor(Math.min(w, h) / 2)));
  const ratio = (count: number, total: number) => (total === 0 ? 0 : count / total);
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let y = 0; y < b; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] > 0) top++;
      if (data[(h - 1 - y) * w + x] > 0) bottom++;
    }
  }
  for (let x = 0; x < b; x++) {
    for (let y = 0; y < h; y++) {
      if (data[y * w + x] > 0) left++;
      if (data[y * w + (w - 1 - x)] > 0) right++;
    }
  }
  return {
    top: ratio(top, b * w), bottom: ratio(bottom, b * w),
    left: ratio(left, b * h), right: ratio(right, b * h),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/image-geometry.test.ts && pnpm --filter @unidocs/doctype-psd typecheck`

- [ ] **Step 5: 提交**

```bash
git add packages/doctype-psd/src/image/geometry.ts packages/doctype-psd/tests/image-geometry.test.ts
git commit -m "feat(psd): rect 几何纯函数 —— 解析、外扩、裁剪、边界覆盖度"
```

---

### Task 4: 带颗粒的 fixture，与差异蒙版在颗粒上的表征测试

这个任务存在的理由：本次会话每个逃逸的缺陷都是从"合成图"钻出去的。所有 fixture 都是平滑渐变，16.8 Mpx 压出 0.3 MB，而真实照片密 40 倍 —— 10MB 上限因此在测试里从没被碰到过，差异蒙版在颗粒上退化的问题也从没被看见过。

**Files:**
- Create: `packages/doctype-psd/src/testing/grainy-pixels.ts`
- Test: `packages/doctype-psd/tests/grain-characterization.test.ts`

**Interfaces:**
- Consumes: `Pixels`。
- Produces: `grainyPixels(width: number, height: number, opts?: { grain?: number; seed?: number }): Pixels`

- [ ] **Step 1: 写 fixture 生成器**

新建 `packages/doctype-psd/src/testing/grainy-pixels.ts`：

```ts
import type { Pixels } from "../model/types.js";

/**
 * 平滑渐变 + 可控强度的确定性噪声。
 *
 * 存在的理由：这个仓库原有的图像 fixture 都是平滑渐变，PNG 能压 18 倍；真实
 * 照片带胶片颗粒，只压 1.3 倍。差了一个数量级，于是"编码后体积"和"差异蒙版
 * 覆盖率"这两类断言在合成图上全都测不出真实行为 —— DashScope 的 10MB 上限
 * 就是这样一路漏到线上的。
 *
 * **凡是断言体积或差异蒙版的测试，都该用这个而不是平滑渐变。**
 *
 * 确定性：同样的 (width, height, grain, seed) 永远得到同样的字节，所以可以
 * 拿来做黄金值断言。
 */
export function grainyPixels(
  width: number,
  height: number,
  opts: { grain?: number; seed?: number } = {},
): Pixels {
  const grain = opts.grain ?? 30;
  let s = (opts.seed ?? 1) >>> 0;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = (i / width) | 0;
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    const n = (((s >> 16) & 255) - 128) * grain / 100;
    data.set([
      (x * 255) / width + n,
      (y * 255) / height + n,
      128 + n,
      255,
    ], i * 4);
  }
  return { width, height, data };
}
```

- [ ] **Step 2: 写表征测试**

新建 `packages/doctype-psd/tests/grain-characterization.test.ts`。**这不是要求某个行为正确，而是把当前行为钉下来** —— 它记录了"为什么区域编辑是必要的"：

```ts
import { describe, expect, it } from "vitest";
import { encode } from "fast-png";
import { grainyPixels } from "../src/testing/grainy-pixels.js";
import { diffMask, resample } from "../src/image/guards.js";

const covered = (c: { data: Uint8ClampedArray } | null): number =>
  c === null ? 1 : c.data.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) / c.data.length;

describe("颗粒对编码体积的影响（钉住盲区，不是要求某个值）", () => {
  it("平滑图压得动，带颗粒的压不动 —— 差一个数量级", () => {
    const size = (grain: number) => {
      const px = grainyPixels(600, 400, { grain });
      return encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 }).length;
    };
    const smooth = size(0), grainy = size(30);
    expect(grainy).toBeGreaterThan(smooth * 5);
  });
});

describe("差异蒙版在颗粒图上会退化（这就是区域编辑存在的理由）", () => {
  it("一次下采样再上采样，就足以让蒙版判定整张图都改过", () => {
    const src = grainyPixels(400, 300, { grain: 30 });
    // 模拟模型那条链路：压小 → 再拉回原尺寸。模型自身的重绘还在这之上。
    const roundTripped = resample(resample(src, 200, 150), 400, 300);
    const fraction = covered(diffMask(src, roundTripped));
    // 记录当前事实：颗粒图上这个比例极高，蒙版因此起不到"只让改动区显形"的作用。
    // 0.5 是个保守的下界猜测，不是实测值 —— 见下面 Step 3 的指示。
    expect(fraction).toBeGreaterThan(0.5);
  });

  it("同样的往返，平滑图上蒙版几乎不动 —— 对照组", () => {
    const src = grainyPixels(400, 300, { grain: 0 });
    const roundTripped = resample(resample(src, 200, 150), 400, 300);
    expect(covered(diffMask(src, roundTripped))).toBeLessThan(0.05);
  });
});
```

- [ ] **Step 3: 跑测试**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/grain-characterization.test.ts`

**先把两条断言实际跑出来的数字打出来**（在 `expect` 之前 `console.log`），记进报告。

- **如果"平滑图对照组"那条失败**，说明 `resample` 或 `diffMask` 有问题，停下来先查它们，别改阈值。
- **如果颗粒那条的实测值低于 0.5**：`0.5` 是我猜的保守下界，不是实测值。把阈值改成**略低于实测值**的数（例如实测 0.62 就写 0.55），并在注释里写明它是实测得来的、以及测得的具体数字。**不要去改 `diffMask` 或 `resample` 来迁就阈值** —— 表征测试的职责是记录现状，不是要求现状。
- 体积那条同理：`5` 倍是保守下界，实测远高于它才正常。

这两个数字后面调 `PAD_RATIO` 时要参考。

- [ ] **Step 4: 提交**

```bash
git add packages/doctype-psd/src/testing/grainy-pixels.ts packages/doctype-psd/tests/grain-characterization.test.ts
git commit -m "test(psd): 带颗粒的 fixture 与表征测试 —— 钉住合成图掩盖的两个盲区"
```

---

### Task 5: `editPixels` 接受 `rect`

**Files:**
- Modify: `packages/doctype-psd/src/image/edit-pixels.ts`
- Modify: `packages/doctype-psd/src/tools.ts`（`editPixelsInstructions`）
- Test: `packages/doctype-psd/tests/edit-pixels.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1-4 的全部产出；`getLayerPixels` 现在返回 `rect`。
- Produces: `editPixels` 的 `inputSchema` 增加可选 `rect`；`PAD_RATIO` 与 `EDGE_BAND` 两个常量。

- [ ] **Step 1: 写失败的测试**

`packages/doctype-psd/tests/edit-pixels.test.ts`。先把 `fakeCtx` 的默认 query 结果补上 `rect` 字段（等于 bounds），否则既有用例会因为新增的形状检查而失败：

```ts
      data: over.queryResult ?? {
        image: createSBlob(srcHash),
        width: SRC_W, height: SRC_H,
        rect: [10, 20, 10 + SRC_H, 20 + SRC_W],
        bounds: [10, 20, 10 + SRC_H, 20 + SRC_W],
        parentId: "g1", index: 2,
      },
```

然后在 `"参数缺失时以 result 报错，不抛"` 之前插入：

```ts
  it("给了 rect 就把扩过边的区域交给 query，而不是整层", async () => {
    const ctx = fakeCtx();
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    await tool.run({ layerId: "portrait", instruction: "x", rect: [100, 100, 200, 300] }, ctx);
    const sent = (ctx.query as any).mock.calls[0][0].payload;
    // 100 高 x 200 宽，PAD_RATIO=0.25 → 纵向各扩 25、横向各扩 50
    expect(sent.rect).toEqual([75, 50, 225, 350]);
    expect(sent.layerId).toBe("portrait");
  });

  it("结果层的 bounds 是用户给的 rect，不是图层 bounds —— 矩形之外原层不被覆盖", async () => {
    const rect = [12, 24, 40, 60];
    const ctx = fakeCtx({
      queryResult: {
        image: createSBlob("1".repeat(64)),
        width: SRC_W, height: SRC_H,
        // query 回报它实际渲染的是扩过边的区域
        rect: [5, 10, 5 + SRC_H, 10 + SRC_W],
        bounds: [0, 0, 200, 300],
        parentId: "g1", index: 2,
      },
    });
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "portrait", instruction: "x", rect }, ctx);
    const layer = (out.ops[0] as any).payload.layer;
    expect(layer.bounds).toEqual(rect);
    expect([layer.pixels.width, layer.pixels.height]).toEqual([60 - 24, 40 - 12]);
    const png = decode(ctx.written[0].data);
    expect([png.width, png.height]).toEqual([60 - 24, 40 - 12]);
  });

  it("rect 顺序反了要拒绝，且说明期望的顺序", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "p", instruction: "x", rect: [40, 20, 10, 60] }, fakeCtx());
    expect(out.ops).toEqual([]);
    expect(String((out.result.structuredContent as any).error)).toMatch(/top.*bottom|\[top, ?left/i);
  });

  it("rect 不是四个数要拒绝", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "p", instruction: "x", rect: [1, 2, 3] }, fakeCtx());
    expect(out.ops).toEqual([]);
    expect(String((out.result.structuredContent as any).error)).toMatch(/four numbers/i);
  });

  it("改动全落在 rect 之外时不产生图层 —— 别留一个全透明的空层污染图层树", async () => {
    // 桩 editor 只改左上 1/4；把 rect 指到右下角，裁完蒙版必然全黑
    const ctx = fakeCtx({
      queryResult: {
        image: createSBlob("1".repeat(64)),
        width: SRC_W, height: SRC_H,
        rect: [0, 0, SRC_H, SRC_W],
        bounds: [0, 0, SRC_H, SRC_W],
        parentId: null, index: 0,
      },
    });
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run(
      { layerId: "p", instruction: "x", rect: [SRC_H - 8, SRC_W - 8, SRC_H, SRC_W] }, ctx);
    expect(out.ops).toEqual([]);
    expect(String((out.result.structuredContent as any).detail ?? ""))
      .toMatch(/outside|矩形之外/i);
  });

  it("改动被 rect 边界切断时，如实告诉模型哪条边被切了", async () => {
    // 桩 editor 改左上 1/4；把 rect 卡在那一块中间，右/下边界必然切到改动
    const ctx = fakeCtx({
      queryResult: {
        image: createSBlob("1".repeat(64)),
        width: SRC_W, height: SRC_H,
        rect: [0, 0, SRC_H, SRC_W],
        bounds: [0, 0, SRC_H, SRC_W],
        parentId: null, index: 0,
      },
    });
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "p", instruction: "x", rect: [0, 0, 12, 16] }, ctx);
    const text = (out.result.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
    expect(text).toMatch(/edge|边界/i);
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/edit-pixels.test.ts`
Expected: FAIL —— `rect` 未被识别，落地 bounds 仍是图层 bounds。

- [ ] **Step 3: 实现**

`packages/doctype-psd/src/image/edit-pixels.ts`：

1. import 补：
   ```ts
   import { cropCoverage, cropPixels, edgeCoverage, expandRect, parseRect } from "./geometry.js";
   ```
2. 常量区加：
   ```ts
   /**
    * 送给模型的区域在用户 rect 之外再各扩这个比例（宽高各涨 1+2*PAD_RATIO）。
    *
    * 模型看不到周围就不知道头发该怎么接、光从哪来。扩出来的那圈只给它看，
    * 不落盘，所以不会污染矩形之外。
    *
    * **这是待验证的起点，不是实测值。** 需要在真实文档上跑过才能定。
    */
   const PAD_RATIO = 0.25;
   /** 判断"改动被边界切断"时，四条边各取多宽的带子。 */
   const EDGE_BAND = 4;
   /** 边界带里改动占比超过这个数就提醒模型 rect 可能给小了。 */
   const EDGE_CLIPPED = 0.15;
   ```
3. `LayerPixelsResult` 增加 `rect`，`asLayerPixels` 增加对应检查：
   ```ts
   interface LayerPixelsResult {
     image: SBlob;
     width: number;
     height: number;
     rect: [number, number, number, number];
     bounds: [number, number, number, number];
     parentId: string | null;
     index: number;
   }
   ```
   在 `asLayerPixels` 里 `bounds` 那条检查之后加一条同样形状的 `rect` 检查（四个数）。
4. `inputSchema` 的 properties 增加：
   ```ts
        rect: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
          description:
            "STRONGLY PREFERRED: the canvas-space area to repaint, [top, left, bottom, right]. "
            + "The user's message carries these numbers in its <<selection bounds=[...]>> marker. "
            + "Omitting it repaints the WHOLE layer, which makes the model re-render everything — "
            + "it will change the composition and destroy film grain and texture outside the part you meant to edit.",
        },
   ```
   `required` 不变（仍是 `["layerId", "instruction"]`）。
5. `run` 里，参数校验之后、query 之前：
   ```ts
         // rect 可选。给了就只重绘那一块 —— 矩形之外原层一个字节都不动，这是
         // 几何事实，不依赖差异蒙版的阈值。不给就退化成整层，同一条路径。
         let requested: [number, number, number, number] | null = null;
         if (args.rect !== undefined) {
           const parsed = parseRect(args.rect);
           if (!parsed.ok) return fail({ error: `editPixels: ${parsed.error}` });
           requested = parsed.rect;
         }
   ```
6. query 调用改成：
   ```ts
         const { data } = await ctx.query({
           kind: "getLayerPixels",
           payload: {
             layerId,
             maxPixels: editor.capabilities.maxPixels,
             // 多要一圈上下文：模型看不到周围就接不上头发和光线。
             ...(requested ? { rect: expandRect(requested, PAD_RATIO) } : {}),
           },
         });
   ```
7. `masked` 之后的整段（缩回尺寸 + 落地）替换为：
   ```ts
         // 落地矩形：用户要的那块与图层的交集。不给 rect 时就是整层。
         const landRect: [number, number, number, number] = requested
           ? [Math.max(requested[0], info.bounds[0]), Math.max(requested[1], info.bounds[1]),
              Math.min(requested[2], info.bounds[2]), Math.min(requested[3], info.bounds[3])]
           : info.bounds;

         // 1) 先缩回 query 实际渲染的那个区域的真实尺寸（它可能按 maxPixels 缩过）
         const sentWidth = info.rect[3] - info.rect[1];
         const sentHeight = info.rect[2] - info.rect[0];
         const atSent = masked.width === sentWidth && masked.height === sentHeight
           ? masked
           : resample(masked, sentWidth, sentHeight);
         // 2) 再裁到落地矩形，丢掉只给模型看的那圈上下文
         const landed = cropPixels(atSent, info.rect, landRect);

         // 裁完之后蒙版全黑，说明模型只动了扩边区。落盘会得到一个全透明的空
         // 图层污染图层树，所以什么都不做，并把原因说清楚。
         const landedCoverage = soft ? cropCoverage(soft, info.rect, landRect) : null;
         if (landedCoverage && landedCoverage.data.every(v => v === 0)) {
           return fail({
             ok: false,
             reason: "no_change_in_rect",
             detail: "The model changed nothing inside the rect you gave — its edits all fell in the surrounding context. The rect may be in the wrong place, or the thing you described is not inside it.",
           });
         }
   ```
   **`soft` 必须只算一次，两处共用。** 把 `masked` 那两行改成：

   ```ts
         // 软化后的差异蒙版。烘 alpha 和边界统计用的必须是同一份 —— 算两次
         // 既浪费（膨胀+两遍盒糊化不便宜），又给了它们悄悄分叉的机会。
         const soft = result.changed ? softenMask(result.changed, MASK_SOFTEN) : null;
         const masked = soft ? applyCoverageToAlpha(result.pixels, soft) : result.pixels;
   ```

   **顺序不能动**：`softenMask（在 sent 尺寸上）→ applyCoverageToAlpha（在 sent
   尺寸上）→ 裁剪`。先裁再羽化会在裁剪边界缺一半邻域，羽化出的过渡带贴回后
   就是一道可见暗边 —— 这是本任务唯一一处顺序写反不会报错、只会出画质问题的
   地方。
8. 落地的 layer 用 `landRect` 与 `landed`：
   ```ts
         bounds: landRect,
         ...
         pixels: { width: landed.width, height: landed.height, hash: resultBlob.hash, blob: resultBlob },
   ```
9. 返回文本里追加边界提示：
   ```ts
         const edges = landedCoverage ? edgeCoverage(landedCoverage, EDGE_BAND) : null;
         const clipped = edges
           ? (["top", "left", "bottom", "right"] as const)
             .filter(k => edges[k] > EDGE_CLIPPED)
             .map(k => `${k} ${(edges[k] * 100).toFixed(0)}%`)
           : [];
         const edgeNote = clipped.length
           ? ` The change runs into the rect's ${clipped.join(", ")} edge — if the result has a hard seam there, retry with a larger rect.`
           : "";
   ```
   把 `edgeNote` 拼到成功那条 text 的末尾。

- [ ] **Step 4: 更新提示词**

`packages/doctype-psd/src/tools.ts` 的 `editPixelsInstructions`，把 editPixels 那一条替换为：

```
- editPixels: change the pixels INSIDE a layer from a plain-language instruction — removing an object, replacing something, painting something in. This is the ONLY tool that can change pixels. Give it {layerId, instruction, rect}.
- ALWAYS give a rect unless the user really means the whole layer. rect is [top, left, bottom, right] in canvas pixels, and the user's message carries those numbers in its <<selection bounds=[...]>> marker — use them, or narrow them further with getPreview {rect} if you can see the thing you need to change is smaller. Without a rect the model re-renders the ENTIRE layer: it will re-compose the picture and destroy grain and texture far outside the part you meant to touch.
- Only the rect is replaced. Everything outside it keeps the original layer's exact pixels, so a tight rect is both safer and sharper — a smaller area means more resolution reaches the model.
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd test && pnpm --filter @unidocs/doctype-psd typecheck`
Expected: PASS，包括既有的整层用例（不给 rect 的路径行为不变）。

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/image/edit-pixels.ts packages/doctype-psd/src/tools.ts \
        packages/doctype-psd/tests/edit-pixels.test.ts
git commit -m "feat(psd): editPixels 接受 rect —— 只重绘选中矩形，矩形之外原层不动"
```

---

### Task 6: 端到端验证"矩形之外逐字节不变"

这是整个功能真正要卖的那个保证，必须有一条走真实 `apply` 的判别性测试。

**Files:**
- Modify: `packages/doctype-psd/tests/edit-pixels-e2e.test.ts`

**Interfaces:**
- Consumes: Task 1-5 的全部产出。
- Produces: 无新导出。

- [ ] **Step 1: 写失败的测试**

在 `packages/doctype-psd/tests/edit-pixels-e2e.test.ts` 里追加一个 describe。沿用文件里已有的 `doc()` / `memCas()` / `effectCtx()` / `findStored()` 写法（先通读该文件，按它实际的辅助函数签名来，不要照抄下面的调用形式）：

```ts
describe("区域编辑：矩形之外逐字节不变", () => {
  it("结果层的 bounds 等于 rect，源层不被触碰", async () => {
    const cas = memCas();
    const model = doc();
    const state0 = await storePsdDoc(model, cas.ctx);
    const srcHashBefore = findStored(state0, "portrait").pixels?.hash;
    expect(typeof srcHashBefore).toBe("string");

    const rect: [number, number, number, number] = [8, 12, 28, 40];
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run(
      { layerId: "portrait", instruction: "x", rect },
      effectCtx(model, cas),
    );

    const dt = createPsdDocumentType(cas.ctx);
    const state1 = await dt.apply(out.ops as never, state0);
    const after = await materializePsdDoc(state1, cas.ctx);

    // (a) 结果层就在源层正上方，且只覆盖 rect
    const names = after.layers.map(l => l.id);
    expect(names.slice(0, 2)).toEqual(["bg", "portrait"]);
    const result = after.layers[2];
    expect(result.bounds).toEqual(rect);

    // (b) 源层的字节没被动过
    expect(findStored(state1, "portrait").pixels?.hash).toBe(srcHashBefore);

    // (c) 结果层的像素尺寸等于 rect，不是图层尺寸
    expect(result.pixels).toMatchObject({ width: 40 - 12, height: 28 - 8 });
  });

  it("判别性：把落地 bounds 改回图层 bounds，这条必须失败", async () => {
    // 这条不是可执行断言，而是给实现者的验证指令 —— 见 Step 3。
    expect(true).toBe(true);
  });
});
```

把第二条那个占位用例删掉，改成 Step 3 里的人工验证。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/edit-pixels-e2e.test.ts`
Expected: FAIL —— 落地 bounds 还是图层 bounds（Task 5 之前）或断言不匹配。

- [ ] **Step 3: 做判别性验证并记进报告**

实现完成、测试转绿之后，**临时**把 `edit-pixels.ts` 里的 `bounds: landRect` 改回 `bounds: info.bounds`，只跑这个测试文件，确认它失败并记下失败信息；然后**逐字节还原**，用 `git diff -- packages/doctype-psd/src/image/edit-pixels.ts` 确认为空。

报告里写清两个方向各自的结果。一条对新旧代码都通过的测试，在这里等于没有。

- [ ] **Step 4: 全量验证**

Run: `pnpm --filter @unidocs/doctype-psd test`
Run: `pnpm typecheck`（全工作区）
Run: `pnpm test`（全工作区；`@unidocs/azure-sdk` 会因为本机没起 Docker 而失败，`@unidocs/web-psd` 会因为 `canvas-stage-pan.test.tsx` 里两个既有未捕获错误而退出 1 —— 两者都与本分支无关，已在 main 上复现过。其余任何失败都要报告。）

- [ ] **Step 5: 提交**

```bash
git add packages/doctype-psd/tests/edit-pixels-e2e.test.ts
git commit -m "test(psd): 端到端钉住区域编辑的核心保证 —— 矩形之外源层逐字节不变"
```

---

## 本轮不做

- 跨包协议改动：`/run` 的请求体仍是 `{instruction}`，选区仍以 `<<selection bounds=[...]>>` 的字符串约定到达模型。
- 把 rect 下推进 `ImageEditor` 端口（会把文档几何泄漏进图像端口 —— 见 spec §2.1）。
- 非矩形选区（lasso / wand）。UI 的 `Region.maskId` 通路留着，但蒙版字节怎么跨包送达需要独立设计。
- JPEG 上传（spec §8 记为有条件的后备项）。
- `PAD_RATIO` 的定值 —— 需要在真实文档上验证，本轮只把它标成待验证的起点。
