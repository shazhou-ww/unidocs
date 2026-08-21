# PSD 前端渲染 · 计划 1：引擎地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `@unidocs/doctype-psd` 增加一个**浏览器安全子入口** `@unidocs/doctype-psd/engine`，并在其中提供一个**区域受限的直接合成原语** `renderRegionDirect`（只算目标矩形、跳过不影响该矩形的图层），逐位等价于现有 `renderRegion`（全量渲染后裁剪）。

**Architecture:** 复用现有纯 TS 合成引擎（`composite.ts`/`blend.ts`），不新增第二套实现。子入口只暴露浏览器能跑的表面（render/apply/deserialize/model），**排除** ag-psd 依赖的 `load`/`save`。`renderRegionDirect` 把合成路径参数化出一个"输出原点偏移 + 区域裁剪"，默认全画布时与今天字节一致（受现有 fidelity 测试保护）。

**Tech Stack:** TypeScript (ESM, `src/*.ts` 入口 + `publishConfig` 重写到 `dist`)、vitest、fast-png。

**Spec:** `docs/superpowers/specs/2026-08-21-psd-frontend-render-model-design.md`（本计划实现其 §1 包划分中的引擎子入口 + §4 IncrementalCompositor 的底层原语）

## Global Constraints

- **工作区包解析约定**：库包 `main`/`types`/`exports` 指向 `src/*.ts`，`publishConfig` 里重写为 `dist/*`（README「Workspace package resolution」）。新增子入口必须两处都加。
- **`typecheck` 用 `tsc -b`**（项目引用），不用 `--noEmit`。
- **保真不可回退**：任何改动**不得**改变现有 `render()` 的输出字节——由 `packages/doctype-psd/tests/fidelity.test.ts` 与既有 render 测试守护，每个重构步骤后必须全绿。
- **引擎子入口零 ag-psd**：从 `src/engine.ts` 可达的静态 import 图**不得**触达 `ag-psd` / `psd/load.ts` / `psd/save.ts` / `psd/canvas-shim.ts` / `doctype.ts`。
- **坐标约定**：矩形一律 `[top, left, bottom, right]`（半开区间，与 `Layer.bounds`、`renderRegion` 一致）。
- 测试命令：`pnpm --filter @unidocs/doctype-psd test`（单测加 `-t` 或文件路径）。

---

## File Structure

- **Create** `packages/doctype-psd/src/engine.ts` — 浏览器安全子入口 barrel（只 re-export 安全表面 + 新 region 原语）。
- **Create** `packages/doctype-psd/src/render/region.ts` — 区域工具：`layerInfluenceBounds` + `renderRegionDirect`（区域受限合成）。
- **Modify** `packages/doctype-psd/src/render/composite.ts` — 抽出可被 region 路径复用的内部合成核（参数化输出原点 + 裁剪区域；默认参数保持现状字节不变）。
- **Modify** `packages/doctype-psd/package.json` — `exports` + `publishConfig` 增加 `./engine` 子入口。
- **Create** `packages/doctype-psd/tests/engine-subentry.test.ts` — 子入口导出 + import 图零 ag-psd 守护。
- **Create** `packages/doctype-psd/tests/render-region-direct.test.ts` — `renderRegionDirect` ≡ `renderRegion` parity（含效果/调整/组/裁剪/蒙版/效果外溢区域）。
- **Create** `packages/doctype-psd/tests/layer-influence-bounds.test.ts` — 影响范围计算单测。

---

## Task 1: 浏览器安全子入口 `@unidocs/doctype-psd/engine`

**Files:**
- Create: `packages/doctype-psd/src/engine.ts`
- Modify: `packages/doctype-psd/package.json`
- Test: `packages/doctype-psd/tests/engine-subentry.test.ts`

