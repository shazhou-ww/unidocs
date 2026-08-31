# web-psd 图层选中设计

日期：2026-08-31
分支：待建（建议 `feat/web-psd-selection`）
依赖：`refactor(web-psd): 缩放 Phase 0 — 收口屏幕↔文档坐标映射`（PR #38，已并入 main）
并行工作：缩放 Phase 1（另一个 agent），文件边界见 §2

## 1. 背景与范围

### 1.1 现状

`store.ts:32` 的 `selection: string[]` 是图层选中的唯一状态，但今天只有两个写入口——图层树的行点击
（`layer-tree.tsx:31`）和降级徽标的跳转（`top-bar.tsx:43`）。画布上：

- 点不出选中；
- 选中了也**没有任何视觉反馈**；
- 移动工具要求「先去树里选中，再回画布拖」（`canvas-stage.tsx:48`），用户看不见自己在拖谁。

`selection-overlay.tsx` 画的是**像素选区**（框选工具拖出的矩形，出口是 `crop`），与「选中了哪个图层」
无关。两者今天共用一套蚂蚁线视觉，必须区分开。

### 1.2 本设计交付

画布上的图层选中：点击命中、选中框、悬停预选、多选、按下即选并拖、树↔画布双向同步。

### 1.3 明确不做

| 不做 | 原因 |
| --- | --- |
| 旋转 / 缩放手柄（拖手柄真的改图层内容） | 依赖第二期地基 5b（`composite.ts` 仿射重采样），见 UI 重构第一期设计 §2.3 |
| 非矩形轮廓（沿 alpha 边缘描边 / 矢量路径描边） | 客户端只有 `vector.pathSummary`（子路径数、节点数），没有路径数据；alpha 描边要另算轮廓，收益不抵成本 |
| 橡皮筋框选图层 | 排在 P2，与框选工具的像素选区语义需要先划清（§6 已给出划分），本期先不做 |
| 图层树的排序方向 | 见 §11 待确认（1） |

## 2. 与缩放 Phase 1 的文件边界

这是本设计**最需要 review 的部分**。缩放 Phase 1 尚未落地，预计要动 canvas 的 CSS 盒子尺寸。

```
                     本设计                缩放 Phase 1（预计）      交集
selection-box.tsx      新增                    —                    无
hit-test.ts            新增                    —                    无
selection-overlay.tsx  不碰 ★                  可能碰                无
canvas-stage.tsx       只改 3 个指针函数体      可能改结构/注释        有 ←
styles.css             只新增 .sel-* 段        改 .view/.stage-inner  有 ←
viewport.ts            不碰                    大改                  无
top-bar.tsx            不碰                    可能改                无
doc-controller.ts      P1 才碰（加 2 个方法）   可能碰                有（P1）←
layer-tree.tsx         改                      —                    无
store.ts               改                      可能加字段            有 ←
```

★ `selection-overlay.tsx` 的文件头注释在 PR #38 里被写成了**定位契约**（覆盖层的几何量、层级位置、
chrome 尺寸三条规则），是给本设计用的。本设计遵守它，但**不修改该文件**——改它冲突概率最高，
而且没有必要：新的选中框走新文件。

三处交集的规避办法：

- **`canvas-stage.tsx`**：只改 `onPointerDown` / `onPointerMove` / `onPointerUp` 三个函数体，
  以及 JSX 里加一行 `<SelectionBox />`。不动组件结构、不动文件头那段注释、不动 `normalise()`。
- **`styles.css`**：新样式全部追加到文件末尾的独立段落，类名前缀 `.sel-`。不碰 `.stage`、
  `.stage-inner`、`.view`、`.marquee` 已有的任何规则。
- **`doc-controller.ts`**（仅 P1）：只新增 `ratio()` 和 `hitTest()` 两个方法，追加在 `pickColor`
  之后。不改 `toCanvas` / `toScreen` / `setZoom` 的实现。
- **`store.ts`**：只新增派生纯函数，`UiState` 只加 `hoverId` 之外的字段一律不加——而 `hoverId`
  **不进这个 store**（§5.4）。

**排期建议**：P0 可与缩放 Phase 1 并行（交集只有两处、都是追加式改动）。P1 建议等缩放 Phase 1
合入后再开，因为它要动 `doc-controller.ts`，且需要在真实缩放下验一遍对齐。

