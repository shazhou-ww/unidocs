# cloudflare-psd — PSD DocumentType 规范 (v0.4)

> 目标：在 **UniDocs 平台**上新增一个 PSD 图片文档类型（`@unidocs/cloudflare-psd`），让 agent 能对图片做可追溯、可回放的编辑与再生成。
>
> 两条铁律：
> 1. **语义严格对齐 Adobe PSD,不自造概念。** PSD 已有的字段/枚举直接沿用其名字或 4 字符 key。
> 2. **存储/版本/历史/快照/回滚/agent 循环全部用平台,不自己造。** 我们只实现一个 `DocumentType`。

---

## 0. 定位：这是一个 UniDocs DocumentType

UniDocs 已经提供了我们前期设计里辛苦推导的**全部基础设施**:

| 我们曾想自建的 | UniDocs 已内建 |
|---|---|
| ops 表 + 单调 version | **delta + 自增 version**(乐观锁 `baseVersion`,冲突 409) |
| 事务性操作批 | **delta 原子应用**(全成功或全回滚) |
| checkpoints | **snapshot**(每 20 个 delta 自动打,R2 CAS 内容寻址去重) |
| 回放/追溯 | **history / rollback**(从最近 snapshot 重放 delta) |
| 三张 DB 表 | KV / DO-sqlite / D1 / R2,平台托管 |
| agent 编辑循环 | **Operator DO**(ReAct 循环 + 工具派发) |

**所以我们要写的,只是一个 `DocumentType<PsdStoredDoc, PsdQuery, PsdOp>`** —— 持久状态遵循 `@unidocs/protocol` 的 SValue 契约:

| DocumentType 成员 | 我们的实现 | 本规范 |
|---|---|---|
| `init()` | 空 `PsdStoredDoc` | §1 |
| `formats.psd.load(bytes)` | ag-psd `readPsd` → `PsdDoc` → 外置像素 | §6 |
| `formats.psd.save(doc)` | 物化 `PsdDoc` → ag-psd `writePsd` | §6 |
| `apply(ops, doc)` | 物化、应用 op、再返回 `PsdStoredDoc` | §5 |
| `query(q, doc)` | 物化后读状态 / 渲染预览 | §5.3 |
| `tools` | 每个 op/query 一个 agent 工具 | §7 |
| `instructions` | agent 系统提示 | §7 |
| `contentType` | `image/vnd.adobe.photoshop` | §6 |

设计原则:

1. **TDoc = `PsdStoredDoc`,编辑模型 = `PsdDoc`,外部格式 = PSD**。平台直接序列化 TDoc;`formats.psd.load/save` 只负责导入导出。
2. **非破坏编辑**:原图作为只读背景层(第 0 层),编辑叠加为新层/新 op。
3. **概念对齐 PSD**:每节 `PSD:` 标注;我们的扩展 `EXT:` 标注。

---

## 1. PsdStoredDoc(DocumentType 的 `TDoc`)

```jsonc
{
  "canvas": { /* §2 */ },
  "layers": [ /* §3，像素为 SBlob,数组顺序 = 从底到顶 */ ]
}
```

> 这就是平台 snapshot 的值:运行时对它做 canonical SValue 编解码,不调用任何 format。
> 含 `Uint8ClampedArray`/lazy PixelRef 的 `PsdDoc` 只在 factory 内按需物化并用 WeakMap 缓存,不是 TDoc。
> **没有 ops/version/checkpoints 字段** —— 那些是平台层的概念,不在文档模型里。
> `init()` 返回一张空文档(空图层数组 + 默认画布)。

---

## 2. Canvas

> `PSD:` File Header Section

```jsonc
{
  "width": 1920,
  "height": 1080,
  "colorMode": "RGB",     // MVP 仅 RGB(§6 支持范围)
  "depth": 8,             // MVP 仅 8-bit
  "resolution": 72,       // DPI
  "profile": "sRGB"
}
```

---

## 3. Layer

### 3.1 通用字段

> `PSD:` Layer Record

```jsonc
{
  "id": "l0",                 // EXT: 稳定唯一 ID(PSD 里是 'lyid')
  "type": "raster",           // §3.2
  "name": "background",       // PSD: 'luni'
  "bounds": [0, 0, 1920, 1080], // PSD: [top,left,bottom,right]
  "opacity": 1.0,             // PSD: 0–255,此处归一化 0.0–1.0
  "blendMode": "normal",      // PSD: blend mode key,见 §4
  "visible": true,            // PSD: flags bit1
  "locked": false,            // PSD: flags bit0
  "clipping": false,          // PSD: 0=base / 1=non-base
  "pixels": null,             // §3.5 像素数据承载
  "mask": null                // §3.3
}
```

