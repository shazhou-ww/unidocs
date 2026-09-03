# PSD 文档类型的图片格式进出口（PNG）

日期：2026-08-31，2026-09-03 复核修订（rebase 到 `0aab9c8`）
原始基点：`fix/web-psd-export-blank`（导出前 flush 待提交编辑的修复是本设计的前提），已在 main 内

> **2026-09-03 修订说明。** 初稿写完后被 `git reset` 撤掉，从未落地；149 个提交之后重新捞出来核对。
>
> 核心结论：**PNG 在两条运行时都没实现**，但**格式分发机制在 Cloudflare 那条已经做完了**——初稿把它
> 写成「语义要对齐的参考」，低估了它。据此改了四处：
>
> 1. 「现状」节重写为两条运行时的对照，并点明生产的 PSD 服务跑在**没有机制的那条**（Azure）。
> 2. 第一节范围收窄为「只补 Azure」，语义从自拟改为**逐字照抄 CF 已有的那份**。
> 3. 新增「落地顺序」节：三步的先后由「哪一步之后哪条运行时能用」决定，第三步必须最后。
> 4. 第四节加了两条护栏测试：PNG 与 PSD 内嵌合成图逐像素一致、两份 `selectFormat` 的 parity。
>
> 第二、三节的做法不变。所有行号已按 `0aab9c8` 重新核过。

## 目标

1. 用户可以直接打开一张 `.png`，得到一个正常的可编辑文档（画布 = 图片尺寸，一个背景图层）。
2. 用户导出时可以选择导出为 PSD 或 PNG；PNG 导出的是文档的展平合成图。

## 非目标

- **JPEG 本期不做。** 它是唯一需要引入新依赖的部分（`doctype-psd` 是 cloud-neutral 包，编解码器必须是纯 JS 或 wasm 才能同时跑在 workerd 和 Azure Functions 里）。格式选择机制本期一次做对，以后加 JPEG 只是多注册一个 `formats.jpeg`。
- 不做「把图片作为新图层置入当前文档」。本期只有「当成新文档打开」。
- 不改 `defaultFormat`，不改 `DocumentType.contentType`，不改文档目录里的 `docType`。

## 认下来的语义

打开一张 PNG 之后，**文档仍然是 psd doctype**：目录记录 `docType = "psd"`，导出的默认格式仍是 PSD，PSD 的图层 / 调整 / 蒙版工具照常可用。PNG 是一种**入口格式**，不是另一种文档类型。这正是 `DocumentType.formats`（`packages/protocol/src/types.ts:158`）存在的意义。

PNG 导出是**展平**：图层结构会丢。这是 PNG 这个格式的性质，不记为 `Degradation`——`Degradation` 描述的是导入时丢失的保真度，不是导出时的格式限制。

## 现状

**两条运行时的成熟度差一整节。** 这是本次修订最重要的一条：

| | 导入选格式 | 导出选格式 |
|---|---|---|
| **Cloudflare**（`cloudflare-sdk/src/editor-do-svalue.ts`） | `:783` `selectFormat(config, form.get("format"), file.type, file.name)` ✅ | `:553` 读 `?format=`，`:562` 按格式给 `Content-Type`，`:563` 给带扩展名的 `Content-Disposition` ✅ |
| **Azure**（`doctype-server-common/src/session.ts`） | `:355` **写死** `formats[defaultFormat].load` ❌ | `:524` **写死** `formats[defaultFormat].save` + 顶层 `config.contentType` ❌ |

Cloudflare 那条的 `selectFormat` 在 `editor-do-svalue.ts:954-975`，是一份完整实现。它连初稿列为「顺手修」的**带扩展名的 Content-Disposition** 都已经做了（`:563` `document${extension}`）。

Azure 那条的链路：

- 导入：`openFile` → `DocController.createFrom`（`FormData`，`fd.append("file", blob, label)`）→ `POST /tenants/{t}/docs/psd/` → 网关 `createDocument` → `POST /_internal/create` → `session-handler.ts:143` **已经拿到了 `File`**（`:153` 甚至检查了 `file.size`），却在 `:164` 只把 `bytes` 传下去，`file.name` / `file.type` 当场丢弃 → `Session.create({ bytes })` → `session.ts:355`
- 导出：导出按钮 → `GET /tenants/{t}/docs/psd/{id}/export` → 网关 `forwardToWorker` → `GET /_internal/export` → `session-handler.ts:196` `session.exportBytes()`（无参数）+ `:204` 写死 `filename="document"` → `session.ts:524`

