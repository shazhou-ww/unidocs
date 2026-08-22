# PSD 前端渲染 · 计划 3：累加器检查点缓存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `IncrementalCompositor` 加**“活动图层下方”检查点**：每 tile 缓存一次“活动图层以下全部图层的合成结果 acc”，之后对同一活动图层的连续编辑只需 `恢复检查点 → 重放 [活动层..顶层]`，而非从底重合成整摞。像素结果仍与 `render(doc)` **逐位一致**。

**Architecture:** 渲染是一次左折叠（acc 从透明开始，每个顶层图层折入）。新增一个**可检查点的区域折叠原语** `foldRange(target, doc, from, to, ctx)`（把顶层图层 `[from,to)` 折入 target 的现有 acc，区域裁剪，边界处重算裁剪基覆盖）。`foldRange(0,N)` 从零 acc 出发 ≡ `renderRegionDirect`（本计划的保真锚）。`IncrementalCompositor` 用它：每 tile 缓存 `belowChk = fold[0,A)`（A=活动层索引），`readTile = copy(belowChk) 上 fold[A,N)`。活动层切换或 A 以下内容变化时重建检查点。内存 ≈ 每 tile 一个额外缓冲。

**Tech Stack:** TypeScript (ESM `src/*.ts`)、vitest。

**Spec:** `docs/superpowers/specs/2026-08-21-psd-frontend-render-model-design.md` §4「图层栈分段缓存（最大收益）」的**累加器检查点**实现（用户拍板 A 方案：只复用下方、对全部 blend/调整/裁剪精确）；§6 增量≡全量属性门升级为 seeded-random。LOD 与 above-复用**不在本计划**（LOD 归交互/worker 计划；above-复用被否决）。

## Global Constraints

- **像素级一致**：`IncrementalCompositor.composite()` 任何时刻、任意 op 序列后必须与 `render(doc)` **逐位相等**。这是核心不变量与主测试门（Task 1 升级为 seeded-random）。
- **`foldRange` 保真锚**：从零 acc 出发 `foldRange(target, doc, 0, N, ctx)`（N=顶层图层数）读出必须**逐位等于** `renderRegionDirect(doc, region, ctx)`（后者已被计划 1 证明等于 `render` 裁剪）。这保证检查点复用不改变结果。
- **不得改 blend/效果/调整数值逻辑**：`foldRange` 复用 `composite.ts` 既有的 `applyLayer`/`compositeBuffer`/效果/调整/`layerAlpha`；只新增“从任意 acc、任意起始索引、边界重算裁剪基”的折叠控制。现有 `render()`/`renderRegionDirect` 输出字节不变——既有 fidelity 全套是回归门。
- **裁剪基边界正确性**：从 `fromIndex` 恢复时，若 `layers[fromIndex]` 是 `clipping` 图层，其裁剪基是它下方最近的非裁剪可见图层（在检查点“下方”里），`foldRange` 必须在边界重算该基覆盖，否则裁剪结果错。**seeded-random 属性门必须包含裁剪图层**才能守住这条。
- **坐标约定** `[top,left,bottom,right]` 半开；复用计划 1/2 的 `Target`、`tileRegion`、`renderRegionDirect`。
- `typecheck` 用 `tsc -b`；测试 `pnpm --filter @unidocs/doctype-psd test <fragment>`。

## 计划 1/2 已落地、本计划消费的接口

- `render(doc, ctx?)`（oracle）、`renderRegionDirect(doc, region, ctx?)`（foldRange 的保真锚）。
- `composite.ts` 内部（本计划要小幅暴露/复用）：`Target`、`applyLayer`/`compositeBuffer`/`layerAlpha`/`applyAdjustment`、`RenderCtx`、`defaultRenderCtx`。
- `IncrementalCompositor`（计划 2）：`#doc`、`#tileSize`、`#ctx`、`#cache`、`applyOp`/`readTile`/`composite`/`get tileSize`。
- `opDirtyRect`（计划 2，保守脏矩形）、`tileRegion`/`tilesForRect`/`allTiles`（计划 2）、`findLayer`。

---

## File Structure

