# web-psd 选择模型设计

日期：2026-08-31
分支：`feat/web-psd-selection`
依赖：画布缩放 Phase 0（PR #38）与 Phase 1（PR #39），**均已并入 main**。
　　　对应设计：`2026-08-31-web-psd-zoom-design.md`，其 §7 是写给本设计的契约。
状态：**0 / A / B / C 期已实现**（计划见 `docs/superpowers/plans/2026-08-31-web-psd-selection-model.md`，
　　　14 个任务，`3609310..393f518`）。**D 期（套索 / 魔棒 / mask 经 CAS 的协议扩展）仍待单独设计**，
　　　理由见 §4.3。落地过程中对本文的两处偏离已记在 §6.1 与 §4.3 的脚注意义上：
　　　`layerAlphaRegion` 不做剪贴限制（与 Photoshop 的 ⌘ 点缩略图一致，§6.1 原文也只说「× mask × opacity」）；
　　　`withTarget` 在图层集为空时按 §3.2 送「与区域相交的图层」，非空时送选中图层名。

> 修订记录：
> - 第一版题为「图层选中设计」，把「选图层」和「选区域」当成两件平行无关的事。那个框架错了，
>   见 §3.4。第二版改为一个目标、两个轴。
> - 第三版按缩放 Phase 1 的落地结果校验：覆盖层定位改用**百分比**（`rectStyle`），
>   原来的 ResizeObserver 方案作废（§7.3），开放问题 2 已解决（§13）。
> - **第五版（2026-09-01）：两个轴由「互不清除」改为「互斥」**，见 §3.3 的修订说明。
>   产品裁决，起因是实际跑起来后两个选择框同时出现让人困惑。§3.1 / §3.2 / §6 / §8 一并更新。
> - 第四版按 PR #40 的 review 意见修订：补三条状态生命周期（§3.6 失效策略、§5.4 选中集归一化、
>   §5.3 异步命中的手势状态机），mask 字节移出全局 store（§4.1），B 期不再交付包围盒命中（§5.1），
>   锁定图层改为可选中（§5.6），悬停命中改为可丢弃（§5.8），六条待裁决全部结案（§13），
>   行号统一对齐 `main` 7e161f5。

## 1. 背景与范围

### 1.1 现状（三条，均已核实）

**图层轴几乎不存在。** `store.ts:32` 的 `selection: string[]` 是唯一状态，但只有两个写入口——
图层树行点击（`layer-tree.tsx:31`）和降级徽标跳转（`top-bar.tsx:43`）。画布上点不出选中，选中了也
没有任何视觉反馈，移动工具还要求「先去树里选中再回画布拖」（`canvas-stage.tsx:103`）。

**区域轴只有一个矩形，且是死路。** `store.ts:36` 的 `marquee: Rect` 由框选工具产生，出口只有 `crop`。

**两个轴都没有送到 agent。** 已核实 `composer.tsx` / `chat-panel.tsx` / `api.ts` 里没有任何一处引用
`selection` 或 `marquee`；`api.ts:39` 的 `runAgent` 只发 `{ instruction }`，`protocol-doc/src/http.ts:161`
的 `DocRunOperatorRequest.body` 也确实只有 `instruction: string`。

**所以「帮我把框中的这块重新生成」这句话今天字面上不可能工作**——agent 收不到「框中」是哪。
这是本设计要补的最大的洞，也是第一版完全没有提到的。

**冷启动不再自动打开文档。** 缩放 Phase 1 的 `f122eb7` 改成了空状态起步：`s.doc` 初始为 `null`，
`canvasBoxStyle` 在无文档时返回 `display: none`（`canvas-stage.tsx:244`），画布区显示「还没有打开
文档」。所以命中测试、覆盖层、context-bar 都必须处理无文档态——不是边缘情况，是**默认的首屏**。

### 1.2 本设计交付

一个统一的选择模型（§3），以及它的两个轴：区域轴（§4）、图层轴（§5）、两轴之间的转换（§6），
覆盖层渲染（§7），交互语义（§8）。

### 1.3 明确不做

| 不做 | 原因 |
| --- | --- |
| 旋转 / 缩放手柄（拖手柄真的改图层内容） | 依赖第二期地基 5b（`composite.ts` 仿射重采样），见 UI 重构第一期设计 §2.3 |
| 沿 alpha 边缘 / 矢量路径描出非矩形**图层**轮廓 | 客户端只有 `vector.pathSummary`（子路径数、节点数），没有路径数据。注意这与 §4 的**区域** mask 是两件事，区域的非矩形是要做的 |
| 区域的羽化、扩展/收缩、布尔运算 | 等区域轴的基本通路跑通后再谈 |

## 2. 与缩放的文件边界

缩放 Phase 1 已并入 main（PR #39），**并发冲突的风险已经过去**，这里只剩三条要遵守的规则：

1. **`selection-overlay.tsx` 只 import `rectStyle`**（`selection-overlay.tsx:59`），不改它的逻辑与
   注释——它现在是定位契约的代码侧副本，注释里明写着给「handles, transform boxes, hover outlines」
   用。唯一例外是 A 期 `marquee` → `region` 改名要动它引用 `s.marquee` 的两行。
2. **`canvas-stage.tsx` 只改三个指针函数体 + JSX 加一行 `<SelectionBox />`**。不动文件头注释、
   两个 `useEffect`、`useLayoutEffect`（取 tile）、`normalise()`、`canvasBoxStyle()`。
   `styles.css` 同理：只往文件末尾追加 `.sel-*`。
3. **新模块保持单向依赖。** `tests/no-import-cycles.test.ts` 已经在守（覆盖 `src/` 全量）。缩放期间
   踩过一次：`controller.ts` ↔ `zoom-controller.ts` 互相 import，编译和类型检查都过，只在浏览器里
   表现为「功能存在但毫无反应」。`selection-box.tsx` → `selection-overlay.tsx` 这条边允许，
   只要后者永不反向 import（§13 第 6 条建议 B 期把 `rectStyle` 抽走，那条边随之消失）。

## 3. 核心模型：一个目标，两个轴

### 3.1 两个轴