**Interfaces:**
- Consumes: 现有 `src/render/index.ts`、`src/ops/index.ts`、`src/resolve.ts`、`src/psd/ir.ts`（`deserialize`）、`src/render/pixel-source.ts`、`src/model/types.ts`。
- Produces: 子入口模块路径 `@unidocs/doctype-psd/engine`，导出 `render, renderRegion, renderLayer, renderCached, downscale, type RenderCtx, apply, applyOne, type PsdOp, resolveDoc, resolveLayerPixels, deserialize, type PixelSource, type PixelRef, type BlobStore, PixelCache, resolvePixels, isRef, DEFAULT_CACHE_BYTES` 及 model 类型 `Layer, Mask, Pixels, Canvas, PsdDoc, BlendMode, LayerType`。

- [ ] **Step 1: 写子入口 barrel**

创建 `src/engine.ts`（**不**导出 `load`/`save`/`createPsdDocumentType`）：

```typescript
// Browser-safe engine surface: everything the in-browser renderer/editor
// needs, with NO ag-psd (parse/export) dependency. See design §1 packaging.
export {
  render, renderRegion, renderLayer, renderCached, downscale, DEFAULT_CACHE_BYTES,
} from "./render/index.js";
export type { RenderCtx } from "./render/index.js";
export { apply, applyOne } from "./ops/index.js";
export type { PsdOp } from "./ops/index.js";
export { resolveDoc, resolveLayerPixels } from "./resolve.js";
export { deserialize } from "./psd/ir.js";
export {
  PixelCache, resolvePixels, isRef,
} from "./render/pixel-source.js";
export type { PixelSource, PixelRef, BlobStore } from "./render/pixel-source.js";
export type {
  Layer, Mask, Pixels, Canvas, PsdDoc, BlendMode, LayerType,
} from "./model/types.js";
```

- [ ] **Step 2: package.json 加 `./engine` 子入口**

在 `exports` 与 `publishConfig.exports` 各加一条（src 指向 `.ts`，publish 重写到 `dist`）：

```jsonc
// exports:
"./engine": { "types": "./src/engine.ts", "import": "./src/engine.ts" }
// publishConfig.exports:
"./engine": { "types": "./dist/engine.d.ts", "import": "./dist/engine.js" }
```

- [ ] **Step 3: 写守护测试（导出存在 + import 图零 ag-psd）**

创建 `tests/engine-subentry.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../src/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../src");

/** Static import graph reachable from a src entry (relative imports only). */
function importClosure(entryRel: string): Set<string> {
  const seen = new Set<string>();
  const walk = (rel: string) => {
    const abs = path.resolve(SRC, rel).replace(/\.js$/, ".ts");
    if (seen.has(abs)) return;
    seen.add(abs);
    const code = readFileSync(abs, "utf8");
    for (const m of code.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
      const dep = path.relative(SRC, path.resolve(path.dirname(abs), m[1]));
      walk(dep);
    }
    for (const m of code.matchAll(/from\s+"(ag-psd)"/g)) seen.add("PKG:" + m[1]);
  };
  walk(entryRel);
  return seen;
}

describe("engine subentry", () => {
  it("exports the browser-safe surface", () => {
    for (const name of ["render", "renderRegion", "applyOne", "deserialize", "resolvePixels", "PixelCache"]) {
      expect(typeof (engine as any)[name]).toBe("function");
    }
  });

  it("does NOT pull ag-psd or the parse/export path into its import graph", () => {
    const closure = importClosure("engine.ts");
    const abs = (rel: string) => path.resolve(SRC, rel);
    expect(closure.has("PKG:ag-psd")).toBe(false);
    expect(closure.has(abs("psd/load.ts"))).toBe(false);
    expect(closure.has(abs("psd/save.ts"))).toBe(false);
    expect(closure.has(abs("psd/canvas-shim.ts"))).toBe(false);
    expect(closure.has(abs("doctype.ts"))).toBe(false);
  });
});
```

- [ ] **Step 4: 跑测试验证**

Run: `pnpm --filter @unidocs/doctype-psd test engine-subentry`
Expected: 两个用例 PASS。若 "zero ag-psd" 失败，说明某个被导出的模块（很可能 `resolve.ts` 或 `ir.ts`）间接 import 了 ag-psd —— 修正为：把该 re-export 从 `engine.ts` 去掉，或把对应源文件的 ag-psd 依赖拆到独立模块，直到 import 图干净。