- **Modify** `packages/doctype-psd/src/render/composite.ts` — 新增 `foldRange`（可检查点的区域折叠），复用现有折叠内核；`render`/`renderRegionDirect` 行为不变。
- **Modify** `packages/doctype-psd/src/render/incremental.ts` — 加“活动层下方检查点”：`#belowChk` per-tile 缓存 + 活动层追踪 + 失效逻辑；`readTile` 走检查点+后缀折叠。
- **Modify** `packages/doctype-psd/src/render/dirty-rect.ts` — 加 `opActiveIndex(op, before, after)`：op 影响的**最小顶层索引**（活动层/结构失效用）。
- **Modify** `packages/doctype-psd/src/engine.ts` — 导出 `foldRange`、`opActiveIndex`（供后续计划/测试）。
- **Create** `packages/doctype-psd/tests/fold-range.test.ts` — `foldRange(0,N)` ≡ `renderRegionDirect` parity（含调整/裁剪/组/效果）；分段折叠 `fold[0,A)` 再 `fold[A,N)` ≡ 全折叠。
- **Create** `packages/doctype-psd/tests/incremental-random.test.ts` — seeded-random 增量≡全量属性门（多样 fixture + 随机 op 序列 + 非整除 tile + crop）。
- **Modify** `packages/doctype-psd/tests/incremental-compositor.test.ts` — 加“活动层连续编辑复用检查点”身份断言。

---

## Task 1: seeded-random 增量≡全量属性门 + 收口遗留小项

先把**强门**建起来（它守护后面检查点缓存的全部机巧），并收掉计划 2 的遗留覆盖小项（非整除 tile、crop 路径）。**本任务不碰生产渲染逻辑**，只加测试。

**Files:**
- Create: `packages/doctype-psd/tests/incremental-random.test.ts`
- Test 命令: `pnpm --filter @unidocs/doctype-psd test incremental-random`

**Interfaces:**
- Consumes: `IncrementalCompositor`、`render`、`applyOne`、model 类型。
- Produces: 一个可复用的随机 op 生成器（确定性种子）+ 属性断言，覆盖 set_props/transform/reorder/remove/add/adjust/mask_edit，在含调整层+裁剪层+组+效果的 fixture 上。

- [ ] **Step 1: 写 seeded-random 属性测试（先失败——它其实应直接通过当前实现，作为强化门）**

创建 `tests/incremental-random.test.ts`。用一个**确定性 PRNG**（mulberry32，禁用 `Math.random` 以可复现）生成 op 序列；每步 `comp.applyOp(op)` 后断言 `comp.composite()` 逐位等于 `render(doc)`。fixture 覆盖调整层（brit）+裁剪层+组+drop shadow；tile 用**非整除**尺寸（如 40，画布 100）以命中部分边缘 tile；序列末尾包含一次 `crop`：

