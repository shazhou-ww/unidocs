# web-psd 选择模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 web-psd 的一次操作有一个完整的地址——`目标 = 图层集 × 区域`——并把这个地址真正送到画布覆盖层、图层树和 agent 三个消费方。

**Architecture:** 两个轴各自独立写入、互不清除（区域由框选类工具写，图层集由移动工具和图层树写），两条纯函数转换把它们缝起来。区域轴 A 期用文本拼接送达 agent（零协议改动）；图层轴的命中测试放在 render Worker 里按 alpha 采样，接口从第一天起就是异步的。所有画布覆盖层用**文档尺寸的百分比**定位（`rectStyle`），渲染阶段一次都不测量 DOM。

**Tech Stack:** React 19 · `useSyncExternalStore` 外部 store（无状态库）· 纯 CSS 变量 · vitest + jsdom + @testing-library/react · Worker + `@unidocs/doctype-psd/engine`

**Spec:** `docs/superpowers/specs/2026-08-31-web-psd-selection-model-design.md`（第四版，PR #40 review 已通过）

## Global Constraints

- 分支 `feat/web-psd-selection`，已含四个 spec 提交。基线 `main` = `7e161f5`（缩放 Phase 1 已并入）。
- Node >= 24，pnpm 11。**不新增任何依赖**——没有状态管理库、没有 CSS 框架、没有 marching-squares 库（D 期才需要）。
- 颜色一律走 `packages/web-psd/src/ui/styles.css` 里 `:root` 上的 CSS 变量；新样式**只往文件末尾追加** `.sel-*` 段。
- **`selection-overlay.tsx` 的 `rectStyle` 逻辑与契约注释不得改写**，只能整体搬到 `ui/overlay-geometry.ts`（Task 6），且注释必须一起搬。任何画布覆盖层都 import 它，**渲染阶段一律不调 `toScreen()` / `getBoundingClientRect()`**。
- **`canvas-stage.tsx` 只许改三个指针函数体、加 `onDoubleClick`（Task 12）与 `onContextMenu`（Task 13）、JSX 加两个覆盖层组件**。不动文件头注释、两个 `useEffect`、`useLayoutEffect`（取 tile）、`normalise()`、`canvasBoxStyle()`——这份「不许动」的清单才是约束的本体。（原规则写的是「只改三个指针函数体 + 一行 JSX」，那是为了躲开并发中的缩放改动；缩放 Phase 1 已并入 main，spec §2 明写「并发冲突的风险已经过去」，所以这里放宽到点名的五处接线。）
- **新模块保持单向依赖**：`doc-model.ts` ← `region.ts` / `hit-test.ts` ← `store.ts` ← 其余。`tests/no-import-cycles.test.ts` 覆盖 `src/` 全量，环会让它变红。
- 矩形一律 `Rect = [top, left, bottom, right]`，文档像素。`layers[0]` 是**最底层**，数组末尾是最上层（`render/composite.ts:178`）。
- `ToolId` 里的 `"marquee"` **不改名**——工具名描述手势，状态名描述产物（spec §4.1 末尾）。
- 提交信息用 Conventional Commits，作用域 `web-psd` 或 `psd-client`。每个 Task 一个提交。
- 测试命令：`pnpm -C packages/web-psd test` / `pnpm -C packages/psd-client test`。跑单个文件用 `pnpm -C packages/web-psd exec vitest run tests/<file>`。
- **本计划不含 D 期**（套索 / 魔棒 / mask 经 CAS 的协议扩展）——spec §4.3 写明它需要单独设计。

## File Structure

**新建（`packages/web-psd/src/ui/`）**

| 文件 | 责任 |
| --- | --- |
| `region.ts` | 区域轴：`Region` 类型、`rectRegion()`、`describeTarget()`；Task 12 追加 mask 字节表 |
| `invalidate.ts` | 纯函数：文档变了之后两个轴各自还剩什么（spec §3.6） |
| `hit-test.ts` | 图层轴的纯函数：`Hit` / `HitTester` 类型、`findLayer`、`layerBox`、`unionRect`、`layersIntersecting`、`normalizeSelection`、`expandAncestors`、`pickFromPath` |
| `overlay-geometry.ts` | 从 `selection-overlay.tsx` 搬来的 `rectStyle` + 定位契约注释 |
| `overlay-store.ts` | 只装 `hoverId` 的独立小 store（不进主 store，否则每帧重渲染整棵图层树） |
| `panels/selection-box.tsx` | 图层选中框 / 并集框 / 悬停框 / 手柄 |

**新建（`packages/psd-client/src/`）**

| 文件 | 责任 |
| --- | --- |
| `layer-alpha.ts` | 纯同步：`alphaAt`、`layerBoxOf`、`hitInList`——不碰 store、不碰 Worker，可单测 |
| `request-queue.ts` | Worker 请求队列：串行 + 悬停请求可丢弃（spec §5.8） |

**修改**

| 文件 | 改动 |
| --- | --- |
| `web-psd/src/doc-model.ts` | `flattenTree` 每层倒序（Task 1） |
| `web-psd/src/ui/store.ts` | `marquee: Rect` → `region: Region`；`setRegion()`；`nextSelection` 接归一化 |
| `web-psd/src/ui/controller.ts` | `onDoc` / `createFrom` 接失效策略 |
| `web-psd/src/ui/api.ts` | `AgentTarget`、`withTarget()`、`runAgent` 增第三参 |
| `web-psd/src/ui/app.tsx` | Esc 清空两个轴 |
| `web-psd/src/doc-controller.ts` | `hitTest()`、`layerAlphaRegion()` |
| `web-psd/src/ui/panels/composer.tsx` | 「已附带选区」chip，可一键摘掉 |
| `web-psd/src/ui/panels/chat-panel.tsx` | `send` 透传 target |
| `web-psd/src/ui/panels/context-bar.tsx` | 目标读成一句话；两条转换的入口；锁定提示 |
| `web-psd/src/ui/panels/layer-tree.tsx` | 展开祖先 + 滚动到选中行 |
| `web-psd/src/ui/panels/top-bar.tsx` | 降级徽标跳转时一并展开祖先 |
| `web-psd/src/ui/panels/canvas-stage.tsx` | 三个指针函数体 + `<SelectionBox />` |
| `web-psd/src/ui/panels/selection-overlay.tsx` | 改用 `s.region`；`rectStyle` 搬走后留指针 |
| `web-psd/src/ui/styles.css` | 末尾追加 `.sel-*` |
| `psd-client/src/render-core.ts` | 存 `store` / `cache` 字段；`hitTest()`、`layerAlphaRegion()` |
| `psd-client/src/render-worker.ts` | `hitTest` / `layerAlpha` 消息；队列换成 `request-queue.ts` |
| `psd-client/src/render-client.ts` | 对应方法 |
| `doctype-psd/src/render/composite.ts` | 只加一个 `export`（`maskCoverageAt`） |
| `doctype-psd/src/engine.ts` | 导出 `maskCoverageAt`、`findLayer` |

## 任务顺序

| Task | 期 | 交付 |
| --- | --- | --- |
| 1 | 0 | 图层树排序方向 |
| 2–4 | A | 区域结构 → 失效策略 → 送达 agent |
| 5–7 | B | 图层轴纯函数 → 选中框 → 树↔画布同步 |
| 8–12 | C | Worker alpha 命中 → 队列分级 → 手势状态机 → 交互语义 → 载入为选区 |

---

### Task 1: 图层树排序方向（0 期）

**Files:**
- Modify: `packages/web-psd/src/doc-model.ts:117-128`
- Test: `packages/web-psd/tests/doc-model.test.ts:74-85`

**Interfaces:**
- Consumes: 无
- Produces: `flattenTree(layers, expanded)` 签名不变，只是**每一层的输出顺序反转**——面板第一行是文档最上层。后续所有 Task 依赖这个方向。

`render/composite.ts:178` 的 `renderList` 是 `for (i = 0; i < layers.length; i++)` 自底向上叠，所以 `layers[0]` 是最底层；`flattenTree` 按数组顺序输出，面板第一行就成了文档最底层，与 Photoshop 相反。不改的话 Task 7 的「画布选中 → 滚动到该行」上线当天会被当 bug 报回来。

**反转每一层的 `list`，不是反转 `out`**——反转 `out` 会把组的子行甩到组的上面去。

- [ ] **Step 1: 改现有测试，让它先红**

`packages/web-psd/tests/doc-model.test.ts` 里 `describe("flattenTree")` 整块替换成：

```ts
describe("flattenTree", () => {
  // `layers[0]` is the BOTTOM layer (render/composite.ts's renderList
  // composites the array front-to-back), so the panel's FIRST row must be the
  // array's LAST element — Photoshop's order. Reversing each level's list is
  // what does that; reversing the flattened output instead would hoist a
  // group's children above the group.
  it("emits each level top-of-document first", () => {
    const layers = [
      leaf("g", { type: "group", children: [leaf("b"), leaf("c")] }),
      leaf("a"),
    ];
    expect(flattenTree(layers, new Set()).map((r) => [r.layer.id, r.depth, r.hasChildren]))
      .toEqual([["a", 0, false], ["g", 0, true]]);
  });

  it("emits children only for expanded groups, in document order within the group", () => {
    const layers = [
      leaf("g", { type: "group", children: [leaf("b"), leaf("c")] }),
      leaf("a"),
    ];
    expect(flattenTree(layers, new Set(["g"])).map((r) => [r.layer.id, r.depth]))
      .toEqual([["a", 0], ["g", 0], ["c", 1], ["b", 1]]);
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/doc-model.test.ts`
Expected: FAIL，两条都报 `expected [ [ 'g', 0, true ], … ] to deeply equal [ [ 'a', 0, false ], … ]`

- [ ] **Step 3: 改 `flattenTree`**

`packages/web-psd/src/doc-model.ts` 里整个函数替换成：

```ts
/** Top-down flattening of the layer tree for rendering: a group's children are
 *  emitted only when the group id is in `expanded`.
 *
 *  Each sibling list is walked BACKWARDS. `layers[0]` is the bottom of the
 *  document (see render/composite.ts's renderList, which composites the array
 *  front-to-back), and a layers panel reads top-of-document first — so the
 *  array's last element is the panel's first row. Reversing per level rather
 *  than reversing the flattened result is what keeps a group's children
 *  directly BELOW their group instead of above it. */
export function flattenTree(layers: LocalLayer[], expanded: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (list: LocalLayer[], depth: number): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const layer = list[i];
      const hasChildren = !!layer.children?.length;
      out.push({ layer, depth, hasChildren });
      if (hasChildren && expanded.has(layer.id)) walk(layer.children!, depth + 1);
    }
  };
  walk(layers, 0);
  return out;
}
```

- [ ] **Step 4: 跑全量测试**

Run: `pnpm -C packages/web-psd test`
Expected: PASS。`layer-tree.test.tsx` 不断言行顺序（只按名字取元素），不受影响。

- [ ] **Step 5: 提交**

```bash
git add packages/web-psd/src/doc-model.ts packages/web-psd/tests/doc-model.test.ts
git commit -m "fix(web-psd): 图层树按文档从上到下排序,与 Photoshop 一致"
```

---

### Task 2: `Region` 结构与 `marquee` 改名（A 期）

**Files:**
- Create: `packages/web-psd/src/ui/region.ts`
- Modify: `packages/web-psd/src/ui/store.ts:2,4,36,53-59` · `panels/selection-overlay.tsx:41-44` · `panels/canvas-stage.tsx:110,112,131` · `panels/context-bar.tsx`
- Test: `packages/web-psd/tests/region.test.ts`（新建）
- Test（改名波及）: `tests/store.test.ts` · `tests/selection.test.tsx` · `tests/canvas-stage-marquee.test.tsx` · `tests/canvas-stage-overlay.test.tsx` · `tests/canvas-stage-drag.test.tsx` · `tests/zoom-wheel.test.tsx` · `tests/zoom-wiring.test.tsx`

**Interfaces:**
- Consumes: `Rect`（`doc-model.ts:10`）
- Produces:
  - `interface Region { bounds: Rect; source: "rect" | "lasso" | "wand" | "layerAlpha"; maskId: string | null }`
  - `rectRegion(bounds: Rect): Region`
  - `describeTarget(layerNames: string[], region: Region | null): string`
  - `UiState.region: Region | null`（取代 `marquee: Rect | null`）
  - `setRegion(region: Region | null): void`（store.ts；Task 12 会在这里加 mask 清扫）

`maskId` 恒为 `null` 到 C 期为止，但**结构里现在就要有这个位**：晚改就要把 `crop`、context-bar、composer、覆盖层和 7 个测试文件再返工一遍（spec §4.1）。字节永远不进这个结构，见 Task 12。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/region.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { rectRegion, describeTarget } from "../src/ui/region.js";

describe("rectRegion", () => {
  it("carries the mask handle slot from day one, empty for a rectangle", () => {
    expect(rectRegion([10, 20, 30, 40])).toEqual({
      bounds: [10, 20, 30, 40], source: "rect", maskId: null,
    });
  });
});

