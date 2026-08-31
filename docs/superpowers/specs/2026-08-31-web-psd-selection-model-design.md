# web-psd 选择模型设计

日期：2026-08-31
分支：`feat/web-psd-selection`
依赖：`refactor(web-psd): 缩放 Phase 0 — 收口屏幕↔文档坐标映射`（PR #38，已并入 main）
并行工作：缩放 Phase 1（另一个 agent），文件边界见 §2

> 本文第一版题为「图层选中设计」，把「选图层」和「选区域」当成两件平行无关的事。
> 那个框架是错的，见 §3.4。本版改为一个目标、两个轴。

## 1. 背景与范围

### 1.1 现状（三条，均已核实）

**图层轴几乎不存在。** `store.ts:32` 的 `selection: string[]` 是唯一状态，但只有两个写入口——
图层树行点击（`layer-tree.tsx:31`）和降级徽标跳转（`top-bar.tsx:43`）。画布上点不出选中，选中了也
没有任何视觉反馈，移动工具还要求「先去树里选中再回画布拖」（`canvas-stage.tsx:48`）。

**区域轴只有一个矩形，且是死路。** `marquee: Rect` 由框选工具产生，出口只有 `crop`。

**两个轴都没有送到 agent。** 已核实 `composer.tsx` / `chat-panel.tsx` / `api.ts` 里没有任何一处引用
`selection` 或 `marquee`；`api.ts:39` 的 `runAgent` 只发 `{ instruction }`，`protocol-doc/src/http.ts:161`
的 `DocRunOperatorRequest.body` 也确实只有 `instruction: string`。

**所以「帮我把框中的这块重新生成」这句话今天字面上不可能工作**——agent 收不到「框中」是哪。
这是本设计要补的最大的洞，也是第一版完全没有提到的。

### 1.2 本设计交付

一个统一的选择模型（§3），以及它的两个轴：区域轴（§4）、图层轴（§5）、两轴之间的转换（§6），
覆盖层渲染（§7），交互语义（§8）。

### 1.3 明确不做

| 不做 | 原因 |
| --- | --- |
| 旋转 / 缩放手柄（拖手柄真的改图层内容） | 依赖第二期地基 5b（`composite.ts` 仿射重采样），见 UI 重构第一期设计 §2.3 |
| 沿 alpha 边缘 / 矢量路径描出非矩形**图层**轮廓 | 客户端只有 `vector.pathSummary`（子路径数、节点数），没有路径数据。注意这与 §4 的**区域** mask 是两件事，区域的非矩形是要做的 |
| 区域的羽化、扩展/收缩、布尔运算 | 等区域轴的基本通路跑通后再谈 |

## 2. 与缩放 Phase 1 的文件边界

缩放 Phase 1 尚未落地，预计要动 canvas 的 CSS 盒子尺寸。

```
                     本设计                缩放 Phase 1（预计）      交集
composer.tsx           改（A 期）              —                    无
api.ts                 改（A 期）              —                    无
context-bar.tsx        改（A 期）              —                    无
selection-box.tsx      新增（B 期）            —                    无
hit-test.ts            新增（B 期）            —                    无
overlay-store.ts       新增（B 期）            —                    无
selection-overlay.tsx  不碰 ★                  可能碰                无
canvas-stage.tsx       只改 3 个指针函数体      可能改结构/注释        有 ←
styles.css             只新增 .sel-* 段        改 .view/.stage-inner  有 ←
viewport.ts            不碰                    大改                  无
top-bar.tsx            不碰                    可能改                无
doc-controller.ts      C 期才碰（加 2 个方法）  可能碰                有（C 期）←
layer-tree.tsx         改（B 期）              —                    无
store.ts               改                      可能加字段            有 ←
```

★ `selection-overlay.tsx` 的文件头注释在 PR #38 里被写成了**定位契约**（覆盖层的几何量、层级位置、
chrome 尺寸三条规则），是给本设计用的。本设计遵守它，但**不修改该文件**——改它冲突概率最高，
而且没有必要：新的覆盖层走新文件。

规避办法：

- **`canvas-stage.tsx`**：只改 `onPointerDown` / `onPointerMove` / `onPointerUp` 三个函数体，
  以及 JSX 里加一行 `<SelectionBox />`。不动组件结构、不动文件头注释、不动 `normalise()`。
- **`styles.css`**：新样式全部追加到文件末尾的独立段落，类名前缀 `.sel-`。不碰 `.stage`、
  `.stage-inner`、`.view`、`.marquee` 已有的任何规则。