```typescript
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";
import { applyOne, type PsdOp } from "../src/ops/index.js";
import { IncrementalCompositor } from "../src/render/incremental.js";

function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function fill(w: number, h: number, rgba: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=rgba[0]; d[i*4+1]=rgba[1]; d[i*4+2]=rgba[2]; d[i*4+3]=rgba[3]; }
  return d;
}
const canvas = { width: 100, height: 100, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
const raster = (id: string, b: [number,number,number,number], rgba: number[], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds: b, opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
  pixels: { width: b[3]-b[1], height: b[2]-b[0], data: fill(b[3]-b[1], b[2]-b[0], rgba) }, ...over,
});
function makeDoc(): PsdDoc { return { canvas, layers: [
  raster("bg", [0,0,100,100], [20,30,40,255]),
  raster("r1", [10,10,50,50], [255,0,0,180], { blendMode: "multiply" }),
  raster("clp", [10,10,50,50], [0,0,255,255], { clipping: true }),
  { id:"adj", type:"adjustment", name:"adj", bounds:[0,0,100,100], opacity:1, blendMode:"normal", visible:true, locked:false, clipping:false, adjustType:"brit", params:{ brightness:0.05, contrast:0.1 } },
  raster("r2", [55,55,90,90], [0,200,0,255], { dropShadow:{ color:{r:0,g:0,b:0}, opacity:0.6, blendMode:"normal", angle:135, distance:5, size:3, choke:0 } }),
]}; }

// Deterministic op stream over the fixture's layer ids.
function genOp(rng: () => number, doc: PsdDoc): PsdOp {
  const ids = doc.layers.map((l) => l.id);
  const id = ids[Math.floor(rng() * ids.length)];
  const kinds = ["opacity", "visible", "blend", "translate", "reorder"] as const;
  const k = kinds[Math.floor(rng() * kinds.length)];
  switch (k) {
    case "opacity": return { kind: "set_props", payload: { layerId: id, props: { opacity: Math.round(rng()*100)/100 } } };
    case "visible": return { kind: "set_props", payload: { layerId: id, props: { visible: rng() > 0.5 } } };
    case "blend":   return { kind: "set_props", payload: { layerId: id, props: { blendMode: rng() > 0.5 ? "screen" : "normal" } } };
    case "translate": return { kind: "transform", payload: { layerId: id, op: { translate: [Math.floor(rng()*20)-10, Math.floor(rng()*20)-10] } } };
    case "reorder": return { kind: "reorder", payload: { layerId: id, parentId: null, index: Math.floor(rng() * doc.layers.length) } };
  }
}

const bytes = (p: { data: Uint8ClampedArray }) => [...p.data];

describe("IncrementalCompositor ≡ render — seeded random op sequences (adjustment+clip+group+effects)", () => {
  for (const seed of [1, 7, 42, 1234]) {
    it(`seed ${seed}: byte-parity after each of 40 random ops (tileSize 40, non-divisible)`, async () => {
      const rng = mulberry32(seed);
      let doc = makeDoc();
      const comp = new IncrementalCompositor(doc, { tileSize: 40 });
      expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
      for (let n = 0; n < 40; n++) {
        const op = genOp(rng, doc);
        let next: PsdDoc;
        try { next = applyOne(doc, op); } catch { continue; } // skip ops the handler rejects (e.g. invalid reorder)
        await comp.applyOp(op);
        doc = next;
        expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
      }
    });
  }

  it("crop mid-sequence keeps byte-parity (grid rebuild)", async () => {
    let doc = makeDoc();
    const comp = new IncrementalCompositor(doc, { tileSize: 40 });
    await comp.composite();
    for (const op of [
      { kind: "set_props", payload: { layerId: "r1", props: { opacity: 0.5 } } },
      { kind: "crop", payload: { rect: [0, 0, 60, 60] } },
      { kind: "set_props", payload: { layerId: "r2", props: { visible: false } } },
    ] as PsdOp[]) {
      let next: PsdDoc; try { next = applyOne(doc, op); } catch { continue; }
      await comp.applyOp(op); doc = next;
      expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
    }
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @unidocs/doctype-psd test incremental-random`
Expected: **PASS**（当前计划 2 的实现应已满足；本门是强化 + 覆盖非整除 tile / crop）。若某 seed 失败，说明计划 2 的 `opDirtyRect`/失效存在未覆盖的低估或 crop bug —— 记录失败的 seed+op，作为发现上报（STOP，BLOCKED），不要弱化断言。

- [ ] **Step 3: 提交**

```bash
git add packages/doctype-psd/tests/incremental-random.test.ts
git commit -m "test(doctype-psd): seeded-random increment≡full property gate (adjustment+clip+group+effects, non-divisible tiles, crop)"
```

> `crop` 的 payload 形状以 `src/ops/geometry-ops.ts` 的 `crop` 实际为准——实现前读它确认（`{rect:[...]}` 或其它），据实修正 crop op 构造。

---

## Task 2: `foldRange` — 可检查点的区域折叠原语

**Files:**
- Modify: `packages/doctype-psd/src/render/composite.ts`
- Modify: `packages/doctype-psd/src/engine.ts`（导出 `foldRange`）
- Test: `packages/doctype-psd/tests/fold-range.test.ts`

**Interfaces:**
- Produces:
  `export async function foldRange(target: Target, doc: PsdDoc, fromIndex: number, toIndex: number, ctx?: RenderCtx): Promise<void>`
  —— 把 `doc.layers`（顶层）`[fromIndex, toIndex)` **折入 `target.data` 的现有内容**（把它当作进行中的 acc；调用方负责预置为检查点或全 0）。区域裁剪由 `target` 的 origin/width/height 决定（同计划 1）。**边界裁剪基**：若 `layers[fromIndex]` 是 `clipping:true`，从 `fromIndex` 向下找最近的非裁剪可见图层作基、在 `target` 区域内重算其覆盖，喂给该裁剪运行——保证从中途恢复的裁剪结果与从头折叠一致。