// spec §3.2: an empty axis is a DEFINED DEFAULT, not an error state. All four
// combinations must read as a sentence, or the user gets stuck behind "please
// select a layer first" for the one request that needs no layer at all.
describe("describeTarget", () => {
  const region = rectRegion([0, 0, 10, 10]);
  it("names both axes when both are set", () => {
    expect(describeTarget(["天空"], region)).toBe("天空 · 限定在选区内");
  });
  it("names the layers alone when there is no region", () => {
    expect(describeTarget(["天空", "云"], null)).toBe("天空 + 云");
  });
  it("means every layer inside the region when no layer is selected", () => {
    expect(describeTarget([], region)).toBe("选区内的所有图层");
  });
  it("means the whole document when neither axis is set", () => {
    expect(describeTarget([], null)).toBe("整个文档");
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/region.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ui/region.js"`

- [ ] **Step 3: 写 `region.ts`**

```ts
import type { Rect } from "../doc-model.js";

/**
 * The region axis of a selection target (spec §3.1): a patch of canvas the
 * user pointed at, which may or may not be a rectangle.
 *
 * A rectangle is the DEGENERATE case, not the basic one — when a person means
 * "this object" they draw a lasso or a smear. `maskId` is therefore present
 * from the first version even though only rectangles can be produced today:
 * widening `Rect` to `Region` later would touch crop, the context bar, the
 * composer, the overlay and seven test files all over again.
 *
 * The mask BYTES never live here. A full-canvas mask is a 12MB
 * Uint8ClampedArray, and this object goes into the global store, which
 * notifies every subscriber on every change (store.ts) and is snapshotted
 * whole by tests. The handle points into the module-level table in this same
 * file (added when its first producer lands — see doc-controller's
 * layerAlphaRegion).
 */
export interface Region {
  /** Enclosing rect, `[top,left,bottom,right]`, document pixels. Always set. */
  bounds: Rect;
  /** The gesture that produced it: decides how the UI describes it and
   *  whether it can be edited back. */
  source: "rect" | "lasso" | "wand" | "layerAlpha";
  /** Handle for per-pixel coverage; null for a plain rectangle. */
  maskId: string | null;
}

export function rectRegion(bounds: Rect): Region {
  return { bounds, source: "rect", maskId: null };
}

/**
 * The current target as one sentence, for the context bar.
 *
 * Every combination is meaningful (spec §3.2) — an empty axis is a default,
 * not a missing input. In particular "no layer + a region" is exactly what a
 * generative edit wants, so it must not read as an error.
 */
export function describeTarget(layerNames: string[], region: Region | null): string {
  if (layerNames.length > 0) {
    const names = layerNames.join(" + ");
    return region ? `${names} · 限定在选区内` : names;
  }
  return region ? "选区内的所有图层" : "整个文档";
}
```

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm -C packages/web-psd exec vitest run tests/region.test.ts`
Expected: PASS

- [ ] **Step 5: store.ts 改名并加 `setRegion`**

`packages/web-psd/src/ui/store.ts`：

顶部 import 改成
```ts
import type { LocalLayer } from "../doc-model.js";
import type { Region } from "./region.js";
```
（`Rect` 不再被 store 直接用到。）

`UiState` 里 `marquee: Rect | null;` 那一行换成：
```ts
  /** The region axis of the current target. Never cleared by a layer-axis
   *  write — the two axes are written by different tools and never compete
   *  (spec §3.3). */
  region: Region | null;
```

`INITIAL` 里 `marquee: null,` 换成 `region: null,`。

文件末尾追加：
```ts
/**
 * The one write point for the region axis. A plain `setState({ region })`
 * works today, but every region carries a mask handle, and the bytes behind
 * discarded handles have to be released somewhere — routing every writer
 * through here means that is one edit later, not a hunt for call sites.
 */
export function setRegion(region: Region | null): void {
  setState({ region });
}
```

- [ ] **Step 6: 改三个消费方**

`panels/selection-overlay.tsx` — 只改引用 `s.marquee` 的两行，**`rectStyle` 与其上的契约注释一个字不动**：
```ts
  if (!s.region || !canvas) return null;
  const [top, left, bottom, right] = s.region.bounds;
```

`panels/canvas-stage.tsx` — 只改 `onPointerDown` / `onPointerMove` 里那三处（顶部补 `import { rectRegion } from "../region.js";` 和 `import { setRegion } from "../store.js";`）：
```ts
      setRegion(null);                                    // was setState({ marquee: null })
```
```ts
    setRegion(rectRegion(normalise(anchor.current, c.toCanvas(e.clientX, e.clientY), getState().doc?.canvas ?? null)));
```

`panels/context-bar.tsx` — `const m = s.marquee;` 改成读 bounds，并把左侧那句话换成 `describeTarget`：
```ts
import { describeTarget } from "../region.js";
import { setRegion } from "../store.js";
...
  const sel = selectedLayers(s);
  const m = s.region?.bounds ?? null;
  const cropable = !!m && m[2] > m[0] && m[3] > m[1];
  ...
      <span className="mono ctx-path">{describeTarget(sel.map((l) => l.name), s.region)}</span>
```
「清除选区」按钮的 `onClick` 改成 `() => setRegion(null)`。

- [ ] **Step 7: 7 个测试文件改名**

七处 `marquee:` 状态键改成 `region:`，值从 `Rect` 改成 `rectRegion(rect)`；断言 `getState().marquee` 改成 `getState().region?.bounds ?? null`。`tests/store.test.ts:23` 的 `beforeEach` 手写了整个 INITIAL，那行 `marquee: null,` 必改成 `region: null,`。`tests/selection.test.tsx` 的
```ts
    setState({ marquee: [10, 20, 132, 200] });
```
改成
```ts
    setState({ region: rectRegion([10, 20, 132, 200]) });
```
`tests/canvas-stage-marquee.test.tsx` 的两处断言：
```ts
    expect(getState().region?.bounds).toEqual([0, 0, 60, 100]);
    ...
    expect(getState().region).toBeNull();
    ...
    const m = getState().region!.bounds;
```
`tests/canvas-stage-overlay.test.tsx` 里 `.marquee` **CSS 类名不改**（它是区域轴的视觉，spec §7.2 明写「保持现状，不动」），只改 `setState({ marquee: … })` 的键。

- [ ] **Step 8: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS，且 `no-import-cycles.test.ts` 绿（`region.ts` 只 import `doc-model.ts`）

- [ ] **Step 9: 提交**

```bash
git add packages/web-psd/src/ui/region.ts packages/web-psd/src/ui/store.ts \
        packages/web-psd/src/ui/panels/ packages/web-psd/tests/
git commit -m "refactor(web-psd): marquee 改为 Region,区域轴从一开始就带 mask 句柄位"
```

---

### Task 3: 文档变了之后的失效策略（A 期）

**Files:**
- Create: `packages/web-psd/src/ui/invalidate.ts`
- Modify: `packages/web-psd/src/ui/controller.ts:27-58,87-89`
- Test: `packages/web-psd/tests/selection-invalidation.test.ts`（新建）

**Interfaces:**
- Consumes: `UiState`（store.ts）、`Region`（region.ts）、`LocalLayer`（doc-model.ts）
- Produces:
  ```ts
  export function invalidateTarget(
    prev: Pick<UiState, "doc" | "selection" | "region">,
    next: { canvas: { width: number; height: number }; layers: LocalLayer[] },
    fresh: boolean,
  ): Partial<UiState>;   // 只含真正变了的键；无事发生时返回 {}
  ```

今天没有任何失效逻辑：`controller.ts:36` 的 `onDoc` 从不碰两个轴。最刺眼的后果是点完「裁到选区」——`region.bounds` 还是旧坐标系里的数，而 `rectStyle` 拿它除**新**的 canvas 尺寸，覆盖层画在一个既不是旧位置也不是新位置的地方。

三条决定（spec §3.6）：`crop` 后**清空**区域而不是重映射（裁剪之后那块区域的语义本来就没了）；图层轴**剔除**死 id 而不是清空（agent 删一个图层不该让其余选中一起没）；剔除必须落在 `s.selection` 本身，因为 `store.ts:142` 的 `selectedLayers` 只在读取侧静默过滤，死 id 会一直留在状态里，然后被 `translateOps` 当真 id 发出去。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/selection-invalidation.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { invalidateTarget } from "../src/ui/invalidate.js";
import { rectRegion } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";
import type { UiState } from "../src/ui/store.js";

const leaf = (id: string, children?: LocalLayer[]): LocalLayer => ({
  id, type: children ? "group" : "raster", name: id,
  opacity: 1, blendMode: "normal", visible: true, ...(children ? { children } : {}),
});

const doc = (w: number, h: number, layers: LocalLayer[]) =>
  ({ canvas: { width: w, height: h }, layers });

const prev = (over: Partial<Pick<UiState, "doc" | "selection" | "region">> = {}) => ({
  doc: doc(100, 80, [leaf("g", [leaf("b")]), leaf("a")]) as UiState["doc"],
  selection: ["b", "a"],
  region: rectRegion([10, 10, 50, 50]),
  ...over,
});

describe("invalidateTarget", () => {
  it("clears BOTH axes when a different document is opened", () => {
    expect(invalidateTarget(prev(), doc(64, 64, [leaf("x")]), true))
      .toEqual({ selection: [], region: null });
  });

  // crop rewrites canvas.width/height and shifts every layer by -[left,top]
  // (geometry-ops.ts). A kept region would be read against the NEW canvas by
  // rectStyle and land somewhere that is neither its old nor its new place.
  it("clears the region when the canvas size changes, and keeps the layers", () => {
    const p = prev();
    expect(invalidateTarget(p, doc(40, 40, p.doc!.layers), false))
      .toEqual({ region: null });
  });

  it("prunes ids of deleted layers instead of clearing the whole selection", () => {
    const p = prev();
    expect(invalidateTarget(p, doc(100, 80, [leaf("a")]), false))
      .toEqual({ selection: ["a"] });
  });

  it("leaves both axes alone when layers merely moved", () => {
    const p = prev();
    expect(invalidateTarget(p, doc(100, 80, [leaf("g", [leaf("b")]), leaf("a")]), false))
      .toEqual({});
  });

  it("survives the empty first screen, where there is no previous document", () => {
    expect(invalidateTarget({ doc: null, selection: [], region: null }, doc(10, 10, []), true))
      .toEqual({});
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/selection-invalidation.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ui/invalidate.js"`

- [ ] **Step 3: 写 `invalidate.ts`**

```ts
import type { LocalLayer } from "../doc-model.js";
import type { UiState } from "./store.js";

/**
 * What survives of the selection target when the document changes underneath
 * it (spec §3.6).
 *
 * The target is long-lived state; the document is not. Nothing invalidated it
 * before, so both axes could silently point at things that no longer exist or
 * have moved — never a crash, always a wrong result, which is the worst shape
 * a bug can have. Returns ONLY the keys that actually change, so an unrelated
 * doc update does not hand React a fresh `selection` array for nothing.
 */
export function invalidateTarget(
  prev: Pick<UiState, "doc" | "selection" | "region">,
  next: { canvas: { width: number; height: number }; layers: LocalLayer[] },
  fresh: boolean,
): Partial<UiState> {
  const patch: Partial<UiState> = {};

  // A different document entirely: nothing about the old target means
  // anything here, and layer ids from the previous file would otherwise be
  // carried straight over.
  if (fresh) {
    if (prev.selection.length > 0) patch.selection = [];
    if (prev.region) patch.region = null;
    return patch;
  }

  // A canvas resize is a crop (or an agent resize): the region's coordinate
  // system is gone. Clearing is more honest than remapping — the user just
  // cropped the canvas DOWN TO that region, so re-selecting "where it now
  // sits" would be a tautology.
  const sized = prev.doc?.canvas;
  if (prev.region && sized && (sized.width !== next.canvas.width || sized.height !== next.canvas.height)) {
    patch.region = null;
  }

  // Layers can vanish under us (a local delete, or an agent run). Prune the
  // dead ids rather than dropping the whole selection — losing four
  // selections because the agent deleted a fifth layer is its own bug.
  if (prev.selection.length > 0) {
    const alive = new Set<string>();
    const walk = (list: LocalLayer[]): void => {
      for (const l of list) { alive.add(l.id); if (l.children) walk(l.children); }
    };
    walk(next.layers);
    const kept = prev.selection.filter((id) => alive.has(id));
    if (kept.length !== prev.selection.length) patch.selection = kept;
  }

  return patch;
}
```

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm -C packages/web-psd exec vitest run tests/selection-invalidation.test.ts`
Expected: PASS

- [ ] **Step 5: 接进 `controller.ts`**

`onDoc` 回调里，紧挨着现有的 `fresh` 判定（那里已经能区分「新文档」和「同一文档变了」，正是做这件事的地方）：

```ts
      const docId = controller?.docId ?? null;
      const fresh = docId !== sessionDocId;
      sessionDocId = docId;
      // Both selection axes are long-lived state and the document just moved
      // under them — see invalidate.ts. Computed from the PREVIOUS state, so
      // it has to be read before `setState` replaces it.
      const invalidation = invalidateTarget(getState(), doc as never, fresh);
      setState({
        doc: doc as never,
        version,
        ...(fresh ? { sessionBaseVersion: version } : {}),
        ...invalidation,
      });
```

顶部加 `import { invalidateTarget } from "./invalidate.js";`。

`createFrom` 的成功分支也要清（`onDoc` 的 `fresh` 分支覆盖的是渲染成功的路径；`initRender` 在 `onDoc` 之前抛错时，`docId` 已经换了而 `onDoc` 从未触发，两个轴会带着上一个文档的 id 留下来）：

```ts
  if (controller.docId && controller.docId !== before) {
    // `selection`/`region` are normally cleared by `onDoc`'s fresh branch.
    // They are cleared again here for the path where `initRender` threw
    // BEFORE reaching that callback: the new docId is adopted (see the
    // comment above) while the previous document's target is still in the
    // store, pointing at layer ids that are not in any open document.
    setState({ docId: controller.docId, docName: label, history: [], chat: [], selection: [], region: null });
  }
```

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS。`tests/controller.test.ts` 现有断言不涉及这两个键。

- [ ] **Step 7: 提交**

```bash
git add packages/web-psd/src/ui/invalidate.ts packages/web-psd/src/ui/controller.ts \
        packages/web-psd/tests/selection-invalidation.test.ts
git commit -m "fix(web-psd): 文档变化后失效选择目标,裁剪清区域、删图层剔死 id"
```

---

### Task 4: 区域送达 agent（A 期）

**Files:**
- Modify: `packages/web-psd/src/ui/api.ts:39-47` · `panels/composer.tsx` · `panels/chat-panel.tsx:37-57`
- Test: `packages/web-psd/tests/api.test.ts`（追加）· `packages/web-psd/tests/composer.test.tsx`（新建）

**Interfaces:**
- Consumes: `Region`（region.ts）、`selectedLayers`（store.ts）
- Produces:
  - `export interface AgentTarget { bounds: Rect; layerNames: string[] }`
  - `export function withTarget(instruction: string, target: AgentTarget | null): string`
  - `runAgent(docId: string, instruction: string, target?: AgentTarget | null): Promise<string>`
  - `Composer` 的 `onSend` 签名变为 `(text: string, target: AgentTarget | null) => void`

**这是本计划的产品主线：「帮我把框中的这块重新生成」今天字面上不可能工作**——`composer.tsx` / `chat-panel.tsx` / `api.ts` 里没有一处引用两个轴，`api.ts:39` 只发 `{ instruction }`。A 期用文本拼接补上，**零协议改动、零后端改动**：`tools.ts:271` 的 operator 指令里明写「Every rectangle is bounds = [top, left, bottom, right], in canvas pixels」，且它有 `getPreview{rect}` 可以去看，所以 agent 今天就能理解这个矩形。

这是**明确的权宜之计**，不是终态（spec §4.3）。三条约束写死在代码里：不易撞的定界且只在开头一次；每轮都带但 composer 上有可见、可一键摘掉的 chip；图层清单只带**名字**不带 id（名字是 agent 能在 `getLayers` 结果里对上的，id 对它没意义还占长度）。

**范围**：只在**存在区域**时附带。「只选了图层、没有区域」走已有的 `@ 图层` 按钮，不在本任务内改。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/api.test.ts` 末尾追加：

```ts
describe("withTarget", () => {
  it("returns the instruction untouched when there is no target", () => {
    expect(withTarget("把角标挪到右下", null)).toBe("把角标挪到右下");
  });

  // The delimiter has to survive a user typing brackets of their own, and it
  // appears ONCE, at the front — the operator is a ReAct loop with
  // conversation memory (api.ts's resetAgent), so a marker sprinkled mid-text
  // would give it several bounds with no way to tell which is current.
  it("prefixes one delimited marker carrying bounds and layer NAMES", () => {
    expect(withTarget("把框中的天空换成晚霞", { bounds: [120, 340, 560, 900], layerNames: ["图层 3", "天空"] }))
      .toBe('<<selection bounds=[120,340,560,900] layers=["图层 3","天空"]>>\n把框中的天空换成晚霞');
  });

  it("omits the layer list entirely when no layer is selected", () => {
    expect(withTarget("重画这块", { bounds: [0, 0, 10, 10], layerNames: [] }))
      .toBe("<<selection bounds=[0,0,10,10]>>\n重画这块");
  });
});
```

`api` 的 `describe` 里追加：

```ts
  it("splices the target into the instruction it POSTs", async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { response: "done" } }));
    await runAgent("abc", "换成晚霞", { bounds: [1, 2, 3, 4], layerNames: ["天空"] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      instruction: '<<selection bounds=[1,2,3,4] layers=["天空"]>>\n换成晚霞',
    });
  });
```

顶部 import 改成 `import { fetchHistory, rollback, runAgent, resetAgent, withTarget } from "../src/ui/api.js";`

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/api.test.ts`
Expected: FAIL — `withTarget is not a function`

- [ ] **Step 3: 改 `api.ts`**

`runAgent` 上方插入，并改其签名：

```ts
/** The selection target as the agent gets to see it. Layer NAMES, not ids:
 *  names are what the agent can match against its own `getLayers` result;
 *  ids mean nothing to it and only cost tokens. */
export interface AgentTarget {
  bounds: [number, number, number, number];
  layerNames: string[];
}

/**
 * Splices the current target into the instruction text.
 *
 * DELIBERATELY A STOPGAP (spec §4.3). The real fix widens
 * `DocRunOperatorRequest.body` from `{ instruction }` to
 * `{ instruction, region? }` and carries a mask through CAS — a cross-package
 * change that needs its own design. This gets the main path working today,
 * and real usage is what will show which fields the agent actually needs,
 * which is more reliable than guessing the protocol first.
 *
 * Being a string convention rather than a typed contract, three things are
 * pinned down: an unlikely-to-collide delimiter, emitted ONCE at the front
 * (users type brackets, and the operator keeps conversation memory across
 * turns — a marker in the middle would leave it with two bounds and no way to
 * tell which is current); and layer names only.
 */
export function withTarget(instruction: string, target: AgentTarget | null): string {
  if (!target) return instruction;
  const [top, left, bottom, right] = target.bounds;
  const layers = target.layerNames.length > 0
    ? ` layers=[${target.layerNames.map((n) => JSON.stringify(n)).join(",")}]`
    : "";
  return `<<selection bounds=[${top},${left},${bottom},${right}]${layers}>>\n${instruction}`;
}

export async function runAgent(docId: string, instruction: string, target: AgentTarget | null = null): Promise<string> {
  const body = await readJson<{ data?: { response?: string } }>(await fetch(docUrl(docId, "run"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: withTarget(instruction, target) }),
  }));
  const reply = body.data?.response;
  return typeof reply === "string" && reply.trim() ? reply : "(done)";
}
```

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm -C packages/web-psd exec vitest run tests/api.test.ts`
Expected: PASS

- [ ] **Step 5: 写 composer 的失败测试**

`packages/web-psd/tests/composer.test.tsx`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/ui/panels/composer.js";
import { setState } from "../src/ui/store.js";
import { rectRegion } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string, name: string): LocalLayer =>
  ({ id, type: "raster", name, opacity: 1, blendMode: "normal", visible: true });

beforeEach(() => {
  setState({
    region: null, selection: [],
    doc: { canvas: { width: 400, height: 200 }, layers: [leaf("a", "天空")] },
  });
});

const send = (text: string) => {
  fireEvent.change(screen.getByPlaceholderText(/说明要改什么/), { target: { value: text } });
  fireEvent.keyDown(screen.getByPlaceholderText(/说明要改什么/), { key: "Enter" });
};

describe("Composer", () => {
  it("sends no target when there is no region", () => {
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    expect(screen.queryByText(/已附带选区/)).not.toBeInTheDocument();
    send("随便改改");
    expect(onSend).toHaveBeenCalledWith("随便改改", null);
  });

  it("shows a chip and attaches bounds plus selected layer names", () => {
    setState({ region: rectRegion([20, 40, 120, 240]), selection: ["a"] });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    expect(screen.getByText("已附带选区 200 × 100")).toBeInTheDocument();
    send("换成晚霞");
    expect(onSend).toHaveBeenCalledWith("换成晚霞", { bounds: [20, 40, 120, 240], layerNames: ["天空"] });
  });

  // Attaching on every turn is required (by turn three, "a bit more to the
  // left" has to still mean the same patch) — so the user must be able to SEE
  // it and take it off, or state leaves the browser without their knowledge.
  it("stops attaching once the chip is dismissed, without clearing the region", () => {
    setState({ region: rectRegion([20, 40, 120, 240]) });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    fireEvent.click(screen.getByLabelText("不附带选区"));
    expect(screen.queryByText(/已附带选区/)).not.toBeInTheDocument();
    send("换成晚霞");
    expect(onSend).toHaveBeenCalledWith("换成晚霞", null);
  });
});
```

- [ ] **Step 6: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/composer.test.tsx`
Expected: FAIL — `expect(onSend).toHaveBeenCalledWith("随便改改", null)`，实际只收到一个参数

- [ ] **Step 7: 改 `composer.tsx`**

整个文件替换成：

```tsx
import { useState } from "react";
import { selectedLayers, useUiState } from "../store.js";
import type { AgentTarget } from "../api.js";
import type { Region } from "../region.js";

export function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string, target: AgentTarget | null) => void }) {
  const s = useUiState();
  const [text, setText] = useState("");
  // The region the user took OFF the composer, held by identity rather than
  // by a boolean: every drag produces a fresh Region object, so a new
  // selection re-attaches on its own and the dismissal only ever applies to
  // the one region it was aimed at.
  const [dropped, setDropped] = useState<Region | null>(null);

  const attached = s.region && s.region !== dropped ? s.region : null;
  const target: AgentTarget | null = attached
    ? { bounds: attached.bounds, layerNames: selectedLayers(s).map((l) => l.name) }
    : null;

  const submit = (): void => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    onSend(t, target);
  };

  // Phase 1: "@layer" only injects TEXT into the instruction. Real structured
  // context (the selected IR subtree travelling with the request) needs the
  // /run contract widened — that is phase 2, foundation 6.
  const mention = (): void => {
    const names = selectedLayers(s).map((l) => `@${l.name}`).join(" ");
    if (names) setText((t) => (t ? `${t} ${names} ` : `${names} `));
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          value={text}
          placeholder="说明要改什么，或先在画布上框出问题区域…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        <div className="composer-actions">
          <button type="button" className="chip" onClick={mention}>@ 图层</button>
          {/* The region rides along on EVERY turn (spec §4.3): drop it after
              the first and "a bit more to the left" three turns later has
              nothing to refer to. That makes it state leaving the browser
              silently, so it is shown, and it comes off in one click. */}
          {attached ? (
            <button
              type="button"
              className="chip chip-on"
              aria-label="不附带选区"
              title="点击后本次不再附带选区"
              onClick={() => setDropped(attached)}
            >
              {`已附带选区 ${attached.bounds[3] - attached.bounds[1]} × ${attached.bounds[2] - attached.bounds[0]} ×`}
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>发送</button>
        </div>
      </div>
    </div>
  );
}
```

`styles.css` 末尾追加一行：
```css
.chip-on { border-color: var(--accent); color: var(--accent-ink); background: color-mix(in srgb, var(--accent) 8%, transparent); }
```

- [ ] **Step 8: 改 `chat-panel.tsx` 透传**

```ts
  const send = async (text: string, target: AgentTarget | null): Promise<void> => {
    const { docId, chatBusy, version } = getState();
    if (!docId || chatBusy) return;
    ...
      const reply = await runAgent(docId, text, target);
```
JSX 末尾：
```tsx
      <Composer busy={s.chatBusy} onSend={(t, target) => void send(t, target)} />
```
顶部 import 加 `type AgentTarget`。

- [ ] **Step 9: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add packages/web-psd/src/ui/api.ts packages/web-psd/src/ui/panels/composer.tsx \
        packages/web-psd/src/ui/panels/chat-panel.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/api.test.ts packages/web-psd/tests/composer.test.tsx
git commit -m "feat(web-psd): 选区随每轮指令送达 agent,composer 上可见可摘"
```

---

### Task 5: 图层轴的纯函数与选中集归一化（B 期）

**Files:**
- Create: `packages/web-psd/src/ui/hit-test.ts`
- Modify: `packages/web-psd/src/ui/store.ts`（`nextSelection` 接归一化）· `src/ui/invalidate.ts`（复用死 id 剔除）
- Test: `packages/web-psd/tests/hit-test.test.ts`（新建）· `packages/web-psd/tests/drag-normalize.test.ts`（新建）

**Interfaces:**
- Consumes: `LocalLayer` / `Rect`（doc-model.ts）
- Produces（全部纯函数，无 DOM、无 store）：
  ```ts
  export interface Hit { layerId: string; path: string[] }   // path: 最外层组 → 叶子，末位 === layerId
  export type HitTester = (x: number, y: number) => Promise<Hit[]>;  // 自上而下的候选栈，[] = 未命中
  export function findLayer(layers: LocalLayer[], id: string): LocalLayer | null;
  export function unionRect(a: Rect, b: Rect): Rect;
  export function layerBox(layer: LocalLayer): Rect | null;
  export function layersIntersecting(layers: LocalLayer[], bounds: Rect): string[];
  export function normalizeSelection(layers: LocalLayer[], ids: string[]): string[];
  export function expandAncestors(layers: LocalLayer[], id: string, expanded: ReadonlySet<string>): ReadonlySet<string>;
  ```

三件事在这里定死：

**组的包围盒必须前端算。** `psd/load.ts:230` 对所有图层一律取 ag-psd 的 `top/left/bottom/right`，而 PSD 里的组（section divider）在文件里通常就报 `0,0,0,0`——`layer.bounds` 对组**不可用**。用 `bounds` 而不是 `layerInfluenceBounds`：后者算上描边外扩和投影偏移，一个带大投影的图层选中框会飘出去一大圈，而 Photoshop 的变换框是贴着 `bounds` 的。

**选中集必须归一到互不为祖先的顶层集合。** `geometry-ops.ts:12` 的 `shiftLayer` **递归子层**，而 `drag.ts:22` 的 `translateOps` 对选中集里每个 id 各发一个 translate——组和它的子层同时在选中集里，**子层会吃到两次位移**。今天要先在树里 Shift 多选才构造得出来；本计划把「单击选最外层组」+「Shift 加选」+「按在未选中图层上直接拖」凑齐之后，这会从边角变成常规路径。

**归一化放在写入侧**（`nextSelection` 之后），不是拖动前：属性面板、context-bar 的计数、送给 agent 的图层清单，全都会因为重复计入而说谎。

**`HitTester` 返回候选栈而不是单个 `Hit`。** spec §5.2 写的是 `Promise<Hit | null>`；这里放宽成数组，因为 §5.7 的 Alt 循环和右键列出**都需要那一串**，而它就是命中测试自上而下走出来的东西，多算的成本是零。单个命中就是 `hits[0] ?? null`。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/hit-test.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  findLayer, unionRect, layerBox, layersIntersecting, normalizeSelection, expandAncestors,
} from "../src/ui/hit-test.js";
import type { LocalLayer, Rect } from "../src/doc-model.js";

const leaf = (id: string, bounds: Rect, over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds, ...over });

const group = (id: string, children: LocalLayer[], over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "group", name: id, opacity: 1, blendMode: "normal", visible: true,
     bounds: [0, 0, 0, 0], children, ...over });

describe("layerBox", () => {
  it("returns a leaf's own bounds", () => {
    expect(layerBox(leaf("a", [10, 10, 20, 20]))).toEqual([10, 10, 20, 20]);
  });

  // psd/load.ts maps ag-psd's top/left/bottom/right for EVERY layer, and a PSD
  // section divider reports 0,0,0,0 — a group has no space of its own, it is a
  // render scope. Trusting `bounds` here would put every group's selection box
  // in the top-left corner at zero size.
  it("unions the children when the group's own bounds are the usual 0,0,0,0", () => {
    const g = group("g", [leaf("a", [10, 10, 20, 20]), leaf("b", [40, 5, 50, 30])]);
    expect(layerBox(g)).toEqual([10, 5, 50, 30]);
  });

  it("ignores hidden children and returns null when none are visible", () => {
    expect(layerBox(group("g", [leaf("a", [10, 10, 20, 20], { visible: false })]))).toBeNull();
  });

  it("nests", () => {
    const g = group("outer", [group("inner", [leaf("a", [0, 0, 5, 5])]), leaf("b", [90, 90, 100, 100])]);
    expect(layerBox(g)).toEqual([0, 0, 100, 100]);
  });
});

describe("unionRect", () => {
  it("takes the outermost edge on each side", () => {
    expect(unionRect([10, 20, 30, 40], [5, 25, 35, 35])).toEqual([5, 20, 35, 40]);
  });
});

describe("layersIntersecting", () => {
  const layers = [leaf("bg", [0, 0, 100, 100]), leaf("a", [10, 10, 20, 20]), leaf("far", [90, 90, 99, 99])];

  it("collects every top-level layer whose box meets the region, over-selecting rather than missing", () => {
    expect(layersIntersecting(layers, [0, 0, 30, 30])).toEqual(["bg", "a"]);
  });

  it("excludes layers that only touch the region's edge", () => {
    expect(layersIntersecting([leaf("a", [0, 0, 10, 10])], [10, 10, 20, 20])).toEqual([]);
  });

  it("skips groups with no visible children, which have no box at all", () => {
    expect(layersIntersecting([group("g", [leaf("h", [0, 0, 5, 5], { visible: false })])], [0, 0, 10, 10]))
      .toEqual([]);
  });
});

describe("normalizeSelection", () => {
  const layers = [group("g", [leaf("b", [0, 0, 1, 1]), leaf("c", [0, 0, 1, 1])]), leaf("a", [0, 0, 1, 1])];

  // geometry-ops.ts's shiftLayer recurses into children while drag.ts emits one
  // translate PER SELECTED ID — so a group plus its own child means the child
  // moves twice. See drag-normalize.test.ts for the end-to-end version.
  it("drops a member whose ancestor is also selected", () => {
    expect(normalizeSelection(layers, ["g", "b"])).toEqual(["g"]);
  });

  it("keeps siblings, which are not ancestors of each other", () => {
    expect(normalizeSelection(layers, ["b", "c"])).toEqual(["b", "c"]);
  });

  it("prunes ids that are not in the document at all", () => {
    expect(normalizeSelection(layers, ["a", "ghost"])).toEqual(["a"]);
  });

  it("dedupes", () => {
    expect(normalizeSelection(layers, ["a", "a"])).toEqual(["a"]);
  });

  it("preserves click order", () => {
    expect(normalizeSelection(layers, ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("findLayer / expandAncestors", () => {
  const layers = [group("outer", [group("inner", [leaf("deep", [0, 0, 1, 1])])]), leaf("a", [0, 0, 1, 1])];

  it("finds through nesting", () => {
    expect(findLayer(layers, "deep")?.name).toBe("deep");
    expect(findLayer(layers, "nope")).toBeNull();
  });

  // flattenTree only emits a group's children when the group is in `expanded`,
  // so selecting something from the canvas without this leaves the user looking
  // at a tree that does not contain what they just selected.
  it("adds every ancestor group of the target, and not the target itself", () => {
    const next = expandAncestors(layers, "deep", new Set(["keep"]));
    expect([...next].sort()).toEqual(["inner", "keep", "outer"]);
  });

  it("returns the same set object when nothing needs opening", () => {
    const before = new Set(["x"]);
    expect(expandAncestors(layers, "a", before)).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/hit-test.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ui/hit-test.js"`

- [ ] **Step 3: 写 `hit-test.ts`**

```ts
import type { LocalLayer, Rect } from "../doc-model.js";

/**
 * The layer axis: pure geometry and set arithmetic over the layer tree. No
 * DOM, no store, no Worker — the actual alpha sampling lives in the render
 * Worker (see doc-controller's hitTest), and this module is what both the
 * synchronous callers and that async result are shaped by.
 */

/** One candidate under the cursor. `path` runs outermost group → leaf, with
 *  `path[path.length - 1] === layerId`, so the caller picks the level it wants
 *  (single click, double click and ⌘-click each want a different one) instead
 *  of the hit test deciding for everyone. */
export interface Hit {
  layerId: string;
  path: string[];
}

/**
 * Async from the very first version even where the answer is already known,
 * because the real implementation is a postMessage round trip to the render
 * Worker: a synchronous stand-in would have every call site rewritten when it
 * lands.
 *
 * Resolves with the candidate stack under the point, topmost first — empty on
 * a miss. Spec §5.2 writes this as a single `Hit | null`; the stack is a
 * superset, and both Alt-cycling and the right-click list need it. It costs
 * nothing extra: the hit test walks that stack anyway.
 */
export type HitTester = (x: number, y: number) => Promise<Hit[]>;

export function findLayer(layers: LocalLayer[], id: string): LocalLayer | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const found = findLayer(l.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function unionRect(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/**
 * The rect a selection box should be drawn around.
 *
 * A GROUP'S OWN `bounds` IS NOT USABLE. `psd/load.ts:230` maps ag-psd's
 * top/left/bottom/right for every layer alike, and a PSD section divider
 * reports `0,0,0,0` — a group is a render scope (blend, opacity, mask), not a
 * spatial container, so it has no extent of its own and one has to be derived
 * from its visible children.
 *
 * Deliberately `bounds` and not `layerInfluenceBounds` (region.ts:14): the
 * latter includes stroke spread and drop-shadow offset, so a layer with a big
 * shadow would get a selection box floating well clear of the thing it is
 * selecting. Photoshop's transform box hugs the bounds too.
 */
export function layerBox(layer: LocalLayer): Rect | null {
  if (!layer.children) return layer.bounds ?? null;
  let box: Rect | null = null;
  for (const child of layer.children) {
    if (!child.visible) continue;
    const b = layerBox(child);
    if (b) box = box ? unionRect(box, b) : b;
  }
  return box;
}

/** Region axis → layer axis (spec §6.2): every top-level layer whose box meets
 *  `bounds`. Box-level, not per-pixel, on purpose — over-selecting is
 *  recoverable (the user deselects), missing something is not. Top-level only,
 *  which also means the result is already normalized. */
export function layersIntersecting(layers: LocalLayer[], bounds: Rect): string[] {
  const [rt, rl, rb, rr] = bounds;
  const out: string[] = [];
  for (const layer of layers) {
    const box = layerBox(layer);
    if (!box) continue;
    const [t, l, b, r] = box;
    if (t < rb && b > rt && l < rr && r > rl) out.push(layer.id);
  }
  return out;
}

/** id → its ancestor ids, outermost first. */
function ancestorIndex(layers: LocalLayer[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (list: LocalLayer[], chain: string[]): void => {
    for (const l of list) {
      index.set(l.id, chain);
      if (l.children) walk(l.children, [...chain, l.id]);
    }
  };
  walk(layers, []);
  return index;
}

/**
 * Reduces a selection to members that are not descendants of one another, and
 * drops ids the document no longer has.
 *
 * Both halves prevent the same class of bug — a selection that looks fine and
 * behaves wrongly. `ops/geometry-ops.ts`'s `shiftLayer` recurses into
 * children, while `drag.ts`'s `translateOps` emits one translate per selected
 * id, so a group selected alongside its own child moves that child TWICE. And
 * a dead id is invisible on screen (`selectedLayers` filters it out at read
 * time) yet still gets dispatched as if it were real.
 *
 * Applied at the WRITE side rather than before a drag: the properties pane,
 * the context bar's count and the layer list sent to the agent would all
 * misreport a double-counted selection.
 */
export function normalizeSelection(layers: LocalLayer[], ids: string[]): string[] {
  const index = ancestorIndex(layers);
  const present = new Set(ids.filter((id) => index.has(id)));
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (seen.has(id)) return false;
    const chain = index.get(id);
    if (!chain || chain.some((a) => present.has(a))) return false;
    seen.add(id);
    return true;
  });
}

/** Every ancestor group of `id`, added to `expanded` — `flattenTree` only
 *  emits a group's children when the group is in that set, so a canvas
 *  selection would otherwise land on a row the tree is not rendering.
 *  Returns the SAME set when nothing has to open, so React sees no change. */
export function expandAncestors(
  layers: LocalLayer[], id: string, expanded: ReadonlySet<string>,
): ReadonlySet<string> {
  const chain = ancestorIndex(layers).get(id);
  if (!chain || chain.every((a) => expanded.has(a))) return expanded;
  const next = new Set(expanded);
  for (const a of chain) next.add(a);
  return next;
}
```

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm -C packages/web-psd exec vitest run tests/hit-test.test.ts`
Expected: PASS

- [ ] **Step 5: 写「子层只位移一次」的端到端测试**

`packages/web-psd/tests/drag-normalize.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { getState, setState, nextSelection } from "../src/ui/store.js";
import { translateOps } from "../src/ui/drag.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 10, 10] });

describe("selection normalization end-to-end", () => {
  it("dispatches ONE translate for a child whose group is already selected", () => {
    setState({
      doc: { canvas: { width: 100, height: 100 }, layers: [
        { id: "g", type: "group", name: "g", opacity: 1, blendMode: "normal", visible: true,
          bounds: [0, 0, 0, 0], children: [leaf("b")] },
      ] },
      selection: ["g"],
    });
    // Shift-clicking the child of an already-selected group is the ordinary
    // path once canvas click-select lands, not an exotic one. Un-normalized,
    // this yields ["g","b"] and geometry-ops' recursive shiftLayer moves "b"
    // by the group's translate AND by its own.
    const selection = nextSelection(getState(), "b", true);
    expect(selection).toEqual(["g"]);

    const ops = translateOps({ layerIds: selection, from: { x: 0, y: 0 }, last: { x: 0, y: 0 } }, { x: 5, y: 0 });
    expect(ops.map((o) => o.payload.layerId)).toEqual(["g"]);
  });
});
```

- [ ] **Step 6: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/drag-normalize.test.ts`
Expected: FAIL — `expected [ 'g', 'b' ] to deeply equal [ 'g' ]`

- [ ] **Step 7: `nextSelection` 接归一化**

`packages/web-psd/src/ui/store.ts`：顶部加 `import { normalizeSelection } from "./hit-test.js";`，函数替换成：

```ts
/**
 * Normalizes at the WRITE side — see hit-test.ts's normalizeSelection for why
 * a group plus its own child is a real bug and not a tidiness question.
 * Without a document there is no tree to normalize against, which is the
 * empty first screen, so the raw list stands.
 */
export function nextSelection(s: UiState, id: string, additive: boolean): string[] {
  const raw = !additive
    ? [id]
    : s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id];
  return s.doc ? normalizeSelection(s.doc.layers, raw) : raw;
}
```

`invalidate.ts` 里那段自己写的存活集合遍历换成同一个函数，两处剔除逻辑不再各写一遍：

```ts
  if (prev.selection.length > 0) {
    const kept = normalizeSelection(next.layers, prev.selection);
    if (kept.length !== prev.selection.length) patch.selection = kept;
  }
```
顶部加 `import { normalizeSelection } from "./hit-test.js";`，并删掉原来的 `alive` / `walk` 局部变量。

- [ ] **Step 8: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS。`store.test.ts` 现有的 `nextSelection` 用例 `s.doc` 为 null，走 raw 分支，不受影响；`no-import-cycles.test.ts` 绿（`store.ts → hit-test.ts → doc-model.ts`，单向）。

- [ ] **Step 9: 提交**

```bash
git add packages/web-psd/src/ui/hit-test.ts packages/web-psd/src/ui/store.ts \
        packages/web-psd/src/ui/invalidate.ts \
        packages/web-psd/tests/hit-test.test.ts packages/web-psd/tests/drag-normalize.test.ts
git commit -m "feat(web-psd): 图层轴纯函数与选中集归一化,组包围盒按子层并集算"
```

---

### Task 6: 选中框与悬停框（B 期）

**Files:**
- Create: `packages/web-psd/src/ui/overlay-geometry.ts` · `src/ui/overlay-store.ts` · `src/ui/panels/selection-box.tsx`
- Modify: `packages/web-psd/src/ui/panels/selection-overlay.tsx`（`rectStyle` 搬走）· `panels/canvas-stage.tsx`（JSX 加一行）· `src/ui/styles.css`（末尾追加）
- Test: `packages/web-psd/tests/selection-box.test.tsx`（新建）

**Interfaces:**
- Consumes: `layerBox` / `unionRect` / `findLayer`（hit-test.ts）、`selectedLayers`（store.ts）
- Produces:
  - `overlay-geometry.ts`: `rectStyle(rect, canvas)`（从 `selection-overlay.tsx:59` 原样搬来，**连同其上的定位契约注释**）
  - `overlay-store.ts`: `getHoverId()` / `setHoverId(id)` / `useHoverId()` / `subscribeHover(fn)`
  - `panels/selection-box.tsx`: `<SelectionBox />`

`rectStyle` 现在有第二个消费方了，按 spec §13 第 6 条抽走，**契约注释一起搬**——否则契约的文字和代码分家，正是 §12 那条风险要防的事。

**悬停不走全局 store。** `store.ts:106` 的注释写明订阅的是整个 state 对象，任何一次 `setState` 都会重渲染整棵树，包括几百行的图层树；悬停是每次 `pointermove` 都变的。`hoverId` 单独一个同构的小 store，**只有覆盖层订阅它**，一次悬停变化的重渲染成本是一个 div。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/selection-box.test.tsx`：

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { SelectionBox } from "../src/ui/panels/selection-box.js";
import { setState } from "../src/ui/store.js";
import { setHoverId } from "../src/ui/overlay-store.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string, bounds: [number, number, number, number]): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds });

beforeEach(() => {
  setHoverId(null);
  setState({
    selection: [], zoom: 1,
    doc: { canvas: { width: 400, height: 200 }, layers: [
      leaf("a", [20, 40, 120, 240]),
      leaf("b", [0, 0, 40, 80]),
      { id: "g", type: "group", name: "g", opacity: 1, blendMode: "normal", visible: true,
        bounds: [0, 0, 0, 0], children: [leaf("c", [100, 100, 200, 400])] },
    ] },
  });
});

describe("SelectionBox", () => {
  it("draws nothing without a selection", () => {
    const { container } = render(<SelectionBox />);
    expect(container.querySelector(".sel-union")).toBeNull();
  });

  /**
   * Percentages, not pixels — jsdom does no layout, so a measured overlay is
   * untestable here, while the percentages sit in the inline style where they
   * ARE readable. Their independence from zoom is the whole property (see
   * canvas-stage-overlay.test.tsx, which asserts the same thing for .marquee).
   */
  it("positions a single selection as a percentage of the document, unchanged by zoom", () => {
    setState({ selection: ["a"] });
    const { container, rerender } = render(<SelectionBox />);
    const box = () => container.querySelector(".sel-union") as HTMLElement;
    expect(box().style.left).toBe("10%");    // 40/400
    expect(box().style.top).toBe("10%");     // 20/200
    expect(box().style.width).toBe("50%");   // (240-40)/400
    expect(box().style.height).toBe("50%");  // (120-20)/200
    expect(container.querySelectorAll(".sel-union .h")).toHaveLength(8);

    act(() => { setState({ zoom: 4 }); });
    rerender(<SelectionBox />);
    expect(box().style.left).toBe("10%");
    expect(box().style.width).toBe("50%");
  });

  it("draws one thin box per layer plus one union box with the handles when several are selected", () => {
    setState({ selection: ["a", "b"] });
    const { container } = render(<SelectionBox />);
    expect(container.querySelectorAll(".sel-box")).toHaveLength(2);
    const union = container.querySelector(".sel-union") as HTMLElement;
    expect(union.style.left).toBe("0%");     // min(40,0)/400
    expect(union.style.width).toBe("60%");   // (240-0)/400
    expect(container.querySelectorAll(".sel-box .h")).toHaveLength(0);
  });

  // A group's own bounds are 0,0,0,0 in a PSD — the box has to come from the
  // children or it collapses into the corner.
  it("boxes a group by its children", () => {
    setState({ selection: ["g"] });
    const { container } = render(<SelectionBox />);
    const union = container.querySelector(".sel-union") as HTMLElement;
    expect(union.style.left).toBe("25%");    // 100/400
    expect(union.style.height).toBe("50%");  // (200-100)/200
  });

  it("draws a hover outline for a layer that is not selected, and not for one that is", () => {
    const { container, rerender } = render(<SelectionBox />);
    act(() => { setHoverId("b"); });
    rerender(<SelectionBox />);
    expect(container.querySelector(".sel-hover")).not.toBeNull();

    act(() => { setState({ selection: ["b"] }); });
    rerender(<SelectionBox />);
    expect(container.querySelector(".sel-hover")).toBeNull();
  });

  it("draws nothing when no document is open — the empty state is the first screen", () => {
    setState({ selection: ["a"], doc: null });
    const { container } = render(<SelectionBox />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/selection-box.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/ui/panels/selection-box.js"`

- [ ] **Step 3: 把 `rectStyle` 搬进 `overlay-geometry.ts`**

新建 `packages/web-psd/src/ui/overlay-geometry.ts`。**`selection-overlay.tsx:3-34` 的整段文件头注释与 `:50-71` 的 `rectStyle` 原样搬来**，一个字不改写：

```ts
import type { Rect } from "../doc-model.js";

/**
 * **Positioning contract for everything drawn over the canvas** (selection
 * chrome, handles, transform boxes, hover outlines — follow this):
 *
 * - Geometry is stored in DOCUMENT pixels and emitted as a PERCENTAGE of the
 *   containing block. Overlays are absolutely positioned, so their containing
 *   block is `.stage-inner` — which has no padding and shrink-wraps the
 *   canvas, making its padding box exactly the canvas box. `left: 25%` is
 *   therefore 25% across the document, whatever size the canvas is drawn at.
 * - The overlay is a SIBLING of the canvas inside `.stage-inner`, not a child
 *   of anything CSS-scaled. Zoom scales the canvas box; the overlay resolves
 *   its own percentages against that box instead of being scaled with it.
 * - Consequently CHROME DOES NOT SCALE: the 1.5px ants, the 6px handles stay
 *   crisp and grabbable at 25% and at 400% alike. Never express chrome
 *   thickness in document pixels, and never wrap this in a `transform:
 *   scale()` — both would make handles unusable at the extremes.
 *
 * **Why percentages rather than measuring `toScreen()` at render time.**
 * Measuring during render reads the DOM before React has committed the new
 * canvas size, so a zoom would position the overlay against the PREVIOUS
 * box and leave it there until some unrelated state change re-rendered it.
 * Percentages hand the arithmetic to the browser, which resolves them during
 * layout — after the new size is in effect, by construction. It also covers
 * every other cause of the box changing (a future fit-on-resize mode, a CSS
 * transition on the canvas) with no observer, no extra render, and no
 * notification plumbing to forget. `toScreen()` remains the right tool for
 * anything measured OUTSIDE render, e.g. in an event handler, where layout
 * has already settled.
 *
 * This module exists so the contract's prose and its code stay in one place:
 * it moved here from selection-overlay.tsx when the selection box became its
 * second consumer.
 */
export function rectStyle(
  rect: Rect,
  canvas: { width: number; height: number },
): { left: string; top: string; width: string; height: string } {
  const [top, left, bottom, right] = rect;
  const pct = (v: number, total: number): string => `${total > 0 ? (v / total) * 100 : 0}%`;
  return {
    left: pct(left, canvas.width),
    top: pct(top, canvas.height),
    width: pct(right - left, canvas.width),
    height: pct(bottom - top, canvas.height),
  };
}
```

`selection-overlay.tsx` 里删掉 `rectStyle` 与其上的两段注释，改成：

```tsx
import { useUiState } from "../store.js";
import { rectStyle } from "../overlay-geometry.js";

/**
 * Marching-ants marquee, drawn as a DOM overlay above the canvas so the
 * compositor never has to re-render for a selection change.
 *
 * Positioned by `rectStyle` — the contract for everything drawn over the
 * canvas, and the reasoning behind it, live in `ui/overlay-geometry.ts`. Read
 * that before adding another overlay.
 */
export function SelectionOverlay() {
```

- [ ] **Step 4: 写 `overlay-store.ts`**

```ts
import { useSyncExternalStore } from "react";

/**
 * The hovered layer id, deliberately NOT in the main store.
 *
 * `store.ts` subscribes components to the whole state object, so every
 * `setState` re-renders the entire tree — including the layer panel's few
 * hundred rows. Hover changes on every `pointermove`; routing it through
 * there would re-render that tree per frame. Here, one hover change costs one
 * div, because the selection overlay is the only subscriber.
 *
 * Same shape as the main store (subscribe / getSnapshot /
 * useSyncExternalStore) so there is one idiom to learn, not two.
 */
let hoverId: string | null = null;
const listeners = new Set<() => void>();

export function getHoverId(): string | null {
  return hoverId;
}

/** No-ops when unchanged: the hit test reports the same layer for most frames
 *  of a slow drag across it, and every one of those would otherwise be a
 *  render. */
export function setHoverId(id: string | null): void {
  if (id === hoverId) return;
  hoverId = id;
  for (const fn of [...listeners]) fn();
}

export function subscribeHover(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useHoverId(): string | null {
  return useSyncExternalStore(subscribeHover, getHoverId, getHoverId);
}
```

- [ ] **Step 5: 写 `selection-box.tsx`**

```tsx
import { selectedLayers, useUiState } from "../store.js";
import { findLayer, layerBox, unionRect } from "../hit-test.js";
import { rectStyle } from "../overlay-geometry.js";
import { useHoverId } from "../overlay-store.js";
import type { Rect } from "../../doc-model.js";

/**
 * The layer axis drawn over the canvas: one outline per selected layer, a
 * union box carrying the handles, and a fainter outline for whatever the
 * cursor is over.
 *
 * Positioning follows `ui/overlay-geometry.ts` — percentages of the document,
 * never a measurement taken during render.
 *
 * The eight handles are VISUAL ONLY this phase. Dragging one would really
 * scale the layer, which needs the affine resampler in composite.ts that does
 * not exist yet — so there is deliberately no `cursor: nwse-resize` and
 * nothing else that suggests they can be grabbed.
 */
export function SelectionBox() {
  const s = useUiState();
  const hoverId = useHoverId();
  const canvas = s.doc?.canvas;
  // No document is the FIRST screen, not an edge case (controller.ts opens
  // nothing on startup), and a percentage has nothing to be a fraction of.
  if (!canvas) return null;

  const boxes = selectedLayers(s)
    .map((l) => layerBox(l))
    .filter((b): b is Rect => !!b);
  const union = boxes.reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null);

  const hovered = hoverId && !s.selection.includes(hoverId) ? findLayer(s.doc!.layers, hoverId) : null;
  const hoverRect = hovered ? layerBox(hovered) : null;

  return (
    <>
      {hoverRect ? <div className="sel-hover" style={rectStyle(hoverRect, canvas)} /> : null}
      {/* With one layer selected the union box IS that layer's box, so the
          per-layer outlines would just double the same line. */}
      {boxes.length > 1
        ? boxes.map((b, i) => <div key={i} className="sel-box" style={rectStyle(b, canvas)} />)
        : null}
      {union ? (
        <div className="sel-union" style={rectStyle(union, canvas)}>
          <i className="h tl" /><i className="h tc" /><i className="h tr" />
          <i className="h ml" /><i className="h mr" />
          <i className="h bl" /><i className="h bc" /><i className="h br" />
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 6: 追加样式并挂载**

`packages/web-psd/src/ui/styles.css` **末尾追加**：

```css
/* Layer-axis selection chrome. Geometry comes from ui/overlay-geometry.ts as
   percentages of the document; everything here is in CSS pixels and must stay
   that way, so it looks the same at 5% and at 400% zoom. `outline` rather than
   `border` on purpose: the boxes are sized in percentages, and a border would
   be added to that width and push the box off the layer it is tracing. */
.sel-box, .sel-union, .sel-hover { position: absolute; pointer-events: none; }
.sel-box   { outline: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); }
.sel-union { outline: 1px solid var(--accent); }
.sel-hover { outline: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); }
.sel-union .h { position: absolute; width: 6px; height: 6px; background: var(--surface); border: 1.5px solid var(--accent); }
.sel-union .tl { left: -3px; top: -3px; }
.sel-union .tc { left: calc(50% - 3px); top: -3px; }
.sel-union .tr { right: -3px; top: -3px; }
.sel-union .ml { left: -3px; top: calc(50% - 3px); }
.sel-union .mr { right: -3px; top: calc(50% - 3px); }
.sel-union .bl { left: -3px; bottom: -3px; }
.sel-union .bc { left: calc(50% - 3px); bottom: -3px; }
.sel-union .br { right: -3px; bottom: -3px; }
```

`panels/canvas-stage.tsx` — JSX 里 `<SelectionOverlay />` 下面加一行，**其余一概不动**：

```tsx
        <SelectionOverlay />
        <SelectionBox />