### 3.2 图层类型（type）

| type          | PSD 对应                          | 说明 |
|---------------|-----------------------------------|------|
| `raster`      | 普通像素图层                       | `pixels` 承载像素。导入的 JPG/PNG = 第 0 层 raster |
| `adjustment`  | 调整图层（`levl`/`curv`/`brit`…）  | 非破坏调色,见 §3.4 |
| `fill`        | 填充图层（`SoCo`/`GdFl`/`PtFl`）   | 纯色 / 渐变 / 图案 |
| `text`        | 文字图层（`TySh`）                 | MVP 栅格化(见 §6 降级) |
| `smartObject` | 智能对象（`SoLd`）                 | MVP 读栅格化预览 |
| `group`       | 图层组（`lsct`=1/2）               | `children: []` |

### 3.3 Mask（图层蒙版）

> `PSD:` Layer Mask + Vector Mask（`vmsk`）

```jsonc
{ "kind": "raster", "pixels": <§3.5>, "bounds": [0,0,1920,1080],
  "defaultColor": 0, "inverted": false }
```

### 3.4 Adjustment 参数（type=adjustment）

> `PSD:` Additional Layer Information,`adjustType` 直接用 PSD 4 字符 key

| adjustType (PSD key) | 含义 | params 示例 |
|---|---|---|
| `brit` | Brightness/Contrast | `{brightness, contrast}` |
| `levl` | Levels | `{channel, inBlack, inWhite, gamma, outBlack, outWhite}` |
| `curv` | Curves | `{channel, points:[[x,y]…]}` |
| `hue2` | Hue/Saturation | `{hue, saturation, lightness}` |
| `blnc` | Color Balance | `{shadows,midtones,highlights}` |
| `mixr` | Channel Mixer | `{output, red, green, blue, constant}` |
| `blwh` | Black & White | `{reds,yellows,greens,…}` |
| `vibA` | Vibrance | `{vibrance, saturation}` |
| `expA` | Exposure | `{exposure, offset, gamma}` |
| `phfl` | Photo Filter | `{color, density, preserveLuminosity}` |
| `grdm` | Gradient Map | `{stops:[…]}` |

### 3.5 像素承载（`pixels`）

> **约束**:cloud-neutral 的 DocumentType 没有直接的存储句柄,像素只能待在文档里(会随 `save()` / op payload 走)。

- **MVP**:内联字节(`{ "w":…, "h":…, "data": <base64 或 Uint8Array> }`)。简单、自包含,`save()` 直接嵌进 PSD。
- **规模化(post-MVP)**:通过工厂 `options` 注入一个 blob 能力(R2),`pixels` 改存内容寻址引用 `{ "ref": "cas://<hash>" }`,避免 delta 日志和 snapshot 膨胀。二选一在 §9 待定。

---

## 4. 混合模式枚举（blendMode）

> `PSD:` blend mode key(4 字符 ASCII,不足补空格)。对外用可读名,`save` 时映射回 key。

| 可读名 | key | | 可读名 | key |
|---|---|-|---|---|
| normal | `norm` | | overlay | `over` |
| pass-through | `pass` | | soft-light | `sLit` |
| dissolve | `diss` | | hard-light | `hLit` |
| darken | `dark` | | vivid-light | `vLit` |
| multiply | `mul ` | | linear-light | `lLit` |
| color-burn | `idiv` | | difference | `diff` |
| linear-burn | `lbrn` | | exclusion | `smud` |
| lighten | `lite` | | subtract | `fsub` |
| screen | `scrn` | | divide | `fdiv` |
| color-dodge | `div ` | | hue | `hue ` |
| linear-dodge | `lddg` | | saturation | `sat ` |
| | | | color | `colr` |
| | | | luminosity | `lum ` |

---

## 5. Operation（`TOp`）与 apply

> `TOp = { kind, payload }`。**没有 id/version/parents** —— 版本、历史、delta 批次、乐观锁全是平台的事(README `/apply`)。

### 5.1 apply 语义

```ts
apply(operations: PsdOp[], doc: PsdDoc): Promise<PsdDoc>
```

逐 op 施加,返回新文档。**任一 op 抛错 → 整个 delta 被平台回滚**(事务性),所以 op 要么干净成功要么抛错。参考 markdown 的 `apply` 写法。

### 5.2 op 设计原则(所有 op 必须遵守)