- 复用 `renderList`/`applyLayer` 现有逻辑；`render`/`renderRegionDirect` 不变。

- [ ] **Step 1: 写 parity 失败测试**

创建 `tests/fold-range.test.ts`：对含调整/裁剪/组/效果的 fixture + 多个区域，断言 (a) 从零 acc `foldRange(t, doc, 0, N)` ≡ `renderRegionDirect(doc, region)`；(b) 分两段 `foldRange(t, doc, 0, A)` 再 `foldRange(t, doc, A, N)` ≡ 一次 `foldRange(t, doc, 0, N)`，对每个 `A ∈ [0..N]`（尤其 A 落在裁剪层/调整层/组上）。

```typescript
import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { renderRegionDirect } from "../src/render/region.js";
import { foldRange, type Target } from "../src/render/composite.js"; // Target exported (Plan 1)

// reuse a fixture with adjustment (index 3) + clipping (index 2) + group + drop shadow
// (same shape as incremental-random makeDoc; inline here)
// ...build `doc` with N top-level layers, at least one clipping and one adjustment...

type Rect = [number, number, number, number];
function zeroTarget(region: Rect): Target {
  const [t,l,b,r] = region; const w = r-l, h = b-t;
  return { data: new Uint8ClampedArray(w*h*4), originX: l, originY: t, width: w, height: h };
}
const bytes = (a: Uint8ClampedArray) => [...a];

describe("foldRange", () => {
  const region: Rect = [0, 0, 100, 100];
  // ... define `doc` and N ...

  it("fold[0,N) from zero acc ≡ renderRegionDirect", async () => {
    const tgt = zeroTarget(region);
    await foldRange(tgt, doc, 0, N);
    const oracle = await renderRegionDirect(doc, region);
    expect(bytes(tgt.data)).toEqual([...oracle.data]);
  });

  it("split fold[0,A)+fold[A,N) ≡ fold[0,N) for every A (incl. clip/adjustment boundaries)", async () => {
    const whole = zeroTarget(region); await foldRange(whole, doc, 0, N);
    for (let A = 0; A <= N; A++) {
      const t = zeroTarget(region);
      await foldRange(t, doc, 0, A);
      await foldRange(t, doc, A, N);
      expect(bytes(t.data)).toEqual(bytes(whole.data)); // A boundary at a clipping layer is the sharp case
    }
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm --filter @unidocs/doctype-psd test fold-range`
Expected: FAIL — `foldRange` 未定义。

- [ ] **Step 3: 实现 `foldRange`（复用折叠内核，边界重算裁剪基）**

在 `composite.ts` 内，把现有 `renderList` 的顶层折叠逻辑抽成可参数化的形式，新增导出 `foldRange`：
- 遍历 `layers[fromIndex..toIndex)`，对每个可见图层调用现有 `applyLayer(target, ...)`（计划 1 已把写入路由到 `Target`）。
- 维护 `baseCoverage`（裁剪基覆盖）状态，逻辑与 `renderList` 完全一致（`layer.type !== "adjustment" && next?.clipping ? layerAlpha(...) : null`）。
- **起始边界**：进入循环前，若 `layers[fromIndex]?.clipping`，向下扫描 `[0..fromIndex)` 找最近的**可见非裁剪**图层作基，用 `layerAlpha` 在 `target` 区域内算其覆盖作为初始 `baseCoverage`；否则初始 `null`。
- `target.data` 视为进行中的 acc（调用方已预置内容），**不清零**。
- 不改任何 blend/效果/调整数值；只是把 `renderList` 泛化成“区间 + 可注入起始 baseCoverage + 目标 target”。

> **低风险实现路径**（不重写 `render`）：现有 `renderList(target, cw, ch, layers, ctx)` 是折叠核，`render` 用 `renderList(fullTarget, …, doc.layers, ctx)`、`renderRegionDirect` 经 `compositeInto` 用 `renderList(target, …, kept, ctx)`。只给 `renderList` **加一个可选参数** `initialBaseCoverage: Uint8ClampedArray | null = null`（默认 null → 现有两个调用点零行为变化，`render`/`renderRegionDirect` 字节不变，既有 fidelity 全套即回归门）。`foldRange` 作为**新的公开封装**：`slice = doc.layers.slice(fromIndex, toIndex)`；若 `doc.layers[fromIndex]?.clipping`，向下扫 `[0..fromIndex)` 找最近可见非裁剪图层、用 `layerAlpha` 在 target 区域算其覆盖作为 `initialBaseCoverage`，否则 null；调用 `renderList(target, target.width?…canvas dims, slice, ctx, initialBaseCoverage)`。注意：`renderList` 的 `cw/ch` 是画布尺寸（用于 `layerAlpha`/mask 的画布坐标），传 `doc.canvas.width/height`，target 的 origin/尺寸负责区域裁剪——与计划 1 一致。**不做影响力过滤**（composite 全部区间图层、裁剪到 target 即可）：过滤是纯优化、不改字节，`fold[0,N)` 仍逐位等于 `renderRegionDirect`（被跳过的图层对区域无贡献）。