- [ ] **Step 5: typecheck + 提交**

```bash
pnpm --filter @unidocs/doctype-psd typecheck
git add packages/doctype-psd/src/engine.ts packages/doctype-psd/package.json packages/doctype-psd/tests/engine-subentry.test.ts
git commit -m "feat(doctype-psd): browser-safe engine subentry (no ag-psd)"
```

---

## Task 2: `layerInfluenceBounds` — 图层影响范围（含效果外溢）

**Files:**
- Create: `packages/doctype-psd/src/render/region.ts`
- Test: `packages/doctype-psd/tests/layer-influence-bounds.test.ts`

**Interfaces:**
- Consumes: `Layer`（`src/model/types.ts`）——字段 `bounds, type, children, dropShadow{distance,size,choke,angle}, stroke{size,position}, mask{bounds}`。
- Produces: `layerInfluenceBounds(layer: Layer, canvas: { width: number; height: number }): [number, number, number, number]` —— 返回该图层**可能写入**的画布矩形 `[top,left,bottom,right]`（已 clamp 到画布），用于 region 合成时安全跳过无关图层。

- [ ] **Step 1: 写失败测试**

创建 `tests/layer-influence-bounds.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import type { Layer } from "../src/model/types.js";
import { layerInfluenceBounds } from "../src/render/region.js";

const CANVAS = { width: 100, height: 100 };
const base = (over: Partial<Layer>): Layer => ({
  id: "l", type: "raster", name: "l", bounds: [40, 40, 60, 60],
  opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
  ...over,
});

describe("layerInfluenceBounds", () => {
  it("plain raster: just its bounds", () => {
    expect(layerInfluenceBounds(base({}), CANVAS)).toEqual([40, 40, 60, 60]);
  });

  it("outside stroke expands by size on all sides", () => {
    const l = base({ stroke: { color: { r: 0, g: 0, b: 0 }, opacity: 1, size: 5, position: "outside", blendMode: "normal" } });
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([35, 35, 65, 65]);
  });

  it("drop shadow unions the offset+blurred copy", () => {
    // angle 0 → dx = -distance, dy = 0; expand by size+choke.
    const l = base({ dropShadow: { color: { r: 0, g: 0, b: 0 }, opacity: 1, blendMode: "normal", angle: 0, distance: 10, size: 4, choke: 0 } });
    // shape [40,40,60,60] ∪ shifted-by-(-10,0) then grown by 4:
    // shifted bounds = [40, 30, 60, 50]; grown = [36, 26, 64, 54]; union with shape = [36,26,64,60]
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([36, 26, 64, 60]);
  });

  it("clamps to the canvas", () => {
    const l = base({ bounds: [-5, -5, 10, 10], stroke: { color: { r: 0, g: 0, b: 0 }, opacity: 1, size: 3, position: "outside", blendMode: "normal" } });
    const [t, le] = layerInfluenceBounds(l, CANVAS);
    expect(t).toBe(0); expect(le).toBe(0);
  });

  it("adjustment influences the whole canvas (or its mask bounds)", () => {
    const l = base({ type: "adjustment", adjustType: "brit" });
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([0, 0, 100, 100]);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm --filter @unidocs/doctype-psd test layer-influence-bounds`
Expected: FAIL —— `layerInfluenceBounds` 未定义。

- [ ] **Step 3: 实现**

创建 `src/render/region.ts`（本 Task 只加此函数；Task 3 再往同文件加 `renderRegionDirect`）：

