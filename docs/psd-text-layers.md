# PSD 文字层：现状、已知损失与实测结论

日期: 2026-09-03 · 分支: feat/psd-image-edit

这份文档记录一次排查的结论。起因是一个看起来很小的请求 —— "把网址改成
www.unidocs.com" —— agent 连试两次生图模型去画字，两次都自己否掉了结果，最后
建议用户去 Photoshop 手动改。查下来牵出的东西远超预期，所以单独记一份。

**每条结论都标了来源**：`实测` 是跑过并有数字的，`代码` 是读源码确认的，
`推断` 是有依据但没验证的。不要把后两类当成前一类用。

## 1. 一个文字层同时装着两样东西

`代码`。PSD 的文字层里既有"这些字是什么"，也有 Photoshop 按那个描述**烘焙**
出来的位图：

| 字段 | 内容 | 谁在用 |
|---|---|---|
| `text` | 字符串 + 字体名 + 字号 + 行距 + 分段样式 + 段落属性 | 导出时写回；**Photoshop 用自己的文字引擎照它现画** |
| `pixels` | 一张 PNG | **我们** —— 画布预览、`getPreview`、合成、导出图，全都是贴这张图 |

之所以两份都存，是因为看图的程序不一定装了那套字体。**PSD 只记字体名，不内嵌
字体文件**（`推断`，但这是 PSD 与 PDF 的常识性差别）。有张现成的图才能保证显示
一致 —— Photoshop 自己就是这么做的。

一个真实例子（从当时那份文档的 IR 里取的，`实测`）：

```jsonc
{
  "id": "l5_Web", "type": "text", "bounds": [1706, 186, 1832, 1108],
  "text": {
    "content": "More info\nwww.yoursite.com",
    "style": { "font": "JosefinSans-Bold", "size": 58.33333, "leading": 79.16666 },
    "shapeType": "point",
    "transform": [1, 0, 0, 1, 184.65522620905017, 1750.9569536423846]
  },
  // IR JSON 里像素是 {width, height, hash} 三元组 —— branded SBlob 带不进
  // JSON（见 psd/ir.ts），读回来时才用 hash 重建。早先这里画成
  // { blob: { $blob: … } } 是错的。
  "pixels": { "width": 922, "height": 126, "hash": "6dea1a62…" },
  "degraded": [{ "reason": "文字层已栅格化", "detail": "…" }]
}
```

**`degraded` 说的是我们的能力，不是文件的内容。** 文件里 `content`、字体名、
字号、行距、位置一样不缺。`save.ts` 也明确不写 `degraded`（"it describes what
the importer lost, not what the document contains"）。

那张 922×126 的烘焙图上写的是：第一行 `MORE INFO`（黑），第二行
`WWW.YOURSITE.COM`（红，字距很大）。而 `content` 是**小写**、`style` 里
**既没有颜色也没有字距** —— 见下一节。

## 2. 导入侧：接了什么，丢了什么

`代码`。ag-psd 31.0.2 的 `LayerTextData` 有 28 个顶层字段，`TextStyle` 有 34 个
（数过；早先这里写的 30 / 36 是更早某个版本的数字）。改动
（提交 `0593a61`）之前我们只留 4 个 / 5 个。

**丢失的直接后果**：上面那层黑/红两色、全大写、大字距，在我们 IR 里全没了。
原因不是字段读漏，是**模型形状错了** —— PSD 的字符样式是**分段（style runs）**
存的，而 `LayerText` 只有一个 `style`，`mapText` 读的是顶层（也就是第一段）。
带着红色和字距的第二段整个不存在。

### 2.1 已接入（`0593a61` 之后）

分段与段落结构：

- `styleRuns[]` → `LayerText.runs[]`（`length` 是字符数，顺次覆盖 `content`）
- `paragraphStyle` / `paragraphStyleRuns[]` → `paragraphStyle` / `paragraphRuns[]`
  - 其中 **`justification` 最关键**：不知道对齐方式，就不知道文字改短之后往
    哪边收
- `boxBounds` / `pointBase`（框文字的换行宽度、点文字的锚点）
- `orientation`（中日韩竖排）

逐段字符样式（`LayerTextStyle`）新增：