```
顶部加 `import { SelectionBox } from "./selection-box.js";`

- [ ] **Step 7: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS。`canvas-stage-overlay.test.tsx` 里「canvas 与 `.marquee` 同父」的断言仍然成立（`SelectionBox` 也是 `.stage-inner` 的子节点）；`no-import-cycles.test.ts` 绿。

- [ ] **Step 8: 提交**

```bash
git add packages/web-psd/src/ui/overlay-geometry.ts packages/web-psd/src/ui/overlay-store.ts \
        packages/web-psd/src/ui/panels/selection-box.tsx packages/web-psd/src/ui/panels/selection-overlay.tsx \
        packages/web-psd/src/ui/panels/canvas-stage.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/selection-box.test.tsx
git commit -m "feat(web-psd): 画布上画出图层选中框与悬停框,rectStyle 连同契约注释抽为共享模块"
```

---

### Task 7: 树↔画布同步与「选中区域内的图层」（B 期）

**Files:**
- Modify: `packages/web-psd/src/ui/panels/layer-tree.tsx` · `panels/top-bar.tsx:33` · `panels/context-bar.tsx`
- Test: `packages/web-psd/tests/layer-tree.test.tsx`（追加）· `packages/web-psd/tests/selection.test.tsx`（追加）

**Interfaces:**
- Consumes: `expandAncestors` / `layersIntersecting`（hit-test.ts）、`setRegion`（store.ts）
- Produces: 无新导出。行为：任何一次图层选中都会展开祖先组并把该行滚进视野；context-bar 多一个「选中区域内的图层」按钮。

`flattenTree` 只渲染 `expanded` 里的组的子层，所以选中一个折叠组里的图层时，用户在树里根本看不到自己刚选的东西。**这今天就已经是 bug**：`top-bar.tsx:33` 的降级徽标跳转直接 `setState({ selection: [d.layerId] })`，如果那个图层在折叠组里，跳过去什么都不会发生。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/layer-tree.test.tsx` 的 `describe("LayerTree")` 里追加：