```typescript
import type { Layer } from "../model/types.js";

type Rect = [number, number, number, number]; // [top,left,bottom,right]

const union = (a: Rect, b: Rect): Rect =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const grow = (r: Rect, m: number): Rect => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
const shift = (r: Rect, dx: number, dy: number): Rect => [r[0] + dy, r[1] + dx, r[2] + dy, r[3] + dx];
const clamp = (r: Rect, w: number, h: number): Rect =>
  [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(h, r[2]), Math.min(w, r[3])];

/** Canvas rect a layer may write into, including layer-effect bleed. */
export function layerInfluenceBounds(layer: Layer, canvas: { width: number; height: number }): Rect {
  // Adjustment layers transform the backdrop across their whole extent.
  if (layer.type === "adjustment") {
    const m = layer.mask?.bounds;
    return clamp(m ? [m[0], m[1], m[2], m[3]] : [0, 0, canvas.height, canvas.width], canvas.width, canvas.height);
  }
  let r: Rect = layer.type === "group"
    ? (layer.children ?? []).reduce<Rect | null>((acc, c) => {
        const cb = layerInfluenceBounds(c, canvas);
        return acc ? union(acc, cb) : cb;
      }, null) ?? [...layer.bounds] as Rect
    : ([...layer.bounds] as Rect);

  if (layer.stroke) {
    const m = layer.stroke.position === "outside" ? layer.stroke.size
      : layer.stroke.position === "center" ? Math.ceil(layer.stroke.size / 2) : 0;
    if (m > 0) r = union(r, grow(layer.bounds as Rect, m));
  }
  if (layer.dropShadow) {
    const ds = layer.dropShadow;
    const rad = (ds.angle * Math.PI) / 180;
    const dx = Math.round(-ds.distance * Math.cos(rad));
    const dy = Math.round(ds.distance * Math.sin(rad));
    r = union(r, grow(shift(layer.bounds as Rect, dx, dy), ds.size + ds.choke));
  }
  return clamp(r, canvas.width, canvas.height);
}
```

> 说明：dropShadow 的 `dx/dy` 公式与 `composite.ts` 的 `dropShadowEffect` 完全一致（`dx = round(-distance*cos)`, `dy = round(distance*sin)`），保证影响范围不小于实际写入范围。

- [ ] **Step 4: 跑测试验证通过**

Run: `pnpm --filter @unidocs/doctype-psd test layer-influence-bounds`
Expected: PASS（5 用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/doctype-psd/src/render/region.ts packages/doctype-psd/tests/layer-influence-bounds.test.ts
git commit -m "feat(doctype-psd): layerInfluenceBounds (effect-aware write extent)"
```

---

## Task 3: `renderRegionDirect` — 区域受限直接合成

把合成核参数化出"输出原点偏移 + 裁剪区域"，实现只算目标矩形、跳过无关图层的 `renderRegionDirect`，并证明它逐位等于现有 `renderRegion`（全量后裁剪）。

**Files:**
- Modify: `packages/doctype-psd/src/render/composite.ts`（抽出内部可复用核，加默认参数）
- Modify: `packages/doctype-psd/src/render/region.ts`（加 `renderRegionDirect`）
- Modify: `packages/doctype-psd/src/engine.ts`（导出 `renderRegionDirect` + `layerInfluenceBounds`）
- Test: `packages/doctype-psd/tests/render-region-direct.test.ts`

**Interfaces:**
- Consumes: `layerInfluenceBounds`（Task 2）、`RenderCtx`、`render/renderRegion`（作为 parity oracle）。
- Produces: `renderRegionDirect(doc: PsdDoc, region: [number,number,number,number], ctx?: RenderCtx): Promise<Pixels>` —— 返回尺寸为 `(right-left)×(bottom-top)` 的 `Pixels`，内容逐位等于 `renderRegion(doc, region, ctx)`。

- [ ] **Step 1: 写 parity 失败测试（含效果/调整/组/裁剪/蒙版/外溢区域）**

创建 `tests/render-region-direct.test.ts`。用 in-code fixture（覆盖各特性）+ 多个 region（全图、角、**图层外但效果外溢进来的区域**）逐位比对 oracle：

```typescript
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { renderRegion } from "../src/render/index.js";
import { renderRegionDirect } from "../src/render/region.js";