`caps`（`fontCaps` 0/1/2 → none/small/all）、`fauxBold` / `fauxItalic`、
`horizontalScale` / `verticalScale`、`autoKerning` / `kerning`、
`baselineShift`、`underline` / `strikethrough` / `ligatures`、
`strokeColor` / `strokeWidth`（`outlineWidth`）。

> `caps` 是"`content` 小写而烘焙图全大写"最可能的解释（`推断` —— 手上没有
> 那份原始 PSD 可验证；另一种可能是字体本身，但 Josefin Sans 有小写字母）。

**导出侧同步写回**（`save.ts` 的 `agTextStyle`）。只补导入不补导出更糟：一次
import → export 就把刚补上的分段信息抹光。

### 2.2 仍未接入，且**出现即不可重排**

`textUneditable()` 命中任一条就写进 `LayerText.uneditable`，这层只能贴烘焙
像素、走 `editPixels`：

| 特性 | 为什么放弃 |
|---|---|
| `warp`（文字变形：arc / bulge / flag / …） | 需要复刻 Photoshop 的网格变形，重排出来必然不像 |
| `textPath`（沿路径排字） | 字沿曲线走，位置由弧长决定，我们的排版按基线推进 |
| `gridding` / `gridInfo`（CJK 排版网格） | 同上，且 `gridInfo` 读不回来（见 §5.1） |

**缺字体不在这一族。** 那不是文件的属性，是"这台机器上装没装"的属性，只有
渲染时才知道。

**`textPath` 的判据是帧类型，不是这个字段在不在。** Photoshop 给每个文字层都写
一条 TextFrameSet 记录，ag-psd 无条件把它挂成 `text.textPath`，所以真实文件里
这个字段**恒为真**。真正区分的是 `textPath.data.type`：缺省/0 = 点文字，
1 = 框文字（这两种我们用 `shapeType` / `boxBounds` 自己建模），其余才是路径文字。
两份素材量到的形状：

```
点文字  { data: { textRange: [-1,-1], pathData: { spacing: -1 } } }      无 bezierCurve
框文字  { bezierCurve: { controlPoints: [矩形四角] },
          data: { type: 1, textRange: [-2,-2] } }                        那条"曲线"就是文本框自己
```

所以既不能看字段在不在，也不能看有没有控制点。早先写成 `if (t.textPath)`，
结果真实 Photoshop 文件里每一个文字层都被判成不可重排 —— `setText` 从未在真实
文件上生效过。合成 fixture 测不出来：ag-psd 的 writer 不写 TextFrameSet。

### 2.3 仍未接入，暂时不影响重排

`antiAlias`（渲染器自己决定抗锯齿模式）、`superscriptSize/Position`、
`subscriptSize/Position`、`smallCapSize`、`useFractionalGlyphWidths`、
`tsume`、`language`、`styleRunAlignment`、`index`、`bounds` / `boundingBox`、
段落里的 `autoHyphenate` 一族与 `wordSpacing` / `letterSpacing` /
`glyphSpacing`。

等真遇到需要的文档再补。列在这里是为了下次不用重新调研一遍。

### 2.4 agent 现在看得见什么

`getLayers` 对文字层多返回 `{ content, font, editable, uneditable? }`。这是
分流的数据基础：`type: "text"` 且 `editable` → 走文字工具；其余 → `editPixels`。

没有这层信息时，模型只能看图猜"这是真文字还是图片上的字"，而实测它猜错了。

## 3. 渲染侧：为什么只贴烘焙图

`代码`。**整条链路上没有任何画字的能力** —— `psd/canvas-shim.ts` 的
`createCanvas` 是直接 `throw` 的，`render/` 一次都没碰过 `.text`。这跟 §2 的
分段丢失是**两件独立的事**：

- 没有渲染器 → 只能贴图（今天的状态）
- 分段丢了 → 就算写了渲染器也画不对

还有一个约束常被忽略：**渲染有两边**。`psd-client/render-worker.ts` 和服务端
都从 `@unidocs/doctype-psd/engine` 引同一份 `render`，而服务端那份供
`getPreview` 用 —— **agent 看的是它**。字体只在浏览器可用（例如靠 `FontFace`）
而 Worker 里没有，就会变成：用户屏幕上对、agent 看到的错、导出的也错。

### 3.1 烘焙图不会变得多余

写完排版引擎之后它仍然不能删，但**降级为兜底**：