一次操作的地址由两部分组成。两者**互斥**——任一时刻至多一个非空（§3.3）：

```
        目标 = 图层集   ×   区域
                 │            │
                 │            └── 画布上的一块像素范围，可带 mask
                 └── 图层 id 列表

   移动 / 改属性 / 显隐 / 重排    取图层集      忽略区域
   裁剪 crop                     忽略图层集    取区域
   生成式填充 / 局部重绘          取当前那个   有区域=画哪(图层清单由相交算出,§4.3);有图层集=对这些图层整体重绘
   导出                          两个都忽略
```

### 3.2 空不是错误态，是有定义的默认值

| 图层集 | 区域 | 含义 |
| --- | --- | --- |
| 有 | 空 | 这些图层的**全部**范围 |
| 空 | 有 | **所有图层**，在这块区域内——也就是合成结果。**生成类操作要的正是这个默认** |
| 空 | 空 | 整个文档 |

（「有 + 有」不存在——两个轴互斥，见 §3.3。）

这条很重要：否则用户会被「请先选中图层」反复卡住，而「圈一块让 agent 重画」这个最常见的诉求
恰恰是不需要先选图层的。

### 3.3 工具写轴，不是切换模式

| 工具 | 写入哪个轴 |
| --- | --- |
| 移动 / 选择 | 图层集 |
| 框选 / 套索 / 魔棒 | 区域 |
| 取色 | 都不写 |

**两个轴互斥：任一时刻至多一个非空。** 写区域会接管图层集，写图层集会接管区域。

> 修订（2026-09-01，产品裁决）：初版是「两个轴始终同时可见、互不清除」，理由是不必让用户事先
> 决定「这次是要选图层还是选区域」。实际跑起来之后否掉了——画布上同时出现两个选择框，用户第一
> 反应是「这两个不应该同时存在吧」。让工具决定写哪个轴这一点保留（§3.3 的表不变），但**产物只有
> 一个**：换工具画一笔，就是换了要指的东西。
>
> 代价说清楚：「这些图层 ∩ 这块区域」这个交集用例没有了。§6 的两条转换因此从「叠加一个轴」变成
> 真正的**转换**——区域→图层会清掉区域，图层→区域会清掉图层集。这反而让它们名副其实。

落点是两个既有的单一写入点，不需要新机制：`store.ts` 的 `setRegion` 与 `selectLayer` /
`setSelection`。`setRegion(null)` **不**清图层集——互斥之下那里本来就是空的，而且「清除选区」不该
读成「清除一切」。

### 3.4 为什么不能做成「选图层 or 选区域」二选一

因为 **PSD 的图层不是 DOM 元素**，套 DOM 的选择直觉会连着错两次。

DOM 里点击选元素之所以可靠，靠的是四个前提：元素是嵌套的盒子、基本不重叠、每个都是视觉上有意义
的东西、命中一点有唯一的最深元素。PSD 一条都不满足：

| DOM | PSD | 后果 |
| --- | --- | --- |
| 元素 = 一个视觉物体 | 一个视觉物体常是好几层（线稿 + 色块 + 阴影 + 叠加纹理） | 点哪一层都「不完全对」 |
| 父元素是空间容器 | 组是**渲染作用域**（混合/不透明度/蒙版），不是空间容器 | 已核实 `psd/load.ts:230`：组的 bounds 在文件里通常就是 `0,0,0,0`，它没有自己的空间（§5.5） |
| 元素基本不重叠 | 图层是绘制顺序栈，任意重叠 | 背景层覆盖全画布，「最上面那个命中的图层」几乎永远有答案，但经常没用 |
| 每个元素都可指 | 调整层作用于整个背景 | 根本指不到 |

两个直接结论：

1. **画布点击选图层是「便捷方式」，不是「主要工具」。** 图层树才是图层轴的主要仪器，因为真实结构
   在那里。画布点击必须承认歧义并提供消歧手段（§5.7），而不是假装单击一定选对。
2. **用户真正想指的东西，经常根本不是图层，而是一块区域。** 所以区域轴不能是图层轴的附属品，
   它得是平级的一等公民，并且要能表达非矩形（§4.1）。

### 3.5 数据流

```
框选/套索拖动 ──→ setState({ region })  ─┐
                                          │
画布点击 ──→ toCanvas ──→ hitTest ──┐     │
                                    ├──→ 目标 = { layers, region } ──→ context-bar 把它读成一句话
图层树行点击 ────────────────────────┘     │                        ──→ SelectionBox 画当前那个轴
                                          │                        ──→ composer 送给 agent（§4.3）
载入图层 alpha 为区域（§6.1）─────────────┘                        ──→ crop / transform / set_props
区域 → 相交图层（§6.2）──────────────────┘
```

### 3.6 失效策略：文档变了，两个轴谁还有效

**目标是长期状态，文档是会在它脚下变的。今天没有任何失效逻辑，两个轴都会静默地指向不存在或
错位的东西。** 这是 A 期第一天就会碰到的，不是边缘情况。

已核实的三条事实：

- `controller.ts:36` 的 `onDoc` 只写 `doc` / `version` / 条件性的 `sessionBaseVersion` 与 zoom，
  **从不碰 `selection` 和 `marquee`**；
- `controller.ts:76` 的 `createFrom` 成功后只清 `history` 和 `chat`，**`selection` / `marquee`
  原样留着**——打开第二个文档时，上一个文档的图层 id 和选区直接带过去；
- `geometry-ops.ts:15` 的 `crop` 改 `canvas.width/height`，并对所有图层 `shiftLayer(-left, -top)`。

最刺眼的后果：点完「裁到选区」之后，`region.bounds` 还是旧坐标系里的数，而 `rectStyle` 拿它除
**新**的 canvas 尺寸——覆盖层会画在一个既不是旧位置也不是新位置的地方。

| 触发 | 区域轴 | 图层轴 |
| --- | --- | --- |
| 打开新文档（`createFrom`） | 清空 | 清空 |
| `crop` / canvas 尺寸变化 | **清空**（见下） | 保留 |
| 图层被删（本地或 agent） | 保留 | 剔除死 id |
| 图层被平移（`transform`） | 保留 | 保留 |
| `/rollback` | 按上面逐条判定：回滚是一次普通的版本前进，`doc` 换了就照 `doc` 的差异走 | 同左 |