- **`doc-controller.ts`**（仅 C 期）：只新增 `ratio()` 和 `hitTest()`，追加在 `pickColor` 之后。
  不改 `toCanvas` / `toScreen` / `setZoom`。
- **`store.ts`**：只新增派生纯函数与 `region` 字段；`hoverId` **不进这个 store**（§7.4）。

**排期**：A 期与缩放**零交集**，随时可开。B 期两处交集都是追加式改动，可并行。
C 期建议等缩放 Phase 1 合入（要动 `doc-controller.ts`，且需在真实缩放下验一遍对齐）。

## 3. 核心模型：一个目标，两个轴

### 3.1 两个轴

一次操作的地址由两部分组成，两者同时存在、互不排斥：

```
        目标 = 图层集   ×   区域
                 │            │
                 │            └── 画布上的一块像素范围，可带 mask
                 └── 图层 id 列表

   移动 / 改属性 / 显隐 / 重排    取图层集      忽略区域
   裁剪 crop                     忽略图层集    取区域
   生成式填充 / 局部重绘          两个都取      区域=画哪，图层集=读谁当上下文、结果落到谁身上
   导出                          两个都忽略
```

### 3.2 空不是错误态，是有定义的默认值

| 图层集 | 区域 | 含义 |
| --- | --- | --- |
| 有 | 空 | 这些图层的**全部**范围 |
| 空 | 有 | **所有图层**，在这块区域内——也就是合成结果。**生成类操作要的正是这个默认** |
| 有 | 有 | 交集 |
| 空 | 空 | 整个文档 |

这条很重要：否则用户会被「请先选中图层」反复卡住，而「圈一块让 agent 重画」这个最常见的诉求
恰恰是不需要先选图层的。

### 3.3 工具写轴，不是切换模式

| 工具 | 写入哪个轴 |
| --- | --- |
| 移动 / 选择 | 图层集 |
| 框选 / 套索 / 魔棒 | 区域 |
| 取色 | 都不写 |

两个轴始终同时可见、**互不清除**。它们从来不竞争，因为不同的仪器写不同的轴。这就是「如何同时
满足两个诉求」的答案——不需要用户事先决定「我这次是要选图层还是选区域」。

### 3.4 为什么不能做成「选图层 or 选区域」二选一

因为 **PSD 的图层不是 DOM 元素**，套 DOM 的选择直觉会连着错两次。

DOM 里点击选元素之所以可靠，靠的是四个前提：元素是嵌套的盒子、基本不重叠、每个都是视觉上有意义
的东西、命中一点有唯一的最深元素。PSD 一条都不满足：

| DOM | PSD | 后果 |
| --- | --- | --- |
| 元素 = 一个视觉物体 | 一个视觉物体常是好几层（线稿 + 色块 + 阴影 + 叠加纹理） | 点哪一层都「不完全对」 |
| 父元素是空间容器 | 组是**渲染作用域**（混合/不透明度/蒙版），不是空间容器 | 已核实 `psd/load.ts:230`：组的 bounds 在文件里通常就是 `0,0,0,0`，它没有自己的空间（§5.3） |
| 元素基本不重叠 | 图层是绘制顺序栈，任意重叠 | 背景层覆盖全画布，「最上面那个命中的图层」几乎永远有答案，但经常没用 |
| 每个元素都可指 | 调整层作用于整个背景 | 根本指不到 |

两个直接结论：

1. **画布点击选图层是「便捷方式」，不是「主要工具」。** 图层树才是图层轴的主要仪器，因为真实结构
   在那里。画布点击必须承认歧义并提供消歧手段（§5.5），而不是假装单击一定选对。
2. **用户真正想指的东西，经常根本不是图层，而是一块区域。** 所以区域轴不能是图层轴的附属品，
   它得是平级的一等公民，并且要能表达非矩形（§4.1）。

### 3.5 数据流

```
框选/套索拖动 ──→ setState({ region })  ─┐
                                          │
画布点击 ──→ toCanvas ──→ hitTest ──┐     │
                                    ├──→ 目标 = { layers, region } ──→ context-bar 把它读成一句话
图层树行点击 ────────────────────────┘     │                        ──→ SelectionBox 画两个轴
                                          │                        ──→ composer 送给 agent（§4.3）
载入图层 alpha 为区域（§6.1）─────────────┘                        ──→ crop / transform / set_props
区域 → 相交图层（§6.2）──────────────────┘
```

## 4. 区域轴

### 4.1 表示：从一开始就带 mask 位

人想说「这个物体」的时候，画出来的是套索或涂抹，不是矩形。**矩形是退化情况，不是基本情况。**

