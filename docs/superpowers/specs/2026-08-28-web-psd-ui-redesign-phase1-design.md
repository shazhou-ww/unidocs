# web-psd UI 重构 · 第一期设计

日期：2026-08-28
分支：`feat/ui-redesign`
设计稿：`Agent Image Editor (standalone).html`（Claude Design 画布，产品名 "Aperture"）

## 1. 背景

`packages/web-psd` 目前是 426 行原生 TS + 手写 DOM 的演示程序：两栏布局（画布 + 右侧图层卡片/Chat），
真实能力仅有打开 PSD、导出、图层可见性与不透明度、Chat 调用 Operator。

设计稿要求三栏布局（列宽与顺序按设计稿的 CSS `order` 核实）：
**左栏 Chat（`order:1`，固定 396px）**、**中栏画布（`order:2`，`flex:1; min-width:700px`）**、
**右栏「图层/属性」双 Tab 面板（`order:3`，固定 296px）**。
外层行是 `display:flex; min-height:0; overflow-x:auto`，中栏底色 `#e6e3dd`，两侧面板 `#fbfaf8`。

设计稿描绘的功能中有相当一部分在当前后端不存在。本设计基于对代码的逐项核实，
把 42 项功能拆成 8 个「地基」（依赖树的根），第一期交付地基 0–5 共 30 项。

## 2. 功能依赖树与分期

### 第一期（地基 0–5，30 项）

| 地基 | 功能项 | 后端改动 |
| --- | --- | --- |
| **0** 视觉层（零依赖） | E1 配色/字体/间距、E2 深色模式决策、E3 accent 变量、A1 Logo、A2 文件名、A6 导出、B1 双 Tab、B7 多选高亮、D1 消息流、D11 新会话 | 无 |
| **1** 图层树读取 | B2 递归树、B3 眼睛显隐、B8 变换只读、B12 IR 片段 | 无 |
| **2** 图层属性写入 | B10 属性·外观面板可编辑 | `layer-ops.ts` + `tools.ts` |
| **3** 画布视口 | C1 渲染、C2 平移缩放、A5 缩放控件、C8 取色、C4 移动工具、C3+C5 选区覆盖层 | 无 |
| **4** 历史与回退 | D4 operations 列表、D6 回退、D5 diff（降级）、D3 会话计数（降级） | 无 |
| **5a** IR 读取保真 | A4 降级报告、B6 降级标记、A3 IR 徽标、B4 类型徽标 T/SHP | `model/types.ts` + `load.ts` + `save.ts` |

### 第二期（12 项：B5 B9 B11 C6 C7 C9 C10 D2 D7 D8 D9 D10）

| 地基 | 功能项 |
| --- | --- |
| **5b** IR 写入 | B9 旋转（仿射变换 + 重采样）、C7 文字工具（`setText` 栅格化） |
| **6** Agent 上下文与轨迹 | C9 结构化上下文、D9 上下文 chips、D2 ReAct 轨迹、D10 附图 |
| **7** 批注领域模型 | C6 圈选批注、C10 批注气泡 |
| **8** 模板/可变字段 | B5 var 标记、B11 Agent 标记（可变字段/安全区/批注，跨地基 7、8） |
| 依赖地基 8 | D7 存为 recipe、D8 变体批量生成（二者挂在地基 4 的树上，但需地基 8 的可变字段概念才有意义） |

### 为什么 5b 不进第一期

- **B9 旋转**：`render/composite.ts`（820 行）是纯轴对齐软件混合器。加旋转需要同时改
  `composite.ts`（双线性重采样）、`region.ts`（`layerInfluenceBounds` 改算变换后四角包围盒）、
  `dirty-rect.ts`、`incremental.ts`（tile 失效）、`psd/save.ts`（回写）。
  工作量数倍于第一期其余所有后端改动之和，而唯一下游是「选区手柄能缩放图层内容」。
- **C7 文字**：`setText` 需要服务端字体栅格化。`psd/canvas-shim.ts` 中 `createCanvas` 直接抛异常
  —— workerd 里既无 canvas 也无字体文件。可行路线只有「内嵌字体子集 + 自写排版栅格化」
  或「浏览器端栅格化后作为 raster 上传」，后者会破坏「服务端是唯一真相」的架构约束。

## 3. 技术栈

与 `unicas-packages/admin-webui` 完全对齐（该包已是本 monorepo 的既定前端栈，依赖均在 lockfile 中）：