1. **id 由调用方分配**:任何新建图层的 op,payload 自带该层的 `id`。**apply 里不许随机生成 id / UUID**——replay 必须确定,同样的 op 每次得到同样结果。
2. **像素预先解析**:任何引入像素的 op(raster 的 `add_layer`、`generative_fill`、`mask_edit`),像素随 payload 传入(§3.5)。**apply 不生成像素、不调模型、不读时钟/网络/随机数。**
3. **apply 纯且确定**:`(doc, op) → doc'` 恒定无副作用;非法 op **抛错** → 平台把整个 delta 回滚(§5.1)。
4. **图层寻址**:`layerId` 定位图层树中任意层;新增/移动位置用 `parentId`(`null`=画布根)+ `index`(该父层 children 的插入下标,省略=置顶)。
5. **坐标**:`bounds` 一律 `[top,left,bottom,right]`,画布坐标系。

> 「导入」不是 op —— 平台用 `load(bytes)` 建初始文档;之后才追加 op。

### 5.2.1 op 目录（payload + apply 语义）

**`add_layer`** — 新增图层(raster/adjustment/fill/text/group 均走它)
```jsonc
payload: { "layer": <Layer 完整对象,含调用方分配的 id 与像素>,
           "parentId": string|null, "index": number }
```
apply:把 `layer` 插入 `parentId`(null=根)的 children 第 `index` 位。
错误:id 已存在 / parentId 不存在或非 group。

**`remove_layer`** — 删除图层
```jsonc
payload: { "layerId": string }
```
apply:从树中移除该层(group 连同子树)。错误:layerId 不存在。

**`reorder`** — 移动图层(改顺序 / 换父层)
```jsonc
payload: { "layerId": string, "parentId": string|null, "index": number }
```
apply:把该层移到新的 parent+index。错误:不存在 / 把 group 移进自己的后代(成环)。

**`set_props`** — 改图层属性
```jsonc
payload: { "layerId": string,
           "props": { "name"?, "opacity"?, "blendMode"?, "visible"?, "locked"?, "clipping"? } }
```
apply:把 `props` 里的允许字段浅合并到该层。
错误:改了不可变字段(`id`/`type`/`pixels` 走专用 op)/ `blendMode` 不在枚举 / `opacity` 不在 [0,1]。

**`crop`** — 裁剪画布(无损)
```jsonc
payload: { "rect": [top, left, bottom, right] }
```
apply:画布尺寸改为 rect 大小;所有图层 `bounds` 平移 `-[left,top]`(**图层像素不重采样**,只挪坐标;超出画布的层 PSD 允许保留)。

**`transform`** — 变换图层
```jsonc
payload: { "layerId": string,
           "op": { "translate"?: [dx,dy], "flip"?: "h"|"v",
                   "scale"?: [sx,sy], "rotate"?: deg } }
```
apply:
- **MVP 只做无损项**:`translate`(改 bounds/偏移)、`flip`(翻转像素排列)—— 不重采样。
- `scale`/`rotate` 需**确定性重采样器**(会拉进渲染引擎),**留 post-MVP**;MVP 收到则抛"未支持"。

**`adjust`** — 修改已有调整图层的参数
```jsonc
payload: { "layerId": string, "params": { ... } }   // §3.4 对应 adjustType 的 params
```
apply:把 `params` 合并进该调整层。错误:layerId 不是 adjustment 层。
> 新增调整层用 `add_layer`(type=adjustment);`adjust` 只改参数,避免与 add 重叠。

**`mask_edit`** — 设置 / 替换 / 移除图层蒙版
```jsonc
payload: { "layerId": string, "mask": <Mask §3.3 对象> | null }
```
apply:用 `mask`(像素已预先算好)整体替换该层蒙版;`null` = 移除蒙版。
> 局部涂抹(笔刷)由工具层先算出新蒙版像素,再整体传入 —— 保持 apply 确定。

**`generative_fill`** — 生成式填充/重绘(结果预先生成,§5.4)
```jsonc
payload: { "layer": <raster Layer,含已生成结果像素 + 调用方分配 id>,
           "parentId": string|null, "index": number,
           "provenance": { "model", "seed", "prompt", "sourceMask"? } }
```
apply:等价于把这张 raster 结果层 `add_layer` 插入(非破坏,盖在源层上);把 `provenance` 挂到该层备溯源/重掷。**apply 不调模型**,`provenance` 不参与 replay。

### 5.3 query 与渲染

`query(q, doc)` 读状态;`q = { kind, payload }`,返回 `QueryValue`(支持 `Uint8Array`)。关键:

- `getLayers` → 图层树 JSON
- **`getPreview` → 渲染后的 PNG 字节**(客户端靠它看当前图)