function fill(w: number, h: number, rgba: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=rgba[0]; d[i*4+1]=rgba[1]; d[i*4+2]=rgba[2]; d[i*4+3]=rgba[3]; }
  return d;
}
const raster = (id: string, bounds: [number,number,number,number], rgba: number[], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: { width: bounds[3]-bounds[1], height: bounds[2]-bounds[0], data: fill(bounds[3]-bounds[1], bounds[2]-bounds[0], rgba) },
  ...over,
});
const canvas = { width: 20, height: 20, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

// A doc exercising: opacity/blend, drop shadow (bleeds outside bounds),
// stroke, a masked adjustment, a group, and a clipping layer.
const shadowLayer = raster("sh", [8, 8, 12, 12], [255,0,0,255], {
  dropShadow: { color:{r:0,g:0,b:0}, opacity:0.8, blendMode:"normal", angle:315, distance:4, size:2, choke:0 },
});
const doc: PsdDoc = {
  canvas,
  layers: [
    raster("bg", [0,0,20,20], [10,20,30,255]),
    raster("mid", [4,4,10,10], [0,255,0,128], { opacity: 0.6, blendMode: "multiply" }),
    shadowLayer,
    { id:"adj", type:"adjustment", name:"adj", bounds:[0,0,20,20], opacity:1, blendMode:"normal", visible:true, locked:false, clipping:false, adjustType:"brit", params:{ brightness:0.1, contrast:0.2 } },
    { id:"grp", type:"group", name:"grp", bounds:[0,0,20,20], opacity:0.9, blendMode:"normal", visible:true, locked:false, clipping:false, children:[ raster("gc", [14,14,18,18], [0,0,255,255]) ] },
  ],
};

const REGIONS: [number,number,number,number][] = [
  [0,0,20,20],   // full
  [0,0,10,10],   // top-left quadrant
  [10,10,20,20], // bottom-right quadrant
  [13,5,16,8],   // OUTSIDE shadowLayer's fill bounds but inside its shadow bleed (angle 315 → dx>0,dy>0)
  [4,4,10,10],   // exactly the multiply layer
];

async function bytes(fn: Promise<{ width:number; height:number; data: Uint8ClampedArray }>) {
  const p = await fn; return [...p.data];
}

describe("renderRegionDirect ≡ renderRegion (parity oracle)", () => {
  for (const region of REGIONS) {
    it(`region ${region.join(",")}`, async () => {
      const oracle = await renderRegion(doc, region);
      const direct = await renderRegionDirect(doc, region);
      expect(direct.width).toBe(oracle.width);
      expect(direct.height).toBe(oracle.height);
      expect([...direct.data]).toEqual([...oracle.data]);
    });
  }
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm --filter @unidocs/doctype-psd test render-region-direct`
Expected: FAIL —— `renderRegionDirect` 未定义。

- [ ] **Step 3: 在 `composite.ts` 抽出参数化合成核（默认参数保持现状字节不变）**

在 `composite.ts` 内，把写入坐标从"画布坐标直接索引 acc"泛化为经一个 `Target` 描述符。**默认全画布 Target 时，索引与今天完全一致**（`origin=(0,0)`, `width=cw`, `height=ch`），因此 `render()` 输出字节不变。

在 `composite.ts` 顶部加：

```typescript
/** Where composited pixels land: a buffer whose (0,0) maps to canvas
 *  (originY, originX). Writes outside [0,width)×[0,height) are dropped.
 *  The full-canvas default (origin 0,0; width=cw; height=ch) is byte-identical
 *  to the pre-refactor behavior. */
export interface Target {
  data: Uint8ClampedArray;
  originX: number; originY: number; // canvas coord of this buffer's (0,0)
  width: number; height: number;    // buffer dimensions
}
const fullTarget = (data: Uint8ClampedArray, cw: number, ch: number): Target =>
  ({ data, originX: 0, originY: 0, width: cw, height: ch });
```

改造 `compositeBuffer`、`strokeEffect`、`dropShadowEffect`、`applyAdjustment` 的合成写、`layerAlpha` 使用的写，使**最终写入**从

```typescript
const di = (cy * cw + cx) * 4;   // 旧：画布索引
```

统一改为经 target 映射：

```typescript
const bx = cx - target.originX, by = cy - target.originY;
if (bx < 0 || bx >= target.width || by < 0 || by >= target.height) continue;
const di = (by * target.width + bx) * 4;
```

`compositeBuffer(acc,cw,ch,...)` 签名改为接收 `target: Target` 取代裸 `acc,cw,ch`（`renderList`/`applyLayer` 透传）。adjustment 分支的 `applyAdjustment(adjusted,...)` 仍在**画布尺寸**的临时缓冲上按像素变换（它是逐像素、与 target 无关），随后经改造后的 `compositeBuffer` 落到 target；group 的 `sub` 子缓冲同理仍全画布，落地时经 target 裁剪。

> 关键：`render()`/`renderList` 内部构造 `fullTarget(acc, w, h)` 调用，行为与今天一致 —— 现有 `fidelity.test.ts` 与 render 测试即回归门。

- [ ] **Step 4: 跑现有 render/fidelity 全套，确认零回归**

Run: `pnpm --filter @unidocs/doctype-psd test`
Expected: **所有既有 render/fidelity 测试保持 PASS**（证明参数化重构未改变 `render()` 输出）。若有红，回到 Step 3 修 target 索引映射，勿改动任何 blend/effect 数值逻辑。

- [ ] **Step 5: 在 `region.ts` 实现 `renderRegionDirect`**

给 `region.ts` 加：

```typescript
import type { PsdDoc, Layer, Pixels } from "../model/types.js";
import { compositeInto, type RenderCtx, defaultRenderCtx } from "./composite.js"; // compositeInto: 见下

type Rect = [number, number, number, number];
const intersects = (a: Rect, b: Rect): boolean =>
  a[1] < b[3] && b[1] < a[3] && a[0] < b[2] && b[0] < a[2];

/** Composite only what falls in `region`, into a region-sized buffer.
 *  Byte-identical to renderRegion(doc, region) but skips layers whose
 *  influence bounds miss the region and iterates only region pixels. */
export async function renderRegionDirect(doc: PsdDoc, region: Rect, ctx?: RenderCtx): Promise<Pixels> {
  const t = Math.max(0, Math.floor(region[0])), l = Math.max(0, Math.floor(region[1]));
  const b = Math.min(doc.canvas.height, Math.ceil(region[2])), r = Math.min(doc.canvas.width, Math.ceil(region[3]));
  const w = Math.max(0, r - l), h = Math.max(0, b - t);
  const data = new Uint8ClampedArray(w * h * 4);
  // Filter the layer tree to those whose influence intersects the region,
  // then composite via the same core as render(), targeting the region buffer.
  await compositeInto(
    { data, originX: l, originY: t, width: w, height: h },
    doc, [t, l, b, r],
    ctx ?? defaultRenderCtx(),
  );
  return { width: w, height: h, data };
}
```

在 `composite.ts` 导出一个薄封装 `compositeInto(target, doc, clipRegion, ctx)`：它跑 `renderList` 但（a）目标是传入 target，（b）用 `layerInfluenceBounds` 跳过 `!intersects(influence, clipRegion)` 的图层（调整层/裁剪基仍需参与 → 保守：调整层不跳过）。同时导出 `defaultRenderCtx`（现有 `defaultCtx` 的公开别名）。

> 图层跳过必须**保守**：只有当 `layerInfluenceBounds(layer) ∩ clipRegion = ∅` 且该图层不是调整层、且其后无裁剪层依赖它作 clip base 时才跳过。最简单安全版：先只跳过 raster/group 且非 clip-base 的图层；clip base 判定沿用 `renderList` 里 `next?.clipping` 的现有逻辑。

- [ ] **Step 6: 跑 parity 测试验证通过**

Run: `pnpm --filter @unidocs/doctype-psd test render-region-direct`
Expected: PASS（5 个 region 全部逐位相等，含效果外溢的 `[13,5,16,8]`）。

- [ ] **Step 7: 用真实 PSD 夹具做一轮 property parity（复用 fidelity 夹具）**

在 `render-region-direct.test.ts` 追加：用 `psd/load.ts` 的 `load` 载入 `tests/fixtures/sample.psd`（node 测试里可用 ag-psd），对一组随机/网格 region 断言 `renderRegionDirect ≡ renderRegion`：

```typescript
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../src/psd/load.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("renderRegionDirect ≡ renderRegion on sample.psd", () => {
  it("matches across a grid of regions", async () => {
    const bytes = readFileSync(path.resolve(here, "fixtures/sample.psd"));
    const psd = await load(new Uint8Array(bytes));
    const { width: W, height: H } = psd.canvas;
    const regions: [number,number,number,number][] = [];
    for (const [t,l] of [[0,0],[0,W>>1],[H>>1,0],[H>>1,W>>1]]) {
      regions.push([t, l, Math.min(H, t + (H>>1)), Math.min(W, l + (W>>1))]);
    }
    for (const region of regions) {
      const oracle = await renderRegion(psd, region);
      const direct = await renderRegionDirect(psd, region);
      expect([...direct.data]).toEqual([...oracle.data]);
    }
  });
});
```

Run: `pnpm --filter @unidocs/doctype-psd test render-region-direct`
Expected: PASS。（此测试仅在 node 用 `load`；`renderRegionDirect` 自身仍是引擎子入口的浏览器安全导出。）

- [ ] **Step 8: 从引擎子入口导出，typecheck，提交**

在 `src/engine.ts` 追加：

```typescript
export { renderRegionDirect, layerInfluenceBounds } from "./render/region.js";
```

```bash
pnpm --filter @unidocs/doctype-psd typecheck
pnpm --filter @unidocs/doctype-psd test
git add packages/doctype-psd/src/render/composite.ts packages/doctype-psd/src/render/region.ts packages/doctype-psd/src/engine.ts packages/doctype-psd/tests/render-region-direct.test.ts
git commit -m "feat(doctype-psd): renderRegionDirect — region-limited composite (parity with renderRegion)"
```

---

## Self-Review

- **Spec coverage（本计划范围）**：§1「引擎子入口」→ Task 1；§4「只重合成脏 tile / renderRegion 风格区域合成」的**底层原语**（region 受限合成 + 影响范围跳过）→ Task 2/3。tile 网格、分段缓存、LOD、Worker、Viewport、DocSession —— **不在本计划**，见下「后续计划」。
- **Placeholder scan**：无 TBD；每步含可运行代码 / 命令 / 期望。
- **Type consistency**：`renderRegionDirect(doc, region, ctx?)`、`layerInfluenceBounds(layer, canvas)`、`Target{data,originX,originY,width,height}`、`Rect=[top,left,bottom,right]` 全计划一致；oracle 为现有 `renderRegion`。
- **风险点**：Task 3 Step 3 的参数化重构触碰已验证的 `composite.ts`；缓释 = Step 4 用现有 fidelity 全套做回归门，且只改索引映射、不改数值逻辑。

---

## 后续计划（本计划落地后逐个用 writing-plans 展开，依赖其确切接口）

- **计划 2 — IncrementalCompositor**：`TileGrid` + op→脏 rect 推导 + 脏 tile 用 `renderRegionDirect` 重合成；图层栈分段缓存（调整层为段屏障）；拖拽 LOD + 收敛测试。核心门 = 增量 ≡ 全量属性测试。
- **计划 3 — `@unidocs/psd-client` 同步核**：`CasBlobStore`（HTTP BlobStore）+ `DocSession`（`baseVersion`/`applyOp`/pending/409 rebase）。含 op-id 幂等（唯一后端小依赖）。
- **计划 4 — Worker 池 + Viewport**：IncrementalCompositor 入 Worker、transferable tile bitmaps 贴 canvas、pan/zoom、金字塔层级选择、SharedArrayBuffer vs 每 Worker PixelCache 选型。
- **计划 5 — `@unidocs/web-psd` 编辑器**：输入→op 映射、图层面板、集成现有 create/export/agent-chat。