## 3. 核心模型

三个空间，任何时候都不能混：

```
  文档空间                     屏幕空间                      chrome
  document px                  CSS px                        CSS px（常量）
  ─────────────                ─────────────                 ─────────────
  layer.bounds                 left / top / width / height   边框 1px
  marquee rect                 = toScreen(文档空间)           手柄 6px
  命中坐标                                                    悬停线 1px
  命中容差 = 3 × ratio         ratio = 位图尺寸 / 布局盒子

  松手即定，缩放不改它    ──→   每次渲染重算              ──→  永不随缩放变化
```

数据流：

```
画布 pointerdown
  → controller.toCanvas(clientX, clientY)        [屏幕 → 文档]
  → hitTest(x, y) → { layerId, path }            [命中，见 §4]
  → setState({ selection })                       [唯一真相]
  → SelectionBox 重渲染
      → layerBox(layer)                           [文档空间矩形，见 §4.3]
      → controller.ratio() 读一次
      → canvasToScreen(ratio, …) 批量换算          [文档 → 屏幕]
      → 绝对定位 div

图层树行点击 ────────────────┘（同一个 setState，同一份 selection）
```

`selection: string[]` 是唯一真相，画布和树都只是它的视图。这一点已经成立，本设计不改。

## 4. 命中测试

### 4.1 分级

| | 做法 | 精度 | 代价 |
| --- | --- | --- | --- |
| **P0** | 主线程遍历包围盒，自上而下取第一个命中 | 透明区会误选 | 零新增管线 |
| **P1** | Worker 内按 alpha 采样 | 与 Photoshop 自动选择一致 | 一次 postMessage 往返 |
| 不做 | 合成时并行产出「每像素属于哪层」的 ID 缓冲区 | 精确且 O(1) | 瓦片内存翻倍、每次编辑多一遍失效；混合模式下「这像素属于谁」本身有歧义 |

P0 的缺陷是真实的：PSD 里大量图层是「整画布尺寸、大部分透明」，只看包围盒会让点空白处选中一个
看不见的图层。所以 P0 只是让交互链路先闭环，P1 才是要长期留下的实现。

### 4.2 接口从一开始就是异步的

P0 同步、P1 异步的话，切换时所有调用方都要改。所以接口一开始就按 P1 的形状定，P0 的实现直接
resolve：

```ts
// packages/web-psd/src/ui/hit-test.ts（新增）
export interface Hit {
  layerId: string;   // 命中的叶子图层
  path: string[];    // 最外层组 → 叶子的完整祖先链，末位 === layerId
}
export type HitTester = (x: number, y: number) => Promise<Hit | null>;
```

`path` 由调用方决定取哪一级（§6 的单击 / 双击 / Cmd+单击 三种语义），命中本身不做这个决定。

**指针捕获必须同步调用。** `hitTest` 是异步的，但 `setPointerCapture` 要在 `pointerdown` 处理函数
里同步调用，且 `e.currentTarget` 在处理函数返回后就没了。所以顺序是：先同步取 `currentTarget` 和
`pointerId` 并 `setPointerCapture`，再 `await hitTest`，没命中就 `releasePointerCapture`。

### 4.3 组的包围盒必须前端算

**已核实**：`psd/load.ts:230` 对所有图层一律取 ag-psd 的 `top/left/bottom/right`，而 PSD 里的组
（section divider）通常报 `0,0,0,0`。所以 `layer.bounds` 对组**不可用**。

组的矩形按子图层并集算，规则与 `render/region.ts:24-29` 一致：

```ts
export function layerBox(layer: LocalLayer): Rect | null;
// 组：递归子层 layerBox 的并集，无可见子层则 null
// 非组：layer.bounds
```

选中框用 `bounds` 而**不是** `layerInfluenceBounds`（`region.ts:14`）。后者算上了描边外扩和投影偏移，
一个带大投影的图层选中框会飘出去一大圈；Photoshop 的变换框也是贴着 `bounds` 的。

### 4.4 语义细则

**堆叠顺序**：已核实 `render/composite.ts:108` 是 `for (i = 0; i < layers.length; i++)` 逐层往上叠，
所以 **`layers[0]` 是最底层、数组末尾是最上层**。命中测试从数组末尾往前走，递归进组。