| 情况 | 用什么 |
|---|---|
| 字体有、排版特性我们支持 | 我们渲染（此时烘焙图确实用不上） |
| 字体缺 | 贴烘焙图，文字不可编辑 |
| 命中 §2.2 的特性 | 贴烘焙图，文字不可编辑 |

决定性的理由只有一条：**PSD 不内嵌字体文件**。开源字体（Google Fonts 那批）
按名字能拿到；Helvetica Neue、Proxima Nova、方正/汉仪这些没有合法来源，
我们去分发也是在分发别人授权的软件。这不是工程能绕开的限制。

另外两条理由较弱，记下来是为了避免以后又被当成硬约束：
"我们的渲染 ≠ Photoshop 的渲染" 和 "导出要写像素" —— 前者在"所有文字都由
我们画"时不成立（就没有不一致了），后者导出时现画一张即可。

### 3.2 只重画被编辑过的图层

**没动过的图层一律继续贴烘焙图**，哪怕字体齐、渲染器已经就绪。否则文件一打开
就变了样 —— 用户什么都没改，观感先退步了。

代价要说在前面：改过的那一层，字形跟同文件里没动过的文字会有细微差异（字距、
抗锯齿、hinting）。这是这条路的固有成本，不是 bug。想完全避免只有一条路 ——
根本不重画、只改元数据，然后用户在屏幕上看不到自己的修改。

### 3.3 "只改元数据"能走多远

`代码`。`set_text` 只改 `text.content` 不动像素，是可行的，但结果是
**数据是新的、画面是旧的**：

| 谁打开 | 看到什么 |
|---|---|
| Photoshop，装着那套字体 | 按新 `content` 重排 → 对 |
| Photoshop，缺字体 | 不确定（未实测） |
| 不渲染文字的读者、缩略图 | 读 .psd 里的合成图 → 旧字 |
| **我们自己再打开这个文件** | 走 `load` → 贴烘焙像素 → 旧字 |

最后一行最容易被忽略：**这个修改过不了我们自己的往返。** 所以缺字体时
`setText` 不应静默改完，而要把选择摆给用户（上传字体 / 接受兜底字形 /
只改数据），否则用户导出、隔天再打开会以为改丢了。

## 4. 实测数据

### 4.1 哨兵往返对文字的破坏（`实测`）

`editPixels` 送图给模型前会 `compositeOnSentinel`（把透明区合成到品红），
回来 `recoverAlpha` 判回透明。**把模型整个拿掉、只跑我们自己这两步**，用一张
900×240 的真实抗锯齿文字层（4347 个软边像素 = 字形可见像素的 21.9%）：

```
源            opaque=15481  transparent=196172  soft=4347
空跑往返       opaque=19361  transparent=196639  soft=   0   可见区平均色差=13.47
+重采样往返     opaque=20900  transparent=195100  soft=   0   可见区平均色差=14.62
```

两个独立的缺陷：

**(a) `recoverAlpha` 硬二值化** —— `a = d <= tolerance ? 0 : 255`。空跑一趟
4347 个抗锯齿像素全部归零。文字几乎全是抗锯齿边，这一刀下去锯齿全露。

**(b) RGB 里留着品红** —— `recoverAlpha` 把 alpha 拉到 255 却不动 RGB，
`withSourceAlpha`（`reshape=false` 那条路）也只换 alpha。那 4347 个边缘像素的
平均色差是 **61.46**：每个字都镶一圈品红。

**(b) 已修**（提交 `c1c9315`）。合成是线性的，`P = a·C + (1−a)·S`，`a` 已知时
`C = (P − (1−a)·S) / a` 是精确解：

```
reshape=false 空跑: 边缘平均色差 61.46 → 2.16   （余下是 8bit 量化）
                    可见区平均色差 13.47 → 0.47
```

源不透明时 `a=1`，逆运算是恒等 —— **照片层一个像素都不会变**。

**(a) 未修。** 它只在 `reshape=true` 时暴露，而重新排字必然改轮廓，所以正好
是文字场景踩的那条路。修它需要先把 alpha 估出来 —— 见下。

### 4.2 抠像估计 alpha（`实测`，未采用）

