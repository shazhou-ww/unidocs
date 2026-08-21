# PSD 前端渲染 · 计划 2：IncrementalCompositor 核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@unidocs/doctype-psd/engine` 里实现一个**有状态的分块增量合成器** `IncrementalCompositor`：持有一个文档 + 每 tile 的 RGBA 缓存，应用一个 op 后只重合成受影响的 tile（经计划 1 的 `renderRegionDirect`），其组装出的整幅合成**逐位等于** `render(doc)`。

**Architecture:** 三个纯 TS 单元：`TileGrid`（画布分块）、`opDirtyRect`（op → 保守脏矩形）、`IncrementalCompositor`（tile 缓存 + `applyOp` + `composite`）。脏 tile 用 `renderRegionDirect` 重算，其余复用缓存。核心正确性门 = **增量 ≡ 全量属性测试**（随机/固定 op 序列，每步断言 `compositor.composite()` 字节等于 `render(doc)`）。不含分段缓存 / LOD / Worker / DOM（分别是计划 3、4）。

**Tech Stack:** TypeScript (ESM `src/*.ts` 入口)、vitest。

**Spec:** `docs/superpowers/specs/2026-08-21-psd-frontend-render-model-design.md`（实现 §4 的 tile + 脏区域重合成层与 §6 的增量≡全量测试；分段缓存/LOD 明确留给后续计划）

## Global Constraints

- **增量 ≡ 全量**：`IncrementalCompositor.composite()` 必须与 `render(doc)` **逐位一致**，任何时刻、任意 op 序列后。这是本计划的核心不变量与主测试门。
- **脏矩形必须保守**：`opDirtyRect` 返回的矩形必须是实际改变区域的**超集**（宁大勿小）。低估 → tile 变脏未刷新 → 属性测试会捕获。宁可整画布也不能漏。
- **坐标约定**：矩形一律 `[top, left, bottom, right]`（半开），与计划 1 的 `renderRegionDirect` / `layerInfluenceBounds` 一致。
- **浏览器安全**：新单元只 import 引擎安全表面（`render/region/ops/model/tree`），无 ag-psd / DOM。从 `src/engine.ts` 导出。
- **复用计划 1**：脏 tile 重合成一律走 `renderRegionDirect`（不要另写合成）；脏矩形用 `layerInfluenceBounds` 推导。
- **不可变 doc**：`applyOne` 返回新 doc（`structuredClone`）；compositor 持有当前 doc 引用，每次 `applyOp` 替换它。
- `typecheck` 用 `tsc -b`。测试命令：`pnpm --filter @unidocs/doctype-psd test <fragment>`。

## 计划 1 已落地、本计划直接消费的接口（确切签名）

- `renderRegionDirect(doc: PsdDoc, region: [number,number,number,number], ctx?: RenderCtx): Promise<Pixels>` — 区域受限合成，尺寸 `(r-l)×(b-t)`，逐位等于 `renderRegion(doc, region)`。
- `layerInfluenceBounds(layer: Layer, canvas: { width: number; height: number }): [number,number,number,number]` — 图层含效果外溢的写入范围（保守超集）。
- `render(doc: PsdDoc, ctx?: RenderCtx): Promise<Pixels>` — 全量合成（属性测试的 oracle）。
- `applyOne(doc: PsdDoc, op: PsdOp): PsdDoc` — 纯、不可变、返回新 doc。
- `findLayer(layers: Layer[], id: string): Layer | undefined`（`src/model/tree.ts`，本地 import，不必从 engine 导出）。
- `Pixels = { width, height, data: Uint8ClampedArray }`；`PsdOp = { kind: string; payload: Record<string,unknown> }`。

---

## File Structure

