# web-psd 打开文件的加载反馈设计

日期：2026-09-01
分支：`feat/web-psd-open-loading`
前置：`2026-08-28-web-psd-ui-redesign-phase1-design.md`（三栏外壳、TopBar 状态行）

## 1. 背景

打开一个 PSD 的完整链路是：

```
TopBar 的「打开」→ <input type="file"> → controller.ts openFile(file)
  → controller.ts createFrom(bytes, label)
    → DocController.createFrom      onStatus("creating from x.psd…")
        POST /tenants/u1/docs/psd/  （fetch + FormData，整个文件上行）
      → DocController.initRender()  onStatus("loading a1b2c3d4…")
          loadDoc()                 拉 snapshot
          view.width/height = doc.canvas；onDoc(doc, version)
          new Worker(render-worker) + renderClient.init()   解码
          requestTiles(首屏)                                 首绘
                                    onStatus("v1 · a1b2c3d4")
```

全程唯一的对外反馈是 `top-bar.tsx:42` 那个 `<span className="mono status">`——右上角
10px 等宽小字。核对代码后确认四个问题：

1. **反馈在视野边缘。** 用户的眼睛在画布上，状态却在右上角，加载中和加载完在视觉上几乎
   没有区别。
2. **没有进度感。** 上传、服务端解析、拉 snapshot、解码 + 首绘四段时长差别极大（大 PSD
   的上传可达几十秒），对外却都只是一句话。
3. **交互没锁住。** 「打开」按钮加载期间可点，可以重复触发；「导出」只看
   `!s.docId || s.exporting`，加载中仍可对**正在被替换的旧文档** flush + 导出；图层树、
   属性面板、工具条、聊天发送同理。
4. **file input 的 value 没清。** 同一个文件连选两次，第二次不触发 `change`，看起来像点了
   没反应。

另有一个**已知但本次不处理**的现象：`initRender` 在渲染之前就 `onDoc`，于是
`stage-empty`「还没有打开文档」立刻消失、画布按新尺寸撑开却还是纯白，要等 worker init +
首屏 tile 才有像素。这个顺序是 load-bearing 的（doc-controller.ts:102-117 的注释解释了
调换会让新文档被画进旧文档的 CSS 盒子里），**不动**；这段白由第 3 节的遮罩盖掉。

## 2. 方案选择

### 2.1 进度粒度

各阶段的可测性：

| 阶段 | 可测吗 |
| --- | --- |
| 上传 PSD | 能，但需 `XMLHttpRequest` 的 `upload.onprogress` |
| 服务端解析入 CAS | 不能 |
| `loadDoc` 拉 snapshot | 能，`Content-Length` + 流式 reader |
| worker `init` 解码 | 不能，psd-client 未往外报 |
| 首屏 tile 绘制 | 能，`tiles.length` 已知，`onTile` 每块回调 |

**采用阶段制，不显示百分比。** 四个阶段里两个根本不可测，凑出来的百分比必然要靠估算填补，
结果就是经典的「卡在 87%」。阶段名本身已经回答了「现在在干什么、还剩几步」，而这正是问题 2
要的东西。

**但保留 4 段划分**，为此把 `createFrom` 里那一处 `fetch` 换成 `XMLHttpRequest`——只为
`upload.onload` 这一个事件，它标出「最后一个字节离开浏览器」的时刻，把「还在上传」和
「服务器在解析」分开。这两段恰好是整条链路里最长、且时长差别最大的两段；合成一段的话，大
文件下遮罩会在第一步停很久，进度感等于没有。

### 2.2 阶段状态放在哪

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **A** | store 加 `opening` 字段，DocController 经新回调驱动 | **采用** |
| B | 复用现有 `status` 字符串，前端解析文案判断阶段 | 否决 |
| C | 仿 `overlay-store.ts` 单开一个 store | 否决 |

**为什么是 A。** 四处禁用和遮罩要读的是同一个状态，主 store 是它们唯一的共同通路。