- **React 19** + `react-dom` + `@vitejs/plugin-react`
- **纯 CSS + `:root` CSS 变量**，单一 `styles.css`，语义化类名（无 Tailwind、无 CSS-in-JS）
- 测试：`vitest` + `jsdom` + `@testing-library/react`
- **不引入** `lucide-react`：设计稿全程使用文字字形（`● ○ ▾ ▸ − +`），它们是视觉的一部分
- **不引入**状态管理库：`DocSession` 是外部可变源，用 `useSyncExternalStore` 桥接

字体：Barlow（400/500/600/700）+ Roboto Mono（400/500）的 woff2 子集文件已从设计稿 bundle 中提取，
直接放入 `public/fonts/` 并在 `styles.css` 里声明 `@font-face`。零新依赖、离线可用、字形与设计稿一致。

## 4. 前端架构

### 4.1 核心原则

**渲染核心逻辑一行不动。** 现 `main.ts` 中的 `initRender` / `DocSession` 构造 / `RenderClient` /
`Viewport` / `repaintAfterDocChange` / `requestVisibleTiles` / `[psd-perf]` 日志，
原样搬入 `src/doc-controller.ts`，不重写、不进 React 渲染树。

`<canvas>` 通过 ref 挂载一次，之后完全由 `Viewport` / `RenderClient` 命令式操作，
**永不进入 React 的 diff**，现有增量 tile 合成的性能保证不受影响。

### 4.2 目录结构

```
packages/web-psd/
  index.html                 只留 <div id="app"> + 字体 preload
  public/
    fonts/                   Barlow ×12 + Roboto Mono ×6 (woff2 子集)
    sample.psd
  src/
    doc-controller.ts        渲染/同步逻辑（从现 main.ts 原样搬入，非 UI）
    ui/
      main.tsx               createRoot 挂载 + 冷启动
      app.tsx                三栏布局骨架
      styles.css             design tokens + 全部样式
      store.ts               UI 状态 + DocSession 桥接
      api.ts                 /history · /rollback · /run · /reset · /export 客户端
      components.tsx         共享原子组件 Badge / Chip / Tab / IconButton / CodeBlock
      panels/
        top-bar.tsx          Brand · DocMeta · IrBadge · DegradeBadge · Zoom · Export
        chat-panel.tsx       左栏 396px：消息流容器
        ops-accordion.tsx    左栏：N operations · 查看 diff · 回退这 N 步
        history-drawer.tsx   左栏：全量 /history 抽屉
        composer.tsx         左栏：@图层 补全 + 发送
        canvas-stage.tsx     中栏：canvas 容器 + 滚动/缩放事件 → Viewport
        selection-overlay.tsx 中栏：蚂蚁线 + 四角手柄（绝对定位 div，非 canvas 绘制）
        tool-strip.tsx       中栏：移动 / 框选 / 取色
        context-bar.tsx      中栏：选中路径 + IR 子树提示
        layer-tree.tsx       右栏 296px：LayerRow（递归 · 缩进 · caret · 眼睛 · 类型徽标 · 降级标记）
        props-pane.tsx       右栏：PropGroup ×3 + IrSnippet
    tests/
      store.test.ts
```

### 4.3 状态

`store.ts` 暴露一个外部 store（`subscribe` / `getSnapshot`），组件用 `useSyncExternalStore` 订阅：

```ts
doc, version            // 转发自 DocSession（唯一真相）
docName                 // 上传时的文件名（现在丢失了，本期补上）
selection: string[]     // 选中图层 id
expanded: Set<string>   // 树折叠状态
pane: 'layers' | 'props'
tool: 'move' | 'marquee' | 'eyedrop'
marquee: Rect | null    // 选区（画布坐标）
zoom, pan               // 转发自 Viewport
history: HistoryEntry[]
sessionBaseVersion      // 页面打开时的 version → D3 会话边界
historyOpen: boolean
chat: Message[]
degradations            // 从图层树递归收集 layer.degraded → A4 / B6
```

### 4.4 设计稿未覆盖、本设计补充的一处

设计稿中 operations 是内嵌在 Agent 消息气泡里的折叠块，但本地直接编辑（拖动图层、改不透明度）
产生的 op 不属于任何 Agent 消息，稿子对此没有交代。

**方案**：左栏 Chat 顶部的 `N ops · 本次会话` 做成可点击，展开 `history-drawer` 盖住 Chat，列出
`/history` 全量；Agent 消息内嵌的 `ops-accordion` 只显示该轮产生的 version 区间。
两者共用同一份 history 数据，`回退` 都打到 `/rollback`。

## 5. 后端改动

共三处，全部在 `packages/doctype-psd`。

### 5.1 地基 2 — 放开图层属性写入