**`crop` 选择清空而不是重映射。** 重映射（`bounds` 减去 `[top,left]` 再裁到新画布）看起来更贴心，
但裁剪之后区域的语义本来就没了——用户刚把画布裁成了那块区域，再选中「那块区域在新画布里的位置」
是同义反复。清空更诚实，也更容易解释。

**图层轴用「剔除」而不是「清空」**：agent 删掉一个图层不该让用户其余的选中一起没。
`store.ts:142` 的 `selectedLayers` 今天已经静默过滤死 id，所以**画面上看不出问题，但
`s.selection` 里的死 id 会一直留着**，然后在「按下即选并拖」时被 `translateOps` 当成真 id 发出去。
所以剔除必须发生在 `selection` 本身，不能只靠 `selectedLayers` 过滤。

落点：`controller.ts` 的 `onDoc` 回调里，紧挨着现有的 `sessionBaseVersion` 判定——那里已经能区分
「新文档」和「同一文档变了」，正是做这件事的地方。

## 4. 区域轴

### 4.1 表示：从一开始就带 mask 位

人想说「这个物体」的时候，画出来的是套索或涂抹，不是矩形。**矩形是退化情况，不是基本情况。**

```ts
// 进全局 store：小、可序列化、值语义
export interface Region {
  /** 外接矩形，[top,left,bottom,right]，文档像素。永远存在。 */
  bounds: Rect;
  /** 产生它的手势，决定 UI 怎么描述它，也决定能不能反向编辑 */
  source: "rect" | "lasso" | "wand" | "layerAlpha";
  /** 逐像素覆盖度的句柄；矩形区域为 null。字节不在这里，见下。 */
  maskId: string | null;
}

// 不进全局 store：模块级的一张表，键是 maskId
// Uint8ClampedArray，尺寸 = bounds 的宽高，0..255
declare const maskBytes: Map<string, Uint8ClampedArray>;
```

**mask 的字节不能住在全局 store。** §7.4 的论证对它更成立：`store.ts:106` 的注释写明订阅的是整个
state 对象，而一个满画布 mask 是 12MB 的 `Uint8ClampedArray`。挂在 `UiState` 上意味着 `resetState`、
每个测试里的 state 快照（`store.test.ts` 的 `beforeEach` 就手写了整个 INITIAL）、以及将来任何 state
序列化都要专门绕过它。**现在写成句柄是零成本的**；D 期真做套索时再改，就是又一次波及所有消费方
——恰恰是本节自己要避免的那件事。

即使 A 期只做矩形（`maskId: null`），**结构里也要留着这个位**。否则套索落地时，从 `Rect` 改成
`Region` 会波及每一个消费方——`crop`、context-bar、composer、覆盖层，全部返工。

`store.ts` 里 `marquee: Rect | null` 改名为 `region: Region | null`。`crop` 取 `region.bounds`
（裁剪本来就只能是矩形），语义不变。

**改名的波及面（A 期必须一次做完）**：`marquee` 在 7 个测试文件里出现——`store.test.ts`、
`selection.test.tsx`、`canvas-stage-marquee.test.tsx`、`canvas-stage-overlay.test.tsx`、
`canvas-stage-drag.test.tsx`、`zoom-wheel.test.tsx`、`zoom-wiring.test.tsx`。
`store.test.ts` 的 `beforeEach` 手写了整个 INITIAL，必改。

**`ToolId` 里的 `"marquee"` 不跟着改名。** 工具叫「框选」是它的手势（拖一个矩形），状态叫 `region`
是它的产物；D 期加套索、魔棒时会有第二个、第三个工具写同一个 `region`，那时「工具名 ≠ 状态名」
反而是对的。今天看着别扭，是因为暂时只有一个工具。

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

但它是字符串约定不是类型契约，所以要把三件事写死：

**一、定界。** 用户输入里可能自带方括号。用一个不容易撞的包裹，并且**只在开头一次**：

```
<<selection bounds=[120,340,560,900] layers=["图层 3","天空"]>>
把框中的天空换成晚霞
```

**二、持久性——每轮都带，并且用户必须看得见。** region 是长期状态，Operator 是**有会话记忆**的
ReAct 循环（`api.ts:50` 的 `resetAgent` 注释写明它清的是「the Operator's in-memory conversation」）。
如果每轮静默附带，第二轮对话里 agent 会同时看到两个不同的 bounds，无从判断哪个是当前的。

决定：**每轮都带**（否则第三轮问「再往左一点」时 agent 已经不知道说的是哪块），但
**composer 上必须有一个可见的「已附带选区 120×340」chip，并且可以一键摘掉**。用户不能在不知情的
情况下把状态发出去。

**三、范围——A 期带图层清单，只带名字不带 id。** 图层名是 agent 能在 `getLayers` 结果里对上的东西，
id 对它没有意义还占长度。这一项已列进 §10 的 A 期文件表。

### 4.4 区域的分期

- **A 期**：矩形（已有的框选工具），改成 `Region` 结构，送达 agent
- **D 期**：套索、魔棒；`mask` 真正被填充；协议扩展

## 5. 图层轴

### 5.1 命中测试分级

| | 做法 | 精度 | 代价 |
| --- | --- | --- | --- |
| **C 期采用** | Worker 内按 alpha 采样 | 与 Photoshop 自动选择一致 | 一次 postMessage 往返 |
| 不做 | 主线程遍历包围盒，自上而下取第一个命中 | 透明区会误选 | 零新增管线 |
| 不做 | 合成时并行产出「每像素属于哪层」的 ID 缓冲区 | 精确且 O(1) | 瓦片内存翻倍、每次编辑多一遍失效；混合模式下「这像素属于谁」本身有歧义 |

**包围盒命中不作为过渡方案交付。** 前几版把它排在 B 期「让交互链路先闭环」，现在撤销：
PSD 里「整画布尺寸、大部分透明」的图层是常态，包围盒命中会让用户点在空白处选中一个看不见的图层
**并且把它拖走**。这比「画布上暂时点不了图层」糟得多，而且一定会被当成 bug 报回来——让一个已知
错误的交互见用户，换来的只是提前几天闭环。