`reshape=true` 时 `a` 未知。哨兵是纯品红 `(255,0,255)`，属于标准抠像场景：
`k = clamp(min(R,B) − G, 0, 255)`，`a = clamp((kHi − k) / (kHi − kLo))`。

同一张文字层：

| 膝点 | opaque | soft | alpha 误差(全/边) | 色差(全/边) |
|---|---|---|---|---|
| 真值 | 15481 | 4347 | — | — |
| kLo=0（无膝点） | 4826 | 15002 | 0.56 / 3.51 | 3.35 / 4.64 |
| **kLo=24** | 15993 | 3835 | 0.17 / 8.57 | 2.03 / 9.27 |
| kLo=48 | 16461 | 2911 | 0.35 / 17.16 | 5.80 / 26.46 |

`kLo=24` 最平衡：实心笔画不发虚，边缘色差比现状（61.46）好 6.6 倍。

**但没有采用**，因为在照片内容上会误伤：

```
kLo=0 : 被判成非实心的像素 36.71%，最低 alpha=4
kLo=24: 被判成非实心的像素 12.04%，最低 alpha=4
```

粉色皮肤、红布会被抠掉 —— 正好毁掉"换帽子"那类**目前唯一能用**的场景。

想过按源图颜色自适应地选哨兵来让抠像变良态，**那个探针我写坏了**（把品红专用
的判别式和通用 L1 距离混用），结论不成立，需要重做。

### 4.3 用生图模型画烘焙图（`实测`）

输入是真实的 922×126 烘焙图，指令"把 WWW.YOURSITE.COM 改成 WWW.UNIDOCS.COM，
保持字体字重字距颜色位置不变"。

| 模型 | 结果 |
|---|---|
| `qwen-image-edit-plus`（当前默认） | `WWW.NOUCNIDE.COM` —— 错。`MORE INFO` 还从黑变灰。输出 2784×384 |
| `wan2.6-image` | **4 次全对** `WWW.UNIDOCS.COM`，字体/字重/字距/红色全保住 |

wan2.6 的输出缩回原尺寸后与输入比：

```
未修改的空白留白      平均色差=0.33   >16 的像素= 0.0%    ← 没乱动
MORE INFO 行(不该变)  平均色差=38.71  >16 的像素=23.6%    ← 整张重画,但画得准
                     中位数=0.7 —— 绝大多数像素一致,差异全在字形边缘
```

**四个实测约束**：

1. **拒收 RGBA**，也拒收 7.3:1 的长条。垫成 922×384（2.4:1）才接受。所以要先
   合成不透明底 + 补边到可接受宽高比。
2. **输出固定 1968×832**，要缩回原尺寸；alpha 靠哨兵还原（§4.1 的逆运算正好
   用得上）。
3. **背景回来是 254 不是 255**，有轻微色偏。
4. **它保的是"框"，不是排版。** `YOURSITE`(16 字符) → `UNIDOCS`(15 字符)，但
   输出的墨迹宽度和输入完全一样（bbox 都到 921）—— 它把字距撑开填满了原宽度。
   真正的文字排版会让这行变短。这不是排版，是修图。

**不能据此断定它可靠**：4/4 是同一个字符串的四次。更长的文案、中文、小字号
没测。所以它只能当兜底，而且必须保留"agent 看结果再判断"这一环 —— 那次 agent
两次都正确地否掉了 qwen 的输出，那个回路是好的。

## 5. ag-psd 与 opentype.js 的坑

### 5.1 `gridInfo` 编解码不对称（`代码`）

**写得出去，读不回来。** `text.js:522-528` 的 `encodeEngineData` 把
`GridIsOn` / `ShowGrid` / `GridSize` / `GridLeading` / `GridColor` /
`AlignLineHeightToGridFlags` 编进 EngineData；而 `GridIsOn` 在整个 dist
（除 bundle 副本）里**只出现这一次**，没有解码对应物。

不是解码器不读 EngineData —— `antiAlias`、`useFractionalGlyphWidths`、
`superscriptSize/Position`、`subscriptSize/Position`、`smallCapSize` 都由它
还原（实测这些确实回来了）。它单单漏了 `Grid*` 这一组。

对照 `gridding`：`decode` 在 `additionalInfo.js:61`，`encode` 在 `:94`，两边
齐全，所以能往返。