`src/ops/layer-ops.ts`：`SETTABLE_PROPS` 增加 `fillOpacity`、`stroke`、`colorOverlay`、`dropShadow`，
并为各自补校验：

- `fillOpacity` ∈ [0,1]
- `stroke.position` ∈ {`inside`,`outside`,`center`}、`stroke.opacity` ∈ [0,1]、`stroke.size` ≥ 0、
  `stroke.blendMode` ∈ `BLEND_MODES`、颜色分量 ∈ [0,255]
- `colorOverlay` 颜色分量 ∈ [0,255]、`opacity` ∈ [0,1]
  （已核实：`render/composite.ts:686` 将其作为 0..1 混合因子使用，`sr*(1-oa) + (r/255)*oa`）
- `dropShadow` 各数值有限、`blendMode` 合法

`src/tools.ts`：同步 `apply_set_props` 的 JSON Schema。

**脏矩形无需改动**（已核实）：`render/region.ts` 的 `layerInfluenceBounds` 已正确处理 stroke 外扩
与 dropShadow 偏移+模糊，`render/dirty-rect.ts` 的 `opDirtyRect(op, before, after)` 已对 before/after
两个文档取并集。放开白名单后脏矩形自动正确。

### 5.2 地基 5a — IR 读取保真

**事实依据**：`ag-psd@31` 已经解析出 `Layer.text`（`LayerTextData`：`text` 字符串、`style`、
`transform` 仿射矩阵、`shapeType`）、`vectorFill` / `vectorStroke` / `vectorMask`、`placedLayer`。
是 `src/psd/load.ts:72` 的 `const type = isGroup ? "group" : adj ? "adjustment" : "raster"`
把它们统统压成 raster 丢弃。这些图层在 PSD 中本就带烘焙好的 `imageData`，**渲染管线零改动**。

`src/model/types.ts` — `Layer` 增加以下可选字段（向后兼容）：

```ts
text?: {
  content: string;
  style?: { font?: string; size?: number; color?: {r,g,b}; tracking?: number; leading?: number };
  transform?: number[];              // ag-psd 的 6 元仿射矩阵，原样保留
  shapeType?: 'point' | 'box';
};
vector?: {
  fill?: unknown;                    // ag-psd VectorContent，原样保留
  stroke?: unknown;
  pathSummary?: { subpaths: number; knots: number };
};
smartObject?: { placedId: string; transform?: number[]; sourceName?: string };
degraded?: { reason: string; detail?: string }[];
```

**不新增文档级 `degradations` 字段。** 已核实 `load()` 对非 8-bit 与非 RGB 色彩模式是**直接抛错**
（`psd/load.ts` 的 `load()`），此类文档根本创建不出来，不存在「降级后仍可用」的状态。
A4 徽标的计数由前端从图层树递归收集 `layer.degraded` 得出，无需后端新增文档级字段。

`src/psd/load.ts`：
- type 判定顺序改为 `group → text → vector → smartObject → adjustment → raster`
- 把 ag-psd 已解析好的字段搬入上述新字段
- 每丢弃一样能力就记一条 `degraded`，例如：
  - `"文字层已栅格化"` / detail: `"编辑文字内容将丢失原有排版"`
  - `"智能对象已展平"` / detail: 源文档名
  - `"不支持的图层效果：<名称>"`

`src/psd/ir.ts`：`IrLayer = Omit<Layer,"pixels"|"mask"|"children"> & {...}`，
新字段**自动进入 IR**，无需改动。

`src/psd/save.ts`：`mapLayer` 回写 `text` / `vector` / `smartObject`，保证 import → export 往返不丢元数据。

### 5.3 地基 4 — 零后端改动（走降级实现）

- **D3 会话边界**：前端记录页面打开时的 `version` 作为 `sessionBaseVersion`，
  `ops since sessionBaseVersion` 即「本次会话」。后端无 session 概念，本期不引入。
- **D5 diff**：`/history` 的 `HistoryEntry` 只有 `{version, timestamp, description, operations[]}`，
  **不含 before 值**。本期只渲染 `operations[]` 本身（即设计稿 diff 中 `+` 的那半边），
  `−` 旧值明确不做。真 diff 需要在 delta 中记录旧值，成本与收益不匹配，推第二期。

## 6. 视觉系统

全部从设计稿逐值提取，写入 `styles.css` 的 `:root`（与 admin-webui 同样的做法）：

