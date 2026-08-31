# web-psd 画布缩放设计

日期：2026-08-31
分支：`feat/web-psd-zoom`（Phase 0，已并入 main）、`feat/web-psd-zoom-phase1`
前置：`2026-08-28-web-psd-ui-redesign-phase1-design.md` 的「地基 3 · 画布视口」（C2 平移缩放、A5 缩放控件）

## 1. 背景

UI 重构第一期留下了缩放的**外壳**：TopBar 有 −/+ 按钮、`state.zoom`、25%–400% 步进 25%，
一路调到 `DocController.setZoom` → `Viewport.setZoom`。但这条链路是断的，而且会破坏画面。

核对代码后发现三个层面的问题：

1. **屏幕↔文档换算有三份互不一致的实现**，其中两份在缩放不等于 1 时是错的：
   - `toCanvas` 走 `Viewport` 存储的 pan/zoom 变换；
   - `pickColor` 自己用 client rect 算比例（这份反而是对的）；
   - `Viewport.visibleTiles` 内联了第三种写法，且走 container 分支时**完全忽略** `view.zoom`。
2. **`Viewport.draw` 会破坏画面**：它按存储的 zoom 把 tile 放大，再画进一张恒为文档尺寸的
   bitmap。点一下放大按钮的结果不是放大，而是画面重叠错位。
3. **引擎不支持按分辨率合成**：`render/tile-grid.ts` 与 `render/composite.ts` 的整条 tile 管线
   只认文档像素空间，没有任何 scale 参数。

第 3 点锁死了方案空间：**「按缩放级别重新合成」不是改 web-psd 能做到的**，那是引擎改造。
缩放只能是显示层的事，tile 管线维持 1:1。

## 2. 方案选择

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **A 显示层缩放** | bitmap 恒为 1:1 文档像素，缩放 canvas 元素的 CSS 盒子 | **采用** |
| B 真·视口缩放 | bitmap = 视口大小，Viewport 自持 pan/zoom 并变换绘制 | 否决 |
| C A + 缩小时降采样 | <100% 时先降采样再画进小 bitmap，省内存 | YAGNI |

**为什么是 A。** `Viewport.visibleTiles` 的 container 分支**已经**在算 `rx = canvas.width / cr.width`
这个「bitmap/CSS 比例」，注释里明写着 *"robust if CSS ever scales the canvas element itself"* ——
这条路是原作者预留的。于是 tile 请求逻辑不用动，`.stage` 的原生滚动继续当平移，滚动范围自动正确。

**为什么否决 B。** 要放弃原生滚动、自己实现平移和滚动条，`.stage-inner` 居中与 overlay 定位全部重写，
平移从零成本变成每帧重绘。而因为合成器不支持按 scale 采样，画质**没有**任何提升。

**代价（接受）。** 缩小到适应窗口时可见文档面积变大，`visibleTiles` 会请求整篇文档的 tile；对超大 PSD，
「适应窗口」这一下等于触发一次全文档合成。合成器有缓存、只付一次，且与「手动滚遍全文档」成本相同。
已写成测试（`viewport-dom.test.ts` 的 "returns MORE document tiles ... when zoomed out"）而非注释。

## 3. 核心不变量

整个设计压在两条不变量上，两条都是承重的：

**一、bitmap 就是文档空间。** tile (tx,ty) 永远画在 `(tx*tileSize, ty*tileSize)`，不做任何变换。
缩放由浏览器在缩放元素 CSS 盒子时完成，零成本，且引擎的 tile 管线完全不受影响。

**二、屏幕↔文档映射是「测量」出来的，不是存储的。** 从元素**实际布局出的盒子**把比例读回来。

第二条是本设计最关键的决定。存储式因子有两个无法回避的缺陷：小数缩放的舍入残差会**沿画布累积**
（右下角比左上角错得多，25% 下 0.5 CSS px 的布局误差就是 2 个文档像素，吸管会取错颜色）；以及任何
改变盒子的东西都必须记得通知它。测量式没有这两个问题——浏览器怎么摆的，换算就怎么算，按定义不可能漂移。

推论：**没有任何下游需要被告知当前缩放**。`setZoom` 不接收参数，因为已经没有地方需要存它。

## 4. 精度分析

- **放大 (z>1)：精度变好。** 1 个文档像素占 z 个 CSS 像素，鼠标能寻址到亚像素。`translateOps` 在
  亚像素位移时返回空数组、`last` 只按实际派发的整数推进，所以 400% 下慢速拖拽是「攒够一个文档像素
  才走一格」——这是 PS 的手感，不是 bug。这两处不需要改。
- **缩小 (z<1)：精度必然下降。** 25% 时一个屏幕像素覆盖 4 个文档像素。这是缩小本身的物理限制，
  方案 B 与 PS 完全一样，唯一解法是放大再操作。
- **亚像素布局漂移：由不变量二消除。**

## 5. 分期

拆成两期，**第一期是「零行为变更」的坐标收口**，因为「选中效果」在并行开发，而它的
hit-testing 依赖 `toCanvas`、选区视觉依赖 `toScreen`。

### Phase 0 — 坐标口径收口（已并入 main，PR #38）