于是 B 期的边界改为：**交付所有不依赖命中测试的东西**（选中框、悬停框、树↔画布同步、§6.2 的
区域→图层），画布点选等 C 期的 alpha 命中一起上。`layerBox` / `unionRect` / `layersIntersecting`
这几个纯函数 B 期照做，它们本来就不是命中测试。

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

### 5.3 异步命中与「按下即选、同一手势直接拖」的竞态

Worker 往返 20–30ms，这期间用户已经移动了十几个像素，甚至可能已经松手。**光处理
`setPointerCapture` 是不够的**，还要定死 await 期间到达的 `pointermove` / `pointerup` 怎么办。

两种写错的方式：

- 拿 hit **返回那一刻**的坐标当 `drag.from` → 图层会跳一下（跳过 await 期间累积的位移）；
- `pointerup` 先于 hit 落地 → drag 状态在手势结束**之后**才建立，表现为「松手了图层还跟着鼠标走」。

写死的顺序：

```
pointerdown  同步：记 anchor（此刻的文档坐标）、pointerId、setPointerCapture
             同步：pending = { anchor, pointerId, alive: true, latest: anchor }
             异步：hitTest(anchor)

pointermove  pending 还在 → 只更新 pending.latest，不派发任何 op
             drag 已建立 → 走正常的 translateOps 路径

pointerup    pending 还在 → pending.alive = false（保留对象，等 hit 回来收尾）
             drag 已建立 → 正常结束

hit 落地     !pending.alive → 整个丢弃：这是一次点击不是拖动，只更新 selection
             命中为 null   → 清空图层集，releasePointerCapture
             否则          → 以 pending.anchor（按下那一刻）为 drag.from 建立 drag，
                            并立刻按 pending.latest 补上累积位移，一次性发出
```

关键是**用按下那一刻的 anchor 而不是 hit 返回时的坐标**，再一次性补齐位移——这样图层的总位移
永远等于手指的总位移，不会因为 await 吃掉一段。

`canvas-stage.tsx` 现在的 `drag.current` 已经是 ref（不是 state，因为它每个 `pointermove` 都变且
不能触发重渲染），这条路径正好能容纳 `pending`，不需要新的状态机制。

### 5.4 选中集必须归一到互不为祖先的顶层集合

**已核实**：`geometry-ops.ts:12` 的 `shiftLayer` **递归子层**（`if (l.children) for (const c of
l.children) shiftLayer(c, dx, dy)`），而 `drag.ts:22` 的 `translateOps` 对选中集里**每个 id 各发一个
translate**。所以只要一个组和它的子层同时在选中集里，**子层会吃到两次位移**。

今天要先在树里 Shift 多选才构造得出来，属于既有 bug。但本设计把「单击选最外层组」+「Shift 加选」
+「按在未选中图层上直接拖」凑齐之后，**这会从边角变成常规路径**——用户选中一个组，再 Shift 点组里
的一个子层想「多选一个」，一拖就散架。

定死：**图层轴每次写入都归一化**，剔除任何祖先已在集合里的成员。

```ts
export function normalizeSelection(layers: LocalLayer[], ids: string[]): string[];
// 保留互不为祖先的成员；若 A 是 B 的祖先且两者都在，剔除 B
```

放在写入侧（`nextSelection` 之后）而不是拖动前，因为选中集本身就不该有这种状态：属性面板、
context-bar 的计数、送给 agent 的图层清单，全都会因为重复计入而说谎。

### 5.5 组的包围盒必须前端算

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

### 5.6 语义细则

**堆叠顺序**：已核实 `render/composite.ts:178` 的 `renderList` 是 `for (i = 0; i < layers.length; i++)`
逐层往上叠，所以 **`layers[0]` 是最底层、数组末尾是最上层**。命中测试从数组末尾往前走，递归进组。

**跳过**：不可见图层（`visible === false`）、调整图层（`type === "adjustment"`，它作用于整个背景，
永远不该被点中）。

**锁定图层可命中、可选中**，只是不能编辑——这是 Photoshop 的行为。跳过它意味着用户点在一个明明
看得见的图层上，却选中了它背后的东西，比选不中更让人困惑。拖动时不产生 op，context-bar 提示
「已锁定」。

补两条核实结论，都影响实现：

- **引擎里没有任何 op 检查 `locked`**（它只是 `layer-ops.ts:11` 的 `SETTABLE_PROPS` 里一个可写属性，
  没有任何地方读它来阻止编辑）。所以「拖动时不产生 op」**必须由前端强制**，不能指望后端拒绝。
- `psd/load.ts:308` 导入时硬编码 `locked: false`，只有属性面板的复选框能置位。所以今天它几乎恒为
  false——这条的优先级可以放低，但语义要先定对，免得以后反着改。

**剪贴蒙版**（`clipping === true`）：它在屏幕上被下方基底的 alpha 裁掉，但它自己的 alpha 在被裁掉的
区域仍然非零。只判它自己会在肉眼看不见的地方选中它，所以命中时要与基底的 alpha 相与。

**阈值**：C 期的判定是 `图层 alpha × 蒙版 alpha × opacity × fillOpacity ≥ 阈值`，阈值取 `8/255`——
不取 0 是为了不被几乎透明的辉光边缘选中。

**容差**：点击判定的宽容度写成 CSS 像素常量（建议 3px），使用时换成文档像素——缩放下限现在是 5%
（缩放设计 §5），5% 时 3 CSS px 就是 60 个文档像素。**写死成文档像素的话缩小后完全点不中东西。**
换算写法见 §7.5。

### 5.7 消歧：画布点击是便捷方式，不是唯一入口

按 §3.4，一次点击命中多个「都说得通」的图层是 PSD 的常态，不是边缘情况。所以：

- **图层树保持为图层轴的主要仪器**，画布点击是快捷方式；
- **Alt + 单击循环**光标下的图层栈（第二次点同一处取下一个候选，到底后回到最上）；
- **右键列出**光标下所有命中的图层，让用户直接挑；
- 上述候选栈就是命中测试自上而下走出来的那一串，不需要额外计算。