```ts
export interface Region {
  /** 外接矩形，[top,left,bottom,right]，文档像素。永远存在。 */
  bounds: Rect;
  /** 逐像素覆盖度（0..255），尺寸 = bounds 的宽高。矩形区域时为 null。 */
  mask: Uint8ClampedArray | null;
  /** 产生它的手势，决定 UI 怎么描述它，也决定能不能反向编辑 */
  source: "rect" | "lasso" | "wand" | "layerAlpha";
}
```

即使 A 期只做矩形（`mask: null`），**结构里也要留着 mask 位**。否则套索落地时，从 `Rect` 改成
`Region` 会波及每一个消费方——`crop`、context-bar、composer、覆盖层，全部返工。

`store.ts` 里 `marquee: Rect | null` 改名为 `region: Region | null`。`crop` 取 `region.bounds`
（裁剪本来就只能是矩形），语义不变。

### 4.2 现状核实：读取侧全是矩形，写入侧已经是区域形状的

| | 现状 | 能否承载带 mask 的区域 |
| --- | --- | --- |
| `store.marquee` | `Rect` | 否，要改 |
| `crop(rect)` | 矩形 | 不需要，裁剪本就是矩形 |
| `getPreview{rect}` | 矩形 | 否——套索区域给 agent 看只能退化成外接矩形 |
| `generativeFill` | 插入「bounds = 区域、alpha 任意」的栅格层 | **能**，已核实 `tools.ts:256` |
| `editMask` / `mask_edit` | 逐像素灰度覆盖 | **能**，已核实 `tools.ts:245` |

也就是说，**带 mask 的区域在文档模型里已经能表达**，缺的是选择侧的表示（§4.1）和送达 agent 的
通道（§4.3）。这是个好消息：区域轴不需要动 `doctype-psd` 的模型。

### 4.3 送给 agent 的地址

agent 要把「框中的这块重新生成」做对，需要四样东西：

```
{ bounds,                    // 外接矩形，getPreview{rect} 能用
  mask,                      // 套索/魔棒时有；矩形时省略
  pixels: 区域内的合成结果,    // 或者让 agent 自己 getPreview
  layers: 与区域相交的图层清单 } // 「这块地方上面都有谁」
```

`getPreview{rect}` 只覆盖第一、三项。第二、四项没有通道。

**分两步走，因为代价差一个数量级：**

**A 期（矩形，零后端改动）**——把区域拼进 `instruction` 文本：

```
用户输入：把框中的天空换成晚霞
实际发出：[选区 bounds=[120,340,560,900]] 把框中的天空换成晚霞
```

已核实 `tools.ts:271` 的 operator 指令里明确写了「Every rectangle is bounds = [top, left, bottom,
right], in canvas pixels」，且 `getPreview{rect}` 就是给 agent 看局部用的。所以 agent **今天就能理解
并使用**这个矩形。图层清单同理可以拼成文本。**零协议改动、零后端改动**，A 期能独立交付。

**D 期（带 mask）**——需要改协议：`protocol-doc/src/http.ts:161` 的
`DocRunOperatorRequest.body` 从 `{ instruction }` 扩成 `{ instruction, region? }`，mask 作为 blob
经 CAS 传递（不要塞进 JSON）。这是跨包改动，需要单独设计，本文只标出位置和形状。

A 期的文本拼接是**明确的权宜之计**，不是终态。它的价值是让主线路今天就能跑通，并且在真实使用中
暴露出 agent 到底需要哪些字段——这比先设计协议再猜要可靠。

### 4.4 区域的分期

- **A 期**：矩形（已有的框选工具），改成 `Region` 结构，送达 agent
- **D 期**：套索、魔棒；`mask` 真正被填充；协议扩展

## 5. 图层轴

### 5.1 命中测试分级

| | 做法 | 精度 | 代价 |
| --- | --- | --- | --- |
| **B 期** | 主线程遍历包围盒，自上而下取第一个命中 | 透明区会误选 | 零新增管线 |
| **C 期** | Worker 内按 alpha 采样 | 与 Photoshop 自动选择一致 | 一次 postMessage 往返 |
| 不做 | 合成时并行产出「每像素属于哪层」的 ID 缓冲区 | 精确且 O(1) | 瓦片内存翻倍、每次编辑多一遍失效；混合模式下「这像素属于谁」本身有歧义 |

B 期的缺陷是真实的：PSD 里大量图层是「整画布尺寸、大部分透明」，只看包围盒会让点空白处选中一个
看不见的图层。B 期只是让交互链路先闭环，C 期才是要长期留下的实现。

### 5.2 接口从一开始就是异步的