- **Create** `packages/doctype-psd/src/render/tile-grid.ts` — `tilesForRect` + tile key 工具（纯）。
- **Create** `packages/doctype-psd/src/render/dirty-rect.ts` — `opDirtyRect(op, before, after)`（纯）。
- **Create** `packages/doctype-psd/src/render/incremental.ts` — `IncrementalCompositor`（有状态）。
- **Modify** `packages/doctype-psd/src/engine.ts` — 导出上述三者。
- **Create** `packages/doctype-psd/tests/tile-grid.test.ts`
- **Create** `packages/doctype-psd/tests/dirty-rect.test.ts`
- **Create** `packages/doctype-psd/tests/incremental-compositor.test.ts` — 增量≡全量属性门。

---

## Task 1: `TileGrid` — 画布分块与覆盖计算

**Files:**
- Create: `packages/doctype-psd/src/render/tile-grid.ts`
- Test: `packages/doctype-psd/tests/tile-grid.test.ts`

**Interfaces:**
- Produces:
  - `type Tile = { tx: number; ty: number; region: [number,number,number,number] }` — `region` 是该 tile 裁剪到画布后的 `[top,left,bottom,right]`。
  - `tileKey(tx: number, ty: number): string` — `"tx,ty"`。
  - `allTiles(canvas: { width: number; height: number }, tileSize: number): Tile[]` — 覆盖整画布的所有 tile（行优先）。
  - `tilesForRect(canvas: { width: number; height: number }, tileSize: number, rect: [number,number,number,number]): Tile[]` — 与 `rect` 相交的 tile（每个 region 已裁剪到画布，且 `rect` 越界/反转时返回 `[]`）。

- [ ] **Step 1: 写失败测试**

创建 `tests/tile-grid.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { allTiles, tilesForRect, tileKey } from "../src/render/tile-grid.js";

const C = { width: 500, height: 300 }; // with tileSize 256 → cols=2 (0..256,256..500), rows=2 (0..256,256..300)

describe("tileKey", () => {
  it("formats tx,ty", () => { expect(tileKey(1, 2)).toBe("1,2"); });
});

describe("allTiles", () => {
  it("covers the whole canvas exactly, clipped to bounds", () => {
    const t = allTiles(C, 256);
    expect(t.length).toBe(4);
    expect(t.map((x) => x.region)).toEqual([
      [0, 0, 256, 256], [0, 256, 256, 500],
      [256, 0, 300, 256], [256, 256, 300, 500],
    ]);
  });
});

describe("tilesForRect", () => {
  it("returns only tiles intersecting the rect, regions clipped to canvas", () => {
    const t = tilesForRect(C, 256, [10, 10, 20, 20]); // top-left tile only
    expect(t.map((x) => x.region)).toEqual([[0, 0, 256, 256]]);
  });
  it("spans multiple tiles", () => {
    const t = tilesForRect(C, 256, [250, 250, 260, 260]); // straddles all 4
    expect(t.length).toBe(4);
  });
  it("empty for degenerate / off-canvas rect", () => {
    expect(tilesForRect(C, 256, [10, 10, 10, 10])).toEqual([]); // zero-area
    expect(tilesForRect(C, 256, [400, 400, 300, 300])).toEqual([]); // inverted
    expect(tilesForRect(C, 256, [500, 0, 600, 100])).toEqual([]); // below canvas
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm --filter @unidocs/doctype-psd test tile-grid`
Expected: FAIL — 模块未定义。

- [ ] **Step 3: 实现**

创建 `src/render/tile-grid.ts`：