不做「智能猜测用户想要哪一层」——猜错的代价（选中了看不见的东西并且拖动了它）远大于多点一次。

### 5.8 C 期的实现位置

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
  `WorkerResponse` 加 `{ type: "hit"; id; layerId: string | null }`。
- `RenderCore` 现在（`render-core.ts:16`）把 `store` 和 `cache` 内联进 `IncrementalCompositor` 就把
  引用丢了。改成存成字段，再加 `hitTest(x, y, threshold)`，用
  `resolvePixels(layer.pixels, store, cache)` 取像素。
- **不改 `IncrementalCompositor`，不合成任何东西。** `prefetch()` 已经把所有图层烤热，这里全是缓存
  命中，单次开销是一次 postMessage 加若干次数组下标读取。
- 蒙版像素在 `deserialize` 之后就是常驻的（见 `doctype-psd/src/resolve.ts:36-39` 的注释），直接可读。

**悬停命中必须是可丢弃的，否则会和瓦片抢队列。** 已核实 `render-worker.ts:131` 是一条
`queue = queue.then(...)` 的**单串行链**——所有请求严格按到达顺序处理。而 §7.4 说悬停命中每帧一次：
平移或缩放时瓦片批次正在排队，悬停请求插在中间，两边互相拖慢。§12 那条「坐标仍落在同一图层包围盒
内就不再发消息」是有用的缓存，但它不解决阻塞。

分级：

| 请求 | 排队规则 |
| --- | --- |
| `applyOp` | 必须排队，不可丢（它是文档状态） |
| 显式点击命中 | 必须排队，不可丢（用户在等结果） |
| **悬停命中** | **可丢弃**：队列里已有未完成的悬停请求就**替换**而不是追加；瓦片批次在飞时直接跳过这一帧 |

丢掉一帧悬停高亮没有任何代价——下一帧就补上了。而让它排在一批瓦片后面，代价是高亮迟到几百毫秒。

## 6. 两轴之间的转换

两个轴互斥（§3.3），所以这两条是**在两个轴之间搬东西**，不是叠加：转过去之后，原来那个轴就空了。
用户不需要事先决定要选哪种，选错了一键换轴——这正是互斥能成立的前提。

### 6.1 图层 → 区域：载入图层 alpha 为选区

Photoshop 里 Cmd 点图层缩略图。**用户指着一个「东西」，拿到一块「区域」，然后说「把这个重新生成」**
——这一针把 §3.4 的两个结论缝上了：图层不好指，但图层可以用来**生产**好指的区域。

```
选中图层 L → 载入为选区 → Region {
  bounds: layerBox(L),
  source: "layerAlpha",
  maskId: 新句柄  ──→ maskBytes 表里存 L 的 alpha（× mask × opacity），裁到 bounds
}
```

实现很便宜：与 §5.8 的 Worker alpha 命中是**同一套读取路径**，多的只是把整块 alpha 拷出来而不是
采样一个点。所以排在 C 期，紧跟 Worker 命中。

这是 `maskBytes` 表（§4.1）的**第一个真实使用者**——比 D 期的套索更早。所以 §4.1 那个句柄结构
不是为将来预留，C 期就要用上。

### 6.2 区域 → 图层：选中与区域相交的所有图层

用户圈一块地方，然后想对底下的东西做图层级操作（一起隐藏、一起移动）。

用 `layerBox` 与 `region.bounds` 求交即可，不需要逐像素——这里宁可多选也不要漏选，用户可以再减。
纯前端纯函数，无成本，可以和 B 期一起做。

### 6.3 两条转换的 UI 落点

都放在 context-bar：区域存在时出现「选中区域内的图层」，图层选中时出现「载入为选区」。
不进工具条——它们是**动作**，不是工具。

## 7. 覆盖层渲染

### 7.1 定位契约

缩放设计（`2026-08-31-web-psd-zoom-design.md` §7）写死了四条，`selection-overlay.tsx` 的文件头
是同一份的代码侧副本。本设计**全部遵守**：

1. 几何量存**文档像素**，用 `rectStyle()` 输出为 containing block 的**百分比**。
2. 覆盖层是 canvas 的**兄弟节点**（在 `.stage-inner` 里），不是任何被 CSS 缩放的元素的子节点。
3. **chrome 尺寸不随缩放变化**：边框粗细、手柄大小只能写 CSS 像素常量，且**不许给覆盖层套
   `transform: scale()`**——否则 25% 时手柄小到抓不住、400% 时糊成一坨。
4. **命中测试用 `toCanvas()`**——它在**事件处理器**里调用，布局已经稳定，测量是安全的。

第 1 条和第 4 条的分工是这份契约的要点：**渲染阶段不测量（用百分比），事件处理器里才测量
（用 `toCanvas`）**。第一版设计把两者都放在测量一侧，那是错的，见 §7.3。

### 7.2 视觉区分

两个轴会同时出现在画布上，必须一眼分得开：

| | 画法 | 类名 |
| --- | --- | --- |
| 区域 · 矩形 | 蚂蚁线虚线 + 四角手柄（**保持现状，不动**） | `.marquee` |
| 区域 · 带 mask（D 期） | 沿 mask 轮廓的蚂蚁线，用 **SVG**（见下） | `.sel-region` |
| 图层选中 | 实线 1px `--accent` + 8 个手柄（四角 + 四边中点） | `.sel-box` |
| 悬停预选 | 实线 1px、更淡、无手柄 | `.sel-hover` |
| 多选 | 每个图层一个细边框（无手柄）+ 一个并集外框（有手柄） | `.sel-box` / `.sel-union` |

**带 mask 的区域用 SVG，不用 canvas。** div 画不了非矩形轮廓，但 canvas 会把 §7.1 的三条全部
打破：canvas 的位图尺寸必须按 CSS 像素开，也就是**必须测量**，于是又回到 §7.3 那个问题上。

SVG 同时满足三条，而且是免费的：