B 期同步、C 期异步的话，切换时所有调用方都要改。所以接口一开始就按 C 期的形状定，B 期直接
resolve：

```ts
// packages/web-psd/src/ui/hit-test.ts（新增）
export interface Hit {
  layerId: string;   // 命中的叶子图层
  path: string[];    // 最外层组 → 叶子的完整祖先链，末位 === layerId
}
export type HitTester = (x: number, y: number) => Promise<Hit | null>;
```

`path` 由调用方决定取哪一级（§8 的单击 / 双击 / Cmd+单击 三种语义），命中本身不做这个决定。

**指针捕获必须同步调用。** `hitTest` 是异步的，但 `setPointerCapture` 要在 `pointerdown` 处理函数
里同步调用，且 `e.currentTarget` 在处理函数返回后就没了。顺序是：先同步取 `currentTarget` 和
`pointerId` 并 `setPointerCapture`，再 `await hitTest`，没命中就 `releasePointerCapture`。

### 5.3 组的包围盒必须前端算

**已核实**：`psd/load.ts:230` 对所有图层一律取 ag-psd 的 `top/left/bottom/right`，而 PSD 里的组
（section divider）通常报 `0,0,0,0`。所以 `layer.bounds` 对组**不可用**——这也是 §3.4「组不是空间
容器」的直接证据。

组的矩形按子图层并集算，规则与 `render/region.ts:24-29` 一致：

```ts
export function layerBox(layer: LocalLayer): Rect | null;
// 组：递归子层 layerBox 的并集，无可见子层则 null
// 非组：layer.bounds
```

选中框用 `bounds` 而**不是** `layerInfluenceBounds`（`region.ts:14`）。后者算上了描边外扩和投影偏移，
一个带大投影的图层选中框会飘出去一大圈；Photoshop 的变换框也是贴着 `bounds` 的。

### 5.4 语义细则

**堆叠顺序**：已核实 `render/composite.ts:108` 是 `for (i = 0; i < layers.length; i++)` 逐层往上叠，
所以 **`layers[0]` 是最底层、数组末尾是最上层**。命中测试从数组末尾往前走，递归进组。

**跳过**：不可见图层（`visible === false`）、锁定图层（`locked`）、调整图层（`type === "adjustment"`，
它作用于整个背景，永远不该被点中）。

**剪贴蒙版**（`clipping === true`）：它在屏幕上被下方基底的 alpha 裁掉，但它自己的 alpha 在被裁掉的
区域仍然非零。只判它自己会在肉眼看不见的地方选中它，所以命中时要与基底的 alpha 相与。B 期的包围盒
版本做不到，是 B 期已知的不精确之一。

**阈值**：C 期的判定是 `图层 alpha × 蒙版 alpha × opacity × fillOpacity ≥ 阈值`，阈值取 `8/255`——
不取 0 是为了不被几乎透明的辉光边缘选中。

**容差**：点击判定的宽容度写成 CSS 像素常量（建议 3px），使用时乘 `ratio` 换成文档像素。
缩到 25% 时那就是 12 个文档像素。**写死成文档像素的话缩小后就点不中细图层了。**

### 5.5 消歧：画布点击是便捷方式，不是唯一入口

按 §3.4，一次点击命中多个「都说得通」的图层是 PSD 的常态，不是边缘情况。所以：

- **图层树保持为图层轴的主要仪器**，画布点击是快捷方式；
- **Alt + 单击循环**光标下的图层栈（第二次点同一处取下一个候选，到底后回到最上）；
- **右键列出**光标下所有命中的图层，让用户直接挑；
- 上述候选栈就是命中测试自上而下走出来的那一串，不需要额外计算。

不做「智能猜测用户想要哪一层」——猜错的代价（选中了看不见的东西并且拖动了它）远大于多点一次。

### 5.6 C 期的实现位置

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
  `WorkerResponse` 加 `{ type: "hit"; id; layerId: string | null }`。走现有串行队列，不与
  `applyOp` / `tiles` 交错。
- `RenderCore` 现在（`render-core.ts:16`）把 `store` 和 `cache` 内联进 `IncrementalCompositor` 就把
  引用丢了。改成存成字段，再加 `hitTest(x, y, threshold)`，用
  `resolvePixels(layer.pixels, store, cache)` 取像素。
- **不改 `IncrementalCompositor`，不合成任何东西。** `prefetch()` 已经把所有图层烤热，这里全是缓存
  命中，单次开销是一次 postMessage 加若干次数组下标读取。
- 蒙版像素在 `deserialize` 之后就是常驻的（见 `resolve.ts:36-39` 的注释），直接可读。

## 6. 两轴之间的转换