```typescript
type Rect = [number, number, number, number]; // [top,left,bottom,right]

export type Tile = { tx: number; ty: number; region: Rect };

export const tileKey = (tx: number, ty: number): string => `${tx},${ty}`;

export function allTiles(canvas: { width: number; height: number }, tileSize: number): Tile[] {
  const out: Tile[] = [];
  const cols = Math.ceil(canvas.width / tileSize);
  const rows = Math.ceil(canvas.height / tileSize);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const top = ty * tileSize, left = tx * tileSize;
      out.push({ tx, ty, region: [top, left, Math.min(canvas.height, top + tileSize), Math.min(canvas.width, left + tileSize)] });
    }
  }
  return out;
}

export function tilesForRect(canvas: { width: number; height: number }, tileSize: number, rect: Rect): Tile[] {
  const [rt, rl, rb, rr] = rect;
  // Clamp the rect to the canvas; empty if degenerate/off-canvas.
  const t = Math.max(0, rt), l = Math.max(0, rl);
  const b = Math.min(canvas.height, rb), r = Math.min(canvas.width, rr);
  if (b <= t || r <= l) return [];
  const tx0 = Math.floor(l / tileSize), tx1 = Math.floor((r - 1) / tileSize);
  const ty0 = Math.floor(t / tileSize), ty1 = Math.floor((b - 1) / tileSize);
  const out: Tile[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const top = ty * tileSize, left = tx * tileSize;
      out.push({ tx, ty, region: [top, left, Math.min(canvas.height, top + tileSize), Math.min(canvas.width, left + tileSize)] });
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `pnpm --filter @unidocs/doctype-psd test tile-grid`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/doctype-psd/src/render/tile-grid.ts packages/doctype-psd/tests/tile-grid.test.ts
git commit -m "feat(doctype-psd): TileGrid — canvas tiling + rect coverage"
```

---

## Task 2: `opDirtyRect` — op → 保守脏矩形

**Files:**
- Create: `packages/doctype-psd/src/render/dirty-rect.ts`
- Test: `packages/doctype-psd/tests/dirty-rect.test.ts`

**Interfaces:**
- Consumes: `layerInfluenceBounds`（计划 1）、`findLayer`、`PsdDoc`/`PsdOp`/`Layer`。
- Produces: `opDirtyRect(op: PsdOp, before: PsdDoc, after: PsdDoc): [number,number,number,number]` — op 改变区域的**保守超集**（画布坐标 `[top,left,bottom,right]`，已 clamp 到画布）。

**规则**（`layerId = op.payload.layerId`；`fullCanvas = [0,0,after.canvas.height, after.canvas.width]`）：
- `crop` / `init`：`fullCanvas`（画布尺寸/整体可能变）。
- 其它 op：取 `before` 与 `after` 中该 `layerId` 图层的 `layerInfluenceBounds` 的**并集**；任一侧找不到该图层则用另一侧；两侧都没有（或无 layerId）→ `fullCanvas`（保守兜底）。
  - 覆盖了移动/变换（两侧 bounds 不同 → 并集覆盖旧+新位置）、可见性/opacity/blend/效果参数（同位置，influence 覆盖）、add（after 有 / before 无）、remove（before 有 / after 无）、reorder（同图层两侧 influence）、adjust/mask_edit/generative_fill（该图层 influence）。

- [ ] **Step 1: 写失败测试**

创建 `tests/dirty-rect.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { applyOne } from "../src/ops/index.js";
import { opDirtyRect } from "../src/render/dirty-rect.js";

const canvas = { width: 100, height: 100, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const raster = (id: string, bounds: [number,number,number,number], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false, pixels: px(bounds[3]-bounds[1], bounds[2]-bounds[0]), ...over,
});
const doc = (layers: Layer[]): PsdDoc => ({ canvas, layers });

describe("opDirtyRect", () => {
  it("set_props on a layer → that layer's influence bounds", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "set_props", payload: { layerId: "a", props: { opacity: 0.5 } } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 20, 20]);
  });

  it("transform move → union of old and new positions", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    // geometry-ops: translate is a [dx,dy] tuple; shiftBounds adds dx to
    // left/right, dy to top/bottom. [10,10,20,20] + [30,30] → [40,40,50,50].
    const op = { kind: "transform", payload: { layerId: "a", op: { translate: [30, 30] } } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 50, 50]); // union of old+new
  });

  it("remove_layer → the removed layer's old influence", () => {
    const before = doc([raster("a", [10, 10, 20, 20]), raster("b", [50, 50, 60, 60])]);
    const op = { kind: "remove_layer", payload: { layerId: "a" } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 20, 20]);
  });

  it("crop → full canvas", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "crop", payload: { rect: [0, 0, 50, 50] } };
    const after = applyOne(before, op);
    const r = opDirtyRect(op, before, after);
    expect(r[0]).toBe(0); expect(r[1]).toBe(0); // top-left of full canvas
  });

  it("unknown/absent layerId → full canvas (conservative)", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "set_props", payload: { layerId: "nope", props: {} } };
    const after = before;
    expect(opDirtyRect(op, before, after)).toEqual([0, 0, 100, 100]);
  });
});
```