**跳过**：不可见图层（`visible === false`）、锁定图层（`locked`）、调整图层（`type === "adjustment"`，
它作用于整个背景，永远不该被点中）。

**剪贴蒙版**（`clipping === true`）：它在屏幕上被下方基底的 alpha 裁掉，但它自己的 alpha 在被裁掉的
区域仍然非零。只判它自己会在肉眼看不见的地方选中它，所以命中时要与基底的 alpha 相与。P0 的包围盒
版本做不到这一点，是 P0 已知的不精确之一。

**阈值**：P1 的判定是 `图层 alpha × 蒙版 alpha × opacity × fillOpacity ≥ 阈值`，阈值取 `8/255`——
不取 0 是为了不被几乎透明的辉光边缘选中。

**容差**：点击判定的宽容度写成 CSS 像素常量（建议 3px），使用时乘 `ratio` 换成文档像素。
缩到 25% 时那就是 12 个文档像素。**写死成文档像素的话缩小后就点不中细图层了。**

### 4.5 P1 的实现位置

```
canvas-stage        DocController          RenderClient      render-worker      RenderCore
     │  hitTest(x,y)     │                      │                  │                 │
     ├──────────────────>│  hitTest             │                  │                 │
     │                   ├─────────────────────>│ {type:"hitTest"} │                 │
     │                   │                      ├─────────────────>│ core.hitTest    │
     │                   │                      │                  ├────────────────>│
     │                   │                      │                  │                 │ 自上而下
     │                   │                      │                  │                 │ resolvePixels
     │                   │                      │  {type:"hit"}    │<────────────────┤ 采样 alpha
     │<──────────────────┴──────────────────────┴──────────────────┘                 │
```

- `render-worker.ts` 的 `WorkerRequest` 加 `{ type: "hitTest"; id; x; y; threshold }`，
  `WorkerResponse` 加 `{ type: "hit"; id; layerId: string | null }`。走现有的串行队列，
  不与 `applyOp` / `tiles` 交错。
- `RenderCore` 现在（`render-core.ts:16`）把 `store` 和 `cache` 内联进 `IncrementalCompositor` 就把
  引用丢了。改成存成字段，再加 `hitTest(x, y, threshold)`，用 `resolvePixels(layer.pixels, store, cache)`
  取像素。
- **不改 `IncrementalCompositor`，不合成任何东西。** `prefetch()` 已经把所有图层烤热，这里全是缓存
  命中，单次开销是一次 postMessage 往返加若干次数组下标读取。
- 蒙版像素在 `deserialize` 之后就是常驻的（见 `resolve.ts:36-39` 的注释），直接可读。

## 5. 选中框渲染

### 5.1 定位契约

照抄 `selection-overlay.tsx:4-21` 已经写死的三条：

1. 几何量存**文档像素**，渲染时用 `toScreen` 换算——这样覆盖层不需要知道缩放是多少就能跟住画布。
2. 覆盖层是 canvas 的**兄弟节点**（在 `.stage-inner` 里），不是任何被 CSS 缩放的元素的子节点。
3. **chrome 尺寸不随缩放变化**：边框粗细、手柄大小只能写 CSS 像素常量，且**不许给覆盖层套
   `transform: scale()`**——否则 25% 时手柄小到抓不住、400% 时糊成一坨。

第 3 条对多选的影响：每个图层一个细边框 + 一个并集外框，是安全的；但如果以后想做「选中态半透明
蒙层」，那个蒙层也要按 CSS 尺寸重算，不能靠缩放一个容器省事。

### 5.2 视觉区分

三种东西今天会同时出现在画布上，必须一眼分得开：

| | 画法 | 类名 |
| --- | --- | --- |
| 像素选区（框选工具） | 蚂蚁线虚线 + 四角手柄（**保持现状，不动**） | `.marquee` |
| 图层选中 | 实线 1px `--accent` + 8 个手柄（四角 + 四边中点） | `.sel-box` |
| 悬停预选 | 实线 1px、更淡、无手柄 | `.sel-hover` |
| 多选 | 每个图层一个细边框（无手柄）+ 一个并集外框（有手柄） | `.sel-box` / `.sel-union` |

手柄本期只有视觉，**不可拖**（拖手柄真的缩放图层依赖地基 5b）。UI 重构第一期设计 §9 已经为选区手柄
做过同样的取舍：手柄不做「可缩放图层」的暗示。