这是让两个诉求「同时满足好」的关键——不是各做各的，而是能互相转过去。有了这两条，用户不需要
事先决定要选哪种，选错了一键换轴。

### 6.1 图层 → 区域：载入图层 alpha 为选区

Photoshop 里 Cmd 点图层缩略图。**用户指着一个「东西」，拿到一块「区域」，然后说「把这个重新生成」**
——这一针把 §3.4 的两个结论缝上了：图层不好指，但图层可以用来**生产**好指的区域。

```
选中图层 L → 载入为选区 → Region {
  bounds: layerBox(L),
  mask:   L 的 alpha（× mask × opacity），裁到 bounds,
  source: "layerAlpha"
}
```

实现很便宜：与 §5.6 的 Worker alpha 命中是**同一套读取路径**，多的只是把整块 alpha 拷出来而不是
采样一个点。所以排在 C 期，紧跟 Worker 命中。

### 6.2 区域 → 图层：选中与区域相交的所有图层

用户圈一块地方，然后想对底下的东西做图层级操作（一起隐藏、一起移动）。

用 `layerBox` 与 `region.bounds` 求交即可，不需要逐像素——这里宁可多选也不要漏选，用户可以再减。
纯前端纯函数，无成本，可以和 B 期一起做。

### 6.3 两条转换的 UI 落点

都放在 context-bar：区域存在时出现「选中区域内的图层」，图层选中时出现「载入为选区」。
不进工具条——它们是**动作**，不是工具。

## 7. 覆盖层渲染

### 7.1 定位契约

照抄 `selection-overlay.tsx:4-21` 已经写死的三条：

1. 几何量存**文档像素**，渲染时用 `toScreen` 换算——这样覆盖层不需要知道缩放是多少就能跟住画布。
2. 覆盖层是 canvas 的**兄弟节点**（在 `.stage-inner` 里），不是任何被 CSS 缩放的元素的子节点。
3. **chrome 尺寸不随缩放变化**：边框粗细、手柄大小只能写 CSS 像素常量，且**不许给覆盖层套
   `transform: scale()`**——否则 25% 时手柄小到抓不住、400% 时糊成一坨。

### 7.2 视觉区分

两个轴会同时出现在画布上，必须一眼分得开：

| | 画法 | 类名 |
| --- | --- | --- |
| 区域 · 矩形 | 蚂蚁线虚线 + 四角手柄（**保持现状，不动**） | `.marquee` |
| 区域 · 带 mask（D 期） | 沿 mask 轮廓的蚂蚁线；轮廓由 mask 描边得出，画进一张覆盖 `bounds` 的 `<canvas>`，不是 div | `.sel-region` |
| 图层选中 | 实线 1px `--accent` + 8 个手柄（四角 + 四边中点） | `.sel-box` |
| 悬停预选 | 实线 1px、更淡、无手柄 | `.sel-hover` |
| 多选 | 每个图层一个细边框（无手柄）+ 一个并集外框（有手柄） | `.sel-box` / `.sel-union` |

带 mask 的区域是唯一必须用 canvas 而不是 div 画的东西——但它仍然遵守 §7.1：这张 canvas 的**位图
按 CSS 像素尺寸开**（不是文档像素），mask 采样时按 ratio 换算。这样蚂蚁线的粗细依然是 CSS 像素。

手柄本期只有视觉，**不可拖**（拖手柄真的缩放图层依赖地基 5b）。不加 `cursor: nwse-resize`，
不做可缩放的暗示。

### 7.3 重新测量的触发（本设计的关键风险）

「缩放是量出来的，不是存的」这个不变量的代价是：**必须有人在 canvas 盒子变化之后通知覆盖层重新量，
而这个通知机制现在不存在。**

两类失效：

- **量早一帧**。缩放 Phase 1 落地后，`s.zoom` 变化走一次 `setState`，React 在同一次渲染里既给 canvas
  写新的 CSS 宽高、又渲染覆盖层；而覆盖层是在**渲染阶段**调 `getBoundingClientRect()` 的，那时新样式
  还没提交进 DOM，量回来的是旧盒子。选中框会停在上一档缩放的位置，且不会自愈——要等下一次无关的
  状态变化才对齐。`.marquee` 今天就有这个毛病，只是缩放还不生效所以看不出来。
- **连渲染都不触发**。窗口 resize（一旦有「适应窗口」模式）、浏览器页面缩放、设备像素比变化、缩放做了
  CSS 过渡动画的那几十帧——盒子变了但 store 没变，React 不重渲染，覆盖层整个脱节。