**后果**：`textUneditable()` 里 `t.gridInfo?.isOn` 这半个条件在 ag-psd 31.0.2
下恒为假。**留着不删** —— 库补上解码就自动生效；只有 `gridding` 兜得住另一半。
测试也只能用 `gridding` 构造那个状态。

### 5.2 `justification: "left"` 无法与"未指定"区分（`实测`）

`left` 是 PSD 的默认值，写出去和根本没写在文件里是一回事。拿它做往返断言会得到
一个**永远绿的假测试**。测试必须用非默认值（我们用 `center`）。

### 5.3 opentype.js 解析 glyf 时把二次曲线升阶成三次（`实测`）

TrueType 的 `glyf` 表原生**只有**二次贝塞尔曲线（`Q`），CFF/OTF 才是三次（`C`）。
但 opentype.js 2.0.0 解析 `glyf` 时会把每条二次曲线升阶成等价的三次曲线，构造
`glyph.path` 时一律产出 `C`。

探针（写进去再读回来，同一份字体字节）：

```
写入前:   [M(0,0),  Q(x1=100, y1=200, x=300, y=400),                    Z]
解析回来: [M(0,0),  C(x1=67, y1=133, x2=167, y2=267, x=300, y=400),     Z]
```

数值对得上二次→三次的标准升阶公式（`C1 = P0 + ⅔(C−P0)`、`C2 = P1 + ⅔(C−P1)`，
即 (66.7, 133.3) 与 (166.7, 266.7)，差值来自 `glyf` 用整数坐标存储的取整），
不是巧合。

**后果**：`parseFontFace` 产出的任何字体，`outline()` **永远不会返回 `Q` 命令**。
`translatePathCommand` 与 `raster.ts` 里的 `Q` 分支在真实调用路径上是死代码 ——
不删（`PathCommand` 类型里有 `Q`，测试用的假字体仍会喂进来），但要知道它们**不受
任何真实字体的测试保护**：Q 分支只能绕过字体解析、直接喂手写命令来测。

这条结论绑死在 opentype.js 2.0.0 的实现行为上，不是规范保证。**升级这个依赖时要
重跑一次上面的探针。**

### 5.4 字体从哪儿来：预置脚本

`代码`。字体索引是**租户级**的（同租户下所有 psd 文档共用），字节在 CAS 里。
索引本身是中立契约 `FontRegistry`（`@unidocs/doctype-server-common`），两个栈各有
一个适配器：Cloudflare 是 `PsdFonts` 这个租户级 Durable Object，Azure 是 psd 库里
的 `font_registry` 表。往里面灌东西的唯一入口是
[`scripts/seed-psd-fonts.mjs`](../scripts/seed-psd-fonts.mjs) —— 用法、配置形状、
以及下面三条限制都写在那个文件顶部的注释里，示例配置见
`scripts/psd-fonts.example.json`。

**本地开发不用手工跑它。** `pnpm dev`（**两个栈**都算，选中了 psd 时）启动就会
自己走一遍：先读一次租户 `u1` 的索引，两套都在就跳过，缺了就把缺的那套下到仓库
根的 `fonts/` 再灌进去，并把 `PSD_FONT_FALLBACKS` 默认成那两个 postScriptName
（挂载点与全部裁定见 [`scripts/psd-font-bootstrap.mjs`](../scripts/psd-font-bootstrap.mjs)）。
`/tenants/{t}/fonts` 已经是中立路由，脚本指向哪个 doc service 就灌哪个 —— 本地与
线上、Cloudflare 与 Azure，**路由与凭据形状**是同一条。但"同一条路径"只到这里为止：
**能不能从你坐的地方够到那个 doc service，是另一回事。** 本地两个栈、以及线上的
Cloudflare 都直接够得到；线上 Azure 够不到 —— doc service 的 ingress 是
`external: false`，而网关的路由表有意不含 `/tenants/{t}/fonts`，仓库里也没有现成的
跳板，得在容器环境内部跑。这一段免责说明和整套手工步骤见
[`stacks/unidocs-azure/README.md`](../stacks/unidocs-azure/README.md) 的
「新环境的字体预置」。

