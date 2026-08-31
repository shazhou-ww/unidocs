# PSD 文档类型的图片格式进出口（PNG）

日期：2026-08-31
分支基点：`fix/web-psd-export-blank`（导出前 flush 待提交编辑的修复是本设计的前提）

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

导入链路：
`openFile` → `DocController.createFrom`（`FormData`，`fd.append("file", blob, label)`）→ `POST /tenants/{t}/docs/psd/` → 网关 `createDocument` → `POST /_internal/create` → `Session.create({ bytes })` → **写死** `formats[defaultFormat].load`（`doctype-server-common/src/session.ts:355`）

导出链路：
导出按钮 → `GET /tenants/{t}/docs/psd/{id}/export` → 网关 `forwardToWorker` → `GET /_internal/export` → `Session.exportBytes()` → **写死** `formats[defaultFormat].save` + 顶层 `config.contentType`（`doctype-server-common/src/session.ts:524`）

两头都没有选格式的入口。另一条运行时 `cloudflare-sdk/src/editor-do-svalue.ts:960` 已经有一份按名字 / mediaType / 扩展名选格式的逻辑，语义要对齐。

## 一、格式选择机制（`doctype-server-common`）

新增纯函数，放在 `packages/doctype-server-common/src/format-select.ts`：

```ts
export function selectFormat<TDoc>(
  config: { formats: Record<string, DocumentFormat<TDoc>>; defaultFormat: string },
  hint: { name?: string; mediaType?: string; filename?: string },
): { name: string; format: DocumentFormat<TDoc> }
```

匹配顺序：`hint.name` 精确命中 → `hint.mediaType` 命中某格式的 `mediaTypes` → `hint.filename` 的扩展名命中某格式的 `extensions` → 回落 `defaultFormat`。扩展名匹配大小写不敏感。`defaultFormat` 未注册时抛错（与 `editor-do-svalue.ts:978` 一致）。

**回落而不是报错**：认不出来的输入按 `defaultFormat` 处理，保持今天的行为。一个不带文件名、或者带着奇怪文件名的 PSD 上传必须继续能用；真正不是 PSD 的字节会在 `load()` 里报错，那才是正确的报错位置。

### 导入

`Session.create` 的入参加一个可选格式名：

```ts
async create(input?: { bytes?: Uint8Array; format?: string }): Promise<{ sessionId: string; version: number }>
```

`input.format` 为空时行为不变（`defaultFormat`）。`session-handler.ts` 的 `/_internal/create` 分支已经拿到了 `File`，把今天丢掉的 `file.name` / `file.type` 喂给 `selectFormat`，把选出的格式名传下去。

### 导出

```ts
async exportBytes(formatName?: string): Promise<{ bytes: Uint8Array; contentType: string }>
```

- `formatName` 为空：与今天逐字节一致——`formats[defaultFormat].save` + 顶层 `config.contentType`。
- `formatName` 给定：`selectFormat(config, { name })` 的 `save`，`contentType` 取 `format.mediaTypes[0]`。

`session-handler.ts` 的 `GET /_internal/export` 读 `url.searchParams.get("format")` 传进去。

顺手修：`Content-Disposition` 今天写死 `attachment; filename="document"`，改成带上所选格式的 `extensions[0]`（`document.psd` / `document.png`）。前端仍然自己设 `a.download`，这只是让直接打 API 的人拿到一个有扩展名的文件。

### 网关

**不用改。** `forwardToWorker` 已经原样带上 `originalUrl.search`（`packages/gateway-common/src/gateway-handler.ts:262`），`?format=png` 会原样到达 `/_internal/export`。

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

`save` 与 PSD 导出走同一条合成路径：`resolveDoc` 把懒加载的 CAS 像素拉实 → `render()`（`render/composite.ts:83`）出全画布 RGBA → `fast-png` 的 `encode`。上一个 commit 刚把 PSD 导出改成走 `render()`，两者保持同源，导出的 PSD 和导出的 PNG 内容一致。

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

`packages/doctype-psd/tests/png-format.test.ts`（新增）：
- `formats.png.load` 一张已知尺寸的 PNG → canvas 尺寸正确、恰好一个图层、bounds 覆盖整个画布。
- `formats.png.save` → 用 `fast-png` decode 回来，逐像素比对一个手工构造的两层文档的期望合成结果。
- PNG → 文档 → PNG 往返：像素不变。
- `toRgba8` 归一化：灰度、灰度+alpha、调色板、16-bit 各一条。
- 零尺寸 PNG 抛错。

`packages/doctype-server-common/tests/session.test.ts`（扩充）：
- `create` 带 `.png` 文件名 → 走 `png.load`。
- `create` 带未知扩展名 / 不带文件名 → 回落 `defaultFormat`（今天的行为不变）。
- `exportBytes("png")` → 用 `png.save`，`contentType` 是 `image/png`。
- `exportBytes()` 不带参数 → 与今天完全一致（`defaultFormat` + 顶层 `contentType`）。
- `selectFormat` 的匹配顺序与大小写不敏感各一条。

`packages/web-psd/tests/export.test.ts` 与 `top-bar.test.tsx`（扩充）：
- `exportFileName` 按格式换扩展名。
- 导出菜单渲染两项；点击「导出为 PNG」发出的请求带 `format=png`。
- 导出中（`s.exporting`）菜单整体禁用。

## 影响面

改动文件：

| 文件 | 改动 |
|---|---|
| `doctype-server-common/src/format-select.ts` | 新增 `selectFormat` |
| `doctype-server-common/src/session.ts` | `create` 收 `format`，`exportBytes` 收 `formatName` |
| `doctype-server-common/src/session-handler.ts` | `/create` 传文件名与 MIME；`/export` 读 `?format=`；`Content-Disposition` 带扩展名 |
| `doctype-psd/src/psd/png.ts` | 新增 `pngToDoc` / `toRgba8` |
| `doctype-psd/src/doctype.ts` | 注册 `formats.png` |
| `web-psd/src/ui/panels/top-bar.tsx` | `accept`；导出菜单 |
| `web-psd/src/ui/controller.ts` | `exportDoc(format)`；`exportFileName(docName, format)`；启动文案 |

不改：`packages/protocol`（`DocumentFormat` 已经够用）、`packages/gateway-common`、`packages/cloudflare-sdk`（那份 `selectFormat` 语义对齐即可，本期不动它）、`azure-*`。

无新增依赖。
