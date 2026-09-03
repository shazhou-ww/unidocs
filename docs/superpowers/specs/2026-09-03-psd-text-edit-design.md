# PSD 文字编辑设计：`setText` 与字形排版

日期: 2026-09-03
分支: feat/psd-text-edit（基于 `bb95f45`）
状态: 设计待评审（未开始实现）
前置: [PSD 文字层：现状、已知损失与实测结论](../../psd-text-layers.md)

## 1. 问题

用户说"把网址改成 www.unidocs.com"。那一层是**真的文字层** —— `type: "text"`，
`content` 是 `"More info\nwww.yoursite.com"`，字体 `JosefinSans-Bold` 58.33px
一样不缺。但 agent 连试两次生图模型去画字，两次都自己否掉了结果，最后建议
用户去 Photoshop 手动改。

原因不是模型不行，是**没有可达路径**：

- 工具表里没有任何能改文字的东西（`ops/index.ts` 的 `HANDLERS` 只有 init /
  add_layer / remove_layer / reorder / set_props / crop / transform / adjust /
  mask_edit / generative_fill）
- `set_props` 也改不了 —— 白名单 `SETTABLE_PROPS` 不含 `text`
- 就算改得了 `content`，**画不出来**：`psd/canvas-shim.ts` 的 `createCanvas`
  是直接 `throw` 的，`render/` 一次都没碰过 `.text`

前置文档已经把导入侧补齐了（分段样式、段落属性、不可重排特性的识别）。这份
文档解决剩下的一半：**改文字，并且把它画出来。**

## 2. 为什么 `setText` 必须是 `effect` 而不是 `op`

重排要拿字体文件，字体存在 CAS 里 —— 那是 IO。而 `apply` 必须纯
（`packages/doctype-psd/docs/design.md:184`："apply 不生成像素、不调模型、
不读时钟/网络/随机数"）。

所以它和 `editPixels` 同形：**`effect` 工具做 IO 与计算，吐出一个纯 op 去落地
已经算好的值。**

```
setText (effect)                          set_text (op, 纯)
  ├─ query getDoc{layerId} 取当前 text      └─ 校验后写入 layer.text / pixels / bounds
  ├─ 切分 runs（纯函数）
  ├─ 解析字体名 → CAS hash → readBlob
  ├─ 排版 + 栅格化（纯函数）
  ├─ writeBlob 新像素
  └─ 产出 op
```

纯函数那两块（run 切分、排版栅格化）不碰 IO，单测覆盖；effect 只负责编排。

## 3. 字体：CAS 存储 + 内置一套兜底

### 3.1 为什么不是打包

渲染有**两边**：`psd-client/render-worker.ts`（浏览器）和服务端都从
`@unidocs/doctype-psd/engine` 引同一份 `render`，而服务端那份供 `getPreview`
用 —— **agent 看的是它**。字体只在一边可用，就会出现"用户屏幕上对、agent 看到
的错、导出的也错"。

打包进 bundle 能解决两边可用，但撞两堵墙：Worker 有脚本体积上限，一套中文字体
5–20 MB 放不进去；而且用户自己的字体永远支持不了。

**存 CAS**：字体是 blob，两边都通过既有的 `BlobStore` 按 hash 拉取，不受脚本
体积限制，`ByteLru` 那套缓存直接复用，后续"用户上传字体"天然就通。

### 3.2 字体表

一个文字层给的是**字体名**（`JosefinSans-Bold`，PostScript 名）。需要一张
名字 → blob hash 的表。

```ts
interface FontEntry {
  /** PSD 里的 PostScript 名,匹配用。 */
  readonly postScriptName: string;
  readonly family: string;
  readonly blob: SBlob;
  /** 字体文件里读出来的,不是登记时填的 —— 见 §3.4。 */
  readonly unitsPerEm: number;
}
```

**存哪儿**：作为文档的一部分（`PsdDoc` 上一个 `fonts?: FontEntry[]`）还是
租户级的一张表？倾向**租户级** —— 同一个用户的多个文档大概率用同一批字体，
按文档存会重复登记同一个 blob。但这需要一个新的存储位置，见 §9 未决。

### 3.3 内置兜底

打包**一套**开源字体作为永远可用的兜底（体积小，不走 CAS）。它的作用只有
一个：字体缺失时仍然画得出字，而不是整个功能不可用。

**它不是默认渲染字体。** 兜底渲染只对**被编辑过的图层**生效 —— 见 §6。

### 3.4 首次登记