```tsx
  // flattenTree emits a group's children only when the group is expanded, so a
  // selection made anywhere else — the canvas, the degradation badge — lands on
  // a row that is not being rendered at all.
  it("expands the ancestors of a layer selected from outside the tree", () => {
    const { rerender } = render(<LayerTree />);
    expect(screen.queryByText("促销角标")).not.toBeInTheDocument();
    act(() => { selectLayer("badge"); });
    rerender(<LayerTree />);
    expect(getState().expanded.has("g")).toBe(true);
    expect(screen.getByText("促销角标")).toBeInTheDocument();
  });

  it("scrolls the selected row into view", () => {
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    setState({ selection: ["t"] });
    render(<LayerTree />);
    expect(into).toHaveBeenCalledWith({ block: "nearest" });
  });
```
顶部 import 补 `act`（来自 `@testing-library/react`）与 `selectLayer`（来自 `../src/ui/store.js`）。

`packages/web-psd/tests/selection.test.tsx` 的 `describe("ContextBar")` 里追加：

```tsx
  it("turns a region into the layers under it", () => {
    setState({
      region: rectRegion([0, 0, 30, 30]),
      doc: { canvas: { width: 100, height: 100 }, layers: [
        { id: "a", type: "raster", name: "a", opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 20, 20] },
        { id: "far", type: "raster", name: "far", opacity: 1, blendMode: "normal", visible: true, bounds: [80, 80, 99, 99] },
      ] },
    });
    render(<ContextBar />);
    fireEvent.click(screen.getByText("选中区域内的图层"));
    expect(getState().selection).toEqual(["a"]);
    // The two axes never clear each other (spec §3.3) — the region must survive
    // being read.
    expect(getState().region).not.toBeNull();
  });
```
顶部 import 补 `rectRegion`。

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/layer-tree.test.tsx tests/selection.test.tsx`
Expected: FAIL — `selectLayer is not a function`，以及 `Unable to find an element with the text: 选中区域内的图层`

- [ ] **Step 3: 在 store.ts 里加唯一的图层轴写入点**

```ts
/**
 * The one write point for the layer axis.
 *
 * Everything a selection has to drag along with it lives here rather than at
 * each call site: normalization (see hit-test.ts) and opening the tree far
 * enough that the newly selected row is actually rendered. The canvas, the
 * degradation badge and the tree itself all go through it.
 */
export function selectLayer(id: string, opts: { additive?: boolean } = {}): void {
  const s = getState();
  const selection = nextSelection(s, id, !!opts.additive);
  setState({
    selection,
    ...(s.doc ? { expanded: expandAncestors(s.doc.layers, id, s.expanded) } : {}),
  });
}

/** Replaces the layer axis outright (region → layers, Esc, click on empty
 *  canvas). Normalized for the same reason `selectLayer` is. */
export function setSelection(ids: string[]): void {
  const s = getState();
  setState({ selection: s.doc ? normalizeSelection(s.doc.layers, ids) : ids });
}
```
顶部 import 改成 `import { expandAncestors, normalizeSelection } from "./hit-test.js";`

- [ ] **Step 4: 三个写入点改用它**

`panels/layer-tree.tsx` 的行点击：
```tsx
      onClick={(e) => selectLayer(layer.id, { additive: e.metaKey || e.ctrlKey })}
```

`panels/top-bar.tsx:33` 的降级跳转：
```tsx
                        onClick={() => { selectLayer(d.layerId); setState({ pane: "props", degradeOpen: false }); }}
```

`panels/context-bar.tsx` 追加按钮（放在「清除选区」之前）：
```tsx
      {m ? (
        <button type="button" className="btn-link"
                onClick={() => setSelection(layersIntersecting(s.doc?.layers ?? [], m))}>选中区域内的图层</button>
      ) : null}