**为什么否决 B。** 靠字符串匹配定状态，文案一改状态就错。

**为什么否决 C。** `overlay-store.ts` 之所以独立，是因为 hover 每帧变化，进主 store 会
让整棵图层树重渲染。阶段一次打开只变 4 次，没有这个理由；而四处禁用都要读它，独立 store
反而要多接一条订阅。

### 2.3 遮罩挂在哪

**挂在 `.col-canvas`，不是 `.stage`。** `.stage` 是 `overflow: auto`，换文件时底下可能还
是上一个文档的滚动内容，`position:absolute; inset:0` 的子元素会跟着内容滚走。
（`.stage-empty` 用的正是这个写法，但它只在无文档、无滚动时出现，碰不到这个问题。）

挂在 `.col-canvas` 上并给它加 `position: relative`，遮罩连 stage 带 context bar 一起盖住，
且不随滚动跑掉。聊天栏和右侧面板不被遮挡——换文件是画布区的局部操作，全屏弹层对它偏重。

## 3. 设计

### 3.1 状态

`src/ui/store.ts`：

```ts
export type OpenPhase = "upload" | "parse" | "load" | "render";

export interface OpenProgress {
  phase: OpenPhase;
  /** 文件名与字节数,只供遮罩显示。 */
  name: string;
  bytes: number;
}

// UiState 新增
/** 一次「打开文件」正在进行中,值是当前阶段;null = 没有。
 *  遮罩和四处禁用读的都是这一个字段。 */
opening: OpenProgress | null;
```

`INITIAL` 里 `opening: null`。

一个字段而不是 `opening` + `openingFile` 两个：四处禁用要的是同一个 null 判断，拆开就多出
「阶段有值但文件名没有」这种表达得出来却不该存在的状态。

### 3.2 阶段推进

`DocControllerEvents` 加两个回调。`onStatus` **原样保留**——它还承载 `local apply failed`
等与打开无关的场景，不在本次改动范围内。

```ts
onOpenPhase(phase: OpenPhase): void;
/** 打开失败。单独一个事件,是因为 createFrom 按设计永不 reject(见 controller.ts
 *  里 `before` 比较那段注释),失败只能作为事件报出来。成功不需要对应事件——
 *  `opening` 的生命周期由 controller.ts 的 try/finally 拥有(见 3.6)。 */
onOpenFailed(error: Error): void;
```

推进点全在 `DocController.createFrom` / `initRender` 这一条链上——`initRender` 是 private，
唯一调用方就是 `createFrom`：

```
createFrom()          → onOpenPhase("upload")
  xhr.upload.onload   → onOpenPhase("parse")
  响应 body.docId 到手
  initRender()        → onOpenPhase("load")     ← loadDoc 之前
    loadDoc / onDoc / worker 起
                      → onOpenPhase("render")   ← renderClient.init 之前
  catch               → onOpenFailed(err)
```

`opening` 的**写入和清除都在 `controller.ts` 的 wrapper 里**（3.6），不在
DocController：文件名和字节数本来就只有 wrapper 手上有，而把清除放在它的 `finally`
里，保证任何路径——包括 DocController 被测试替身顶掉、一个事件都不发的情况——都不会
把遮罩永久留在屏幕上。DocController 只负责报告它自己知道的事：阶段变了、失败了。

### 3.3 XHR helper

`fetch` → `XMLHttpRequest` 的替换**只发生在 `createFrom` 里那一处 POST**，封成
doc-controller.ts 的本地函数：

```ts
/** POST 一个 FormData,resolve 解析后的 JSON body。用 XHR 而不是 fetch 只为一件事:
 *  upload.onload 标出「最后一个字节离开浏览器」的时刻,把「还在上传」和「服务器在
 *  解析」分开。fetch 下这两段是一个不透明的 await,而对一个大 PSD 它们恰好是整个
 *  打开流程里最长、且时长差别最大的两段。 */
function postForm(
  url: string,
  fd: FormData,
  onUploaded: () => void,
): Promise<{ success?: boolean; docId?: string; error?: string }>
```