**`doctype-psd` 只注册了 `formats.psd`**（`doctype.ts:80-89`，`defaultFormat: "psd"`）。所以即使在已有机制的 Cloudflare 上，今天的实际行为也是：

- `?format=png` → `formats["png"]` 是 `undefined` → `editor-do-svalue.ts:556` 返回 **400 `Unknown format: png`**
- 上传 `.png` → `selectFormat` 按 mediaType 不命中（`image/png` ≠ `image/vnd.adobe.photoshop`），按扩展名也不命中 → **回落 `defaultFormat`** → 拿 `psd.load()` 去解 PNG 字节 → 报错

机制通了，但没有格式可选。

**生产环境走的是没有机制的那条。** Azure 侧注册了 `docx` / `markdown` / `psd`，PSD 服务跑在 `azure-sdk`，用的正是 `doctype-server-common` 的 `Session`。

## 一、格式选择机制 —— **只补 Azure 那条**（`doctype-server-common`）

> **别从这一节开始动手。** 章节编号是叙述顺序，不是施工顺序——本节是「落地顺序」里的**第 2 步**，
> 第 1 步是第二节（注册 `formats.png`）。理由见文末「落地顺序」。

Cloudflare 那条已经做完（见「现状」），本节不动它的任何逻辑。要补的只有 `doctype-server-common`。

新增纯函数，放在 `packages/doctype-server-common/src/format-select.ts`：

```ts
export function selectFormat<TDoc>(
  config: { formats: Record<string, DocumentFormat<TDoc>>; defaultFormat: string },
  hint: { name?: string; mediaType?: string; filename?: string },
): { name: string; format: DocumentFormat<TDoc> }
```

### 语义：逐字照抄 Cloudflare 那份

初稿在这里自己拟了一套匹配规则。本次修订**放弃自拟，改为逐字照抄 `editor-do-svalue.ts:954-975` 已有的语义**——那份代码今天在生产上跑着，两条运行时对同一个上传给出不同判断是比任何规则细节都更糟的结果。

| 情形 | 行为 |
|---|---|
| `hint.name` 给定且已注册 | 用它 |
| `hint.name` 给定但未注册 | 抛 `Unknown format: X` |
| `hint.mediaType` **恰好命中一个**格式的 `mediaTypes` | 用它 |
| `hint.filename` 的扩展名**恰好命中一个**格式的 `extensions` | 用它 |
| mediaType 或扩展名命中**多于一个** | 抛 `Ambiguous document format` |
| 全不命中 | 回落 `defaultFormat` |
| `defaultFormat` 未注册 | 抛错 |

匹配顺序 name → mediaType → 扩展名，两处比较均大小写不敏感。

**注意「恰好命中一个」而不是「取第一个」。** 初稿写的是顺序匹配取第一个；CF 那份是命中多个就抛。差别只在**注册了 mediaTypes 或 extensions 相互重叠的两个格式**时才可见——psd 与 png 不重叠，本期任何用例都碰不到。正因为碰不到，更没有理由在这里制造分歧：照抄，让两份实现零差异。

**回落而不是报错**：认不出来的输入按 `defaultFormat` 处理，保持今天的行为。一个不带文件名、或者带着奇怪文件名的 PSD 上传必须继续能用；真正不是 PSD 的字节会在 `load()` 里报错，那才是正确的报错位置。

### 为什么是两份实现而不是一份

合并意味着让 `cloudflare-sdk` 去 import `doctype-server-common` 的新函数，改动一条今天工作正常、且属于另一朵云的关键路径。收益是消掉一份重复，代价是本期的功能改动骑在一次跨包重构上。**本期两份并存，用第四节的 parity 测试锁住行为一致**；两份零差异，将来合并就是纯删除，不是调和。

> **后续（不在本期）**：把 `format-select.ts` 提为两条运行时的唯一实现，`editor-do-svalue.ts:954-975` 删掉改为引用。依赖方向是通的——`cloudflare-sdk/src/sblob-context.ts` 等文件今天已经在 import `doctype-server-common`——只是不该和本期的功能改动混在一起。