```

- [ ] **Step 5: 图层树的滚动**

`panels/layer-tree.tsx` 的 `LayerRow` 里加 ref 与 effect：

```tsx
function LayerRow({ layer, depth, hasChildren }: { layer: LocalLayer; depth: number; hasChildren: boolean }) {
  const s = useUiState();
  const selected = s.selection.includes(layer.id);
  const row = useRef<HTMLDivElement>(null);
  // A selection made on the canvas can land far outside the scrolled view.
  // `block: "nearest"` is a no-op when the row is already visible, so this
  // does not fight the user's own scrolling. Optional-called because jsdom
  // does not implement scrollIntoView.
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  ...
    <div className="tree-row" ref={row} ...>
```
顶部 import 加 `import { useEffect, useRef } from "react";`

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/web-psd/src/ui/store.ts packages/web-psd/src/ui/panels/ packages/web-psd/tests/
git commit -m "feat(web-psd): 选中图层自动展开祖先并滚动到该行,支持区域转图层"
```

---

### Task 8: 按 alpha 采样的命中判定（C 期，纯函数）

**Files:**
- Modify: `packages/doctype-psd/src/render/composite.ts:70`（加一个 `export`）· `packages/doctype-psd/src/engine.ts`（导出两个已有函数）
- Create: `packages/psd-client/src/layer-alpha.ts`
- Test: `packages/psd-client/tests/layer-alpha.test.ts`（新建）

**Interfaces:**
- Consumes: `Layer` / `Pixels` / `maskCoverageAt` / `findLayer`（`@unidocs/doctype-psd/engine`）
- Produces:
  ```ts
  export const HIT_ALPHA_THRESHOLD: number;              // 8/255
  export const MAX_CANDIDATES: number;                   // 8
  export type Rect = [number, number, number, number];
  export type ResidentPixels = (layer: Layer) => Pixels | null;
  export interface HitCandidate { layerId: string; path: string[] }
  export function residentOnly(layer: Layer): Pixels | null;
  export function layerBoxOf(layer: Layer): Rect | null;
  export function alphaAt(layer: Layer, x: number, y: number, resident: ResidentPixels, shapeOnly: boolean): number;
  export function hitInList(layers: Layer[], points: Array<[number, number]>, threshold: number,
                            resident: ResidentPixels, path?: string[], out?: HitCandidate[]): HitCandidate[];
  ```

命中判定按 spec §5.1 采用 **Worker 内按 alpha 采样**：与 Photoshop 的自动选择一致，代价是一次 postMessage 往返。**不做包围盒命中**——PSD 里「整画布尺寸、大部分透明」的图层是常态，包围盒命中会让用户点在空白处选中一个看不见的图层**并且把它拖走**。

这个模块**全同步、无 IO**：像素由调用方先 fault 进来（`prefetch()` 已经把所有图层烤热，取像素是缓存命中），所以判定本身可以在没有 store、没有 Worker 的情况下单测。

语义细则（spec §5.6）：

- **堆叠顺序**：`layers[0]` 最底，从数组末尾往前走，递归进组。
- **跳过**不可见图层与调整层（调整层作用于整个背景，永远不该被点中）。
- **锁定图层可命中、可选中**——这是 Photoshop 的行为；跳过它意味着用户点在一个明明看得见的图层上却选中了它背后的东西。**引擎里没有任何 op 检查 `locked`**，所以「不能编辑」必须由前端强制（Task 12）。
- **剪贴蒙版**在屏幕上被下方基底的 alpha 裁掉，但它自己的 alpha 在被裁掉的区域仍然非零，所以要与基底相与。基底 alpha 只取**形状**（自身 alpha × mask），不乘 opacity——与 `composite.ts:607` 的 `layerAlpha` 一致。
- **阈值** `8/255`，不取 0 是为了不被几乎透明的辉光边缘选中。

- [ ] **Step 1: 写失败的测试**

`packages/psd-client/tests/layer-alpha.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import type { Layer, Pixels } from "@unidocs/doctype-psd/engine";
import { alphaAt, hitInList, layerBoxOf, residentOnly, HIT_ALPHA_THRESHOLD } from "../src/layer-alpha.js";

function px(w: number, h: number, alpha: number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4 + 3] = alpha; }
  return { width: w, height: h, data };
}

const base = {
  type: "raster" as const, opacity: 1, blendMode: "normal" as const,
  visible: true, locked: false, clipping: false,
};

const raster = (id: string, bounds: [number, number, number, number], alpha: number, over: Partial<Layer> = {}): Layer => ({
  ...base, id, name: id, bounds,
  pixels: px(bounds[3] - bounds[1], bounds[2] - bounds[0], alpha),
  ...over,
});

const group = (id: string, children: Layer[], over: Partial<Layer> = {}): Layer =>
  ({ ...base, id, name: id, type: "group", bounds: [0, 0, 0, 0], children, ...over });

const at = (x: number, y: number): Array<[number, number]> => [[x, y]];

describe("alphaAt", () => {
  it("reads the layer's own alpha at a canvas point", () => {
    expect(alphaAt(raster("a", [10, 10, 20, 20], 255), 15, 15, residentOnly, false)).toBeCloseTo(1);
  });

  it("is zero outside the layer's bounds", () => {
    expect(alphaAt(raster("a", [10, 10, 20, 20], 255), 5, 5, residentOnly, false)).toBe(0);
  });

  it("multiplies opacity and fillOpacity, but not for a clip base's shape", () => {
    const l = raster("a", [0, 0, 10, 10], 255, { opacity: 0.5, fillOpacity: 0.5 });
    expect(alphaAt(l, 5, 5, residentOnly, false)).toBeCloseTo(0.25);
    expect(alphaAt(l, 5, 5, residentOnly, true)).toBeCloseTo(1);
  });

  it("multiplies the layer mask", () => {
    const l = raster("a", [0, 0, 10, 10], 255, {
      mask: { pixels: px(10, 10, 0), bounds: [0, 0, 10, 10], defaultColor: 0, inverted: false },
    });
    // The mask's channel 0 is 0 everywhere, so nothing shows through.
    expect(alphaAt(l, 5, 5, residentOnly, false)).toBe(0);
  });

  it("takes a group's alpha from its most opaque visible child", () => {
    const g = group("g", [raster("hidden", [0, 0, 10, 10], 255, { visible: false }), raster("b", [0, 0, 10, 10], 128)]);
    expect(alphaAt(g, 5, 5, residentOnly, false)).toBeCloseTo(128 / 255, 2);
  });

  it("is zero for an adjustment layer, which acts on the whole backdrop and can never be pointed at", () => {
    expect(alphaAt({ ...base, id: "adj", name: "adj", type: "adjustment", bounds: [0, 0, 10, 10] }, 5, 5, residentOnly, false)).toBe(0);
  });
});

describe("hitInList", () => {
  it("returns candidates topmost first — layers[0] is the BOTTOM of the document", () => {
    const layers = [raster("bottom", [0, 0, 10, 10], 255), raster("top", [0, 0, 10, 10], 255)];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["top", "bottom"]);
  });

  it("skips a transparent layer and finds the opaque one beneath it", () => {
    const layers = [raster("solid", [0, 0, 10, 10], 255), raster("clear", [0, 0, 10, 10], 0)];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["solid"]);
  });

  it("ignores an almost-transparent glow edge, which is what the threshold is for", () => {
    const layers = [raster("glow", [0, 0, 10, 10], 4)];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly)).toEqual([]);
  });

  it("reports a leaf inside a group with the full ancestor path", () => {
    const layers = [group("outer", [group("inner", [raster("deep", [0, 0, 10, 10], 255)])])];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly))
      .toEqual([{ layerId: "deep", path: ["outer", "inner", "deep"] }]);
  });

  it("still hits a locked layer — Photoshop selects it, it just cannot be edited", () => {
    const layers = [raster("locked", [0, 0, 10, 10], 255, { locked: true })];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["locked"]);
  });

  // A clipping layer is confined ON SCREEN to the alpha of the base below it,
  // but its OWN alpha stays non-zero where it is being clipped away — testing
  // it alone selects it in places the eye cannot see it.
  it("confines a clipping layer to the alpha of the base beneath it", () => {
    const layers = [
      raster("base", [0, 0, 10, 10], 255),
      raster("clip", [0, 0, 20, 20], 255, { clipping: true }),
    ];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["clip", "base"]);
    // (15,15) is inside `clip`'s own bounds but outside the base's, so the
    // clipped layer paints nothing there and must not be hittable.
    expect(hitInList(layers, at(15, 15), HIT_ALPHA_THRESHOLD, residentOnly)).toEqual([]);
  });

  it("accepts several sample points and takes the most opaque, which is the click tolerance", () => {
    const layers = [raster("thin", [0, 0, 10, 1], 255)];
    expect(hitInList(layers, [[5, 3]], HIT_ALPHA_THRESHOLD, residentOnly)).toEqual([]);
    expect(hitInList(layers, [[5, 3], [5, 0]], HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["thin"]);
  });
});

describe("layerBoxOf", () => {
  it("unions a group's visible children, since a PSD group reports 0,0,0,0", () => {
    expect(layerBoxOf(group("g", [raster("a", [10, 10, 20, 20], 255), raster("b", [40, 5, 50, 30], 255)])))
      .toEqual([10, 5, 50, 30]);
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/psd-client exec vitest run tests/layer-alpha.test.ts`
Expected: FAIL — `Failed to resolve import "../src/layer-alpha.js"`

- [ ] **Step 3: 从引擎导出两个已有函数**

`packages/doctype-psd/src/render/composite.ts:70`，只加一个关键字（函数体一字不动）：
```ts
export function maskCoverageAt(mask: Mask, cx: number, cy: number): number {
```

`packages/doctype-psd/src/engine.ts` 追加：
```ts
// Point-sampling helpers the browser hit test needs. Exported rather than
// re-implemented in psd-client: a second copy of the mask rules (defaultColor
// outside the rect, `inverted`) would drift from the compositor's, and then
// clicking would disagree with what is on screen.
export { maskCoverageAt } from "./render/composite.js";
export { findLayer } from "./model/tree.js";
```

- [ ] **Step 4: 写 `layer-alpha.ts`**

```ts
import type { Layer, Pixels } from "@unidocs/doctype-psd/engine";
import { maskCoverageAt } from "@unidocs/doctype-psd/engine";

export type Rect = [number, number, number, number];

/** Below this, a pixel does not count as hit. Not zero: the near-transparent
 *  outer edge of a glow covers a large area and selecting by it feels random. */
export const HIT_ALPHA_THRESHOLD = 8 / 255;

/** How deep the candidate stack under the cursor goes. Alt-cycling and the
 *  right-click list read it; past a handful it stops being a menu anyone can
 *  use, and a full-canvas background means the walk would otherwise never stop
 *  early. */
export const MAX_CANDIDATES = 8;

export interface HitCandidate {
  layerId: string;
  path: string[];
}

/** How the caller supplies already-decoded pixels. Everything in this module
 *  is synchronous; faulting lazy PixelRefs in is the caller's job (see
 *  RenderCore), which is what makes the rules here testable with no store. */
export type ResidentPixels = (layer: Layer) => Pixels | null;

/** For callers whose layers are already resident (tests, and any doc that was
 *  never lazy). */
export function residentOnly(layer: Layer): Pixels | null {
  const p = layer.pixels;
  return p && "data" in p ? (p as Pixels) : null;
}

/**
 * The rect a layer occupies. A PSD group is a section divider whose own
 * bounds are usually `0,0,0,0` — it is a render scope, not a spatial
 * container — so a group's extent has to come from its visible children.
 */
export function layerBoxOf(layer: Layer): Rect | null {
  if (!layer.children) return [...layer.bounds] as Rect;
  let box: Rect | null = null;
  for (const child of layer.children) {
    if (!child.visible) continue;
    const b = layerBoxOf(child);
    if (!b) continue;
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
  }
  return box;
}

/**
 * Coverage of one layer at one canvas pixel, 0..1.
 *
 * `shapeOnly` gives the CLIP BASE reading: a clipping mask is confined by the
 * base's transparency and mask but not by its opacity, matching
 * `composite.ts`'s `layerAlpha`. The hit reading (`shapeOnly === false`)
 * multiplies opacity and fillOpacity, because that is what the user can
 * actually see.
 */
export function alphaAt(layer: Layer, x: number, y: number, resident: ResidentPixels, shapeOnly: boolean): number {
  // An adjustment layer transforms the whole backdrop; there is no shape to
  // point at, and picking one by clicking would be an accident every time.
  if (layer.type === "adjustment") return 0;

  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let a = 0;

  if (layer.children) {
    for (const child of layer.children) {
      if (!child.visible) continue;
      a = Math.max(a, alphaAt(child, x, y, resident, false));
      if (a >= 1) break;
    }
  } else {
    const [top, left, bottom, right] = layer.bounds;
    if (cx < left || cx >= right || cy < top || cy >= bottom) return 0;
    const px = resident(layer);
    if (!px) return 0;
    const ix = cx - left;
    const iy = cy - top;
    if (ix < 0 || iy < 0 || ix >= px.width || iy >= px.height) return 0;
    a = px.data[(iy * px.width + ix) * 4 + 3] / 255;
  }

  if (a <= 0) return 0;
  if (layer.mask) a *= maskCoverageAt(layer.mask, cx, cy);
  if (shapeOnly) return a;
  return a * layer.opacity * (layer.fillOpacity ?? 1);
}

function maxAlpha(layer: Layer, points: Array<[number, number]>, resident: ResidentPixels, shapeOnly: boolean): number {
  let best = 0;
  for (const [x, y] of points) {
    best = Math.max(best, alphaAt(layer, x, y, resident, shapeOnly));
    if (best >= 1) break;
  }
  return best;
}

/** The nearest visible non-clipping layer below `i` — the base a run of
 *  clipping layers is confined to, same rule `renderList` applies. */
function clipBaseBelow(layers: Layer[], i: number): Layer | null {
  for (let j = i - 1; j >= 0; j--) {
    if (!layers[j].visible) continue;
    if (!layers[j].clipping) return layers[j];
  }
  return null;
}

/**
 * Every layer under `points`, topmost first.
 *
 * A stack rather than a single answer because one click landing on several
 * plausible layers is NORMAL in a PSD, not an edge case (spec §3.4): the
 * layers are a paint-order stack with arbitrary overlap, a background covers
 * the whole canvas, and one visual object is often four layers. Alt-cycling
 * and the right-click list are how the user disambiguates, and both read this
 * list — which the walk produces anyway.
 *
 * `points` carries the click tolerance: the caller passes the cursor plus a
 * few neighbours, and the most opaque sample wins. That has to be computed in
 * DOCUMENT pixels from a CSS-pixel constant, because at the 5% zoom floor
 * three CSS pixels are sixty document pixels.
 */
export function hitInList(
  layers: Layer[],
  points: Array<[number, number]>,
  threshold: number,
  resident: ResidentPixels,
  path: string[] = [],
  out: HitCandidate[] = [],
): HitCandidate[] {
  for (let i = layers.length - 1; i >= 0 && out.length < MAX_CANDIDATES; i--) {
    const layer = layers[i];
    if (!layer.visible || layer.type === "adjustment") continue;

    // A clipping layer paints only where the base below it does, but its own
    // alpha stays non-zero in the clipped-away part — judging it alone would
    // select it where nothing of it is visible.
    let confine = 1;
    if (layer.clipping) {
      const base = clipBaseBelow(layers, i);
      confine = base ? maxAlpha(base, points, resident, true) : 0;
      if (confine <= 0) continue;
    }

    if (maxAlpha(layer, points, resident, false) * confine < threshold) continue;

    // A group's coverage is its children's, so the group passing means at
    // least one child does. Descend rather than reporting the group: `path`
    // is what lets the caller choose a level (spec §8's click semantics).
    if (layer.children) hitInList(layer.children, points, threshold, resident, [...path, layer.id], out);
    else out.push({ layerId: layer.id, path: [...path, layer.id] });
  }
  return out;
}
```

- [ ] **Step 5: 跑测试确认变绿**

Run: `pnpm -C packages/psd-client exec vitest run tests/layer-alpha.test.ts && pnpm -C packages/doctype-psd test`
Expected: PASS —— doctype-psd 只多了两个 export，行为无变化

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/render/composite.ts packages/doctype-psd/src/engine.ts \
        packages/psd-client/src/layer-alpha.ts packages/psd-client/tests/layer-alpha.test.ts
git commit -m "feat(psd-client): 按 alpha 采样的命中判定,剪贴蒙版与基底相与"
```

---

### Task 9: `RenderCore` 的 `hitTest` 与 `layerAlphaRegion`（C 期）

**Files:**
- Modify: `packages/psd-client/src/render-core.ts`
- Test: `packages/psd-client/tests/render-core-hit.test.ts`（新建）

**Interfaces:**
- Consumes: `hitInList` / `alphaAt` / `layerBoxOf` / `HitCandidate` / `HIT_ALPHA_THRESHOLD`（layer-alpha.ts）、`resolvePixels` / `findLayer` / `isRef`（engine）
- Produces:
  ```ts
  hitTest(x: number, y: number, opts?: { threshold?: number; radius?: number }): Promise<HitCandidate[]>;
  layerAlphaRegion(layerId: string): Promise<{ bounds: Rect; data: Uint8ClampedArray } | null>;
  ```
  `data` 是 `bounds` 尺寸的**单通道** 0..255 覆盖度。

**不改 `IncrementalCompositor`，不合成任何东西。** `prefetch()` 已经把所有图层烤热，这里全是缓存命中，单次开销是若干次数组下标读取。`RenderCore` 现在（`render-core.ts:16`）把 `store` 和 `cache` 内联进构造函数就把引用丢了，改成存成字段。

已 fault 的像素表按 `this.doc` 的**对象身份**缓存：引擎每次编辑都 `structuredClone` 换掉整个 doc（`composite.ts` 自己就用这个当版本键），所以身份比较就是正确的失效条件。悬停每帧一次命中，这一条决定了它是一次 Map 身份比较还是一次全树遍历。

- [ ] **Step 1: 写失败的测试**

`packages/psd-client/tests/render-core-hit.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { encode } from "fast-png";
import type { BlobStore, Layer, PsdDoc } from "@unidocs/doctype-psd/engine";
import { RenderCore } from "../src/render-core.js";

const canvas = { width: 64, height: 64, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

function pngBytes(w: number, h: number, alpha: number): Uint8Array {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 200; data[i * 4 + 3] = alpha; }
  return encode({ width: w, height: h, data, channels: 4, depth: 8 });
}

function store(blobs: Record<string, Uint8Array>): BlobStore {
  return {
    async put(): Promise<string> { throw new Error("not implemented"); },
    async get(hash: string): Promise<Uint8Array | null> { return blobs[hash] ?? null; },
  };
}

const base = { type: "raster" as const, opacity: 1, blendMode: "normal" as const, visible: true, locked: false, clipping: false };

/** Two lazy layers: a full-canvas backdrop and a small opaque square on top. */
function lazyDoc(): PsdDoc {
  const layers: Layer[] = [
    { ...base, id: "bg", name: "bg", bounds: [0, 0, 64, 64], pixels: { width: 64, height: 64, hash: "h-bg" } },
    { ...base, id: "sq", name: "sq", bounds: [10, 10, 30, 30], pixels: { width: 20, height: 20, hash: "h-sq" } },
  ];
  return { canvas, layers };
}

const blobs = { "h-bg": pngBytes(64, 64, 255), "h-sq": pngBytes(20, 20, 255) };

describe("RenderCore.hitTest", () => {
  it("faults lazy pixels in and reports the top layer first", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect((await core.hitTest(15, 15)).map((h) => h.layerId)).toEqual(["sq", "bg"]);
  });

  it("reports only what is actually under the point", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect((await core.hitTest(50, 50)).map((h) => h.layerId)).toEqual(["bg"]);
  });

  // 3 CSS px is 60 document px at the 5% zoom floor, so the radius has to come
  // in per call rather than being a constant in document space.
  it("widens the sample by `radius`, in document pixels", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect((await core.hitTest(33, 20)).map((h) => h.layerId)).toEqual(["bg"]);
    expect((await core.hitTest(33, 20, { radius: 4 })).map((h) => h.layerId)).toEqual(["sq", "bg"]);
  });

  it("re-faults after the document is replaced, rather than serving the old pixel table", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect((await core.hitTest(15, 15)).map((h) => h.layerId)).toEqual(["sq", "bg"]);
    const next = lazyDoc();
    next.layers = [next.layers[0]];
    core.reset(next);
    expect((await core.hitTest(15, 15)).map((h) => h.layerId)).toEqual(["bg"]);
  });
});