### 5.3 重新测量的触发（本设计的关键风险）

「缩放是量出来的，不是存的」这个不变量的代价是：**必须有人在 canvas 盒子变化之后通知覆盖层重新量，
而这个通知机制现在不存在。**

两类失效：

- **量早一帧**。缩放 Phase 1 落地后，`s.zoom` 变化走一次 `setState`，React 在同一次渲染里既给 canvas
  写新的 CSS 宽高、又渲染覆盖层；而覆盖层是在**渲染阶段**调 `getBoundingClientRect()` 的，那时新样式
  还没提交进 DOM，量回来的是旧盒子。结果是选中框停在上一档缩放的位置，且不会自己恢复——要等下一次
  无关的状态变化才对齐。`.marquee` 今天就有这个毛病，只是缩放还不生效所以看不出来。
- **连渲染都不触发**。窗口 resize（一旦有「适应窗口」模式）、浏览器页面缩放、设备像素比变化、缩放做了
  CSS 过渡动画的那几十帧——盒子变了但 store 没变，React 不重渲染，覆盖层整个脱节。

**解法**：给 canvas 挂 `ResizeObserver`，盒子一变就推一个版本号，覆盖层订阅它。

```
canvas 盒子变化（任何原因）
  → ResizeObserver 回调（浏览器保证在布局之后）
  → 覆盖层重渲染 → toScreen 量到的一定是已生效的盒子
```

它在布局之后触发，天然躲开「量早一帧」；它不关心变化的原因，四类失效全覆盖；它不需要覆盖层知道缩放
是多少，与「measured, never stored」完全一致。

不采纳的两条：把覆盖层塞进被 `transform: scale()` 的容器里跟着缩（违反 §5.1 第 3 条）；让覆盖层直接读
`s.zoom` 自己乘（等于把 zoom 又存一份，正是 PR #38 刚拆掉的东西）。

**归属**：这个问题是缩放引入的，`.marquee` 也需要它，理想归属是缩放 Phase 1。

**兜底**：如果缩放 Phase 1 不带这个，本设计在 `canvas-stage.tsx` 的现有 `useEffect` 里挂
`ResizeObserver`，版本号推进一个独立的小 store（与 §5.4 的悬停 store 同一个模块）。
**需要在开工前和缩放那边确认由谁做，避免两边都做或都不做。**

### 5.4 悬停不走全局 store

`store.ts:113` 明确说了订阅的是整个 state 对象，任何一次 `setState` 都会重渲染整棵树，包括几百行的
图层树。悬停是每次 `pointermove` 都变的，走全局 store 会把整棵树按帧重渲染。

`hoverId` 和 §5.3 的盒子版本号一起放进 `packages/web-psd/src/ui/overlay-store.ts`（新增），结构与现有
store 同构（`subscribe` / `getSnapshot` / `useSyncExternalStore`），**只有 `SelectionBox` 订阅它**。
一次悬停变化的重渲染成本是一个 div。

命中测试本身用 `requestAnimationFrame` 节流，且只在 `tool === "move"` 时跑。

### 5.5 换算次数

`toCanvas` 每次调用读**两遍** `getBoundingClientRect`：`doc-controller.ts:203` 自己读一遍拿
`left/top`，`viewport.ratio()` 里面又读一遍拿 `width/height`。`toScreen` 读一遍。

今天只有拖动时每个 `pointermove` 调一次，问题不大。加上悬停命中（每个 `pointermove`）和选中框
（每次渲染 2N 次换算，N = 选中图层数）之后，建议：

- `DocController` 加 `ratio(): Ratio` 透传（P1 时一并加）；
- `SelectionBox` 每次渲染只读一次 ratio，然后用 `@unidocs/psd-client` 已导出的纯函数
  `canvasToScreen(ratio, x, y)` 批量换算。

这不违反契约——契约要的是「共用同一套映射」，不是「每次都重新量」。

## 6. 交互语义

参照 Figma，比 Photoshop 的「自动选择」复选框更好懂：