| 想做的事 | 怎么做 |
|---|---|
| 什么都不做 | 默认就是"有就跳过，没有就灌" |
| 跳过（离线、CI、不想要这几 MB） | `pnpm dev … --fonts off`，或 `UNIDOCS_PSD_FONTS=off` |
| 灌到别的租户 | `UNIDOCS_PSD_FONT_TENANT=<租户>`（默认 `u1`，与 web-psd 硬编码的 `USER` 一致） |
| 自己配回退链 | Cloudflare 写在 `packages/cloudflare-psd/.dev.vars`，Azure 写在仓库根 `.env.azure`，都是 `PSD_FONT_FALLBACKS=…`（压过默认值） |
| 换字体 / 灌到生产 | 还是手工跑 `seed-psd-fonts.mjs`，形状见下 |

这一步**不会阻断启动**：没网、下载失败、预置失败，一律打一条说清"这次少了什么
功能、怎么手工补、怎么彻底关掉"的警告然后继续。开发环境因为字体下不下来就起不
来是不可接受的。代价是失败时索引仍然是空的 —— 那时 `setText` 还在工具表里
（判据是"有没有那张登记表"，不是"表里有没有字体"：Cloudflare 看 `PSD_FONTS` 绑定
在不在，Azure 无条件注册），只是每次调用都取不到字形。

三条要先知道的：

1. **它不走 gateway。** gateway 的路由表只认 `/tenants/{t}/docs/…` 与
   `/tenants/{t}/cas/…`；字体端点 `/tenants/{t}/fonts` 和 CAS 的 root-refs 都不在
   里面（后者是**有意**不暴露的私有服务操作）。所以脚本直连 psd doc service 和
   CAS 服务，并且需要两把本该只存在 gateway 上的私钥。它是**部署者工具**，不是
   终端用户接口。Azure 上还多一道：doc service 的 ingress 是内部的，脚本得在容器
   环境内部跑（见 [`stacks/unidocs-azure/README.md`](../stacks/unidocs-azure/README.md)
   的「新环境的字体预置」）。
2. **写权限沿用租户作用域的 `sessions:create`**（裁定 R41）—— 能创建会话的人就
   能往该租户的字体表里登记字体。这是有意为之的取舍（字体是加法，不改动既有
   文档），但别以为这个端点有更严的保护。
3. **字体二进制不进仓库**（裁定 R19）：一套中文字体 5–20 MB，进 git 就永远留在
   历史里。配置里写本地路径，文件由部署者自备（仓库根的 `fonts/` 已 gitignore）。
4. **脚本修不回"索引有条目、根引用是 0"这个状态**（`推断` —— 评审做过推演并用注入反证过，但那次验证只活在它的临时目录里，**仓库里没有任何测试守着这条**。这正是本文档反复强调的区别："我跑通了 X"不等于"有东西守着 X"）。
   正常路径不会走到这个状态 —— 但如果它已经存在（早期版本的脚本、或有人绕过脚本
   直接 POST 那个端点），重跑修好的脚本**不会修复它**：哈希没变就走"跳过"这条路，
   一次 retain 都不发。字节倒是被重新传了一遍、续上 24 小时租约，于是**看起来好了
   一天，然后再次消失**，如此往复。
   而且没有任何可观测信号：脚本回读只打印覆盖范围，不提根引用；客户端的
   `readMetadata` 把带计数的 `state` 丢掉了（`tenant-client/src/client.ts`）；
   列根引用的只有本地测试探针，不是运维工具。**第一个症状就是字体凭空消失。**
   出路：换一个 `postScriptName` 重新登记，或去 CAS 侧手工补一次根引用。
   待办：给脚本加一个 `--repin` 开关（无条件重钉一次），或补一条 CAS 侧的
   "列出有索引但无根引用"的运维命令。

**中文那套该取哪个文件。** 脚本有一道 16 MiB 的闸（`MAX_FONT_BYTES`，对齐编辑器
DO 的 `MAX_SVALUE_ROOT_BYTES`），而 noto-cjk 里好几个都叫得上"Noto Sans SC"、
体积差得很远。撞上闸只会看到一句"请改用子集化过的字体"，仓库里却没有任何子集化
工具，所以这里点名（字节数 2026-09-03 实测自 `notofonts/noto-cjk` 的 `main`）：