**解法**：给 canvas 挂 `ResizeObserver`，盒子一变就推一个版本号，覆盖层订阅它。它在布局之后触发，
天然躲开「量早一帧」；不关心变化原因，四类失效全覆盖；不需要覆盖层知道缩放是多少，与
「measured, never stored」完全一致。约 15 行。

不采纳：把覆盖层塞进被 `transform: scale()` 的容器里跟着缩（违反 §7.1 第 3 条）；让覆盖层直接读
`s.zoom` 自己乘（等于把 zoom 又存一份，正是 PR #38 刚拆掉的东西）。

归属待裁决，见 §13 第 2 条。

### 7.4 悬停不走全局 store

`store.ts:113` 明确说了订阅的是整个 state 对象，任何一次 `setState` 都会重渲染整棵树，包括几百行的
图层树。悬停是每次 `pointermove` 都变的，走全局 store 会把整棵树按帧重渲染。

`hoverId` 和 §7.3 的盒子版本号一起放进 `packages/web-psd/src/ui/overlay-store.ts`（新增），结构与现有
store 同构（`subscribe` / `getSnapshot` / `useSyncExternalStore`），**只有覆盖层订阅它**。一次悬停变化
的重渲染成本是一个 div。

命中测试本身用 `requestAnimationFrame` 节流，且只在移动工具下跑。

### 7.5 换算次数

`toCanvas` 每次调用读**两遍** `getBoundingClientRect`：`doc-controller.ts:203` 自己读一遍拿
`left/top`，`viewport.ratio()` 里面又读一遍拿 `width/height`。`toScreen` 读一遍。

今天只有拖动时每个 `pointermove` 调一次。加上悬停命中和选中框（每次渲染 2N 次换算）之后，建议：

- `DocController` 加 `ratio(): Ratio` 透传（C 期一并加）；
- 覆盖层每次渲染只读一次 ratio，然后用 `@unidocs/psd-client` 已导出的纯函数
  `canvasToScreen(ratio, x, y)` 批量换算。

不违反契约——契约要的是「共用同一套映射」，不是「每次都重新量」。

## 8. 交互语义

| 操作 | 写哪个轴 | 结果 |
| --- | --- | --- |
| 移动工具单击图层 | 图层 | 选中命中路径的**最外层组**（`path[0]`） |
| 双击 | 图层 | 沿 `path` 下探一级 |
| Cmd / Ctrl + 单击 | 图层 | 直接选中叶子（`path` 末位） |
| Alt + 单击（重复） | 图层 | 循环光标下的图层栈（§5.5） |
| 右键 | 图层 | 列出光标下所有命中图层供挑选（§5.5） |
| Shift + 单击 | 图层 | 加选 / 减选（复用 `store.ts:123` 的 `nextSelection`） |
| 按在未选中的图层上并拖 | 图层 | **先选中它，同一次手势直接进入拖动**（今天要求先在树里选中） |
| 按在已选中的图层上并拖 | 图层 | 拖动当前整个选中集（现状） |
| 移动工具单击空白 | 图层 | 清空**图层集**，区域不动 |
| 框选 / 套索工具拖 | 区域 | 覆盖**区域**，图层集不动 |
| Esc | 两个 | 都清空 |

「单击空白只清图层集、不清区域」是 §3.3「互不清除」的直接体现——用户圈好了区域，再去点选图层，
区域不能因此消失。

## 9. 树↔画布同步

画布上选中之后，图层树要：

1. **展开所有祖先组**——`flattenTree`（`doc-model.ts:117`）只渲染 `expanded` 里的组的子层，不展开的话
   用户在树里根本看不到自己刚选的东西；
2. **滚动到该行**。

`path` 正好就是要展开的祖先组 id 列表，不需要再算一次。反向（树选中 → 画布）不需要额外动作，
覆盖层订阅同一份 `selection`。

## 10. 文件清单与分期

优先级按「产品主线 + 今天完全不存在」排，不按「实现由易到难」排。

### A 期 — 区域送达 agent（矩形，零后端改动，与缩放零交集）

主线路今天字面上不通（§1.1），且不依赖任何其他工作。

| 文件 | 改动 |
| --- | --- |
| `web-psd/src/ui/store.ts` | `marquee: Rect` → `region: Region`（§4.1），`mask` 恒为 null |
| `web-psd/src/ui/api.ts` | `runAgent` 增加可选 region 参数，拼进 instruction（§4.3） |
| `web-psd/src/ui/panels/composer.tsx` | 送出时带上当前目标 |
| `web-psd/src/ui/panels/context-bar.tsx` | 把当前目标读成一句话；「选中区域内的图层」入口（§6.2） |