> **已核对的 op 形状**（无需再猜）：`transform` = `{ layerId, op: { translate: [dx, dy] } }`（`translate` 是 2 元组，`dx` 加到 left/right，`dy` 加到 top/bottom；`scale`/`rotate` 在 MVP 抛异常，勿用）；`set_props` = `{ layerId, props }`（props 限 SETTABLE_PROPS，如 visible/opacity/blendMode）；`remove_layer` = `{ layerId }`；`reorder` = `{ layerId, parentId, index }`（`parentId` 必填，顶层用 `null`）；`add_layer` = `{ layer, parentId, index }`。

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm --filter @unidocs/doctype-psd test dirty-rect`
Expected: FAIL — 未定义。

- [ ] **Step 3: 实现**

创建 `src/render/dirty-rect.ts`：

```typescript
import type { PsdDoc } from "../model/types.js";
import { layerInfluenceBounds } from "./region.js";
import { findLayer } from "../model/tree.js";

type Rect = [number, number, number, number];

const union = (a: Rect, b: Rect): Rect =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

export function opDirtyRect(op: { kind: string; payload: Record<string, unknown> }, before: PsdDoc, after: PsdDoc): Rect {
  const canvas = after.canvas;
  const full: Rect = [0, 0, canvas.height, canvas.width];
  if (op.kind === "crop" || op.kind === "init") return full;

  const layerId = (op.payload as { layerId?: string }).layerId;
  if (!layerId) return full;

  const lb = findLayer(before.layers, layerId);
  const la = findLayer(after.layers, layerId);
  const rb = lb ? layerInfluenceBounds(lb, canvas) : null;
  const ra = la ? layerInfluenceBounds(la, canvas) : null;
  if (rb && ra) return union(rb, ra);
  if (rb) return rb;
  if (ra) return ra;
  return full; // neither side has it → conservative
}
```

> `PsdOp` 类型从 `ops/index.ts` 导出；此处用结构化的 `{ kind, payload }` 形参即可，避免额外 import 环。`Layer` 仅类型引用。

- [ ] **Step 4: 跑测试验证通过**

Run: `pnpm --filter @unidocs/doctype-psd test dirty-rect`
Expected: PASS（op 形状已在计划中核对，无需再改）。

- [ ] **Step 5: 提交**

```bash
git add packages/doctype-psd/src/render/dirty-rect.ts packages/doctype-psd/tests/dirty-rect.test.ts
git commit -m "feat(doctype-psd): opDirtyRect — conservative dirty rect from an op"
```

---

## Task 3: `IncrementalCompositor` + 增量≡全量属性门

**Files:**
- Create: `packages/doctype-psd/src/render/incremental.ts`
- Modify: `packages/doctype-psd/src/engine.ts`（导出三者）
- Test: `packages/doctype-psd/tests/incremental-compositor.test.ts`

**Interfaces:**
- Consumes: `TileGrid`（Task 1）、`opDirtyRect`（Task 2）、`renderRegionDirect`/`render`（计划 1）、`applyOne`、`RenderCtx`。
- Produces:
  - `class IncrementalCompositor` with:
    - `constructor(doc: PsdDoc, opts?: { tileSize?: number; ctx?: RenderCtx })`（默认 `tileSize = 256`）。
    - `get doc(): PsdDoc`。
    - `applyOp(op: PsdOp): Promise<[number,number,number,number]>` — `applyOne` 推进 doc、算脏矩形、失效并重算覆盖脏矩形的 tile；返回脏矩形。
    - `composite(): Promise<Pixels>` — 确保所有 tile 已算，组装并返回整幅 `Pixels`（画布尺寸）。
    - `readTile(tx: number, ty: number): Promise<Pixels>` — 单 tile（懒算+缓存）。

**语义**：tile 缓存 `Map<string, Pixels>`（key = `tileKey`）。`applyOp` 只失效脏 tile；未脏 tile 复用缓存 → 省算力。`composite`/`readTile` 懒算缺失 tile（经 `renderRegionDirect(doc, tile.region, ctx)`）。

- [ ] **Step 1: 写增量≡全量属性测试（核心门）**

创建 `tests/incremental-compositor.test.ts`。用覆盖各 op 的**固定 op 序列**逐步驱动，每步断言 `composite()` 字节等于 `render(doc)`；tileSize 取小值（如 32）以强制多 tile 与跨 tile 脏区域：

```typescript
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";
import { applyOne } from "../src/ops/index.js";
import { IncrementalCompositor } from "../src/render/incremental.js";