| 操作 | 结果 |
| --- | --- |
| 单击图层 | 选中命中路径的**最外层组**（`path[0]`） |
| 双击 | 沿 `path` 下探一级 |
| Cmd / Ctrl + 单击 | 直接选中叶子（`path` 末位） |
| Shift + 单击 | 加选 / 减选（复用 `store.ts:123` 的 `nextSelection`） |
| 按在未选中的图层上并拖 | **先选中它，同一次手势直接进入拖动**（今天要求先在树里选中，见 `canvas-stage.tsx:48`） |
| 按在已选中的图层上并拖 | 拖动当前整个选中集（现状） |
| 单击空白 / Esc | 清空选中 |
| 移动工具在空白处拖 | P2：橡皮筋框选图层 |
| 框选工具拖 | 像素选区（现状，不变） |

移动工具和框选工具各管各的：**移动工具的拖 = 选图层，框选工具的拖 = 选像素**，两者不共用状态、
不互相清除。

## 7. 树↔画布同步

画布上选中之后，图层树要：

1. **展开所有祖先组**——`flattenTree`（`doc-model.ts:117`）只渲染 `expanded` 里的组的子层，不展开的话
   用户在树里根本看不到自己刚选的东西；
2. **滚动到该行**。

`path` 正好就是要展开的祖先组 id 列表，不需要再算一次。反向（树选中 → 画布）不需要额外动作，
`SelectionBox` 订阅同一份 `selection`。

## 8. 文件清单与分期

### P0（可与缩放 Phase 1 并行）

| 文件 | 改动 |
| --- | --- |
| `web-psd/src/ui/hit-test.ts` | **新增**：`layerBox`、`unionRect`、`boundsHitTest`（纯函数，无 DOM） |
| `web-psd/src/ui/overlay-store.ts` | **新增**：`hoverId` + 盒子版本号的独立小 store |
| `web-psd/src/ui/panels/selection-box.tsx` | **新增**：选中框 + 悬停框 + 手柄 |
| `web-psd/src/ui/panels/canvas-stage.tsx` | 改三个指针函数体；JSX 加一行 `<SelectionBox />` |
| `web-psd/src/ui/panels/layer-tree.tsx` | 展开祖先 + 滚动到选中行 |
| `web-psd/src/ui/styles.css` | 文件末尾追加 `.sel-*` 段 |

### P1（建议等缩放 Phase 1 合入）

| 文件 | 改动 |
| --- | --- |
| `psd-client/src/render-core.ts` | 存 `store` / `cache` 字段；加 `hitTest` |
| `psd-client/src/render-worker.ts` | 加 `hitTest` 请求 / `hit` 响应 |
| `psd-client/src/render-client.ts` | 加 `hitTest` 方法 |
| `web-psd/src/doc-controller.ts` | 加 `ratio()`、`hitTest()`，追加在 `pickColor` 之后 |
| `web-psd/src/ui/hit-test.ts` | `boundsHitTest` 降级为兜底，主路径切到 Worker |
| `selection-box.tsx` | 接上悬停预选 |

### P2（本期之后）

橡皮筋框选图层；方向键微移（复用 `drag.ts` 的 `translateOps`）；组的进入 / 退出层级导航。

## 9. 测试

`packages/web-psd/tests/` 新增：

- `hit-test.test.ts` — 纯函数，无 DOM：
  - 堆叠顺序（数组末尾优先命中）
  - 跳过不可见 / 锁定 / 调整图层
  - 组的包围盒是子层并集，**组自身的 `bounds` 是 `[0,0,0,0]` 时仍然正确**（这是 §4.3 的核实结论，
    必须有测试兜住）
  - `path` 从最外层组到叶子
  - 容差按 ratio 缩放
- `selection-box.test.tsx` — 选中 N 个图层出 N 个框 + 1 个并集框；`ratio ≠ 1` 时位置正确；
  chrome 尺寸不随 ratio 变化
- `canvas-stage-select.test.tsx` — 按下即选并拖；单击空白清空；Shift 加选；双击下探
- `layer-tree.test.tsx`（已存在）补：画布选中后祖先组自动展开

`packages/psd-client/tests/` 新增（P1）：

- `render-core-hit.test.ts` — alpha 阈值；蒙版参与判定；剪贴蒙版与基底相与；调整图层不命中

## 10. 风险