- [ ] **Step 4: 跑 fold-range parity + 现有 fidelity 全套（零回归）**

Run: `pnpm --filter @unidocs/doctype-psd test fold-range` → PASS（含每个 A 边界）。
Run: `pnpm --filter @unidocs/doctype-psd test` → **既有 render/fidelity/region/incremental 全绿**（证明 `render`/`renderRegionDirect` 未变）。

- [ ] **Step 5: 导出、typecheck、提交**

`engine.ts` 追加 `export { foldRange } from "./render/composite.js";`（`Target` 若尚未从 engine 导出则一并导出类型）。

```bash
pnpm --filter @unidocs/doctype-psd typecheck && pnpm --filter @unidocs/doctype-psd test
git add packages/doctype-psd/src/render/composite.ts packages/doctype-psd/src/engine.ts packages/doctype-psd/tests/fold-range.test.ts
git commit -m "feat(doctype-psd): foldRange — checkpointable region fold (parity with renderRegionDirect)"
```

---

## Task 3: 活动层下方检查点 + `opActiveIndex`

**Files:**
- Modify: `packages/doctype-psd/src/render/dirty-rect.ts`（加 `opActiveIndex`）
- Modify: `packages/doctype-psd/src/render/incremental.ts`（检查点缓存）
- Modify: `packages/doctype-psd/src/engine.ts`（导出 `opActiveIndex`）
- Modify: `packages/doctype-psd/tests/incremental-compositor.test.ts`（复用身份断言）

**Interfaces:**
- Produces:
  - `opActiveIndex(op, before, after): number` —— op 影响的**最小顶层索引**（检查点失效阈值）。规则：`crop`/`init` → `0`；结构性 op（reorder/add/remove）→ `min(受影响图层在 before 的顶层索引, 在 after 的顶层索引)`（找不到则 `0` 保守）；其它按 `layerId` 的**顶层祖先**索引（`before`/`after` 取较小；缺失 → `0`）。
  - `IncrementalCompositor` 内部行为增强（对外 API 不变）：维护每 tile 的 `belowChk`（活动索引 A 以下的 acc）与全局 `#activeIndex`。`readTile` = `copy(belowChk[tile])` 之上 `foldRange(_, doc, A, N)`；`belowChk` 缺失则 `foldRange(zero, doc, 0, A)` 现算并缓存。`applyOp`：`A' = opActiveIndex(op)`；若 `A' !== #activeIndex` 或 `A' < #activeIndex`（下方变化）→ 清所有 `belowChk`，`#activeIndex = A'`；tile 级失效仍按 `opDirtyRect`（清脏 tile 的成品，不清 belowChk 除非上面条件触发）。crop/尺寸变 → 全清（含 belowChk）。

- [ ] **Step 1: 写 `opActiveIndex` 测试 + 检查点复用身份断言**

在新测试或 `incremental-compositor.test.ts` 加：
- `opActiveIndex`：set_props on 顶层第 k 层 → k；顶层第 k 层里的组子层 → k（顶层祖先）；reorder → min(旧,新)；crop → 0。
- 复用身份门：构造多层 fixture，`composite()` 预热；对**高索引活动层** L 连续两次 `set_props opacity`，断言两次之间**同一 belowChk 被复用**——用可观察代理：连续编辑同一 L 时，某个“L 以下、且不在 L 脏矩形内”的 tile 的 `belowChk` 未被重算（对该 tile 连续 `readTile` 返回的 acc 分量一致）。最稳的可观察量：暴露一个只读计数 `#belowRebuilds`（测试用 getter `get _belowRebuilds()`），断言连续编辑同一 L 时不增长、切换活动层时增长。