describe("RenderCore.layerAlphaRegion", () => {
  it("returns coverage sized to the layer's box", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    const region = await core.layerAlphaRegion("sq");
    expect(region?.bounds).toEqual([10, 10, 30, 30]);
    expect(region?.data).toHaveLength(20 * 20);
    expect(region?.data[0]).toBe(255);
  });

  it("scales the coverage by the layer's opacity", async () => {
    const doc = lazyDoc();
    doc.layers[1].opacity = 0.5;
    const core = new RenderCore(doc, store(blobs));
    const region = await core.layerAlphaRegion("sq");
    expect(region?.data[0]).toBe(128);
  });

  it("returns null for a layer that is not in the document", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect(await core.layerAlphaRegion("ghost")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/psd-client exec vitest run tests/render-core-hit.test.ts`
Expected: FAIL — `core.hitTest is not a function`

- [ ] **Step 3: 改 `render-core.ts`**

顶部 import 改成：
```ts
import type { BlobStore, Layer, Pixels, PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";
import {
  DEFAULT_CACHE_BYTES, IncrementalCompositor, PixelCache, findLayer, isRef, resolvePixels,
} from "@unidocs/doctype-psd/engine";
import {
  HIT_ALPHA_THRESHOLD, alphaAt, hitInList, layerBoxOf,
  type HitCandidate, type Rect, type ResidentPixels,
} from "./layer-alpha.js";
```

构造函数改成保留引用，并追加两个方法：

```ts
export class RenderCore {
  private readonly compositor: IncrementalCompositor;
  // Kept as fields rather than only being handed to the compositor: the hit
  // test reads single pixels out of the same warm cache, and inlining these
  // into the constructor call threw the references away.
  private readonly store: BlobStore;
  private readonly cache: PixelCache;
  // Decoded pixels, keyed by layer id, valid for exactly one document object.
  // Every edit REPLACES the doc (applyOne structuredClones it), so object
  // identity is the version key — the compositor uses the same trick for its
  // framebuffer slot. Without this, a hover hit test at 60fps would re-walk
  // and re-resolve the whole tree every frame.
  private resident = new Map<string, Pixels>();
  private residentFor: PsdDoc | null = null;

  constructor(doc: PsdDoc, store: BlobStore, opts: { tileSize?: number; cacheBytes?: number } = {}) {
    this.store = store;
    this.cache = new PixelCache(opts.cacheBytes ?? DEFAULT_CACHE_BYTES);
    this.compositor = new IncrementalCompositor(doc, {
      tileSize: opts.tileSize,
      ctx: { store, cache: this.cache },
    });
  }
```

（`applyOp` / `prefetch` / `reset` / `tile` / `composite` / `doc` / `tileSize` 一字不动。）

类末尾追加：

```ts
  /** Faults every layer's pixels to resident once per document version, then
   *  hands `layer-alpha`'s synchronous rules a plain lookup. Cache hits after
   *  `prefetch()`, so this is table reads, not network. */
  private async residentPixels(): Promise<ResidentPixels> {
    if (this.residentFor !== this.doc) {
      const map = new Map<string, Pixels>();
      const walk = async (layers: Layer[]): Promise<void> => {
        for (const l of layers) {
          if (l.pixels) map.set(l.id, isRef(l.pixels) ? await resolvePixels(l.pixels, this.store, this.cache) : l.pixels);
          if (l.children) await walk(l.children);
        }
      };
      await walk(this.doc.layers);
      this.resident = map;
      this.residentFor = this.doc;
    }
    const map = this.resident;
    return (layer: Layer) => map.get(layer.id) ?? null;
  }

  /**
   * Every layer under the point, topmost first — [] on a miss.
   *
   * `radius` is the click tolerance IN DOCUMENT PIXELS; the caller converts it
   * from a CSS-pixel constant, because at the 5% zoom floor three CSS pixels
   * span sixty document pixels and a fixed document-space tolerance would make
   * small things unclickable when zoomed out.
   *
   * Nothing is composited here and `IncrementalCompositor` is untouched.
   */
  async hitTest(x: number, y: number, opts: { threshold?: number; radius?: number } = {}): Promise<HitCandidate[]> {
    const resident = await this.residentPixels();
    const r = Math.max(0, Math.round(opts.radius ?? 0));
    const points: Array<[number, number]> = r > 0
      ? [[x, y], [x - r, y], [x + r, y], [x, y - r], [x, y + r]]
      : [[x, y]];
    return hitInList(this.doc.layers, points, opts.threshold ?? HIT_ALPHA_THRESHOLD, resident);
  }

  /**
   * A layer's alpha as a single-channel coverage buffer over its own box —
   * "load layer as selection" (spec §6.1), the conversion that lets someone
   * point at a THING and get back an AREA.
   *
   * Same read path as `hitTest`; the only difference is copying the whole
   * block out instead of sampling one point.
   */
  async layerAlphaRegion(layerId: string): Promise<{ bounds: Rect; data: Uint8ClampedArray } | null> {
    const layer = findLayer(this.doc.layers, layerId);
    if (!layer) return null;
    const bounds = layerBoxOf(layer);
    if (!bounds) return null;
    const resident = await this.residentPixels();
    const [top, left, bottom, right] = bounds;
    const w = Math.max(0, right - left);
    const h = Math.max(0, bottom - top);
    const data = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        data[y * w + x] = Math.round(255 * alphaAt(layer, left + x, top + y, resident, false));
      }
    }
    return { bounds, data };
  }
```

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm -C packages/psd-client test && pnpm -C packages/psd-client typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/psd-client/src/render-core.ts packages/psd-client/tests/render-core-hit.test.ts
git commit -m "feat(psd-client): RenderCore 支持 alpha 命中与载入图层 alpha 为区域"
```

---

### Task 10: Worker 协议与可丢弃的悬停请求（C 期）

**Files:**
- Create: `packages/psd-client/src/request-queue.ts`
- Modify: `packages/psd-client/src/render-worker.ts:17-29,46-144` · `src/render-client.ts`
- Test: `packages/psd-client/tests/request-queue.test.ts`（新建）

**Interfaces:**
- Consumes: `HitCandidate` / `Rect`（layer-alpha.ts）、`RenderCore.hitTest` / `layerAlphaRegion`
- Produces:
  ```ts
  // request-queue.ts
  export interface QueueHooks<Req> {
    run(req: Req): Promise<void>;
    drop(req: Req): void;          // settle a request that will never run
    discardable(req: Req): boolean;
  }
  export function createRequestQueue<Req>(hooks: QueueHooks<Req>): { submit(req: Req): void };

  // render-worker.ts — 协议追加
  | { type: "hitTest"; id: number; x: number; y: number; radius: number; threshold?: number; hover?: boolean }
  | { type: "layerAlpha"; id: number; layerId: string }
  | { type: "hit"; id: number; hits: HitCandidate[] }
  | { type: "layerAlpha"; id: number; bounds: Rect | null; width: number; height: number; data: Uint8ClampedArray }

  // render-client.ts
  hitTest(x: number, y: number, opts: { radius: number; threshold?: number; hover?: boolean }): Promise<HitCandidate[]>;
  layerAlpha(layerId: string): Promise<{ bounds: Rect; width: number; height: number; data: Uint8ClampedArray } | null>;
  ```

**悬停命中必须是可丢弃的，否则会和瓦片抢队列。** `render-worker.ts:131` 今天是一条 `queue = queue.then(...)` 的**单串行链**——所有请求严格按到达顺序处理。悬停每帧一次，平移或缩放时瓦片批次正在排队，悬停请求插在中间，两边互相拖慢。

分级（spec §5.8）：

| 请求 | 排队规则 |
| --- | --- |
| `applyOp` | 必须排队，不可丢（它是文档状态） |
| 显式点击命中 | 必须排队，不可丢（用户在等结果） |
| **悬停命中** | **可丢弃**：队列里已有未完成的悬停请求就**替换**而不是追加；有别的活在飞时直接跳过这一帧 |

丢掉一帧悬停高亮没有任何代价——下一帧就补上了。而让它排在一批瓦片后面，代价是高亮迟到几百毫秒。

**被丢弃的请求仍然必须回一条响应**：`RenderClient` 按 id 存 pending，不回就永远留在 Map 里，调用方的 promise 也永远不 settle。

- [ ] **Step 1: 写失败的测试**

`packages/psd-client/tests/request-queue.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createRequestQueue } from "../src/request-queue.js";

interface Req { id: number; hover?: boolean }

function harness() {
  const started: number[] = [];
  const dropped: number[] = [];
  const gates = new Map<number, () => void>();
  const queue = createRequestQueue<Req>({
    run: (req) => { started.push(req.id); return new Promise<void>((resolve) => gates.set(req.id, resolve)); },
    drop: (req) => { dropped.push(req.id); },
    discardable: (req) => !!req.hover,
  });
  const finish = async (id: number): Promise<void> => { gates.get(id)!(); await Promise.resolve(); await Promise.resolve(); };
  return { queue, started, dropped, finish };
}

describe("createRequestQueue", () => {
  it("runs non-discardable requests strictly in arrival order, one at a time", async () => {
    const h = harness();
    h.queue.submit({ id: 1 });
    h.queue.submit({ id: 2 });
    expect(h.started).toEqual([1]);
    await h.finish(1);
    expect(h.started).toEqual([1, 2]);
  });

  // Tiles and hover both go through one worker. A hover point that is already
  // stale by the time its turn comes is worth nothing; the frame after it is
  // the answer anyone actually sees.
  it("replaces a waiting hover request instead of appending it", async () => {
    const h = harness();
    h.queue.submit({ id: 1 });               // real work, in flight
    h.queue.submit({ id: 2, hover: true });
    h.queue.submit({ id: 3, hover: true });
    expect(h.started).toEqual([1]);
    expect(h.dropped).toEqual([2]);          // superseded, and settled
    await h.finish(1);
    expect(h.started).toEqual([1, 3]);
  });

  it("runs a hover request immediately when nothing else is queued", () => {
    const h = harness();
    h.queue.submit({ id: 9, hover: true });
    expect(h.started).toEqual([9]);
  });

  // A rejected handler must not poison the chain: one bad message would
  // otherwise wedge the worker for the rest of the session.
  it("keeps draining after a request rejects", async () => {
    const started: number[] = [];
    const queue = createRequestQueue<Req>({
      run: async (req) => { started.push(req.id); if (req.id === 1) throw new Error("boom"); },
      drop: () => {}, discardable: () => false,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    queue.submit({ id: 1 });
    queue.submit({ id: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/psd-client exec vitest run tests/request-queue.test.ts`
Expected: FAIL — `Failed to resolve import "../src/request-queue.js"`

- [ ] **Step 3: 写 `request-queue.ts`**

```ts
/**
 * The render Worker's message queue: strictly serial, with one discardable
 * slot.
 *
 * Serial because the Worker holds ONE resident RenderCore — letting an async
 * handler's `await` points interleave two mutations of it (or race an applyOp
 * against a tile read mid-composite) is the bug this replaced a bare
 * `onmessage` to avoid.
 *
 * The discardable slot exists because hover hit tests arrive once per frame
 * and would otherwise queue behind a whole batch of tiles during a pan: at
 * most ONE hover request waits, a newer one replaces it, and it only runs
 * when nothing else is in flight. Losing a frame of hover highlight costs
 * nothing — the next frame supplies it — while arriving several hundred
 * milliseconds late is exactly what it feels like.
 *
 * A superseded request is handed to `drop` rather than forgotten: callers
 * hold a promise keyed by request id, and one that is never answered is a
 * leaked map entry plus a promise that never settles.
 */
export interface QueueHooks<Req> {
  run(req: Req): Promise<void>;
  drop(req: Req): void;
  discardable(req: Req): boolean;
}

export function createRequestQueue<Req>(hooks: QueueHooks<Req>): { submit(req: Req): void } {
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;
  let waiting: Req | null = null;

  const flush = (): void => {
    const req = waiting;
    waiting = null;
    if (req) enqueue(req);
  };

  const enqueue = (req: Req): void => {
    inFlight++;
    chain = chain
      .then(() => hooks.run(req))
      // `run` already reports every request-scoped failure to its own caller,
      // so this is a backstop for anything escaping it. Without it a rejection
      // would propagate into `chain` and every future request chained onto it
      // would be skipped — one bad message wedging the Worker for good.
      .catch((err) => { console.error("request-queue: unhandled error draining queue", err); })
      .then(() => {
        inFlight--;
        if (inFlight === 0) flush();
      });
  };

  return {
    submit(req: Req): void {
      if (!hooks.discardable(req)) { enqueue(req); return; }
      if (waiting) hooks.drop(waiting);
      waiting = req;
      if (inFlight === 0) flush();
    },
  };
}
```

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm -C packages/psd-client exec vitest run tests/request-queue.test.ts`
Expected: PASS

- [ ] **Step 5: 扩 Worker 协议**

`packages/psd-client/src/render-worker.ts`：

顶部 import 追加 `import type { HitCandidate, Rect as AlphaRect } from "./layer-alpha.js";`（`Rect` 本文件已有同名局部类型，用别名避免撞名）。

`WorkerRequest` 追加两支：
```ts
  | { type: "hitTest"; id: number; x: number; y: number; radius: number; threshold?: number; hover?: boolean }
  | { type: "layerAlpha"; id: number; layerId: string };
```

`WorkerResponse` 追加两支：
```ts
  | { type: "hit"; id: number; hits: HitCandidate[] }
  | { type: "layerAlpha"; id: number; bounds: AlphaRect | null; width: number; height: number; data: Uint8ClampedArray };
```

`handle` 的 switch 追加两个 case：
```ts
    case "hitTest": {
      try {
        if (!core) throw new Error("render-worker: received hitTest before init");
        post({ type: "hit", id: req.id, hits: await core.hitTest(req.x, req.y, { radius: req.radius, threshold: req.threshold }) });
      } catch (err) {
        post({ type: "error", id: req.id, message: errorMessage(err) });
      }
      break;
    }
    case "layerAlpha": {
      try {
        if (!core) throw new Error("render-worker: received layerAlpha before init");
        const region = await core.layerAlphaRegion(req.layerId);
        if (!region) {
          post({ type: "layerAlpha", id: req.id, bounds: null, width: 0, height: 0, data: new Uint8ClampedArray(0) });
          break;
        }
        const [top, left, bottom, right] = region.bounds;
        // A fresh buffer, because `region.data` may be a view over the
        // persistent PixelCache's storage and transferring detaches it here —
        // same reason the tiles branch copies.
        const data = new Uint8ClampedArray(region.data);
        post({ type: "layerAlpha", id: req.id, bounds: region.bounds, width: right - left, height: bottom - top, data }, [data.buffer]);
      } catch (err) {
        post({ type: "error", id: req.id, message: errorMessage(err) });
      }
      break;
    }
```

文件末尾的手写队列整块替换成：
```ts
const queue = createRequestQueue<WorkerRequest>({
  run: (req) => handle(req),
  // A hover request that never runs still owes its caller an answer: the
  // client keeps one pending entry per id, and an unanswered one is a leaked
  // map entry and a promise that never settles.
  drop: (req) => { if (req.type === "hitTest") post({ type: "hit", id: req.id, hits: [] }); },
  // Only hover hit tests. `applyOp` is document state and a click is a user
  // waiting for an answer — neither may be skipped.
  discardable: (req) => req.type === "hitTest" && !!req.hover,
});

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue.submit(ev.data);
};
```
顶部 import 追加 `import { createRequestQueue } from "./request-queue.js";`

- [ ] **Step 6: 扩 `render-client.ts`**

`PendingEntry` 追加两支：
```ts
  | { kind: "hitTest"; resolve: (hits: HitCandidate[]) => void; reject: (e: unknown) => void }
  | { kind: "layerAlpha"; resolve: (v: LayerAlphaResult | null) => void; reject: (e: unknown) => void };
```
并在文件顶部：
```ts
import type { HitCandidate, Rect as AlphaRect } from "./layer-alpha.js";
export interface LayerAlphaResult { bounds: AlphaRect; width: number; height: number; data: Uint8ClampedArray }
```

`handleMessage` 的 switch 追加：
```ts
      case "hit": {
        const entry = this.pending.get(msg.id);
        if (entry?.kind === "hitTest") entry.resolve(msg.hits);
        this.pending.delete(msg.id);
        break;
      }
      case "layerAlpha": {
        const entry = this.pending.get(msg.id);
        if (entry?.kind === "layerAlpha") {
          entry.resolve(msg.bounds ? { bounds: msg.bounds, width: msg.width, height: msg.height, data: msg.data } : null);
        }
        this.pending.delete(msg.id);
        break;
      }
```

类里追加两个方法：
```ts
  /** Every layer under the point, topmost first. `radius` is the click
   *  tolerance in DOCUMENT pixels — the caller converts it from CSS pixels,
   *  which is zoom-dependent. `hover: true` marks the request DISCARDABLE:
   *  the Worker replaces a waiting one and skips it while real work is in
   *  flight, resolving the skipped one with `[]`. */
  hitTest(x: number, y: number, opts: { radius: number; threshold?: number; hover?: boolean }): Promise<HitCandidate[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "hitTest", resolve, reject });
      const req: WorkerRequest = { type: "hitTest", id, x, y, radius: opts.radius, threshold: opts.threshold, hover: opts.hover };
      this.worker.postMessage(req);
    });
  }

  /** One layer's alpha as a single-channel coverage buffer over its own box;
   *  null when the layer is gone or has no extent. */
  layerAlpha(layerId: string): Promise<LayerAlphaResult | null> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "layerAlpha", resolve, reject });
      const req: WorkerRequest = { type: "layerAlpha", id, layerId };
      this.worker.postMessage(req);
    });
  }
```

- [ ] **Step 7: 跑全量测试与类型检查**

Run: `pnpm -C packages/psd-client test && pnpm -C packages/psd-client typecheck`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add packages/psd-client/src/request-queue.ts packages/psd-client/src/render-worker.ts \
        packages/psd-client/src/render-client.ts packages/psd-client/tests/request-queue.test.ts
git commit -m "feat(psd-client): Worker 支持命中与图层 alpha 请求,悬停请求可丢弃不占队列"
```

---

### Task 11: 异步命中与「按下即选、同一手势直接拖」（C 期）

**Files:**
- Modify: `packages/web-psd/src/doc-controller.ts`（`pickColor` 之后追加）· `src/ui/panels/canvas-stage.tsx:95-139`
- Test: `packages/web-psd/tests/hit-race.test.tsx`（新建）

**Interfaces:**
- Consumes: `RenderClient.hitTest`、`layerBox` / `findLayer` / `Hit`（hit-test.ts）、`selectLayer` / `setSelection`（store.ts）
- Produces:
  - `DocController.hitTest(clientX: number, clientY: number, opts?: { hover?: boolean }): Promise<Hit[]>`
  - `canvas-stage.tsx` 的移动工具：按在图层上直接选中并在同一次手势里拖走（今天要求「先去树里选中再回画布拖」，`canvas-stage.tsx:103`）

Worker 往返 20–30ms，这期间用户已经移动了十几个像素，甚至可能已经松手。**光处理 `setPointerCapture` 是不够的**，还要定死 await 期间到达的 `pointermove` / `pointerup` 怎么办。两种写错的方式：拿 hit **返回那一刻**的坐标当 `drag.from`（图层会跳一下，跳过 await 期间累积的位移）；`pointerup` 先于 hit 落地（drag 在手势结束**之后**才建立，表现为「松手了图层还跟着鼠标走」）。

写死的顺序（spec §5.3）：

```
pointerdown  同步：记 anchor（此刻的文档坐标）、setPointerCapture
             同步：pending = { anchor, alive: true, latest: anchor, … }
             异步：hitTest(anchor)

pointermove  pending 还在 → 只更新 pending.latest，不派发任何 op
             drag 已建立 → 走正常的 translateOps 路径

pointerup    pending 还在 → pending.alive = false（保留对象，等 hit 回来收尾）
             drag 已建立 → 正常结束

hit 落地     !pending.alive → 整个丢弃：这是一次点击不是拖动，只更新选中
             命中为空     → 清空图层集
             否则         → 以 pending.anchor（按下那一刻）为 drag.from 建立 drag，
                           并立刻按 pending.latest 补上累积位移，一次性发出
```

关键是**用按下那一刻的 anchor 而不是 hit 返回时的坐标**——这样图层的总位移永远等于手指的总位移。

容差按 spec §7.5 的「甲」写法：两次 `toCanvas` 相减，不给 `DocController` 加 `ratio()`。容差每次手势只算一次，不在热路径上，不值得为它扩接口。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/hit-race.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { getState, setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const { dispatch, hitTest } = vi.hoisted(() => ({ dispatch: vi.fn(), hitTest: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    hitTest,
  }),
  dispatch,
}));

// See canvas-stage-drag.test.tsx: jsdom 25 has no PointerEvent constructor, so
// a MouseEvent named "pointer*" is what carries clientX/Y to React's handlers.
const pointer = (type: string, clientX: number, clientY: number): MouseEvent =>
  new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });

const leaf = (id: string): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 100, 100] });

/** Hands back a hit only when `settle()` is called, so the test can drive the
 *  exact interleaving a 20–30ms worker round trip produces. */
function deferredHit(hits: unknown) {
  let settle = (): void => {};
  hitTest.mockImplementation(() => new Promise((resolve) => { settle = () => resolve(hits); }));
  return async (): Promise<void> => { settle(); await Promise.resolve(); await Promise.resolve(); };
}

beforeEach(() => {
  dispatch.mockClear();
  hitTest.mockReset();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "move", region: null, selection: [], pickedColor: null,
    doc: { canvas: { width: 100, height: 100 }, layers: [leaf("a")] },
  });
});

const totalDx = (): number => dispatch.mock.calls
  .map((args) => (args[0].payload.op as { translate: [number, number] }).translate[0])
  .reduce((a: number, b: number) => a + b, 0);

describe("async hit + press-to-drag", () => {
  it("dispatches nothing while the hit test is still in flight", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    expect(dispatch).not.toHaveBeenCalled();
    await settle();
    expect(getState().selection).toEqual(["a"]);
  });

  // Using the coordinate the hit came back AT would swallow the movement made
  // during the round trip and the layer would visibly jump behind the cursor.
  it("moves the layer by the FULL finger travel once the hit lands", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    await settle();
    expect(totalDx()).toBe(12);
    fireEvent(stage, pointer("pointermove", 30, 10));
    expect(totalDx()).toBe(20);
  });

  it("degrades to a plain click when the pointer is released before the hit lands", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    fireEvent(stage, pointer("pointerup", 22, 10));
    await settle();
    expect(getState().selection).toEqual(["a"]);
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent(stage, pointer("pointermove", 40, 10));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("clears the layer axis on a miss and leaves the region alone", async () => {
    setState({ selection: ["a"], region: { bounds: [0, 0, 10, 10], source: "rect", maskId: null } });
    const settle = deferredHit([]);
    const { container } = render(<CanvasStage />);
    fireEvent(container.querySelector("div.stage")!, pointer("pointerdown", 90, 90));
    await settle();
    expect(getState().selection).toEqual([]);
    expect(getState().region).not.toBeNull();
  });

  it("drags the existing selection with no round trip when the press is inside it", () => {
    setState({ selection: ["a"] });
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 15, 10));
    expect(hitTest).not.toHaveBeenCalled();
    expect(totalDx()).toBe(5);
  });
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/hit-race.test.tsx`
Expected: FAIL — `dispatch` 从未被调用、`selection` 仍为 `[]`

- [ ] **Step 3: 给 `DocController` 加 `hitTest`**

`packages/web-psd/src/doc-controller.ts`，紧接 `pickColor` 之后：

```ts
  /** Click leniency, in CSS pixels. Converted to document pixels per call
   *  because the zoom floor is 5% (see the zoom design), where 3 CSS px is 60
   *  document px — a tolerance written in document pixels would make small
   *  things unclickable zoomed out and select the wrong thing zoomed in. */
  private static readonly HIT_TOLERANCE_CSS_PX = 3;

  /**
   * Every layer under the cursor, topmost first — [] on a miss or before a
   * document is open.
   *
   * The conversion is two `toCanvas` calls subtracted rather than a new
   * `ratio()` accessor: it happens once per gesture, not in a hot loop, and
   * `toCanvas` is already the one mapping the marquee, the drag and the
   * eyedropper share, so nothing here can disagree with them about which
   * pixel the cursor is over.
   *
   * `hover: true` marks the request discardable in the Worker's queue — a
   * stale hover point is worthless and must not sit in front of a tile batch.
   */
  async hitTest(clientX: number, clientY: number, opts: { hover?: boolean } = {}): Promise<Hit[]> {
    if (!this.renderClient) return [];
    const at = this.toCanvas(clientX, clientY);
    const wide = this.toCanvas(clientX + DocController.HIT_TOLERANCE_CSS_PX, clientY);
    return this.renderClient.hitTest(at.x, at.y, { radius: Math.abs(wide.x - at.x), hover: opts.hover });
  }
```
顶部 import 追加 `import type { Hit } from "./ui/hit-test.js";`

> `Hit` 与 psd-client 的 `HitCandidate` 结构相同（`{ layerId, path }`）；web-psd 刻意不依赖 doc type，所以两边各有一份结构等价的声明，与 `LocalLayer` 镜像 `Layer` 的做法一致。

- [ ] **Step 4: 改 `canvas-stage.tsx` 的三个指针函数**

**只改这三个函数体和顶部 import**，文件头注释、两个 `useEffect`、`useLayoutEffect`、`normalise()`、`canvasBoxStyle()` 一字不动。

顶部 import 追加：
```ts
import { findLayer, layerBox, type Hit } from "../hit-test.js";
import { rectRegion } from "../region.js";
import { setRegion, setSelection, nextSelection } from "../store.js";
```

在 `drag` ref 旁边加一个：
```ts
  // The gesture that is waiting on an async hit test. A ref, not state, for
  // the same reason `drag` is: it changes mid-gesture and must not re-render.
  const pending = useRef<PendingHit | null>(null);