function fill(w: number, h: number, rgba: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=rgba[0]; d[i*4+1]=rgba[1]; d[i*4+2]=rgba[2]; d[i*4+3]=rgba[3]; }
  return d;
}
const canvas = { width: 96, height: 96, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
const raster = (id: string, b: [number,number,number,number], rgba: number[], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds: b, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: { width: b[3]-b[1], height: b[2]-b[0], data: fill(b[3]-b[1], b[2]-b[0], rgba) }, ...over,
});
const base: PsdDoc = { canvas, layers: [
  raster("bg", [0,0,96,96], [20,30,40,255]),
  raster("red", [8,8,40,40], [255,0,0,200], { blendMode: "multiply" }),
  raster("grn", [50,50,80,80], [0,255,0,255], { dropShadow: { color:{r:0,g:0,b:0}, opacity:0.7, blendMode:"normal", angle:135, distance:5, size:3, choke:0 } }),
]};

// A fixed op sequence exercising set_props, transform, add, remove, reorder.
const ops = [
  { kind: "set_props", payload: { layerId: "red", props: { opacity: 0.4 } } },
  { kind: "set_props", payload: { layerId: "grn", props: { visible: false } } },
  { kind: "set_props", payload: { layerId: "grn", props: { visible: true } } },
  { kind: "transform", payload: { layerId: "red", op: { translate: [20, 12] } } }, // translate is a [dx,dy] tuple
  { kind: "reorder", payload: { layerId: "red", parentId: null, index: 0 } },       // parentId required (null = top level)
  { kind: "remove_layer", payload: { layerId: "grn" } },
];

const bytes = (p: { data: Uint8ClampedArray }) => [...p.data];

describe("IncrementalCompositor ≡ render(doc) across an op sequence", () => {
  it("matches full render after each op (tileSize 32)", async () => {
    const comp = new IncrementalCompositor(base, { tileSize: 32 });
    // initial frame
    expect(bytes(await comp.composite())).toEqual(bytes(await render(base)));
    let doc = base;
    for (const op of ops) {
      await comp.applyOp(op as any);
      doc = applyOne(doc, op as any);
      expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
    }
  });

  it("only dirty tiles are recomputed (cache reuse)", async () => {
    const comp = new IncrementalCompositor(base, { tileSize: 32 });
    await comp.composite();                       // warm all tiles
    const dirty = await comp.applyOp({ kind: "set_props", payload: { layerId: "red", props: { opacity: 0.5 } } } as any);
    // red influence [8,8,40,40] → dirty rect within top-left; a far tile stays byte-equal to full render
    const full = await render(comp.doc);
    expect(bytes(await comp.composite())).toEqual(bytes(full));
    expect(dirty[0]).toBeLessThan(dirty[2]); // non-empty rect
  });
});
```

> op 形状已核对（见 Task 2 的「已核对的 op 形状」块）：`transform.op.translate` 是 `[dx,dy]` 元组；`reorder` 需 `parentId`（顶层 `null`）。上面的序列已用正确形状。若想加 `add_layer`，形状是 `{ layer, parentId, index }`（`layer` 需完整合法图层）。

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm --filter @unidocs/doctype-psd test incremental-compositor`
Expected: FAIL — `IncrementalCompositor` 未定义。