### 导入

`Session.create` 的入参加一个可选格式名：

```ts
async create(input?: { bytes?: Uint8Array; format?: string }): Promise<{ sessionId: string; version: number }>
```

`input.format` 为空时行为不变（`defaultFormat`）。`session-handler.ts:143` 的 `/_internal/create` 分支已经拿到了 `File`，把今天在 `:164` 丢掉的 `file.name` / `file.type` 喂给 `selectFormat`，把选出的格式名传下去。同时接受 `formData.get("format")` 作为显式覆盖（与 CF 的 `:783` 对齐，前端本期不用它）。

### 导出

```ts
async exportBytes(formatName?: string): Promise<{ bytes: Uint8Array; contentType: string }>
```

- `formatName` 为空：与今天逐字节一致——`formats[defaultFormat].save` + 顶层 `config.contentType`。
- `formatName` 给定：`selectFormat(config, { name })` 的 `save`，`contentType` 取 `format.mediaTypes[0]`。

`session-handler.ts:196` 的 `GET /_internal/export` 读 `url.searchParams.get("format")` 传进去。

顺手修：`session-handler.ts:204` 的 `Content-Disposition` 今天写死 `attachment; filename="document"`，改成带上所选格式的 `extensions[0]`（`document.psd` / `document.png`）。**这不是新设计，是把 Azure 补齐到 Cloudflare 已有的行为**（`editor-do-svalue.ts:563` 早就是 `document${extension}`）。前端仍然自己设 `a.download`，这只是让直接打 API 的人拿到一个有扩展名的文件。

### 网关

**不用改。** `forwardToWorker` 已经原样带上 `originalUrl.search`（`packages/gateway-common/src/gateway-handler.ts:335`），`?format=png` 会原样到达 `/_internal/export`。

## 二、`doctype-psd` 注册 `formats.png`

在 `packages/doctype-psd/src/doctype.ts` 的 `formats` 里加一项，`defaultFormat` 保持 `"psd"`：

```ts
png: {
  mediaTypes: ["image/png"],
  extensions: [".png"],
  load: async (data) => store(pngToDoc(data)),
  save: async (state) =>
    encode(await render(await resolveDoc(await materialize(state), casBlobStore(ctx)))),
}
```

新文件 `packages/doctype-psd/src/psd/png.ts`，导出 `pngToDoc(bytes): PsdDoc`。

### 解码与归一化

`fast-png` 的 `decode` 返回 `{ width, height, data, channels, depth, palette? }`，`data` 可能是 `Uint8Array` 或 `Uint16Array`。需要一个 `toRgba8(decoded): Pixels` 把它统一成 `model/types.ts` 里的 RGBA8 `Pixels`：

- `depth === 16`：每个分量右移 8 位。
- `palette` 存在（indexed PNG）：`data` 是调色板下标，查表得到 RGB，alpha 取 255（tRNS 透明调色板本期不处理，alpha 一律 255）。
- `channels === 1`（灰度）：铺到 R/G/B，alpha 255。
- `channels === 2`（灰度 + alpha）：铺到 R/G/B，第二个分量作 alpha。
- `channels === 3`（RGB）：alpha 补 255。
- `channels === 4`（RGBA）：直接用。
- `depth === 1 | 2 | 4`：`fast-png` 已经在 `decode` 里展开成每分量一字节，按上面的通道规则处理即可。

### 产出的文档

```ts
{
  canvas: { width, height, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [{
    id: <生成>, name: "背景", type: "raster",
    bounds: [0, 0, height, width],   // [top, left, bottom, right]
    opacity: 1, fillOpacity: 1, visible: true, clipping: false,
    blendMode: "normal",
    pixels: <toRgba8 的结果>,
  }],
}
```

图层 id 沿用 `psd/load.ts:298` 的 `` `l${i}_${name}` `` 形式，即 `l0_背景`。零尺寸（`width` 或 `height` 为 0）的 PNG 直接抛错，不产出一个画布为 0 的文档。

### 编码

`save` 与 PSD 导出走同一条合成路径：`resolveDoc` 把懒加载的 CAS 像素拉实 → `render()`（`render/composite.ts:83`）出全画布 RGBA → `fast-png` 的 `encode`。