```css
:root {
  --bg: #eeece7;            --panel: #fbfaf8;
  --border: #e2e0da;        --border-strong: #dcd8d0;
  --fg: #1c1d1a;            --fg-2: #7c7d75;
  --fg-3: #8a8b82;          --fg-dim: #b6b7ae;
  --accent: #00a38a;        --accent-ink: #00806d;
  --warn: #d9a441;          --warn-ink: #99711a;
  --kind-text: #5b4bd9;     --kind-img: #00806d;
  --kind-grp: #7c7d75;      --kind-shp: #b4622f;
  --canvas-bg: #e6e3dd;     --canvas-dot: #d3cfc7;
  --font: Barlow, Helvetica, sans-serif;
  --mono: "Roboto Mono", monospace;
  --fs: 13px;  --row-h: 26px;  --topbar-h: 48px;  --radius: 5px;
  --col-chat: 396px;        --col-panel: 296px;   --canvas-min: 700px;
  color-scheme: light;
}
```

派生规则照搬设计稿：选中行底色 `accent + 1f`、徽标底 `accent + 14`、
徽标边框 `accent + 33`/`accent + 40`。`--accent` 改一个值即可整体换主色（E3）。

**深色模式（E2）**：第一期锁浅色 —— `color-scheme: light`，与 admin-webui 一致，
移除 `index.html` 现有的 `color-scheme: light dark`。所有颜色已走变量，
第二期补暗色只需增加一组变量覆盖。

`@keyframes ants`（蚂蚁线）与 `@keyframes blip` 从设计稿原样搬入。

## 7. 数据流

```
用户改属性 → store.dispatch(op)
             → doc-controller.dispatch(op)
               → DocSession.applyLocal(op) → 本地即时重绘脏 tile
                                           → 后台队列提交 /apply

Agent /run 完成 → DocSession.reconcile() → onRebase → store 刷新 → repaintAfterDocChange

历史抽屉 → api.history() → store.history
回退     → api.rollback(v) → DocSession.reconcile() → 同上
```

`DocSession` 保持唯一真相，UI 只读它并派发 op。现有 `onRebase` 钩子直接接到 store 的刷新：
409 冲突、agent 改动、其它标签页改动全部走同一条路径，无需新增同步机制。

## 8. 测试策略

**`packages/doctype-psd/tests/` 新增：**

- `load-fidelity.test.ts` — 文字层 / 形状层 / 智能对象被识别为对应 type 且元数据被保留；
  每类丢弃能力都产出对应 `degraded` 记录；非 RGB / 非 8-bit 仍按现状抛错（不降级）
- `save-roundtrip.test.ts` — 含新字段的文档 import → export → import 后元数据不丢
- `set-props-effects.test.ts` — `stroke` / `colorOverlay` / `dropShadow` / `fillOpacity` 可写；
  非法值被拒；改 `dropShadow` 后 `opDirtyRect` 含偏移与模糊外扩

**`packages/web-psd/tests/` 新增（该包目前无测试）：**

- `store.test.ts` — 选中、树折叠、会话边界（`ops since sessionBaseVersion`）等纯逻辑
- 组件不做快照测试

**集成测试：**

- `tests/integration/cloudflare/local-runtime.test.mjs` 补一条 `/history` + `/rollback` 往返

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `load.ts` 改 type 判定后，既有文档的 raster 层被重新识别为 text/vector，行为变化 | 新字段全部可选；type 变化不影响渲染（仍走 `imageData`）；`save-roundtrip.test.ts` 兜底 |
| 引入 React 后画布被重渲染，毁掉增量 tile 性能 | `<canvas>` 用 ref 挂载、永不进 React diff；保留现有 `[psd-perf]` 日志作为回归信号 |
| 选区手柄能拖但不能真缩放图层内容（依赖第二期 B9），体验割裂 | 第一期手柄只承担「改选区」语义，视觉上不做可缩放图层的暗示；选区的三个真实出口是 `crop`、`getPreview{rect}`、作为文本描述喂给 agent |
| `doc-controller.ts` 搬迁过程中改动了渲染逻辑，引入性能回归 | 严格按「原样搬入」执行，搬迁与 UI 重写分成独立提交，中间跑一次 `[psd-perf]` 基线对比 |
| 字体文件（18 个 woff2，约 300KB）拖慢首屏 | `font-display: swap` + 只 preload latin 子集；其余按 `unicode-range` 惰性加载 |

## 10. 明确不在第一期范围内

- 地基 5b：图层旋转 / 缩放、文字内容编辑
- 地基 6：Agent 结构化上下文、上下文 chips、ReAct 轨迹展示、附图
- 地基 7：圈选批注、批注气泡
- 地基 8：可变字段标记、recipe、变体批量生成
- 真 diff（`−` 旧值）
- 深色模式