- [ ] **Step 3: 实现**

创建 `src/render/incremental.ts`：

```typescript
import type { PsdDoc, Pixels } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { RenderCtx } from "./composite.js";
import { applyOne } from "../ops/index.js";
import { renderRegionDirect } from "./region.js";
import { allTiles, tilesForRect, tileKey, type Tile } from "./tile-grid.js";
import { opDirtyRect } from "./dirty-rect.js";

type Rect = [number, number, number, number];

/** Stateful tile-incremental compositor. composite() is byte-identical to
 *  render(doc); applyOp recomputes only tiles covering the op's dirty rect. */
export class IncrementalCompositor {
  #doc: PsdDoc;
  readonly #tileSize: number;
  readonly #ctx?: RenderCtx;
  readonly #cache = new Map<string, Pixels>();

  constructor(doc: PsdDoc, opts: { tileSize?: number; ctx?: RenderCtx } = {}) {
    this.#doc = doc;
    this.#tileSize = opts.tileSize ?? 256;
    this.#ctx = opts.ctx;
  }

  get doc(): PsdDoc { return this.#doc; }

  async applyOp(op: PsdOp): Promise<Rect> {
    const next = applyOne(this.#doc, op);
    const dirty = opDirtyRect(op, this.#doc, next);
    this.#doc = next;
    // Invalidate every tile the dirty rect touches. A canvas-size change
    // (crop) can change the grid, so on size change drop the whole cache.
    if (next.canvas.width !== undefined && this.#cacheGridMismatch(next)) {
      this.#cache.clear();
    } else {
      for (const t of tilesForRect(next.canvas, this.#tileSize, dirty)) this.#cache.delete(tileKey(t.tx, t.ty));
    }
    return dirty;
  }

  async readTile(tx: number, ty: number): Promise<Pixels> {
    const key = tileKey(tx, ty);
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const top = ty * this.#tileSize, left = tx * this.#tileSize;
    const region: Rect = [top, left, Math.min(this.#doc.canvas.height, top + this.#tileSize), Math.min(this.#doc.canvas.width, left + this.#tileSize)];
    const px = await renderRegionDirect(this.#doc, region, this.#ctx);
    this.#cache.set(key, px);
    return px;
  }

  async composite(): Promise<Pixels> {
    const { width: W, height: H } = this.#doc.canvas;
    const out = new Uint8ClampedArray(W * H * 4);
    for (const t of allTiles(this.#doc.canvas, this.#tileSize)) {
      const px = await this.readTile(t.tx, t.ty);
      const [top, left, , ] = t.region;
      for (let y = 0; y < px.height; y++) {
        const dst = ((top + y) * W + left) * 4;
        out.set(px.data.subarray(y * px.width * 4, (y + 1) * px.width * 4), dst);
      }
    }
    return { width: W, height: H, data: out };
  }

  // A cheap guard: if the cached tiles were built for a different canvas size,
  // the grid differs — clear. (Only crop/init change canvas dims.)
  #cachedW?: number; #cachedH?: number;
  #cacheGridMismatch(next: PsdDoc): boolean {
    const changed = this.#cachedW !== undefined && (this.#cachedW !== next.canvas.width || this.#cachedH !== next.canvas.height);
    this.#cachedW = next.canvas.width; this.#cachedH = next.canvas.height;
    return changed;
  }
}
```