**两者同源已经是事实，不是本期要建立的约定**：`psd/save.ts:108` 就是用同一个 `render(doc)` 生成 PSD 内嵌的展平合成图（`:113` `imageData`）的。所以导出的 PNG 与导出的 PSD 里那张合成图逐像素一致——这一条在测试里可以直接断言。

`doctype-psd` 已经依赖 `fast-png`（`package.json:32`，`^8.0.0`），编解码两侧都不引入新依赖。

### 本节做完之后 Cloudflare 立刻可用

因为格式分发在 CF 那条已经是通的（`editor-do-svalue.ts:783` / `:553`），**只要 `formats.png` 注册上，CF 的 PNG 打开与 `?format=png` 导出就同时生效**，不需要第一节。第一节纯粹是把 Azure 补齐到同一水位。

## 三、前端 `web-psd`

### 打开

`ui/panels/top-bar.tsx` 的 `<input accept=".psd">` → `accept=".psd,.png"`。
`ui/controller.ts` 的启动文案「打开一个 PSD 文件开始」去掉格式名，改成「打开一个文件开始」（与 commit `1da1da8` 对空态提示的处理一致）。

其余不动：`createFrom` 已经把文件名作为 `FormData` 的 filename 传上去了，服务端据此选格式。

### 导出

导出按钮从「点击即下载」改成「点击弹菜单」，菜单两项：**导出为 PSD** / **导出为 PNG**，选完立即下载。复用 `top-bar.tsx` 里 `degrade-pop` 那套 popover 的结构与样式（同一个组件里已有的模式，不新造一套）。

- `exportDoc(format: "psd" | "png")`：URL 带上 `?format=`；PSD 一路保持今天的行为。
- `exportFileName(docName, format)`：按格式换扩展名，无文档名时回落 `export.psd` / `export.png`。
- `flush()` 仍然在 fetch 之前跑——导出的是服务端的文档，本地队列没排空就导出会丢掉刚做的编辑（这正是本分支基点那个 commit 修的问题）。
- 导出中禁用整个菜单（沿用现有的 `s.exporting`）。

## 四、测试

**步 1** —— `packages/doctype-psd/tests/png-format.test.ts`（新增）：
- `formats.png.load` 一张已知尺寸的 PNG → canvas 尺寸正确、恰好一个图层、bounds 覆盖整个画布。
- `formats.png.save` → 用 `fast-png` decode 回来，逐像素比对一个手工构造的两层文档的期望合成结果。
- PNG → 文档 → PNG 往返：像素不变。
- **PNG 导出与 PSD 内嵌合成图逐像素一致** —— 同一个文档分别走 `formats.png.save` 和 `formats.psd.save`，后者解出 `imageData` 比对。这条锁住的是「两者同源」（`psd/save.ts:108`），将来谁改了其中一条路径会立刻红。
- `toRgba8` 归一化：灰度、灰度+alpha、调色板、16-bit 各一条。
- 零尺寸 PNG 抛错。

**步 2** —— `packages/doctype-server-common/tests/session.test.ts`（扩充）：
- `create` 带 `.png` 文件名 → 走 `png.load`。
- `create` 带未知扩展名 / 不带文件名 → 回落 `defaultFormat`（今天的行为不变）。
- `exportBytes("png")` → 用 `png.save`，`contentType` 是 `image/png`。
- `exportBytes()` 不带参数 → 与今天完全一致（`defaultFormat` + 顶层 `contentType`）。这是**回归护栏**，比新功能的用例更重要。
- `selectFormat` 的七种情形（第一节那张表）各一条：显式 name 命中 / 显式 name 未注册抛错 / mediaType 唯一命中 / 扩展名唯一命中 / 多命中抛 `Ambiguous document format` / 全不命中回落 / `defaultFormat` 未注册抛错。大小写不敏感另算一条。

**步 2 的等价性护栏** —— 新增 `packages/cloudflare-sdk/tests/format-select-parity.test.ts`：对同一组输入（显式 name / 只有 mediaType / 只有扩展名 / 全不命中 / 多命中），`doctype-server-common` 的 `selectFormat` 与 `editor-do-svalue.ts:954` 那份选出同一个格式，或抛同一类错。两份并存的前提就是行为一致；没有这条断言，「将来合并是纯删除」这句话就没有保障。