**渲染引擎 = `doctype-psd/src/render/`**:纯函数 `render(doc) → 像素`,cloud-neutral,**webui 和 DO 共用同一份**(避免两套渲染逻辑对不上)。MVP 引擎 = **纯 TS 软件合成器**(逐像素对 `Uint8ClampedArray` 做合成/混合/调整,无 wasm,Node/workerd/浏览器通吃,消灭 workerd 门槛)。浏览器端可后续用 canvas/WebGL/canvaskit 作**加速器**(计划④)。

两条渲染路径:
- **交互热路径**:webui import `render/` 在浏览器本地合成;编辑时本地 `apply(op)`(ops 也是纯函数、前后端共用)→ 本地 render 立即出图 → op 异步发 `/apply` 落库(带 baseVersion,409 则重新 query 同步)。
- **冷路径**:DO 的 `query getPreview` 用同一 `render/` 出图,供缩略图 / agent 视觉 / 非交互客户端 / 导出拍平用。

> render 暂放 doctype-psd 内,webui + DO 共用;将来需要独立演进再抽包(§8)。

### 5.4 生成式 op:必须「先出图、再 apply」

生成是非确定、有副作用、慢的;而 `apply` 会在**初次应用和每次 rollback 重放时都执行**。所以**绝不能在 apply 里调模型**。

正确姿势:

1. Operator 的工具(或一个 query)**先**调模型拿到结果像素;

   > 这一步由 `effect` 工具形态承载（protocol/types.ts），PSD 的实现是
   > `editPixels`(src/image/edit-pixels.ts)。它是**唯一**被允许做 IO 的工具形态；
   > query/op 仍然是同步纯函数。见 docs/superpowers/specs/2026-09-01-psd-image-edit-design.md。

2. 再构造 `generative_fill` op,payload **携带已生成的结果**(§3.5 的 pixels/ref)+ 复现信息(`model`/`seed`/`prompt`/`mask`);
3. `apply` 只是把结果像素装进图层 —— **纯、可确定重放**。

```jsonc
{ "kind": "generative_fill", "payload": {
    "target": "l2", "mask": <pixels>,
    "result": <pixels>,                 // 已生成,apply 只安装它
    "model": "sdxl-inpaint@1.2", "seed": 42, "prompt": "remove the car"
} }
```

`model/seed/prompt` 只作溯源与「重掷」用,不参与 replay。

---

## 6. PSD load / save（ag-psd）

- **库:`ag-psd`**(纯 JS,读写皆强)。`load` = `readPsd`,`save` = `writePsd`。
- **`formats.psd.save()` 只产生 `/export` 的 PSD 字节,绝不参与 snapshot。** snapshot 是 `encodeSValue(PsdStoredDoc)`;导入把 PSD 解析并外置像素,导出才重新物化并写回 PSD。
- `contentType: "image/vnd.adobe.photoshop"`。
- 运行环境:**ag-psd 读写不需要 node-canvas / wasm**。用 `initializeCanvas(createCanvas, createImageData)` 注入一个**纯 JS 的 `createImageData`**(返回 `{width,height,data:Uint8ClampedArray}`),配合 `readPsd({ useImageData:true, skipThumbnail:true })` 与 `writePsd`,全程不碰真 canvas。已在 Node 验证(见 `tests/fixtures/`)。

**支持范围(锁死)** — 主流 8-bit RGB PSD 完整往返:

| ✅ 支持 | ❌ 不做(已确认无需求) |
|---|---|
| 8-bit RGB | CMYK / Lab / Indexed / 灰度 |
| 图层/组/蒙版/矢量蒙版 | 16 / 32-bit |
| 混合模式/不透明度/剪贴蒙版 | PSB 大文件 |
| 调整图层 / 图层效果 | 可编辑文字往返 |
| alpha / 透明度 (RGBA) | |

**MVP 导入策略(方案 B:宽进)** —— 在 `load()` 内:
- `logMissingFeatures: true`:能读的读进来,未知块跳过并记日志。
- `throwForMissingFeatures: false`:不因单个冷门块拒绝整张图。
- 例外:整文档级不支持(CMYK/Lab/16-32bit/PSB)→ **明确报错拒绝**。
- 代价:未知块永久丢弃(ag-psd 源码 `skipBytes`);MVP 可接受。

**降级**:文字层/智能对象 → 栅格化为 raster 层。

**未知块透传(post-MVP)**:给 ag-psd 打约 10 行补丁(读 `skipBytes`→`readBytes` 存 `_passthrough`;写时末尾原样写回),`_passthrough` 随 `PsdDoc` 走。限制:只救"完全未知"的块;写回是末尾追加、非原位。

### 字段映射