字体文件从哪来是未决项（§9）。但有一条现在就能定：**`unitsPerEm` 等度量必须
从字体文件里解析出来，不能由登记方填**。填错了排版会整体偏移，而这种错很难
被发现 —— 字还是那些字，只是位置全错。

## 4. 排版与栅格化

### 4.1 已验证的技术选型（`实测`）

`opentype.js@2.0.0`，**零依赖**，有 ESM 构建（压缩后 239 KB，对 Worker 体积
无压力）。实测它给出：

- 字形轮廓：`M` / `L` / `Q` 命令（TrueType 二次曲线），一串 15 字的文本 305 条
- 步进宽度 `advanceWidth`
- **字偶距真的生效**：`A`/`V` = −152 font units，`V` 起点 37.58 而 `A` 步进
  41.89，被拉近了 4.31px

栅格化**没有库可用，自己写** —— 扫描线填充 + 非零环绕，每像素行取 5 条子扫描
线做垂直抗锯齿，水平方向用精确的分数覆盖。约 70 行。

实测：922×126 的两行文字，**排版 + 栅格化合计 31ms**。输出抗锯齿干净，字距与
字偶距正确。

**所以不需要 WASM，不需要 canvas，纯 JS 能跑，两边同一份代码。**

### 4.2 v1 支持的排版

按 `LayerText` 已经导入的字段：

| 支持 | 说明 |
|---|---|
| 点文字（`shapeType: "point"`） | 不换行,锚点由 `justification` 决定 |
| 逐段样式（`runs[]`） | 每段各自的字体/字号/颜色/字距 |
| `caps` | none / small / all 的大小写变换 |
| `tracking` | 千分之一 em,PSD 单位 |
| 字偶距 | `autoKerning` 时用字体自带的表 |
| `leading` | 行距;`\n` 分行 |
| `justification` | left / right / center 决定锚点 |
| `horizontalScale` / `verticalScale` | 字形拉伸 |
| `baselineShift` | 基线偏移 |

### 4.3 v1 不做

- **框文字换行**（`shapeType: "box"`）—— 需要断行算法，且要对得上 Adobe 的
  every-line composer，v1 只在 `boxBounds` 存在时**拒绝重排**
- **竖排**（`orientation: "vertical"`）—— 同上，拒绝
- **复杂文种塑形**（阿拉伯语、印地语系）—— 需要 harfbuzz 级别的塑形，v1 只
  按码位逐字形放置。拉丁文与中日韩（非竖排）可行
- `underline` / `strikethrough` / `strokeColor` / faux bold·italic —— 导入侧
  已经存下来了，v1 渲染时忽略，命中就在结果里报出来
- 连字（`ligatures`）—— 忽略

**忽略与拒绝是两件事**：拒绝的（框文字、竖排）会让 `setText` 失败并说明原因；
忽略的会照常渲染，但在返回值里列出"这次没有还原的样式"，让 agent 有机会告诉
用户。

## 5. `set_text` 的语义

### 5.1 接口

```ts
// effect 工具
setText({ layerId: string, content: string })
```

**整串替换**，不是范围替换。理由：agent 从 `getLayers` 读到 `content`，写一个
新的完整字符串是它最不容易出错的形式；让 LLM 算字符偏移量则很容易错位。

### 5.2 改动区间的推导

用**最长公共前缀 + 最长公共后缀**把新旧字符串的差异夹出来，得到被替换的区间
`[start, end)` 与插入长度 `m`。

`www.yoursite.com` → `www.unidocs.com`：公共前缀 `www.` (4)，公共后缀
`s.com`... 具体由算法定，无需人工指定。

前缀后缀法在"aa → aaa"这类情况下区间是有歧义的，但**只要歧义范围落在同一个
run 里，选哪个都等价**，不影响样式。

### 5.3 run 重切分

`runs[]` 的 `length` 是字符数，顺次覆盖 `content`。替换之后：

- 完全在 `start` 之前的 run：不变
- 完全在 `end` 之后的 run：不变
- 与 `[start, end)` 相交的 run：按相交长度缩短
- 新插入的 `m` 个字符：**继承 `start` 落在的那个 run 的样式** —— "新文字用它
  替换掉的那段文字的样式"

`paragraphRuns[]` 用同一个函数处理。

### 5.4 跨 run 的替换：拒绝

如果 `[start, end)` 跨越了**样式不同的**多个 run，塌成一段必然丢样式。这时
`setText` 失败，并告诉 agent 分两次改。

样式相同的相邻 run 合并即可，不算跨越。