| 文件 | 字节 | 过 16 MiB 闸？ |
|---|---|---|
| `Sans/SubsetOTF/SC/NotoSansSC-Regular.otf` | 8,331,336（8.0 MB） | ✅ **用这个** |
| `Sans/Variable/OTF/Subset/NotoSansSC-VF.otf` | 15,054,748 | ⚠️ 过，但只剩 1.6 MB 余量 |
| `Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf` | 16,437,364 | ⚠️ 过，但只剩 0.3 MB 余量 |
| `Sans/OTC/NotoSansCJK-Regular.ttc` | 19,484,784 | ❌ 超闸，脚本当场拒绝 |

推荐那份实测跑过 `describeFont`：`postScriptName` 就是配置里要写的
`NotoSansSC-Regular`，`unitsPerEm=1000`，覆盖 30,890 个码位、其中基本区汉字
20,976 个。

回退链本身不在配置里，是 psd doc service 的 `PSD_FONT_FALLBACKS` 环境变量（逗号
分隔、顺序即优先级）。两个栈读的是同一个变量，缺省都是空链、不硬编码字体名 ——
硬编码一个 CAS 里没有的
名字只会让回退链静默失效。所以**装了字体还要配这个变量**，两步都做了兜底才真的
生效。本地 `pnpm dev` 把这两步绑在一起做了（见本节开头）；**手工部署仍然要自己
配**，只灌索引不配变量的结果不是报错，是中文一个字都画不出来。配在哪儿：
Cloudflare 是 `packages/cloudflare-psd/wrangler.toml` 的 `[vars]`，Azure 是
`pnpm stack:deploy unidocs-azure --service psd --psd-font-fallbacks …`
（注入点在 `stacks/unidocs-azure/deploy/service.bicep` 的 `psdFontFallbacks`）。

兜底必须同时覆盖中文和英文。脚本跑完会回读索引并打印每套字体覆盖了多少码位、
其中落在 CJK 统一表意文字区的有多少 —— 一套只有拉丁字母的索引会得到一条明确的
警告。那是操作者唯一能一眼看出"中文兜底真的带了中文"的地方。

### 5.5 默认样式表不合并，只写在那里的字段全部丢失（`代码`）

`layer.text.style` **不是**"这层的默认样式"，它是 `deduplicateValues` 从各个
`styleRuns` 里往上提的公共值。真正的默认样式表读都没读 —— `text.js:322-326`：

```js
// const theNormalStyleSheet = resourceDict.TheNormalStyleSheet;
// const styleSheetSet = resourceDict.StyleSheetSet;
// const styleSheetData = styleSheetSet[theNormalStyleSheet].StyleSheetData;
...
result.style = {};   // decodeStyle(styleSheetData, fonts);
```

代码写好了，被注释掉了。**后果**：只写在默认表里的字段一个都到不了
`layer.text.style`。实测 `strokeFlag` / `fillFlag` / `outlineWidth` 就是这一族
—— 两份素材、14 个文字层全是 `undefined`，而原始字节里 `/StrokeFlag` 明明出现
18 次。解码器本身是忠实的（`decodeObject` 把 EngineData 里有的键照抄，
`styleKeys` 也列全了），丢的是这一层合并。

**这决定了"有没有描边"我们判不出来**：每个文字层都带 `strokeColor: {0,0,0}`
（Photoshop 默认值），而唯一能区分的开关取不到。所以 `IGNORABLE_STYLE_NAMES`
里**不放** `strokeColor` —— 一条永远为真的警告会把它旁边那些真警告一起废掉。
留 `strokeWidth`：真解出一个宽度来，那才是描边存在的证据。

要拿回这些字段只能 fork（取消那几行注释）。作者主动禁用多半有原因 ——
`encodeEngineData` 会往回写，`style` 预先塞满 34 个默认值会改变写回行为 ——
而收益目前只有一个布尔值，不值得为它分叉一个活跃依赖。

### 5.6 逐段样式是**增量**，不是整份样式（`实测`）

不是 ag-psd 的坑，是读它的人容易踩的坑，写在这里因为形状和 §5.5 一样。
`styleRuns[].style` 只存与层级 `style` 的差异：

```
style:     { font: "JosefinSans-Bold", size: 58.33, leading: 79.17, caps: "all", … }
styleRuns: [ { length: 10, style: { tracking: 0,   fillColor: … } },
             { length: 16, style: { tracking: 340, fillColor: … } } ]
```