- `viewBox="0 0 docWidth docHeight"` —— 路径坐标直接用**文档像素**（第 1 条），不需要任何换算；
- SVG 元素本身用 `rectStyle()` 定位到 `bounds` 的百分比，浏览器在布局阶段解析（第 1 条）；
- `vector-effect: non-scaling-stroke` —— 描边粗细**不随 viewBox 缩放**，永远是 CSS 像素（第 3 条）。

轮廓从 mask 提取（marching squares 之类），得到的是文档像素坐标的路径，正好是 `viewBox` 要的东西。

手柄本期只有视觉，**不可拖**（拖手柄真的缩放图层依赖地基 5b）。不加 `cursor: nwse-resize`，
不做可缩放的暗示。

### 7.3 覆盖层为什么不测量（已由缩放 Phase 1 解决）

前两版把这里写成本设计的关键风险，并提议挂 `ResizeObserver`。**缩放 Phase 1 用更好的办法解决了，
本设计不再需要任何通知机制。** 记在这里是因为理由仍然承重——写新覆盖层的人必须知道为什么不能测量。

**问题**（真实存在过，`66718eb` 的提交信息记录了它）：覆盖层在**渲染阶段**调
`getBoundingClientRect()`，那时 React 还没把新的 canvas 尺寸提交进 DOM，量到的是**旧盒子**。
缩放后选中框停在旧位置，而且不会自愈——要等下一次无关的状态变化才对齐。另有一类连渲染都不触发：
窗口 resize、浏览器页面缩放、设备像素比变化、CSS 过渡的每一帧。

**解法**（已落地）：让覆盖层**不需要测量**。`.marquee` 绝对定位，containing block 是 `.stage-inner`
——无 padding、收缩包裹 canvas，其 padding box **就是** canvas 盒子。把矩形写成文档尺寸的百分比，
算术交给浏览器在布局阶段解析，按定义发生在新尺寸生效**之后**。

```ts
// selection-overlay.tsx:59 —— 直接 import，不要重新实现
export function rectStyle(rect: Rect, canvas: { width: number; height: number }):
  { left: string; top: string; width: string; height: string }
```

比 ResizeObserver 好在三点：没有额外渲染；没有需要人记得去维护的通知路径；将来的常驻「适应窗口」
模式和 CSS 过渡**自动**被覆盖，而不是靠有人想起来把它们接进观察者。

**对本设计的直接后果**：

- 选中框、悬停框、并集框、手柄容器，全部用 `rectStyle` 定位，**一律不在渲染阶段调 `toScreen`**；
- `overlay-store.ts` 不再需要盒子版本号，只剩 `hoverId`（§7.4）；
- `toScreen` 仍然是事件处理器里的正确工具（契约第 4 条），只是覆盖层用不到它了。

顺带作废的另外两条：把覆盖层塞进被 `transform: scale()` 的容器里跟着缩（违反契约第 3 条）；
让覆盖层直接读 `s.zoom` 自己乘（等于把 zoom 又存一份）。

### 7.4 悬停不走全局 store

`store.ts:106` 的注释明确说了订阅的是整个 state 对象，任何一次 `setState` 都会重渲染整棵树，包括几百行的
图层树。悬停是每次 `pointermove` 都变的，走全局 store 会把整棵树按帧重渲染。

`hoverId` 放进 `packages/web-psd/src/ui/overlay-store.ts`（新增），结构与现有 store 同构
（`subscribe` / `getSnapshot` / `useSyncExternalStore`），**只有覆盖层订阅它**。一次悬停变化的
重渲染成本是一个 div。

（§7.3 原本要放进这个 store 的盒子版本号已经不需要了，所以这个模块只有一个字段。它仍然值得单独
存在——把 `hoverId` 放进主 store 就会按帧重渲染整棵图层树。）

命中测试本身用 `requestAnimationFrame` 节流，且只在移动工具下跑。

### 7.5 换算次数

`toCanvas` 每次调用读**两遍** `getBoundingClientRect`：`doc-controller.ts:229` 自己读一遍拿
`left/top`，`viewport.ratio()` 里面又读一遍拿 `width/height`。

§7.3 落地后，**覆盖层一次都不调**（改用百分比），所以第二版担心的「每次渲染 2N 次换算」不存在了。
剩下的调用点只有事件处理器：拖动每个 `pointermove` 一次、悬停命中每帧一次。这个量级不需要优化。

唯一还需要 ratio 的地方是**命中容差**（§5.6：3 CSS px 要换成文档像素）。两种写法：

```ts
// 甲：不加任何 API，两次 toCanvas 相减
const tol = c.toCanvas(clientX + 3, clientY).x - c.toCanvas(clientX, clientY).x;

// 乙：DocController 加 ratio() 透传
const tol = 3 * c.ratio().x;
```

甲是 4 次布局读、零新 API；乙是 1 次、多一个方法。**倾向甲**——容差每次手势只算一次，不在热路径上，
不值得为它扩接口。若 C 期发现别处也要 ratio，再加乙。

## 8. 交互语义

| 操作 | 写哪个轴 | 结果 |
| --- | --- | --- |
| 移动工具单击图层 | 图层 | 选中命中路径的**最外层组**（`path[0]`），但见下面的降级 |
| 双击 | 图层 | 沿 `path` 下探一级 |
| Cmd / Ctrl + 单击 | 图层 | 直接选中叶子（`path` 末位） |
| Alt + 单击（重复） | 图层 | 循环光标下的图层栈（§5.7） |
| 右键 | 图层 | 列出光标下所有命中图层供挑选（§5.7） |
| Shift + 单击 | 图层 | 加选 / 减选（复用 `store.ts:123` 的 `nextSelection`） |
| 按在未选中的图层上并拖 | 图层 | **先选中它，同一次手势直接进入拖动**（今天要求先在树里选中） |
| 按在已选中的图层上并拖 | 图层 | 拖动当前整个选中集（现状） |
| 移动工具单击空白 | 两个 | 取消——互斥之下只有一个轴非空，所以「点空白」要能取消到它 |
| 框选 / 套索工具拖 | 区域 | 写**区域**，并接管图层集（清空它） |
| Esc | 两个 | 都清空 |

「单击空白取消当前那个轴」是 §3.3 互斥的直接体现：只有一个轴会非空，取消就该取消到它。
如果只清图层集，画在空白处的区域就会变成点不掉的残留。