> **代价说清楚**：`editor-do-svalue.ts:954` 的 `selectFormat` 今天是**模块私有**的（无 `export`，`index.ts` 也没转出），所以这条测试要求给它加一个 `export` 关键字。这是本设计对 `cloudflare-sdk` 的**唯一**改动：只放开测试可见性，没有任何行为变化，不进 `index.ts` 的公开面（测试从 `src/editor-do-svalue.js` 直接 import，与该包既有测试的做法一致）。
>
> 不愿意动 `cloudflare-sdk` 的话，退路是放弃这条测试，改为把上面那张语义差异表当作规范，只测新实现。**但那样两份实现的一致性就只靠人读代码维持**，属于明确的降级，需要显式接受。

`packages/web-psd/tests/export.test.ts` 与 `top-bar.test.tsx`（扩充）：
- `exportFileName` 按格式换扩展名。
- 导出菜单渲染两项；点击「导出为 PNG」发出的请求带 `format=png`。
- 导出中（`s.exporting`）菜单整体禁用。

## 落地顺序

三步各自是一个可独立验证的交付，**顺序由「哪一步之后哪条运行时能用」决定**，不是由文件依赖决定：

| 步 | 内容 | 做完之后 |
|---|---|---|
| **1** | 第二节：`doctype-psd` 的 `png.ts` + 注册 `formats.png` | **Cloudflare 全通**（打开 `.png`、`?format=png` 导出）。Azure 仍然只有 psd —— 机制没补，`?format=png` 被忽略、上传 `.png` 回落到 `psd.load` 报错 |
| **2** | 第一节：`doctype-server-common` 的 `selectFormat` + `create(format)` + `exportBytes(name)` + Content-Disposition | **Azure 追平**。两条运行时行为一致 |
| **3** | 第三节：前端 `accept` + 导出菜单 | 用户能用上。**必须排在 2 之后**——生产的 PSD 服务跑在 Azure，先放开 `accept=".psd,.png"` 会让用户选到一个服务端还打不开的文件 |

第 1 步单独上线是安全的（多注册一个格式，没有任何调用方会选到它）。第 2 步单独上线也是安全的（不传 `format`、不带可识别文件名时逐字节等价于今天）。

## 影响面

改动文件：

| 文件 | 改动 | 步 |
|---|---|---|
| `doctype-psd/src/psd/png.ts` | 新增 `pngToDoc` / `toRgba8` | 1 |
| `doctype-psd/src/doctype.ts` | 注册 `formats.png`（`:80` 的 `formats` 块） | 1 |
| `doctype-server-common/src/format-select.ts` | 新增 `selectFormat` | 2 |
| `doctype-server-common/src/session.ts` | `create` 收 `format`（`:343`/`:355`），`exportBytes` 收 `formatName`（`:521`/`:524`） | 2 |
| `doctype-server-common/src/session-handler.ts` | `/create` 传文件名与 MIME（`:143`→`:164`）；`/export` 读 `?format=`（`:196`）；`Content-Disposition` 带扩展名（`:204`） | 2 |
| `cloudflare-sdk/src/editor-do-svalue.ts` | `selectFormat`（`:954`）加 `export`，仅测试可见性 | 2 |
| `web-psd/src/ui/panels/top-bar.tsx` | `accept`（`:64`）；导出菜单 | 3 |
| `web-psd/src/ui/controller.ts` | `exportDoc(format)`；`exportFileName(docName, format)`；启动文案 | 3 |

不改：

- `packages/protocol` —— `DocumentFormat` / `formats` / `defaultFormat` 已经够用（`src/types.ts:158-162`）
- `packages/gateway-common` —— `?format=` 随 `originalUrl.search` 原样转发（`gateway-handler.ts:335`）
- **`packages/cloudflare-sdk` —— 格式分发已经实现了，本期不动它的逻辑**（这是本次修订相对初稿的主要变化；两份 `selectFormat` 并存的理由见第一节）。唯一的改动是给 `editor-do-svalue.ts:954` 的 `selectFormat` 加一个 `export`，纯测试可见性，无行为变化 —— 理由与退路见第四节
- `azure-*` —— 它只是 `doctype-server-common` 的宿主，机制补在被宿主的那一侧

无新增依赖（`fast-png` 已在 `doctype-psd/package.json:32`）。