| 风险 | 缓解 |
| --- | --- |
| 与缩放 Phase 1 改到同一个文件 | §2 的边界；P0 的两处交集都是追加式改动；P1 排在缩放之后 |
| ResizeObserver 两边都没做，选中框在缩放后错位 | §5.3 的归属需要开工前确认；本设计带兜底方案 |
| P0 的包围盒命中让用户点空白选中透明图层，被当成 bug | P0 只是过渡；如果 P1 排期拉长，考虑跳过 P0 直接做 P1（P1 本身不大） |
| 手柄看起来可拖但拖不动 | 与 UI 重构第一期对选区手柄的取舍一致：手柄只做视觉，不做可缩放的暗示；不加 `cursor: nwse-resize` |
| 悬停命中每帧一次 Worker 往返，掉帧 | rAF 节流 + 只在 move 工具下跑；缓存上一次命中结果，坐标落在同一图层包围盒内就不再发消息 |

## 11. 待确认（review 时请裁决）

1. **图层树的排序方向。** 已核实 `composite.ts:108` 是 `layers[0]` 最底、末尾最上，而
   `flattenTree` 按数组顺序渲染、`LayerTree` 按顺序 map——也就是说**面板最上面那行是文档最底层**，
   与 Photoshop 相反。这不是本设计引入的，但它和选中直接相关（用户点画布最上面的图层，树里高亮的
   却是列表最下面那行）。是本期顺手改掉（`flattenTree` 里翻转），还是单独一条？

2. **覆盖层重新测量（ResizeObserver）由谁做？** 展开说明如下。

   **问题**：PR #38 确立了「缩放是量出来的，不是存的」——覆盖层每次渲染调 `getBoundingClientRect()`
   现算屏幕坐标。代价是**必须有人在 canvas 盒子变化之后通知覆盖层重新量，而这个通知机制现在不存在**。
   两类失效（详见 §5.3）：

   - *量早一帧*：缩放 Phase 1 落地后，`s.zoom` 变化走一次 `setState`，React 在同一次渲染里既给 canvas
     写新的 CSS 宽高、又渲染覆盖层。覆盖层在**渲染阶段**读盒子，那时新样式还没提交进 DOM，量到的是
     旧盒子。选中框会停在上一档缩放的位置，且不会自愈——要等下一次无关的状态变化才对齐。
   - *连渲染都不触发*：窗口 resize（一旦有「适应窗口」模式）、浏览器页面缩放、设备像素比变化、
     缩放若做了 CSS 过渡动画的那几十帧。盒子变了但 store 没变，React 不重渲染，覆盖层整个脱节。

   **解法**（两边同意的部分）：给 canvas 挂 `ResizeObserver`，盒子一变就推一个版本号，覆盖层订阅它。
   它在布局之后触发，天然躲开「量早一帧」；不关心变化原因，四类失效全覆盖；不需要覆盖层知道缩放是
   多少，与「measured, never stored」一致。约 15 行代码。

   **待裁决的是归属，不是做法。** 两个候选：

   | | 归缩放 Phase 1 | 归本设计（选中） |
   | --- | --- | --- |
   | 理由 | 问题是缩放引入的；`.marquee` 今天就有这个毛病（只是缩放不生效所以看不出来），修了它也一起受益 | 选中框是第一个真正会被用户盯着看的覆盖层，错位最刺眼 |
   | 落点 | 缩放 Phase 1 在改 canvas CSS 盒子的同一处 | `canvas-stage.tsx` 现有的 `useEffect`（`canvas-stage.tsx:36`），版本号推进 `overlay-store.ts`（§5.4 新增的那个小 store） |
   | 风险 | 若缩放 Phase 1 不带它，选中框直接错位 | 若缩放那边也做了，两个 ResizeObserver 挂在同一个元素上，重复渲染 |

   **倾向**：归缩放 Phase 1。它是缩放的内在代价，且 `.marquee` 也需要。本设计带兜底方案，**但两边
   必须先确认，不能各做各的**——都做会挂两个观察者，都不做会让选中框在缩放后错位且不自愈。

   **需要 review 给出的结论**：归属方 + 若归缩放则本设计删掉 §5.3 的兜底段落。

3. **P0 要不要做**：如果缩放 Phase 1 很快合入，可以跳过 P0 的包围盒命中，直接做 P1 的 Worker 命中，
   省掉一次实现和一次替换。P0 的价值只是「不阻塞、先闭环」。

4. **单击选组还是选叶子**（§6 第一行）。Figma 是选最外层组，Photoshop 默认是选叶子。这里选了 Figma
   的语义，因为 PSD 的组嵌套通常很深，单击直接选叶子会让「拖一整组」变得很难触发。