- `xhr.upload.onload` → 调 `onUploaded()`。
- `xhr.onerror` / `xhr.onabort` → reject。
- 响应体不是 JSON → reject。
- 其余情况 resolve 解析后的 body；**`body.success` 的检查留在调用方**，与现状一致。
- 不设任何请求头——现有 `fetch` 也没设，网关的鉴权走别的通路。

### 3.4 遮罩组件

新文件 `src/ui/panels/open-overlay.tsx`，在 `app.tsx` 里挂进
`<section className="col-canvas">`：

```
┌────────────────────────────┐
│  ● 上传 ── ● 解析 ── ○ 载入 ── ○ 渲染  │
│                            │
│  demo.psd · 42.1 MB        │
│  正在解析…                  │
└────────────────────────────┘
```

- 四个点的步进条：已过的实心，当前实心 + 脉冲动画，未到空心。
- 文件名 · 大小（字节数格式化到 MB/KB）。
- 一行当前阶段文案：上传中 / 解析中 / 载入中 / 渲染中。
- `s.opening` 为 null 时 `return null`。

样式加进 `styles.css`，颜色只用现有 token：底色
`color-mix(in srgb, var(--canvas-bg) 92%, transparent)`——**背景色带 alpha，不是元素
`opacity`**，后者会把卡片上的文字一起淡掉；当前步 `--accent`、已过的步 `--accent-ink`、
未到的步 `--fg-dim`、文件名 `--fg`、阶段文案 `--fg-3`。当前步的脉冲直接复用 styles.css
里已有的 `@keyframes blip`（目前定义了但无人使用）。`.col-canvas` 补 `position: relative`。

### 3.5 六处禁用

| 位置 | 文件 | 做法 |
| --- | --- | --- |
| 「打开」按钮 + file input | `top-bar.tsx` | 按钮 `disabled={!!s.opening}`；`onChange` 里 `e.target.value = ""` |
| 「导出」按钮 | `top-bar.tsx` | 并进现有条件：`!s.docId \|\| s.exporting \|\| !!s.opening` |
| 图层树 / 属性面板 | `side-panel.tsx` | 根元素 `inert={!!s.opening}` + `.is-locked` |
| 上下文栏(含工具条) | `context-bar.tsx` | 根元素 `inert={!!s.opening}` + `.is-locked` |
| 聊天列 | `chat-panel.tsx` | 根元素 `inert={!!s.opening}` + `.is-locked`；`<Composer busy={s.chatBusy \|\| !!s.opening} />` 照旧保留 |

用 `inert` 而不是逐个控件加 `disabled`：React 19 原生支持这个属性，一次盖住指针、键盘焦点
和 a11y 树，而逐个 `disabled` 既要改十几处、又漏掉面板里那些非 `<button>` 的可点行。
`.is-locked { opacity: .45 }` 只管视觉，不承担任何拦截职责。

`e.target.value = ""` 放在 `onChange` 里而不是打开完成后：`openFile` 是 async 的，等它
回来才清，中间这段时间同一文件仍然选不动。

`inert` 一律挂在每个区域自己的根元素上，不挂在某个子组件上：遮罩挡得住指针，挡不住
Tab——键盘不管上面盖没盖东西都能走到下面的按钮。`ToolStrip` 渲染在 `ContextBar` 内部，
`inert` 因此落在 `context-bar.tsx` 的根上而不是 `tool-strip.tsx` 自己，否则上下文栏自己
那几个按钮(载入为选区 / 裁到选区 / 选中区域内的图层 / 清除选区)仍然可以被 Tab 到，
对正在被替换的 OUTGOING `DocSession` 发一个 `crop` 之类的 op。同理，聊天列的
「新会话」「N ops · 本次会话」和历史面板里「回退这 N 步」都是真正的服务端写(`resetAgent`
/ `rollback` + `reconcile()`)，只锁 `Composer` 挡不住它们，所以 `inert` 落在
`chat-panel.tsx` 的 `<section className="col-chat">` 根上，聊天历史本身在加载期间也随之
不可点——这是拿到项目 owner 认可的取舍。