| PsdDoc | PSD |
|---|---|
| canvas | File Header |
| layer 通用字段 | Layer Record |
| layer.name / id | `luni` / `lyid` |
| blendMode | blend mode key(§4) |
| group(children) | `lsct` 哨兵 |
| adjustment.adjustType | Additional Layer Info key |
| mask | Layer Mask / `vmsk` |

---

## 7. Agent 接口（`tools` + `instructions`）

平台的 Operator DO 提供 ReAct 循环;我们只提供:

- **`tools`**:每个 op → 一个 `apply_*` 工具,每个 query → 一个 `query_*` 工具,各带 JSON Schema(参考 markdown)。Operator 负责 query→拿 version→apply→处理 409 重试。
- **`instructions`**:图片编辑 agent 的系统提示(有哪些图层操作、何时渲染预览确认、生成式怎么用)。
- 生成式工具在**工具层**调模型出图(§5.4),再 apply。

---

## 8. 打包（跟平台约定）

两个包,已按平台"cloud-neutral / adapter 分离"惯例拆好:

- **`doctype-psd`**(`@unidocs/doctype-psd`,cloud-neutral):文档模型 + ops + **render**(`src/render/`)+ ag-psd load/save,组装 `createPsdDocumentType(options)`。**webui 和 DO 都依赖它**。工厂 `options` 可注入 blob 能力(§3.5)、模型 provider。
- **`cloudflare-psd`**(薄适配,仅 `src/worker.ts`):
  ```ts
  export const PsdEditor   = createEditorDO(createPsdDocumentType);
  export const PsdOperator = createOperatorDO({ agent: psdAgent, provider, getEditorStub });
  ```
  配 `wrangler.toml`(DO 类 `PsdEditor`/`PsdOperator` + 共享 D1/R2)+ 在 Gateway 注册绑定。

**目录约定(`doctype-psd/src`):**
```
model/    PsdDoc 类型(纯,无 ag-psd)    ← webui 也 import
ops/      apply 操作(纯,无 ag-psd)     ← webui 也 import(本地乐观 apply)
render/   render(doc)→像素(canvaskit)   ← webui 也 import(本地渲染)
psd/      ag-psd load/save              ← 仅服务端/导入
doctype.ts  组装 DocumentType
```

**Bundle 纪律**:webui 只 import `model/ops/render`,**绝不碰 `psd/`**,以免把 ag-psd 拖进浏览器包。用**子路径导出**(如 `@unidocs/doctype-psd/model`)把纯模块与 ag-psd 隔开,保证 tree-shaking 能甩掉 ag-psd。

> **后续可选拆分**:render 需要独立演进时,再从 doctype-psd 抽成 `render-psd` 包(webui + DO 共用不变)。MVP 先放 doctype-psd 内。

---

## 9. 决策与待定

**已定:**
- 落在 UniDocs 上,实现 `DocumentType<PsdStoredDoc, PsdQuery, PsdOp>`;`PsdDoc` 仅作 materialized cache;**不自建存储/版本/历史/快照/agent 循环**。
- 像素通过 SBlob 外置到 CAS;snapshot 直接编码 `PsdStoredDoc`,不设 `snapshotFormat`,不调用 PSD save。
- op = `{kind, payload}`;版本/回放/乐观锁归平台。
- 生成式:先出图再 apply,payload 携带结果(§5.4)。
- PSD 库 ag-psd;仅 8-bit RGB;MVP 导入方案 B;透传留 post-MVP。
- **渲染引擎:纯 TS 软件合成器**(MVP),无 wasm、Node/workerd/浏览器通吃;render 放 `doctype-psd/src/render/`,webui 与 DO 共用(§5.3/§8)。canvaskit/WebGL 留作浏览器加速器(计划④)。

**待定:**
1. **DO-runtime spike**:
   - ✅ **ag-psd 已在 Node 验证**:纯 JS `createImageData` shim + `useImageData` + `skipThumbnail`,读写往返完整、无 canvas 依赖(`tests/fixtures/generate.mjs` 生成的 `sample.psd`)。剩:同一路径在 **workerd** 里跑一遍确认。
   - ✅ **渲染改用纯 TS 合成器**(逐像素数学),无 wasm,workerd 天然可跑 —— canvaskit 门槛已消除。剩:PNG 编码用纯 JS 编码器(getPreview)。

---

### 参考来源
- UniDocs README + `@unidocs/protocol` `DocumentType` 契约 + `doctype-markdown` 参考实现(本仓库 `~/workspace/unidocs`)
- Adobe Photoshop File Format Summary — https://www.fileformat.info/format/psd/egff.htm
- ag-psd — https://github.com/Agamnentzar/ag-psd