**「选最外层组」的降级：整个文件只有一个总组时选叶子。** PSD 里「所有内容装在一个总组里」很常见，
这时 `path[0]` 就是那个总组，选中它等于选中一切——选中框贴着画布边框，零信息量，而且拖动会平移
整篇文档。规则：**`layerBox(path[0])` 的面积超过画布的 80% 时，下探一级**（必要时递归，直到面积
低于阈值或到达叶子）。

阈值而不是「是否唯一顶层组」，因为一个占满画布的背景组和一个总组对用户是同一个体验问题。

## 9. 树↔画布同步

画布上选中之后，图层树要：

1. **展开所有祖先组**——`flattenTree`（`doc-model.ts:117`）只渲染 `expanded` 里的组的子层，不展开的话
   用户在树里根本看不到自己刚选的东西；
2. **滚动到该行**。

`path` 正好就是要展开的祖先组 id 列表，不需要再算一次。反向（树选中 → 画布）不需要额外动作，
覆盖层订阅同一份 `selection`。

## 10. 文件清单与分期

优先级按「产品主线 + 今天完全不存在」排，不按「实现由易到难」排。

### 0 期 — 图层树排序方向（一个提交，先于 A 期）

§13 第 1 条的裁决结论。`flattenTree` 里反转每一层 `list`（不是反转 `out`），一个纯函数改动 +
一条 `doc-model.test.ts` 断言。单独一个提交，因为它和选择模型无关，只是被它暴露出来。

| 文件 | 改动 |
| --- | --- |
| `web-psd/src/doc-model.ts` | `flattenTree` 每层倒序遍历 |
| `web-psd/tests/doc-model.test.ts` | 断言面板第一行是文档最上层 |

### A 期 — 区域送达 agent（矩形，零后端改动）

主线路今天字面上不通（§1.1），且不依赖任何其他工作。

| 文件 | 改动 |
| --- | --- |
| `web-psd/src/ui/store.ts` | `marquee: Rect` → `region: Region`（§4.1），`maskId` 恒为 null |
| `web-psd/src/ui/controller.ts` | **`onDoc` / `createFrom` 里的失效策略（§3.6）** |
| `web-psd/src/ui/api.ts` | `runAgent` 增加可选 region 参数，按 §4.3 的定界拼进 instruction |
| `web-psd/src/ui/panels/composer.tsx` | 送出时带上当前目标；**「已附带选区」chip，可一键摘掉**（§4.3 二） |
| `web-psd/src/ui/panels/context-bar.tsx` | 把当前目标读成一句话 |
| `web-psd/src/ui/panels/selection-overlay.tsx` | 仅改引用 `s.marquee` 的两行；**不动** `rectStyle` 与契约注释 |
| `web-psd/src/ui/panels/canvas-stage.tsx` | 仅 `onPointerMove` 里那一处 `setState({ marquee })` |
| **7 个现有测试文件** | `marquee` → `region` 改名，清单见 §4.1 |

### B 期 — 图层轴基础（**不含画布点选**，见 §5.1）

| 文件 | 改动 |
| --- | --- |
| `web-psd/src/ui/hit-test.ts` | **新增**：`layerBox`、`unionRect`、`layersIntersecting`、`normalizeSelection`（纯函数，无 DOM） |
| `web-psd/src/ui/overlay-store.ts` | **新增**：`hoverId` 的独立小 store |
| `web-psd/src/ui/panels/selection-box.tsx` | **新增**：选中框 + 并集框 + 手柄，用 `rectStyle` 定位 |
| `web-psd/src/ui/store.ts` | `nextSelection` 之后接 `normalizeSelection`（§5.4） |
| `web-psd/src/ui/panels/layer-tree.tsx` | 展开祖先 + 滚动到选中行 |
| `web-psd/src/ui/panels/context-bar.tsx` | 「选中区域内的图层」入口（§6.2） |
| `web-psd/src/ui/styles.css` | 文件末尾追加 `.sel-*` 段 |

### C 期 — Worker alpha 命中 + 画布点选

| 文件 | 改动 |
| --- | --- |
| `psd-client/src/render-core.ts` | 存 `store` / `cache` 字段；加 `hitTest`、`layerAlphaRegion` |
| `psd-client/src/render-worker.ts` | 加 `hitTest` / `layerAlpha` 请求与响应；**悬停请求可替换**（§5.8） |
| `psd-client/src/render-client.ts` | 对应方法 |
| `web-psd/src/doc-controller.ts` | 加 `hitTest()`，追加在 `pickColor` 之后（`ratio()` 按 §7.5 暂不加） |
| `web-psd/src/ui/panels/canvas-stage.tsx` | 三个指针函数体：**§5.3 的手势状态机**；JSX 加一行 `<SelectionBox />` |
| `web-psd/src/ui/panels/context-bar.tsx` | 「载入为选区」入口（§6.1）；锁定图层提示（§5.6） |

### D 期 — 带 mask 的区域（需单独设计）

套索 / 魔棒工具；`maskBytes` 表被真正填充；`.sel-region` 的 SVG 轮廓绘制；
`protocol-doc/src/http.ts` 的 `DocRunOperatorRequest.body` 扩展 + mask 经 CAS 传递；
橡皮筋框选图层；方向键微移。

## 11. 测试

`packages/web-psd/tests/` 新增：

- `hit-test.test.ts` — 纯函数，无 DOM：
  - 堆叠顺序（数组末尾优先命中）
  - 跳过不可见 / 调整图层；**锁定图层仍可命中**（§5.6）
  - 组的包围盒是子层并集，**组自身 `bounds` 为 `[0,0,0,0]` 时仍然正确**（§5.5 的核实结论，必须兜住）
  - `path` 从最外层组到叶子
  - 容差按 ratio 缩放
  - `layersIntersecting` 宁可多选不漏选
  - **`normalizeSelection` 剔除祖先已在集合里的成员**（§5.4）
- `selection-target.test.ts` — §3.2 四种空/非空组合各自解析成什么；单击空白只清图层集不清区域；
  **无文档时不崩**（§1.1，空状态是首屏）