字体、字号、行距、caps 一个都不在 run 里。**消费侧必须自己叠**（`effectiveStyle`），
直接拿 `run.style` 当整份样式的后果：字号掉回 `DEFAULT_FONT_SIZE` 的 12px
（58.33px 的两行字排成六分之一大）、请求字体恒为 `undefined`（缺字体的替换记录
永远是空的，用户看到一层默默换了字体的文字）、caps 恒不展开（拿未展开的字符去
查覆盖，选字体选的是错的码位）。

合并只发生在消费侧，不写回模型 —— 写回去 `save` 就会把整份样式灌进每个 run。

## 6. 已交付与未决

这份文档写在 `feat/psd-text-edit` 之前，下面前四条**已经由那条分支交付**，
留在这里只为记录当时的判断与实际做法的差别。

| 当时列为未决 | 实际做法 |
|---|---|
| `set_text` op + 提示词分流 | 已交付。分流规则拆成两半：不点名工具的硬规则进基础提示词，点名 `setText`/`editPixels` 的三条另立一块、只在两个工具**都**注入时追加 —— 否则会造出"提示词里有、工具表里没有"的幽灵工具 |
| 字体来源（三条路，倾向打包） | **三条都没选**。打包被否掉了：兜底要同时覆盖中英，而一套中文字体 5–20 MB，进不了 Worker。改成全部走 CAS + 租户级索引 DO + 预置脚本（§5.4） |
| 字形栅格化（用现成库） | **一半自己写**。用 `opentype.js` 解析字体（零依赖、ESM、239 KB），但排版与扫描线栅格化是自己写的 —— 现成库要么带 DOM 依赖，要么把布局和绘制绑在一起 |
| UI：图层选择的 chip | 已交付（`composer.tsx`） |

**真实文件上的保真度（`实测`）**。上面那层 `Web`（58.33px 两行、tracking 340、
1:1 变换），索引里有 `JosefinSans-Bold`：

```
Photoshop 烘的图层框            922 × 126    [1706, 186, 1832, 1108]
我们排 "www.yoursite.com"       922 × 126    [1706, 186, 1832, 1108]
我们排 "www.unidocs.com"        892 × 126    [1706, 186, 1832, 1078]
```

原文重排四个坐标逐一复现。换成 `unidocs` 少一个字符，左/上/下三边不动
（左对齐），只有右边缩 30px。

**这个数字是三个缺陷修完之后才拿到的**，而三个都只有真实 Photoshop 文件才暴露
（合成 fixture 全绿）：`textPath` 恒真（§2.2）、逐段样式不继承（§5.6）、
按 `strokeColor` 误报描边（§5.5）。前两个各自都足以让 `setText` 在真实文件上
完全不可用。教训写在这里：**这条链的测试必须有真实素材那一档**，用 ag-psd 的
writer 造出来的 PSD 证明不了任何事 —— 它写不出 TextFrameSet，也不会把样式拆成
增量。

**仍然未决**：

1. **`reshape=true` 的 alpha 估计**（§4.2）—— 需要重做自适应哨兵的实验。
2. **`baselineShift` 的方向**（`layout.ts`）—— 正值向上是**按跨标准约定推定的**
   （CSS baseline-shift / PDF 的 Ts / PostScript 都是正值抬升），**没有拿真
   Photoshop 实测过**。需要一份带非零 `baselineShift` 的真实 PSD 核对。
3. **预置脚本的 `--repin`**（§5.4 第 4 条）—— 脚本修不回"索引有条目、根引用是 0"
   这个状态，而那个状态没有任何可观测信号。
4. **子集化** —— CJK 字体每次拉 5–20 MB，靠既有的 `ByteLru` 缓存吃掉；
   真正的解法是按文档实际用到的码位做子集，v1 不做。
5. **描边判不出来**（§5.5）—— ag-psd 不合并默认样式表，`strokeFlag` /
   `outlineWidth` 取不到。现在按 `strokeWidth` 报，等于真实文件上一律不报描边。
   要拿回来只能 fork ag-psd，为一个布尔值不值得；更该做的是给上游提 issue 问
   那几行为什么被注释掉。
6. **连字（ligatures）** —— 排版不做，命中就进 `ignored`。真实素材里那层
   `ligatures: true`，所以每次编辑都会如实报一句。