### B 期 — 图层轴基础（两处交集均为追加式，可与缩放并行）

| 文件 | 改动 |
| --- | --- |
| `web-psd/src/ui/hit-test.ts` | **新增**：`layerBox`、`unionRect`、`boundsHitTest`、`layersIntersecting`（纯函数，无 DOM） |
| `web-psd/src/ui/overlay-store.ts` | **新增**：`hoverId` + 盒子版本号的独立小 store |
| `web-psd/src/ui/panels/selection-box.tsx` | **新增**：选中框 + 悬停框 + 手柄 |
| `web-psd/src/ui/panels/canvas-stage.tsx` | 改三个指针函数体；JSX 加一行 `<SelectionBox />` |
| `web-psd/src/ui/panels/layer-tree.tsx` | 展开祖先 + 滚动到选中行 |
| `web-psd/src/ui/styles.css` | 文件末尾追加 `.sel-*` 段 |

### C 期 — Worker alpha（建议等缩放 Phase 1 合入）

| 文件 | 改动 |
| --- | --- |
| `psd-client/src/render-core.ts` | 存 `store` / `cache` 字段；加 `hitTest`、`layerAlphaRegion` |
| `psd-client/src/render-worker.ts` | 加 `hitTest` / `layerAlpha` 请求与响应 |
| `psd-client/src/render-client.ts` | 对应方法 |
| `web-psd/src/doc-controller.ts` | 加 `ratio()`、`hitTest()`，追加在 `pickColor` 之后 |
| `web-psd/src/ui/hit-test.ts` | `boundsHitTest` 降级为兜底 |
| `context-bar.tsx` | 「载入为选区」入口（§6.1） |

### D 期 — 带 mask 的区域（需单独设计）

套索 / 魔棒工具；`Region.mask` 真正被填充；`.sel-region` 的 canvas 轮廓绘制；
`protocol-doc/src/http.ts` 的 `DocRunOperatorRequest.body` 扩展 + mask 经 CAS 传递；
橡皮筋框选图层；方向键微移。

## 11. 测试

`packages/web-psd/tests/` 新增：

- `hit-test.test.ts` — 纯函数，无 DOM：
  - 堆叠顺序（数组末尾优先命中）
  - 跳过不可见 / 锁定 / 调整图层
  - 组的包围盒是子层并集，**组自身 `bounds` 为 `[0,0,0,0]` 时仍然正确**（§5.3 的核实结论，必须兜住）
  - `path` 从最外层组到叶子
  - 容差按 ratio 缩放
  - `layersIntersecting` 宁可多选不漏选
- `selection-target.test.ts` — §3.2 四种空/非空组合各自解析成什么；单击空白只清图层集不清区域
- `selection-box.test.tsx` — 选中 N 个图层出 N 个框 + 1 个并集框；`ratio ≠ 1` 时位置正确；
  chrome 尺寸不随 ratio 变化
- `canvas-stage-select.test.tsx` — 按下即选并拖；Shift 加选；双击下探；Alt 循环
- `composer.test.tsx` — 有区域时 instruction 带上 bounds，无区域时不带
- `layer-tree.test.tsx`（已存在）补：画布选中后祖先组自动展开

`packages/psd-client/tests/` 新增（C 期）：

- `render-core-hit.test.ts` — alpha 阈值；蒙版参与判定；剪贴蒙版与基底相与；调整图层不命中
- `render-core-alpha-region.test.ts` — 载入的 alpha 区域尺寸等于 `layerBox`，opacity 参与相乘

## 12. 风险

| 风险 | 缓解 |
| --- | --- |
| 与缩放 Phase 1 改到同一个文件 | §2 的边界；A 期零交集；B 期两处交集都是追加式；C 期排在缩放之后 |
| ResizeObserver 两边都没做，覆盖层在缩放后错位 | §13 第 2 条需在开工前裁决；本设计带兜底方案 |
| A 期的文本拼接被当成终态，D 期的协议扩展一直不做 | 在 §4.3 和代码注释里都写明是权宜之计；A 期上线后收集 agent 实际需要哪些字段，用真实数据推动协议设计 |
| B 期的包围盒命中让用户点空白选中透明图层，被当成 bug | B 期只是过渡；§5.5 的消歧手段能缓解；若 C 期排期不长可考虑跳过 B 期的命中部分 |
| 手柄看起来可拖但拖不动 | 与 UI 重构第一期对选区手柄的取舍一致：只做视觉，不加 `cursor: nwse-resize` |
| 悬停命中每帧一次 Worker 往返，掉帧 | rAF 节流 + 只在移动工具下跑；缓存上次结果，坐标仍落在同一图层包围盒内就不再发消息 |
| `Region` 结构改动波及 `crop` / context-bar 现有测试 | A 期一次改到位，`mask` 位先留空；晚改代价更大（§4.1） |