- [ ] **Step 2: 跑验证失败** → `opActiveIndex` 未定义 / getter 不存在。

- [ ] **Step 3: 实现 `opActiveIndex` + 检查点缓存**

- `dirty-rect.ts`：加 `opActiveIndex`（顶层索引用 `after.layers.findIndex`/`before.layers.findIndex`；组子层用 `findLayer` 定位后回溯顶层祖先——或直接：顶层索引 = 包含该 layerId 的顶层图层下标，用一个 `topIndexOf(doc, layerId)` 辅助递归判断 `layerId===topLayer.id || 在其 children 内`）。
- `incremental.ts`：加 `#belowChk: Map<string, Uint8ClampedArray>`（key=tileKey，值=A 以下的 acc，target 尺寸）、`#activeIndex: number`、`#belowRebuilds: number`（测试可观察）。`readTile`：取/建 `belowChk`（`foldRange(zeroTarget, doc, 0, A)`；建时 `#belowRebuilds++`）→ `copy` 到成品 target → `foldRange(_, doc, A, N)` → 缓存成品到 `#cache`。`applyOp`：算 `dirty=opDirtyRect`、`A'=opActiveIndex`；尺寸变→全清（`#cache`+`#belowChk`）；否则若 `A' !== #activeIndex || A' < #activeIndex` → 清 `#belowChk`（下方失效）并 `#activeIndex=A'`；再按 `dirty` 清 `#cache` 的脏 tile 成品。
  > 正确性靠 `foldRange` 的 parity + Task 1 seeded-random 门；`belowChk` 只是 `fold[0,A)` 的记忆，`A' < #activeIndex`（下方变了）或活动层换了就丢弃，保证永不用陈旧下方。

- [ ] **Step 4: 跑全部测试**

Run: `pnpm --filter @unidocs/doctype-psd test`（尤其 `incremental-random` seeded-random 门、`incremental-compositor` 复用身份、`fold-range`）。Expected: 全绿，`_belowRebuilds` 在连续同层编辑时不增、切层时增。

- [ ] **Step 5: 导出、typecheck、提交**

`engine.ts` 追加 `export { opActiveIndex } from "./render/dirty-rect.js";`

```bash
pnpm --filter @unidocs/doctype-psd typecheck && pnpm --filter @unidocs/doctype-psd test
git add -A packages/doctype-psd
git commit -m "feat(doctype-psd): active-layer below-checkpoint caching (foldRange-backed, byte-parity preserved)"
```

---

## Self-Review

- **Spec coverage**：§4 分段缓存（累加器检查点/A 方案）→ Task 2+3；§6 增量≡全量升级 seeded-random + 覆盖非整除 tile/crop → Task 1（并收计划 2 遗留小项）。LOD、above-复用不在范围（已述）。
- **Placeholder scan**：无 TBD；测试/实现给了可运行骨架。Task 2/3 是**判断型**任务（改动已验证的 `composite.ts`、边界裁剪基），实现体由清晰算法 + parity 门驱动——分派用更强模型。
- **Type consistency**：`foldRange(target, doc, from, to, ctx?)`、`Target`、`opActiveIndex(op,before,after):number`、`tileRegion`、`[top,left,bottom,right]` 全一致；保真锚=`renderRegionDirect`，oracle=`render`。
- **风险**：Task 2 触碰 fidelity-critical `composite.ts`——缓释=把 `render`/`renderRegionDirect` 重构为 `foldInto` 的特例（字节不变，既有 fidelity 全套回归门）+ fold-range 每个 A 边界 parity；Task 3 的 belowChk 陈旧风险——缓释=`A'<active` 或换层即清 + seeded-random 门（含裁剪层，专打边界裁剪基）。

## 后续计划

- **计划 4 — Worker 池 + Viewport + 拖拽 LOD**：IncrementalCompositor（+`get tileSize`/失效 tile）入 Worker、transferable tile bitmaps、pan/zoom、金字塔/LOD、SharedArrayBuffer vs 每 worker cache。
- **计划 5 — `@unidocs/psd-client` 同步核 + `web-psd` 编辑器**：`CasBlobStore`、`DocSession`（`baseVersion`/op/409 rebase，需服务端 op-id 幂等）、输入→op、图层面板、集成 create/export/agent-chat。