- `measuredRatio` / `screenToCanvas` / `canvasToScreen` / `visibleBitmapRect` 四个纯函数，DOM 无关。
- `toCanvas` / `toScreen` / `pickColor` / `visibleTiles` 全部改走它，删除各自的私有算法。
- 删除 `Viewport` 的 `View`/`pan`/`zoom` 状态与 `setPan`/`panBy`/`setZoom`/`getView`，
  以及 `draw` 里会破坏画面的 zoom 分支。
- 未布局的盒子（jsdom、`display:none`）回落 1:1，而不是除零。
- **zoom=1 下输出与改动前逐像素相同**，因此对并行工作是可以随时合并的。

### Phase 1 — 缩放功能本体

| 项 | 决定 |
| --- | --- |
| 缩放施加方式 | canvas 元素的 CSS 宽高 = `round(doc × zoom)`，仅此一处 |
| 档位 | 几何级数 `0.05 0.1 0.25 0.33 0.5 0.67 1 1.5 2 3 4`；−/+ 在相邻档位间跳 |
| 下限 | 5%（原 25%）。6000×4000 的 PSD 需要 21.7% 才能放进典型画布，旧下限让「适应窗口」名不副实 |
| 滚轮 | Ctrl/⌘ + 滚轮连续缩放、不吸附档位；指数式，使同样的滚动距离在任何位置都是同样的**比例** |
| 触控板捏合 | 白送：浏览器报成带 `ctrlKey` 的 wheel |
| 锚点 | 滚轮锚光标，按钮/快捷键锚视口中心 |
| 初始缩放 | 1:1，**超出画布区才**缩到适应；且只在**真正新开**的文档上生效 |
| 快捷键 | ⌘0 适应窗口、⌘1 实际大小、⌘± 步进；输入框内不拦截 |
| `image-rendering` | z≥1 用 `pixelated`，z<1 用 `auto` |

## 6. 两个非显然的实现细节

**锚点补偿必须测量，且必须同步。** 缩放时不锚定，感觉是画面从光标下逃走。而锚点最终落在哪，只有浏览器
重新布局**之后**才知道，所以是测量新位置而非从新旧倍率推算——`.stage` 用 `margin:auto` 居中，盒子变化时
canvas 在滚动区里的偏移会自行漂移，建模它等于重新实现 flexbox。`flushSync` 在这里是承重的：让状态更新
走批处理会测到**旧**布局、滚一个过期的距离，于是每步都漂一点。

**"取 tile" 也不能在调用点做。** `initRender` 先按当前盒子请求首屏 tile，**之后**才触发 `onDoc` →
适应窗口缩放；而 `zoomForNewDoc` 里 `setState` 之后立刻取 tile，量到的还是 React 未提交的旧盒子。
两处叠加的结果是：打开大图缩到适应窗口后，新露出的区域从没被请求过，要等一次无关的滚动或 resize 才补上。
`repaintAfterDocChange`（agent 裁剪）同理。修法是把"重取可见 tile"收进 `CanvasStage` 的一个
`useLayoutEffect`，依赖 `[zoom, doc.width, doc.height]`——它在 DOM 提交和布局之后、绘制之前运行，
测量按定义正确，且一处覆盖冷启动、缩放、文档尺寸变化三条路径。`DocController.setZoom` 随之删除：
它既不 set 也不接收 zoom，`requestVisibleTiles` 已经诚实地说明了它做什么。

**overlay 用百分比定位，不在渲染阶段测量。** `SelectionOverlay` 原本在**渲染阶段**调 `toScreen()` →
`getBoundingClientRect()`，此时 React 还没把新的 canvas 尺寸提交进 DOM，量到的是**旧盒子**；缩放后
选中框会停在旧位置且不会自行恢复。修法不是加 ResizeObserver 去通知它，而是让它**不需要测量**：
`.marquee` 绝对定位，containing block 是 `.stage-inner`——无 padding、收缩包裹 canvas，其 padding box
**就是** canvas 盒子。把矩形写成文档尺寸的百分比，算术交给浏览器在布局阶段解析,按定义发生在新尺寸生效之后。
这同时覆盖了观察者本来要靠人记得才能覆盖的情形（将来的常驻适应模式、CSS 过渡的每一帧），且无额外渲染。

## 7. 给「选中效果」的契约

画在 canvas 之上的一切（选区视觉、手柄、变换框、hover 描边）：

1. 几何存**文档像素**，用 `rectStyle()` 输出为 containing block 的百分比；
2. overlay 是 canvas 的**兄弟节点**，不是任何被 CSS 缩放容器的子节点；
3. **chrome 不缩放**：1.5px 蚂蚁线、6px 手柄在 25% 和 400% 下同样清晰可抓。绝不用文档像素表达
   chrome 厚度，绝不把 overlay 包进 `transform: scale()`；
4. hit-testing 用 `toCanvas()`——它在**事件处理器**里调用，布局已经稳定，测量是安全的。

按此契约写的代码不需要知道 zoom 存在，就自动是 zoom-safe 的。

## 8. 已知未覆盖

- **未在真实浏览器验证**。锚点算术、档位、盒子尺寸、百分比定位均有测试覆盖，但「缩放起来跟不跟手」
  不是测试能报告的。
- 平移仍是 `.stage` 的原生滚动，没有空格键拖拽——本次交互范围不含全套手势。
- 「适应窗口」是一次性命令，不是随窗口 resize 持续生效的模式。若将来改成常驻模式，第 6 节所述的
  百分比定位已经能覆盖，无需额外通知机制。