```

三个函数替换成：

```tsx
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c) return;
    const s = getState();
    if (s.tool === "eyedrop") {
      setState({ pickedColor: c.pickColor(e.clientX, e.clientY) });
      return;
    }
    if (s.tool === "move") {
      const at = c.toCanvas(e.clientX, e.clientY);
      e.currentTarget.setPointerCapture(e.pointerId);
      // Pressing inside the existing selection continues to drag it, with no
      // round trip — the gesture the user is most likely to repeat stays
      // instant. A box test is enough here BECAUSE it cannot select anything:
      // it only decides whether to keep dragging what is already selected.
      // (Today's code drags on `selection.length > 0` with no position test at
      // all, so this is strictly narrower.)
      if (s.selection.length > 0 && insideSelection(s, at)) {
        drag.current = { layerIds: [...s.selection], from: at, last: at };
        return;
      }
      const p: PendingHit = {
        anchor: at, latest: at, pointerId: e.pointerId, alive: true,
        additive: e.shiftKey, leaf: e.metaKey || e.ctrlKey,
      };
      pending.current = p;
      void c.hitTest(e.clientX, e.clientY).then((hits) => settleHit(p, hits));
      return;
    }
    if (s.tool === "marquee") {
      anchor.current = c.toCanvas(e.clientX, e.clientY);
      setRegion(null);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c) return;
    if (drag.current) {
      const to = c.toCanvas(e.clientX, e.clientY);
      const ops = translateOps(drag.current, to);
      for (const op of ops) void dispatch(op);
      // Advance `last` by the WHOLE PIXELS actually dispatched, not to `to`:
      // otherwise the sub-pixel remainder translateOps discarded would be lost
      // on every frame and the layer would drift behind the cursor.
      const [dx, dy] = (ops[0]?.payload.op as { translate: [number, number] } | undefined)?.translate ?? [0, 0];
      drag.current = { ...drag.current, last: { x: drag.current.last.x + dx, y: drag.current.last.y + dy } };
      return;
    }
    // The hit test has not come back yet: record where the finger is and
    // dispatch NOTHING. Moving from the hit's own coordinate later would drop
    // everything travelled during the round trip.
    if (pending.current) {
      pending.current.latest = c.toCanvas(e.clientX, e.clientY);
      return;
    }
    if (!anchor.current) return;
    setRegion(rectRegion(normalise(anchor.current, c.toCanvas(e.clientX, e.clientY), getState().doc?.canvas ?? null)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Released before the hit landed: keep the object so the late result can
    // finish it off as a CLICK. Dropping it here instead would leave the
    // layer following the cursor after the button was let go.
    if (pending.current) pending.current.alive = false;
    if (!drag.current && !anchor.current && !pending.current) return;
    drag.current = null;
    anchor.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const settleHit = (p: PendingHit, hits: Hit[]): void => {
    if (pending.current !== p) return;   // a newer gesture already superseded this one
    pending.current = null;
    const s = getState();
    const hit = hits[0] ?? null;
    if (!hit) {
      // Clearing the LAYER axis only. The region survives: the two axes are
      // written by different tools and never clear each other (spec §3.3).
      setSelection([]);
      return;
    }
    const id = p.leaf ? hit.path[hit.path.length - 1] : hit.path[0];
    const selection = nextSelection({ ...s, selection: p.additive ? s.selection : [] }, id, p.additive);
    setState({ selection });
    if (!p.alive) return;                // it was a click, not a drag
    const c = getController();
    if (!c) return;
    // `drag.from` is where the finger went DOWN, and the whole distance
    // travelled since is applied in one go — so the layer's total movement
    // always equals the finger's, however long the round trip took.
    const started: DragState = { layerIds: selection, from: p.anchor, last: p.anchor };
    const ops = translateOps(started, p.latest);
    for (const op of ops) void dispatch(op);
    const [dx, dy] = (ops[0]?.payload.op as { translate: [number, number] } | undefined)?.translate ?? [0, 0];
    drag.current = { ...started, last: { x: p.anchor.x + dx, y: p.anchor.y + dy } };
  };
```

文件末尾（`canvasBoxStyle` 之后）追加两个小东西：

```ts
/** A gesture whose hit test has not answered yet. */
interface PendingHit {
  anchor: { x: number; y: number };
  latest: { x: number; y: number };
  pointerId: number;
  /** False once the pointer has been released — the late hit then resolves as
   *  a click rather than starting a drag. */
  alive: boolean;
  additive: boolean;
  leaf: boolean;
}

/** Whether a press lands within the boxes of the current selection. Used only
 *  to decide "keep dragging what is already selected", never to select
 *  anything — box-level hit testing is exactly what §5.1 rules out as a way
 *  to pick a layer, because a full-canvas mostly-transparent layer is the
 *  norm in a PSD. */
function insideSelection(s: ReturnType<typeof getState>, at: { x: number; y: number }): boolean {
  if (!s.doc) return false;
  for (const id of s.selection) {
    const layer = findLayer(s.doc.layers, id);
    const box = layer ? layerBox(layer) : null;
    if (box && at.y >= box[0] && at.x >= box[1] && at.y < box[2] && at.x < box[3]) return true;
  }
  return false;
}
```

- [ ] **Step 5: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS。`canvas-stage-drag.test.tsx` 现在选中的是 `["a"]` 且 mock 的 `getController` 没有 `hitTest`——它按下的点在 `a` 的包围盒内，走 `insideSelection` 的同步分支，行为不变。若该测试的 `doc` 没有 `layers`，给它补上一个 `bounds` 覆盖全画布的图层。

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/src/doc-controller.ts packages/web-psd/src/ui/panels/canvas-stage.tsx \
        packages/web-psd/tests/hit-race.test.tsx packages/web-psd/tests/canvas-stage-drag.test.tsx
git commit -m "feat(web-psd): 画布按下即选并在同一手势直接拖动,异步命中不丢位移"
```

---

### Task 12: 点击语义与锁定图层（C 期）

**Files:**
- Modify: `packages/web-psd/src/ui/hit-test.ts`（追加两个纯函数）· `src/ui/panels/canvas-stage.tsx`（`settleHit` + 双击处理器）· `src/ui/app.tsx`（Esc）· `src/ui/panels/context-bar.tsx`（锁定提示）
- Test: `packages/web-psd/tests/hit-test.test.ts`（追加）· `packages/web-psd/tests/canvas-stage-select.test.tsx`（新建）

**Interfaces:**
- Produces:
  ```ts
  export function clickTarget(layers: LocalLayer[], path: string[],
                              canvas: { width: number; height: number }, maxFraction?: number): string;
  export function descendPath(path: string[], current: string): string;
  export function draggableIds(layers: LocalLayer[], ids: string[]): string[];
  ```

| 操作 | 写哪个轴 | 结果 |
| --- | --- | --- |
| 移动工具单击图层 | 图层 | 选中命中路径的**最外层组**（`path[0]`），见下面的降级 |
| 双击 | 图层 | 沿 `path` 下探一级 |
| ⌘ / Ctrl + 单击 | 图层 | 直接选中叶子（`path` 末位） |
| Shift + 单击 | 图层 | 加选 / 减选 |
| 移动工具单击空白 | 图层 | 清空**图层集**，区域不动 |
| Esc | 两个 | 都清空 |

**「选最外层组」的降级：`layerBox(path[0])` 面积超过画布 80% 时下探一级**（必要时递归）。PSD 里「所有内容装在一个总组里」很常见，这时选最外层组等于选中一切——选中框贴着画布边框、零信息量，而且一拖就平移整篇文档。用面积阈值而不是「是否唯一顶层组」，因为一个占满画布的背景组和一个总组对用户是同一个体验问题。

**锁定图层可选中但不能拖。** 已核实**引擎里没有任何 op 检查 `locked`**（它只是 `layer-ops.ts:11` 的 `SETTABLE_PROPS` 里一个可写属性，没有任何地方读它来阻止编辑），所以「拖动时不产生 op」**必须由前端强制**，不能指望后端拒绝。另：`psd/load.ts:308` 导入时硬编码 `locked: false`，只有属性面板的复选框能置位，所以今天它几乎恒为 false——语义先定对，免得以后反着改。

- [ ] **Step 1: 写失败的纯函数测试**

`packages/web-psd/tests/hit-test.test.ts` 追加：

```ts
describe("clickTarget", () => {
  const canvas = { width: 100, height: 100 };
  const tree = [group("root", [group("mid", [leaf("deep", [10, 10, 20, 20])])])];

  it("selects the outermost group, the Figma semantics", () => {
    const shallow = [group("g", [leaf("a", [10, 10, 20, 20])]), leaf("b", [0, 0, 5, 5])];
    expect(clickTarget(shallow, ["g", "a"], canvas)).toBe("g");
  });

  // "Everything in one root group" is common in a PSD. Selecting it puts the
  // box flush against the canvas edge — no information at all — and dragging
  // translates the entire document.
  it("descends past a group that covers most of the canvas", () => {
    const wide = [group("root", [leaf("bg", [0, 0, 100, 100]), leaf("a", [10, 10, 20, 20])])];
    expect(clickTarget(wide, ["root", "a"], canvas)).toBe("a");
  });

  it("keeps descending while each level is still too big, stopping at the leaf", () => {
    const nested = [group("root", [group("mid", [leaf("full", [0, 0, 100, 100])])])];
    expect(clickTarget(nested, ["root", "mid", "full"], canvas)).toBe("full");
  });

  it("returns the leaf when the path has no groups in it", () => {
    expect(clickTarget(tree, ["deep"], canvas)).toBe("deep");
  });
});

describe("descendPath", () => {
  it("moves one level deeper on each call and stops at the leaf", () => {
    expect(descendPath(["a", "b", "c"], "a")).toBe("b");
    expect(descendPath(["a", "b", "c"], "b")).toBe("c");
    expect(descendPath(["a", "b", "c"], "c")).toBe("c");
  });

  it("starts at the outermost level when the current id is not on the path", () => {
    expect(descendPath(["a", "b", "c"], "elsewhere")).toBe("a");
  });
});

describe("draggableIds", () => {
  it("drops locked layers, which nothing in the engine refuses on its own", () => {
    const layers = [leaf("free", [0, 0, 5, 5]), leaf("pinned", [0, 0, 5, 5], { locked: true })];
    expect(draggableIds(layers, ["free", "pinned"])).toEqual(["free"]);
  });

  it("treats a group as locked when the group itself is", () => {
    const layers = [group("g", [leaf("a", [0, 0, 5, 5])], { locked: true })];
    expect(draggableIds(layers, ["g"])).toEqual([]);
  });
});
```
顶部 import 追加 `clickTarget, descendPath, draggableIds`。

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/hit-test.test.ts`
Expected: FAIL — `clickTarget is not a function`

- [ ] **Step 3: 在 `hit-test.ts` 追加三个纯函数**

```ts
/**
 * Which level of a hit path a plain click should select.
 *
 * The default is the OUTERMOST group (Figma's semantics), because PSD group
 * nesting is usually deep and landing on a leaf four levels in is rarely what
 * someone means by clicking a picture.
 *
 * With one caveat: a PSD where everything sits in a single root group is
 * common, and selecting that group selects the whole document — a box flush
 * with the canvas edge carrying no information, that translates the entire
 * file when dragged. So a level covering more than `maxFraction` of the
 * canvas is skipped, repeatedly, down to the leaf if need be. The test is
 * AREA rather than "is it the only top-level group", because a background
 * group filling the canvas is the same experience for the user.
 */
export function clickTarget(
  layers: LocalLayer[],
  path: string[],
  canvas: { width: number; height: number },
  maxFraction = 0.8,
): string {
  const area = canvas.width * canvas.height;
  for (let i = 0; i < path.length - 1; i++) {
    const layer = findLayer(layers, path[i]);
    const box = layer ? layerBox(layer) : null;
    if (!box) continue;
    const covered = Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
    if (area <= 0 || covered / area <= maxFraction) return path[i];
  }
  return path[path.length - 1];
}

/** One level deeper along `path` than whatever is selected now — the
 *  double-click gesture. Stays put at the leaf, and starts from the outermost
 *  level if the current selection is not on this path at all. */
export function descendPath(path: string[], current: string): string {
  const i = path.indexOf(current);
  if (i < 0) return path[0];
  return path[Math.min(i + 1, path.length - 1)];
}

/**
 * The subset of `ids` that may actually be edited.
 *
 * Locked layers stay selectable — that is Photoshop's behaviour, and skipping
 * them would mean clicking a plainly visible layer and selecting the thing
 * behind it, which is more confusing than not being able to move it. But NO
 * op in the engine checks `locked` (it is only a writable property in
 * `layer-ops.ts`'s SETTABLE_PROPS; nothing reads it to refuse an edit), so
 * "does not move" has to be enforced here — the server will not do it.
 */
export function draggableIds(layers: LocalLayer[], ids: string[]): string[] {
  return ids.filter((id) => !findLayer(layers, id)?.locked);
}
```

- [ ] **Step 4: 写画布点击语义的测试**

`packages/web-psd/tests/canvas-stage-select.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { App } from "../src/ui/app.js";
import { getState, setState } from "../src/ui/store.js";
import { rectRegion } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";

const { dispatch, hitTest } = vi.hoisted(() => ({ dispatch: vi.fn(), hitTest: vi.fn() }));
// `vi.mock` replaces the WHOLE module, so every export any rendered component
// imports has to be here — the Escape tests below render <App />, and
// `top-bar.tsx:3` imports `exportUrl` and `openFile`. Leaving them out gives
// an undefined-is-not-a-function throw from a component that has nothing to
// do with selection.
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    hitTest,
  }),
  dispatch,
  exportUrl: () => null,
  openFile: vi.fn(),
}));

// See canvas-stage-drag.test.tsx: jsdom 25 has no PointerEvent constructor, so
// a MouseEvent named "pointer*" is what carries clientX/Y to React's handlers.
const pointer = (type: string, clientX: number, clientY: number, init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true, ...init });

const leaf = (id: string, bounds: [number, number, number, number], over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds, ...over });

/** Lets the awaited hit settle before assertions: the handler chains two
 *  microtasks (the hitTest promise, then `.then`). */
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

const stageOf = (container: HTMLElement): Element => container.querySelector("div.stage")!;

beforeEach(() => {
  dispatch.mockClear();
  hitTest.mockReset();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "move", region: null, selection: [], pickedColor: null, expanded: new Set(),
    doc: { canvas: { width: 100, height: 100 }, layers: [
      { id: "g", type: "group", name: "g", opacity: 1, blendMode: "normal", visible: true,
        bounds: [0, 0, 0, 0], children: [leaf("a", [10, 10, 30, 30])] },
      leaf("b", [60, 60, 70, 70]),
    ] },
  });
});