### 3.6 失败路径

`opening` 的生命周期由 `controller.ts` 的 **`openFile`** 拥有——不是里层的
`createFrom` wrapper：

```ts
export async function openFile(file: File): Promise<void> {
  setState({ opening: { phase: "upload", name: file.name, bytes: file.size } });
  try {
    await createFrom(new Uint8Array(await file.arrayBuffer()), file.name);
  } finally {
    setState({ opening: null });
  }
}
```

**为什么是 `openFile` 而不是 `createFrom`。** 种在 `createFrom` 里的话，种下去之前还得先
`await file.arrayBuffer()`——对这个功能存在的理由（几十 MB 的 PSD）那是秒级的分配加拷贝，
期间没有遮罩、没有状态变化，「打开」按钮也还亮着，能在第一次打开跑到一半时再点开第二次。
从 `File` 本身取 `name`/`size`（`file.size === bytes.length`，遮罩内容不变）就能在读之前
种下去。`try/finally` 跟着一起上移，于是任何路径都清得干净，包括 `controller` 是 `null`、
`createFrom` 整个是空操作的那条。

**失败时不要把自己的错误气泡擦掉。** `createFrom` 里采纳新文档那一步会清空聊天记录
（新文档，新会话），但 POST 成功而 `initRender` 随后抛错时，`reportError` 刚往 `chat` 追加的
那条 err 气泡也在被清的范围内——于是最需要解释的那条失败路径反而只剩右上角一行小字。
清空要写成 `chat: getState().chat.slice(chatBefore)`，`chatBefore` 是调用前记下的长度：
既保留「新文档、新会话」的语义，又让这次打开自己写的东西活下来。

`onOpenFailed` 只负责报错，在 `initController` 里落成
`(err) => reportError("打开文件失败", err)`，走 `store.ts` 里已有的那条约定（status 行 + 聊天里一条 err 气泡），失败不再只是右上角一行
小字。`DocController.createFrom` 仍然不 reject，`controller.ts` 里那段靠 `before` 比较
docId 来判断是否采纳新文件名的逻辑**一行不动**。

## 4. 测试

新增三个测试文件，按各自需要的替身分开——沿用 `tests/` 里现有的写法：

- `tests/open-overlay.test.tsx`——纯渲染，不需要任何替身：`opening` 为 null 时不渲染；
  四个阶段各自的文案与步进条 `data-state`；文件名和大小的显示。
- `tests/open-flow.test.ts`——用 `controller.test.ts` 那套 `vi.mock("../src/doc-controller.js")`
  替身，扩出 `onOpenPhase` / `onOpenFailed`：阶段被写进 store；成功走完 `opening` 清回
  null；失败也清回 null 且聊天里多一条 `role: "err"`。
- `tests/open-locks.test.tsx`——四处禁用各自的断言，外加 file input 的 `value` 在
  `change` 之后是空串。

`postForm` 单独导出，在 `tests/post-form.test.ts` 里用一个假 `XMLHttpRequest` 覆盖
`upload.onload` 的分界、以及 error / abort / 非 JSON 三条 reject 路径。

`tests/no-import-cycles.test.ts` 已在仓库里，新组件不得引入环——`open-overlay.tsx` 只
`import { useUiState } from "../store.js"`，不碰 `controller.ts`。

## 5. 不做的事

- **不显示百分比**（2.1）。
- **不动 `initRender` 里 `onDoc` 的时序**（1 节末尾）。
- **不给 `loadDoc` / worker init 加进度上报**：那要改 psd-client 的 Worker 协议，与本次
  目标（反馈显眼、有阶段、锁交互）无关。
- **不做取消**：POST 到一半 abort 之后服务端可能已经建好文档，收尾语义要单独设计。