> 例：一次把黑色的 `More info` 和红色的 `www.yoursite.com` 一起换掉 —— 拒绝。
> 只换第二行 —— 允许，新字继承红色和那个字距。

## 6. 渲染时机：只重画被编辑过的图层

**没动过的图层一律继续贴 Photoshop 的烘焙图**，哪怕字体齐、渲染器就绪。否则
文件一打开就变了样 —— 用户什么都没改，观感先退步了（前置文档 §3.2）。

代价说在前面：改过的那一层，字形跟同文件里没动过的文字会有细微差异（字距、
抗锯齿、hinting）。这是固有成本，不是 bug。

**落地方式**：`setText` 直接产出新的 `pixels` blob 并更新 `bounds`。所以
"编辑过"这个状态不需要额外的标记位 —— 像素在 op 落地的那一刻就已经是我们画
的了。同时在 op 里记 `provenance`（与 `generative_fill` 同一套），让 UI 和
agent 知道这一层的像素不再是 Photoshop 烘的。

## 7. `bounds` 与锚点

新文字的宽度会变（`yoursite` 8 字符 → `unidocs` 7 字符）。`bounds` 必须跟着
更新 —— 图层影响范围、脏矩形、蒙版对齐都读它。

**往哪边收由 `justification` 决定**：

| 对齐 | 锚点 |
|---|---|
| `left` | 左边界不动,右边界随宽度变 |
| `right` | 右边界不动 |
| `center` | 中心不动,两边同时变 |

这正是前置文档里"没有对齐方式就不知道往哪边收"要解决的问题，导入侧已经补上了。

`transform` 里的平移分量是文字的锚点位置，不随内容变。

## 8. 缺字体时的三条出路

`setText` 解析不到字体时**不静默兜底**，把选择交出去：

```
无法重排：本机没有字体 JosefinSans-Bold。
  · 上传该字体文件后重试（推荐）
  · 用兜底字体渲染（字形会变，版面会变）
  · 只改文字数据，不更新画面（交给 Photoshop 重排；本机预览仍显示旧字）
```

第三条要用户**明确选**，选了之后那层必须一直挂着"画面已过期"的标记 —— 否则
用户导出、隔天再打开会以为改丢了（前置文档 §3.3：这个修改过不了我们自己的
往返）。

## 9. 提示词分流

`getLayers` 已经为文字层带上 `{ content, font, editable, uneditable? }`。提示
词要加一条硬规则：

- `type: "text"` 且 `editable` → **必须**走 `setText`，不许用 `editPixels`
- 其余（`raster` / `fill` / `smartObject` 里的字）→ `editPixels`

这次故障的直接原因就是没有第一条路，模型只能看图猜"这是真文字还是图片上的
字"，而它猜错了。

## 10. UI

一个已知的小缺口顺带补掉：图层选择**会**随指令发给 agent
（`composer.tsx` 拼 `<<selection layers=[…]>>`），但 composer 上只为"拖出来的
选区"渲染了提示 chip，图层选择没有 —— 用户看不出自己附带了什么。数据没问题，
是显示漏了。

## 11. 任务拆分

1. **run 重切分**（纯函数 + 单测）—— §5.2/5.3/5.4。不碰 IO，是后面全部的地基
2. **排版引擎**（纯函数 + 单测）—— §4.2 的字段 → 每个字形的位置
3. **栅格化**（纯函数 + 单测）—— 扫描线填充，已验证
4. **字体表与解析** —— §3，含内置兜底
5. **`setText` effect + `set_text` op** —— 编排,§6/§7
6. **提示词分流 + composer chip** —— §9/§10

1–3 可以独立完成并测住，不依赖 4。

## 12. 验证

- 单测：run 切分的边界（区间在 run 中间/边界/跨 run）、排版（字偶距、字距、
  caps、多行行距、三种对齐的锚点）、栅格化（覆盖率与已知形状对比）
- 往返：`setText` 之后 `save()` → `load()`，`content` 与 `runs` 不丢
- 实机：拿那份真实文档改一次网址，肉眼对比

## 13. 未决

需要拍板才能开始 §4（其余可以先做）：

1. **内置兜底字体选哪一套**，要不要覆盖中日韩（一套中文字体 5–20 MB，打包进
   bundle 不现实，那兜底就只能覆盖拉丁文，中文缺字体时只能走 §8 的后两条）
2. **字体文件怎么第一次进 CAS** —— 构建期预置若干开源字体？还是完全靠用户
   上传？
3. **字体表存哪儿** —— 文档级（`PsdDoc.fonts`）还是租户级（新的存储位置）