describe("click semantics", () => {
  it("selects the outermost group on a plain click", async () => {
    hitTest.mockResolvedValue([{ layerId: "a", path: ["g", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointerdown", 15, 15));
    await flush();
    expect(getState().selection).toEqual(["g"]);
  });

  it("selects the leaf on ⌘-click", async () => {
    hitTest.mockResolvedValue([{ layerId: "a", path: ["g", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointerdown", 15, 15, { metaKey: true }));
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  it("adds on shift-click", async () => {
    setState({ selection: ["b"] });
    hitTest.mockResolvedValue([{ layerId: "a", path: ["g", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointerdown", 15, 15, { shiftKey: true }));
    await flush();
    expect(getState().selection).toEqual(["b", "g"]);
  });

  // A root group covering the whole canvas is common in PSDs; selecting it
  // gives a box flush with the canvas edge and drags the entire document.
  it("descends past a group that covers most of the canvas", async () => {
    setState({ doc: { canvas: { width: 100, height: 100 }, layers: [
      { id: "root", type: "group", name: "root", opacity: 1, blendMode: "normal", visible: true,
        bounds: [0, 0, 0, 0], children: [leaf("bg", [0, 0, 100, 100]), leaf("a", [10, 10, 30, 30])] },
    ] } });
    hitTest.mockResolvedValue([{ layerId: "a", path: ["root", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointerdown", 15, 15));
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  it("descends one level on double click", async () => {
    setState({ selection: ["g"] });
    hitTest.mockResolvedValue([{ layerId: "a", path: ["g", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent.doubleClick(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  // No op in the engine checks `locked` — it is only a writable property — so
  // if the front end does not refuse the drag, nothing will.
  it("selects a locked layer but dispatches no op when dragging it", async () => {
    setState({ doc: { canvas: { width: 100, height: 100 }, layers: [leaf("p", [0, 0, 50, 50], { locked: true })] } });
    hitTest.mockResolvedValue([{ layerId: "p", path: ["p"] }]);
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    fireEvent(stage, pointer("pointerdown", 15, 15));
    fireEvent(stage, pointer("pointermove", 40, 15));
    await flush();
    expect(getState().selection).toEqual(["p"]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("Escape", () => {
  it("clears both axes, which is the one gesture that does", () => {
    setState({ selection: ["b"], region: rectRegion([0, 0, 10, 10]) });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(getState().selection).toEqual([]);
    expect(getState().region).toBeNull();
  });

  it("is ignored while typing — Escape in the composer is not a deselect", () => {
    setState({ selection: ["b"] });
    const { container } = render(<App />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(getState().selection).toEqual(["b"]);
  });
});
```

- [ ] **Step 5: 接进 `canvas-stage.tsx`**

`settleHit` 里选 id 的那一行换成：
```ts
    const s2 = getState();
    const id = p.leaf
      ? hit.path[hit.path.length - 1]
      : clickTarget(s2.doc?.layers ?? [], hit.path, s2.doc?.canvas ?? { width: 0, height: 0 });
```
建立 drag 的那一句改成只带可拖的 id，并在全被锁定时不进入拖动：
```ts
    const movable = draggableIds(s2.doc?.layers ?? [], selection);
    if (movable.length === 0) return;    // locked: selected, but nothing to move (the engine will not refuse it for us)
    const started: DragState = { layerIds: movable, from: p.anchor, last: p.anchor };
```

双击处理器（JSX 上加 `onDoubleClick={onDoubleClick}`）：
```tsx
  // Descends one level into the group the last click selected. Uses the same
  // candidate stack as the click, so the two can never disagree about which
  // path the cursor is on.
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c || getState().tool !== "move") return;
    void c.hitTest(e.clientX, e.clientY).then((hits) => {
      const hit = hits[0];
      if (!hit) return;
      setSelection([descendPath(hit.path, getState().selection[0] ?? "")]);
    });
  };
```

- [ ] **Step 6: Esc 与锁定提示**

`packages/web-psd/src/ui/app.tsx` 的 `useZoomShortcuts` 旁边加一个，并在 `App()` 里调用：

```tsx
/**
 * Escape clears BOTH axes at once — the one gesture that does, because it is
 * the "never mind" key and leaving half a target behind is exactly what it is
 * for. Everything else leaves the other axis alone (spec §3.3).
 *
 * Bound on `window`, and ignored while typing: Escape in the chat composer is
 * not a request to drop the selection.
 */
function useSelectionShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      setSelection([]);
      setRegion(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
```

`panels/context-bar.tsx` 在 `ctx-path` 之后加一条提示：
```tsx
      {sel.length > 0 && sel.every((l) => l.locked) ? <span className="mono ctx-size">已锁定</span> : null}
```

- [ ] **Step 7: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add packages/web-psd/src/ui/hit-test.ts packages/web-psd/src/ui/panels/canvas-stage.tsx \
        packages/web-psd/src/ui/app.tsx packages/web-psd/src/ui/panels/context-bar.tsx \
        packages/web-psd/tests/hit-test.test.ts packages/web-psd/tests/canvas-stage-select.test.tsx
git commit -m "feat(web-psd): 画布点击语义 —— 选最外层组并按面积降级,双击下探,锁定图层不产生 op"
```

---

### Task 13: 悬停高亮与消歧（C 期）

**Files:**
- Create: `packages/web-psd/src/ui/panels/hit-menu.tsx`
- Modify: `packages/web-psd/src/ui/panels/canvas-stage.tsx` · `src/ui/styles.css`
- Test: `packages/web-psd/tests/hit-menu.test.tsx`（新建）

**Interfaces:**
- Consumes: `DocController.hitTest`、`setHoverId`（overlay-store.ts）、`selectLayer`（store.ts）
- Produces: `<HitMenu />`（右键候选列表）；`canvas-stage.tsx` 多一个 `onContextMenu`

> 这一步把 §2 规则 2 的「只改三个指针函数体 + JSX 加一行」放宽到「加一个 `onContextMenu` 与一行 `<HitMenu />`」。刻意记在这里：菜单本体在自己的文件里，`canvas-stage.tsx` 只多两处接线。

按 §3.4，一次点击命中多个「都说得通」的图层是 PSD 的常态，不是边缘情况。所以画布点击是**便捷方式**，图层树才是主要仪器，并且必须提供消歧手段：

- **Alt + 单击循环**光标下的图层栈（第二次点同一处取下一个候选，到底后回到最上）；
- **右键列出**光标下所有命中的图层，让用户直接挑。

候选栈就是 `hitTest` 已经返回的那一串，不需要额外计算。**不做「智能猜测用户想要哪一层」**——猜错的代价（选中了看不见的东西并且拖动了它）远大于多点一次。

悬停用 `requestAnimationFrame` 节流，且**只在移动工具下跑**；请求带 `hover: true`，在 Worker 队列里可丢弃（Task 10）。命中结果进 `overlay-store.ts` 而不是主 store，否则每帧重渲染整棵图层树。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/hit-menu.test.tsx`（mock、`pointer()`、`leaf()`、`flush()`、`stageOf()` 与 `canvas-stage-select.test.tsx` 同款，照抄）：

```tsx
describe("HitMenu", () => {
  const stack = [
    { layerId: "top", path: ["g", "top"] },
    { layerId: "bg", path: ["bg"] },
  ];

  // One click landing on several plausible layers is the normal case in a PSD,
  // so the whole stack is offered instead of the code guessing.
  it("lists every candidate under the cursor, topmost first", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    const items = [...container.querySelectorAll(".hit-menu button")].map((b) => b.textContent);
    expect(items).toEqual(["top", "bg"]);
  });

  it("selects the one that is clicked and closes", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    fireEvent.click(container.querySelectorAll(".hit-menu button")[1]);
    expect(getState().selection).toEqual(["bg"]);
    expect(container.querySelector(".hit-menu")).toBeNull();
  });

  it("closes on Escape without changing the selection", async () => {
    setState({ selection: ["b"] });
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".hit-menu")).toBeNull();
    expect(getState().selection).toEqual(["b"]);
  });

  it("renders nothing when the cursor is over empty canvas", async () => {
    hitTest.mockResolvedValue([]);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 90, clientY: 90 });
    await flush();
    expect(container.querySelector(".hit-menu")).toBeNull();
  });
});
```

> `hit-menu.test.tsx` 里的 Escape 用例与 `canvas-stage-select.test.tsx` 的 Escape 用例不冲突：这里渲染的是 `<CanvasStage />`，没有挂 `useSelectionShortcuts`，所以只有菜单自己的监听器在。

`packages/web-psd/tests/canvas-stage-select.test.tsx` 追加：

```tsx
describe("disambiguation and hover", () => {
  const stack = [
    { layerId: "a", path: ["a"] },
    { layerId: "b", path: ["b"] },
    { layerId: "c", path: ["c"] },
  ];

  // Not "guess which layer they meant": being wrong there means selecting
  // something invisible and then dragging it, which costs far more than one
  // extra click.
  it("cycles the candidate stack on repeated alt-clicks at the same point", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    for (const expected of [["a"], ["b"], ["c"], ["a"]]) {
      fireEvent(stage, pointer("pointerdown", 15, 15, { altKey: true }));
      fireEvent(stage, pointer("pointerup", 15, 15));
      await flush();
      expect(getState().selection).toEqual(expected);
    }
  });

  it("restarts the cycle at a different point", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    fireEvent(stage, pointer("pointerdown", 15, 15, { altKey: true }));
    fireEvent(stage, pointer("pointerup", 15, 15));
    await flush();
    fireEvent(stage, pointer("pointerdown", 15, 15, { altKey: true }));
    fireEvent(stage, pointer("pointerup", 15, 15));
    await flush();
    expect(getState().selection).toEqual(["b"]);

    fireEvent(stage, pointer("pointerdown", 65, 65, { altKey: true }));
    fireEvent(stage, pointer("pointerup", 65, 65));
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  // The main store notifies every subscriber, so a per-frame hover there would
  // re-render the whole layer tree (store.ts:106).
  it("writes the hovered id to the overlay store and leaves the main store alone", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    hitTest.mockResolvedValue([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const before = getState();
    fireEvent(stageOf(container), pointer("pointermove", 15, 15));
    await flush();
    expect(getHoverId()).toBe("a");
    expect(getState()).toBe(before);
  });

  it("clears the hover when the tool changes away from move", async () => {
    const { rerender } = render(<CanvasStage />);
    act(() => { setHoverId("a"); setState({ tool: "marquee" }); });
    rerender(<CanvasStage />);
    expect(getHoverId()).toBeNull();
  });
});
```
顶部 import 追加 `act`（`@testing-library/react`）与 `getHoverId, setHoverId`（`../src/ui/overlay-store.js`）。

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/hit-menu.test.tsx tests/canvas-stage-select.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/ui/panels/hit-menu.js"`

- [ ] **Step 3: 悬停接线**

`canvas-stage.tsx` 顶部加：
```ts
import { setHoverId } from "../overlay-store.js";
```
组件里加一个 rAF 节流的 ref：
```ts
  // Hover hit tests are throttled to one per frame and only run under the move
  // tool. The result goes to overlay-store, NOT the main store: the main store
  // notifies every subscriber, so a per-frame hover would re-render the whole
  // layer tree (store.ts:106).
  const hoverFrame = useRef(0);
```
`onPointerMove` 末尾（`anchor.current` 分支之前，`drag` / `pending` 分支之后）插入：
```ts
    if (getState().tool === "move" && !anchor.current && hoverFrame.current === 0) {
      const { clientX, clientY } = e;
      hoverFrame.current = requestAnimationFrame(() => {
        hoverFrame.current = 0;
        void c.hitTest(clientX, clientY, { hover: true }).then((hits) => setHoverId(hits[0]?.layerId ?? null));
      });
    }
```
`onPointerUp` 与工具切换时清掉：在组件里加
```ts
  useEffect(() => {
    if (s.tool !== "move") setHoverId(null);
    return () => { if (hoverFrame.current !== 0) cancelAnimationFrame(hoverFrame.current); };
  }, [s.tool]);
```

- [ ] **Step 4: Alt 循环**

`canvas-stage.tsx` 里加一个 ref 与 `settleHit` 的分支：
```ts
  // Where the last alt-click landed and how deep into that point's candidate
  // stack it had got. Keyed by the rounded document coordinate so moving away
  // and coming back starts over rather than resuming somewhere arbitrary.
  const cycle = useRef<{ key: string; index: number } | null>(null);
```
`onPointerDown` 的 move 分支里，`PendingHit` 加一个 `cycle: e.altKey` 字段；`settleHit` 在取 id 之前插入：
```ts
    if (p.cycle) {
      const key = `${Math.round(p.anchor.x)},${Math.round(p.anchor.y)}`;
      const index = cycle.current?.key === key ? (cycle.current.index + 1) % hits.length : 0;
      cycle.current = { key, index };
      setSelection([hits[index].layerId]);
      return;
    }
```

- [ ] **Step 5: 写 `hit-menu.tsx`**

```tsx
import { useEffect } from "react";
import { findLayer, type Hit } from "../hit-test.js";
import { setSelection, useUiState } from "../store.js";

/**
 * The candidate list for a right-click.
 *
 * One click landing on several plausible layers is the NORMAL case in a PSD,
 * not an edge case (spec §3.4): layers are a paint-order stack with arbitrary
 * overlap and one visual object is often several of them. Rather than guessing
 * which one was meant — where being wrong means selecting something invisible
 * and then dragging it — the whole stack is offered, topmost first.
 */
export function HitMenu({ at, hits, onClose }: {
  at: { x: number; y: number } | null;
  hits: Hit[];
  onClose: () => void;
}) {
  const s = useUiState();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!at || hits.length === 0) return null;
  return (
    <div className="hit-menu" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      {hits.map((h) => (
        <button key={h.layerId} type="button"
                onClick={() => { setSelection([h.layerId]); onClose(); }}>
          {findLayer(s.doc?.layers ?? [], h.layerId)?.name ?? h.layerId}
        </button>
      ))}
    </div>
  );
}
```

`canvas-stage.tsx` 加状态与处理器（本地 `useState`，因为它只属于这个组件，不是应用状态）。顶部 import 补 `useState` 与 `HitMenu`：
```tsx
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { HitMenu } from "./hit-menu.js";
```
```tsx
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; hits: Hit[] } | null>(null);
  ...
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c || getState().tool !== "move") return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const at = { x: e.clientX - box.left + e.currentTarget.scrollLeft, y: e.clientY - box.top + e.currentTarget.scrollTop };
    void c.hitTest(e.clientX, e.clientY).then((hits) => setMenu(hits.length ? { at, hits } : null));
  };
```
JSX：`.stage` 上加 `onContextMenu={onContextMenu}`，并在 `.stage` 内（`.stage-inner` 之外）加
```tsx
      <HitMenu at={menu?.at ?? null} hits={menu?.hits ?? []} onClose={() => setMenu(null)} />
```
`onPointerDown` 开头加一行 `if (menu) setMenu(null);`——点画布任何地方都关掉菜单。

> 菜单用**测量得到的 CSS 像素**定位，不是百分比：它是 chrome，不是画布上的几何（契约第 3 条），必须钉在光标处而不是随缩放漂移。测量发生在**事件处理器**里，布局已经稳定（契约第 4 条），这正是 `toScreen` 类测量被允许的场合。

`styles.css` 末尾追加：
```css
.hit-menu {
  position: absolute; z-index: 3; min-width: 120px; padding: 4px;
  display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 6px 20px rgb(0 0 0 / .12);
}
.hit-menu button {
  border: 0; background: transparent; font: inherit; text-align: left;
  padding: 5px 8px; border-radius: 5px; cursor: pointer; color: var(--fg-1);
}
.hit-menu button:hover { background: var(--surface-sunken); }
```

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/web-psd typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/web-psd/src/ui/panels/hit-menu.tsx packages/web-psd/src/ui/panels/canvas-stage.tsx \
        packages/web-psd/src/ui/styles.css packages/web-psd/tests/hit-menu.test.tsx \
        packages/web-psd/tests/canvas-stage-select.test.tsx
git commit -m "feat(web-psd): 悬停高亮与消歧 —— Alt 循环候选栈、右键列出光标下所有图层"
```

---

### Task 14: 载入图层 alpha 为选区（C 期）

**Files:**
- Modify: `packages/web-psd/src/ui/region.ts`（追加 mask 字节表）· `src/ui/store.ts`（`setRegion` 加清扫）· `src/doc-controller.ts` · `src/ui/panels/context-bar.tsx`
- Test: `packages/web-psd/tests/region.test.ts`（追加）· `packages/web-psd/tests/selection.test.tsx`（追加）

**Interfaces:**
- Consumes: `RenderClient.layerAlpha`（Task 10）
- Produces:
  - `region.ts`: `putMask(bytes: Uint8ClampedArray): string` · `getMask(id: string | null): Uint8ClampedArray | null` · `sweepMasks(keep: string | null): void`
  - `DocController.layerAlphaRegion(layerId: string): Promise<{ bounds: Rect; data: Uint8ClampedArray } | null>`
  - context-bar 的「载入为选区」按钮

Photoshop 里 ⌘ 点图层缩略图。**用户指着一个「东西」，拿到一块「区域」，然后说「把这个重新生成」**——这一针把 §3.4 的两个结论缝上了：图层不好指，但图层可以用来**生产**好指的区域。

这是 `maskBytes` 表的**第一个真实使用者**——比 D 期的套索更早，所以 §4.1 那个句柄结构不是为将来预留。字节表放在模块作用域而不是全局 store：`store.ts:106` 的注释写明订阅的是整个 state 对象，一个满画布 mask 是 12MB 的 `Uint8ClampedArray`，挂上去意味着 `resetState`、每个测试里的 state 快照（`store.test.ts` 的 `beforeEach` 手写了整个 INITIAL）、以及将来任何 state 序列化都要专门绕过它。

- [ ] **Step 1: 写失败的测试**

`packages/web-psd/tests/region.test.ts` 追加：

```ts
describe("mask table", () => {
  it("hands back a handle and the bytes behind it", () => {
    const id = putMask(new Uint8ClampedArray([1, 2, 3]));
    expect(getMask(id)).toEqual(new Uint8ClampedArray([1, 2, 3]));
    expect(getMask(null)).toBeNull();
  });

  // Only one region exists at a time, so only one mask can be reachable. The
  // bytes are megabytes each; leaving the old one behind is a leak that grows
  // by a full canvas on every load.
  it("drops every mask except the one still in use", () => {
    const stale = putMask(new Uint8ClampedArray([1]));
    const live = putMask(new Uint8ClampedArray([2]));
    sweepMasks(live);
    expect(getMask(stale)).toBeNull();
    expect(getMask(live)).not.toBeNull();
  });
});
```

`packages/web-psd/tests/selection.test.tsx` 的 `ContextBar` 里追加：

```tsx
  it("turns the selected layer into a region carrying its alpha", async () => {
    setState({ selection: ["a"], doc: { canvas: { width: 100, height: 100 }, layers: [
      { id: "a", type: "raster", name: "a", opacity: 1, blendMode: "normal", visible: true, bounds: [10, 10, 12, 12] },
    ] } });
    render(<ContextBar />);
    fireEvent.click(screen.getByText("载入为选区"));
    await Promise.resolve(); await Promise.resolve();
    const region = getState().region!;
    expect(region.bounds).toEqual([10, 10, 12, 12]);
    expect(region.source).toBe("layerAlpha");
    expect(getMask(region.maskId)).toEqual(new Uint8ClampedArray([1, 2, 3, 4]));
    // The layer axis is untouched — the two conversions ADD an axis, they do
    // not swap one for the other (spec §3.3).
    expect(getState().selection).toEqual(["a"]);
  });
```

`selection.test.tsx` 顶部的 mock 补一个 **`loadLayerAsRegion`**（注意：context-bar 调的是 `ui/controller.js` 的这个转发函数，不是 `DocController.layerAlphaRegion`——后者低一层，这个文件的 `vi.mock` 够不着）。它自己写 store，所以 mock 要给一个真实现的替身而不是空 spy：

```ts
vi.mock("../src/ui/controller.js", () => ({
  dispatch: (op: unknown) => dispatch(op),
  getController: () => ({ pickColor, toCanvas: (x: number, y: number) => ({ x, y }) }),
  loadLayerAsRegion: async (): Promise<void> => {
    const { setRegion } = await import("../src/ui/store.js");
    const { putMask } = await import("../src/ui/region.js");
    setRegion({ bounds: [10, 10, 12, 12], source: "layerAlpha", maskId: putMask(new Uint8ClampedArray([1, 2, 3, 4])) });
  },
}));
```
顶部 import 补 `getMask`（`../src/ui/region.js`）。

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm -C packages/web-psd exec vitest run tests/region.test.ts tests/selection.test.tsx`
Expected: FAIL — `putMask is not a function`

- [ ] **Step 3: 在 `region.ts` 追加字节表**

```ts
/**
 * Per-pixel coverage for regions that are not rectangles, keyed by the handle
 * their `Region` carries.
 *
 * Module scope, deliberately NOT part of `UiState`. The store notifies every
 * subscriber on every change and is snapshotted whole by tests; a full-canvas
 * mask is a 12MB Uint8ClampedArray, and putting it in there would mean
 * `resetState`, every test's hand-written INITIAL and any future state
 * serialization all having to route around it.
 *
 * Buffer layout: `bounds`-sized, one byte per pixel, 0..255, row-major.
 */
const maskBytes = new Map<string, Uint8ClampedArray>();
let nextMaskId = 1;

export function putMask(bytes: Uint8ClampedArray): string {
  const id = `m${nextMaskId++}`;
  maskBytes.set(id, bytes);
  return id;
}

export function getMask(id: string | null): Uint8ClampedArray | null {
  return id ? maskBytes.get(id) ?? null : null;
}

/** Exactly one region exists at a time, so exactly one mask is reachable.
 *  Called from `setRegion`, which is the only place a region is written. */
export function sweepMasks(keep: string | null): void {
  for (const id of [...maskBytes.keys()]) if (id !== keep) maskBytes.delete(id);
}
```

`store.ts` 的 `setRegion` 补一行：
```ts
export function setRegion(region: Region | null): void {
  setState({ region });
  sweepMasks(region?.maskId ?? null);
}
```
顶部 import 补 `sweepMasks`。

- [ ] **Step 4: `DocController.layerAlphaRegion`**

`packages/web-psd/src/doc-controller.ts`，`hitTest` 之后：
```ts
  /** One layer's alpha as a coverage buffer over its own box — the layer →
   *  region conversion (spec §6.1). Same read path in the Worker as the hit
   *  test; the only difference is copying the block out rather than sampling
   *  a point. */
  async layerAlphaRegion(layerId: string): Promise<{ bounds: Rect; data: Uint8ClampedArray } | null> {
    if (!this.renderClient) return null;
    const r = await this.renderClient.layerAlpha(layerId);
    return r ? { bounds: r.bounds as Rect, data: r.data } : null;
  }
```

`controller.ts` 加一个薄转发（面板不直接摸 `DocController`），顶部 import 补 `import { setRegion } from "./store.js";` 与 `import { putMask } from "./region.js";`：
```ts
export async function loadLayerAsRegion(layerId: string): Promise<void> {
  const r = await controller?.layerAlphaRegion(layerId);
  if (!r) return;
  setRegion({ bounds: r.bounds, source: "layerAlpha", maskId: putMask(r.data) });
}
```

- [ ] **Step 5: context-bar 入口**

两条转换都放在 context-bar，**不进工具条**——它们是**动作**，不是工具（spec §6.3）：
```tsx
      {sel.length === 1 ? (
        <button type="button" className="btn-link"
                onClick={() => void loadLayerAsRegion(sel[0].id)}>载入为选区</button>
      ) : null}
```

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm -C packages/web-psd test && pnpm -C packages/psd-client test && pnpm -C packages/doctype-psd test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/web-psd/src/ui/region.ts packages/web-psd/src/ui/store.ts \
        packages/web-psd/src/doc-controller.ts packages/web-psd/src/ui/controller.ts \
        packages/web-psd/src/ui/panels/context-bar.tsx packages/web-psd/tests/
git commit -m "feat(web-psd): 载入图层 alpha 为选区,mask 字节走模块级表不进全局 store"
```

---

## 收尾

- [ ] **全量验证**

```bash
pnpm -r test && pnpm -r typecheck
```

- [ ] **手动验收**（`pnpm -C packages/web-psd dev`，按 spec §3.2 的四种组合各走一遍）

1. 空白首屏点画布、切工具、按 Esc——不崩（无文档态是默认首屏，不是边缘情况）。
2. 打开 PSD：画布上按住一个图层直接拖走；⌘ 点进叶子；双击下探；Alt 反复点同一处循环；右键列出候选。
3. 框一块 → composer 出现「已附带选区」chip → 发一句「把框中的这块换成晚霞」→ 在 `/run` 的请求体里看到 `<<selection bounds=[…]>>`。
4. 摘掉 chip 再发一次——请求体里没有标记，且选区仍在画布上。
5. 「裁到选区」之后覆盖层消失（不是错位）；打开第二个文档，两个轴都空。
6. 选一个图层 →「载入为选区」→ 选区外框贴着该图层。
7. 25% 与 400% 下选中框、悬停框、手柄粗细一致，位置不漂。

- [ ] **更新 spec 的状态行**，标注 0/A/B/C 期已落地、D 期待设计，然后推分支。

## 与 spec 的对照

| spec | 落在 |
| --- | --- |
| §3.1–3.3 两个轴、空是默认值、工具写轴 | Task 2（`describeTarget` 四种组合）、Task 11（点空白只清图层集） |
| §3.6 失效策略 | Task 3 |
| §4.1 `Region` 结构与 mask 不进 store | Task 2（句柄）、Task 14（字节表） |
| §4.3 送给 agent 的地址与三条约束 | Task 4 |
| §5.1 命中分级（不做包围盒命中） | Task 8 |
| §5.2 异步接口 | Task 5（类型）、Task 11（`DocController.hitTest`） |
| §5.3 竞态状态机 | Task 11 |
| §5.4 选中集归一化 | Task 5 |
| §5.5 组包围盒 | Task 5（`layerBox`）、Task 8（`layerBoxOf`） |
| §5.6 语义细则（堆叠、跳过、锁定、剪贴、阈值、容差） | Task 8（前五项）、Task 11（容差换算）、Task 12（锁定不产生 op） |
| §5.7 消歧 | Task 13 |
| §5.8 实现位置与悬停可丢弃 | Task 9、Task 10 |
| §6.1 图层 → 区域 | Task 9（引擎侧）、Task 14（UI） |
| §6.2 区域 → 图层 | Task 5（`layersIntersecting`）、Task 7（入口） |
| §7.1–7.3 定位契约 | Task 6（`overlay-geometry.ts`） |
| §7.4 悬停不走全局 store | Task 6（store）、Task 13（接线） |
| §7.5 换算次数 | Task 11（两次 `toCanvas` 相减，不加 `ratio()`） |
| §8 交互语义 | Task 12 |
| §9 树↔画布同步 | Task 7 |
| §13.1 树排序方向 | Task 1 |
| §13.6 抽 `rectStyle` 并搬走契约注释 | Task 6 |
| §7.2 带 mask 的 SVG 轮廓、§4.4 D 期 | **不在本计划内**——spec §4.3 写明协议扩展需单独设计 |

spec §11 列的测试文件与本计划的对应，两处合并了：

- `selection-target.test.ts` 的内容拆进了 `region.test.ts`（§3.2 四种空/非空组合）与 `hit-race.test.tsx`（单击空白只清图层集不清区域；无文档时不崩）——被测的是 `describeTarget` 与指针路径两个不同的东西，各自跟着自己的代码走比放一起清楚。
- `render-core-alpha-region.test.ts` 并进了 `render-core-hit.test.ts`：两者共用同一份 `lazyDoc()` 与 mock store，而 `layerAlphaRegion` 和 `hitTest` 走的本来就是同一条读取路径。