- `selection-invalidation.test.ts` — §3.6 的整张表：
  - `crop` 之后区域被清空，且 `rectStyle` 不会拿旧 bounds 除新画布
  - agent 删图层之后 `s.selection` 里的死 id 被**剔除**（不只是 `selectedLayers` 过滤掉）
  - 打开第二个文档时两个轴都清空
  - 图层平移不影响任何一个轴
- `drag-normalize.test.ts` — 组和子层同时在选中集里时，**子层只位移一次**（§5.4 的双重平移）
- `hit-race.test.tsx` — §5.3 的手势状态机：await 期间的 `pointermove` 不丢；`pointerup` 先到时
  整个手势降级为一次点击；drag 建立后的总位移等于手指总位移
- `selection-box.test.tsx` — 选中 N 个图层出 N 个框 + 1 个并集框。
  **断言的是百分比字符串，不是像素**：jsdom 不做布局，像素定位在这里根本测不了，而百分比就写在
  inline style 里，「缩放不改变它」这条恰恰是可以直接断言的（`canvas-stage-overlay.test.tsx` 已经
  用这个办法测 `.marquee`，照抄即可）
- `canvas-stage-select.test.tsx` — 按下即选并拖；Shift 加选；双击下探；Alt 循环
- `composer.test.tsx` — 有区域时 instruction 带上 bounds，无区域时不带
- `layer-tree.test.tsx`（已存在）补：画布选中后祖先组自动展开

`packages/psd-client/tests/` 新增（C 期）：

- `render-core-hit.test.ts` — alpha 阈值；蒙版参与判定；剪贴蒙版与基底相与；调整图层不命中
- `render-core-alpha-region.test.ts` — 载入的 alpha 区域尺寸等于 `layerBox`，opacity 参与相乘

## 12. 风险

| 风险 | 缓解 |
| --- | --- |
| 与缩放改到同一个文件 | 缩放 Phase 1 已合入，主要风险已过去；§2 记录了剩余接触面 |
| 新覆盖层照第一版的写法在渲染阶段调 `toScreen`，缩放后错位 | §7.1 契约第 1/4 条 + §7.3 的理由；`selection-box.test.tsx` 断言百分比，写错了测试会红 |
| 新增模块引入 import 环，编译通过但浏览器里静默失效 | `tests/no-import-cycles.test.ts` 已经在守；§2 给了单向依赖规则 |
| A 期的文本拼接被当成终态，D 期的协议扩展一直不做 | 在 §4.3 和代码注释里都写明是权宜之计；A 期上线后收集 agent 实际需要哪些字段，用真实数据推动协议设计 |
| 手柄看起来可拖但拖不动 | 与 UI 重构第一期对选区手柄的取舍一致：只做视觉，不加 `cursor: nwse-resize` |
| 悬停命中每帧一次 Worker 往返，掉帧 | rAF 节流 + 只在移动工具下跑；缓存上次结果，坐标仍落在同一图层包围盒内就不再发消息；**悬停请求可丢弃**（§5.8） |
| `Region` 结构改动波及 `crop` / context-bar / 7 个测试文件 | A 期一次改到位，`maskId` 先留 null；晚改代价更大（§4.1） |
| B 期交付了选中框却点不了画布，用户以为坏了 | B 期的选中框仍可从图层树点出来，是净收益；context-bar 说明「画布点选即将到来」；这是 §5.1 撤掉包围盒命中的自觉代价 |
| 三条状态生命周期（§3.6 / §5.4 / §5.3）任何一条漏做，都表现为「偶发的诡异行为」而不是崩溃 | 三条各自有测试（§11）；共同点是都在**写入侧**收口，而不是靠读取侧过滤兜底 |

## 13. 裁决记录（PR #40 review）

六条全部有结论，不再有待裁决项。

1. **图层树排序方向 —— 本期一起改，单独一个提交，排在 A 期之前（0 期）。**
   已核实 `composite.ts:178` 的 `renderList` 按数组顺序自底向上叠，`layer-tree.tsx:8` 直接按
   `flattenTree` 顺序 map，所以面板第一行确实是文档最底层。不改的话，§9 的「画布选中 → 展开祖先 +
   滚动到该行」上线当天就会被当 bug。改法是 `flattenTree` 里反转每一层 `list`（不是反转 `out`）。

2. **覆盖层重新测量 —— 已由缩放 Phase 1 解决，做法见 §7.3。** 新覆盖层一律 import `rectStyle`，
   不得在渲染阶段调 `toScreen`。（理由留在 §7.3 而不是这里，因为它是持续有效的约束，不是历史。）

3. **A 期拼字符串 —— 可接受**，但要满足 §4.3 的三条约束：不易撞的定界、每轮都带且 composer 上有
   可摘掉的可见 chip、图层清单只带名字。

4. **单击选最外层组（Figma 语义）—— 采用，但加一条降级。** PSD 里常见「整个文件就一个总组」，
   这时选最外层组等于选中一切，选中框贴着画布边框、零信息量。**最外层组的 `layerBox` 面积超过画布
   80% 时降级为选叶子**（§8 已记录）。

5. **mask 用 `Uint8ClampedArray` —— 采用**，但真正的问题不是表示而是**它住在哪**：字节不进全局
   store，`Region` 只存 `maskId` 句柄。见 §4.1。

6. **`rectStyle` 抽到 `ui/overlay-geometry.ts` —— B 期开工时抽**，那时正好有两个消费方。
   **抽的时候把 `selection-overlay.tsx` 的定位契约注释一起搬过去**（或留一个明确指针），
   否则契约的文字和代码分家，正是 §12 那条风险要防的事。

### 未采纳的两条

- **「`canvasBoxStyle` 在 `canvas-stage.tsx:235` 不是 :244」** —— §1.1 引的 `:244` 是
  `return { display: "none" }` 那一行，正是那句话在说的事；`:235` 是函数声明。行号不改。
- **「`ToolId` 里的 `marquee` 要不要跟着改名」** —— 不改，理由见 §4.1 末尾：工具名描述手势，
  状态名描述产物，D 期会有多个工具写同一个 `region`。