## 13. 待确认（review 时请裁决）

1. **图层树的排序方向。** 已核实 `composite.ts:108` 是 `layers[0]` 最底、末尾最上，而
   `flattenTree` 按数组顺序渲染、`LayerTree` 按顺序 map——也就是说**面板最上面那行是文档最底层**，
   与 Photoshop 相反。不是本设计引入的，但和选中直接相关（用户点画布最上层的图层，树里高亮的却是
   列表最下面那行）。本期顺手改掉（`flattenTree` 里翻转），还是单独一条？

2. **覆盖层重新测量（ResizeObserver）由谁做？** 展开说明如下。

   **问题**：PR #38 确立了「缩放是量出来的，不是存的」——覆盖层每次渲染调 `getBoundingClientRect()`
   现算屏幕坐标。代价是**必须有人在 canvas 盒子变化之后通知覆盖层重新量，而这个通知机制现在不存在**。
   两类失效（详见 §7.3）：

   - *量早一帧*：缩放 Phase 1 落地后，`s.zoom` 变化走一次 `setState`，React 在同一次渲染里既给 canvas
     写新的 CSS 宽高、又渲染覆盖层。覆盖层在**渲染阶段**读盒子，那时新样式还没提交进 DOM，量到的是
     旧盒子。选中框会停在上一档缩放的位置，且不会自愈——要等下一次无关的状态变化才对齐。
   - *连渲染都不触发*：窗口 resize（一旦有「适应窗口」模式）、浏览器页面缩放、设备像素比变化、
     缩放若做了 CSS 过渡动画的那几十帧。盒子变了但 store 没变，React 不重渲染，覆盖层整个脱节。

   **解法**（两边没有分歧）：给 canvas 挂 `ResizeObserver`，盒子一变推一个版本号，覆盖层订阅它。
   它在布局之后触发，天然躲开「量早一帧」；不关心变化原因，四类失效全覆盖；不需要覆盖层知道缩放是
   多少，与「measured, never stored」一致。约 15 行代码。

   **待裁决的是归属，不是做法。** 两个候选：

   | | 归缩放 Phase 1 | 归本设计（选择） |
   | --- | --- | --- |
   | 理由 | 问题是缩放引入的；`.marquee` 今天就有这个毛病（只是缩放不生效所以看不出来），修了它也一起受益 | 选中框和区域轮廓是第一批会被用户盯着看的覆盖层，错位最刺眼 |
   | 落点 | 缩放 Phase 1 在改 canvas CSS 盒子的同一处 | `canvas-stage.tsx:36` 现有的 `useEffect`，版本号推进 `overlay-store.ts`（§7.4 新增的那个小 store） |
   | 风险 | 若缩放 Phase 1 不带它，覆盖层直接错位 | 若缩放那边也做了，两个 ResizeObserver 挂在同一个元素上，重复渲染 |

   **倾向**：归缩放 Phase 1。它是缩放的内在代价，且 `.marquee` 也需要。本设计带兜底方案，**但两边
   必须先确认，不能各做各的**——都做会挂两个观察者，都不做会让覆盖层在缩放后错位且不自愈。

   **需要 review 给出的结论**：归属方 + 若归缩放则本设计删掉 §7.3 的兜底段落。

3. **A 期把区域拼进 `instruction` 文本，是否可接受。** 已核实 agent 能理解
   `[top,left,bottom,right]`（`tools.ts:271`）并有 `getPreview{rect}` 去看，所以这条路今天就能跑通、
   零协议改动。代价是它是字符串约定，不是类型契约。替代方案是 A 期直接做协议扩展（§4.3 的 D 期部分），
   代价是主线路要多等一个跨包改动。

4. **单击选组还是选叶子**（§8 第一行）。Figma 是选最外层组，Photoshop 默认是选叶子。这里选了 Figma
   的语义，因为 PSD 的组嵌套通常很深，单击直接选叶子会让「拖一整组」很难触发。§5.5 的 Alt 循环和
   右键列表都能覆盖到叶子。

5. **`Region.mask` 用 `Uint8ClampedArray` 还是位图。** 前者简单、能表达羽化；后者省内存（1/8）但
   只能表达硬边。一个 4000×3000 的全画布 mask 用前者是 12MB，用后者 1.5MB。倾向前者——区域通常远
   小于画布，且羽化是迟早要的；但如果 D 期要支持「全选 + 羽化」这类场景，值得重新算一次。