> 实现者注意：`composite()` 用 `Uint8ClampedArray.set(subarray)` 按行拷贝，是把 tile 贴回画布坐标的最简正确写法。`#cacheGridMismatch` 只需在 `crop`/`init` 改尺寸时清缓存；非尺寸变更走脏 tile 失效。若初次调用 `#cachedW` 未初始化，构造后首帧 `composite` 前它仍为 undefined —— 可在构造函数末尾设 `this.#cachedW = doc.canvas.width; this.#cachedH = doc.canvas.height;`。

- [ ] **Step 4: 跑属性测试验证通过**

Run: `pnpm --filter @unidocs/doctype-psd test incremental-compositor`
Expected: PASS（初始帧 + 每个 op 后逐位相等；缓存复用用例通过）。若某 op 后不相等，先怀疑 `opDirtyRect` 对该 op 低估（脏矩形太小）—— 扩大该 op 的规则至更保守（必要时 fullCanvas），再收紧。

- [ ] **Step 5: 从 engine 导出，typecheck，全量测试，提交**

在 `src/engine.ts` 追加：

```typescript
export { IncrementalCompositor } from "./render/incremental.js";
export { allTiles, tilesForRect, tileKey } from "./render/tile-grid.js";
export type { Tile } from "./render/tile-grid.js";
export { opDirtyRect } from "./render/dirty-rect.js";
```

```bash
pnpm --filter @unidocs/doctype-psd typecheck
pnpm --filter @unidocs/doctype-psd test
git add packages/doctype-psd/src/render/incremental.ts packages/doctype-psd/src/engine.ts packages/doctype-psd/tests/incremental-compositor.test.ts
git commit -m "feat(doctype-psd): IncrementalCompositor — tile-incremental render, byte-parity with render()"
```

---

## Self-Review

- **Spec coverage（本计划范围）**：§4「分块 tile / 只重合成脏 tile / renderRegion 风格区域合成」→ Task 1+3；§4 脏区域推导 → Task 2；§6「增量≡全量属性测试」→ Task 3 核心门。**分段缓存、LOD、金字塔、Worker、Viewport 不在本计划**（见后续计划）。
- **Placeholder scan**：无 TBD；每步含可运行代码/命令/期望。两处显式「实现前读 geometry-ops/layer-ops 对齐 op 字段」是必要的真实对齐点，非占位。
- **Type consistency**：`Tile{tx,ty,region:Rect}`、`tileKey(tx,ty)`、`allTiles(canvas,tileSize)`、`tilesForRect(canvas,tileSize,rect)`、`opDirtyRect(op,before,after):Rect`、`IncrementalCompositor(doc,{tileSize,ctx}).applyOp/composite/readTile`、`Rect=[top,left,bottom,right]` 全计划一致；oracle=`render`。
- **保守性风险**：`opDirtyRect` 低估会让 tile 变脏未刷新 → Task 3 属性门捕获；兜底规则（未知 op/layerId → fullCanvas）保证不静默漏。

---

## 后续计划（本计划落地后展开）

- **计划 3 — 分段缓存 + LOD**：图层栈按调整层屏障分段缓存（改一层只重混该段）；拖拽降采样 LOD + 落定收敛测试；随机 op 属性门升级（seeded PRNG）。
- **计划 4 — Worker 池 + Viewport**：IncrementalCompositor 入 Worker、transferable tile bitmaps 贴 canvas、pan/zoom、金字塔层级选择、SharedArrayBuffer vs 每 Worker PixelCache。
- **计划 5 — `@unidocs/web-psd` 编辑器**：输入→op、图层面板、集成 create/export/agent-chat + `DocSession`（计划 x：CasBlobStore/baseVersion 同步）。
