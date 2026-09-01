# PSD 层内像素编辑设计

日期: 2026-09-01
分支: feat/psd-image-edit
状态: 设计待评审（未开始实现）

## 1. 问题与根因

现象：操作**图层**（移动、改属性、调整顺序）时 agent 几轮就完成；一旦指定图层去改**像素**
（"把人像帽子删掉，变成没帽子的样子"），交互必然撞上 25 轮上限。

根因不是慢，是**没有可达路径**。`packages/doctype-psd/src/tools.ts` 里 12 个工具中，三个能碰像素的
（`addLayer` 的 raster 分支、`editMask`、`generativeFill`）都要求调用方在 JSON 参数里交出 RGBA 数组。
LLM 产不出像素。图层操作快，恰恰因为它们的参数是数字、字符串、枚举。

结构上的硬阻塞在 `packages/protocol/src/types.ts:202`：`AgentTool` 是一个两分支联合，
`query` 与 `op` 都是**同步纯函数**，没有任何一种工具形态被允许做 IO。
`packages/doctype-psd/docs/design.md:184` 进一步规定 `apply` 必须纯：
"apply 不生成像素、不调模型、不读时钟/网络/随机数"。
同文件 `:280` 留下了这个洞的说明："Operator 的工具（或一个 query）**先**调模型拿到结果像素"——
但这个"先"字对应的机制从未存在。

次要成本（不是根因，但加剧了轮次消耗）：
- `session.ts` 每轮都 `materializeMessages(this.#history, ...)`，把历史里所有预览 PNG 重发一遍（每张约 720 KiB）。
- 模型只能从 768px 降采样预览里猜坐标。
- `packages/web-psd/src/ui/api.ts:63` 的 `withTarget()` 只传图层**名**不传 id，强迫多一次 `getLayers` 往返。

## 2. 接口定义

### 2.1 内核：第三种工具形态 `effect`

`packages/protocol/src/types.ts`，给 `AgentTool` 联合加第三个分支。这是**唯一**被允许做 IO 的工具形态。

```ts
| {
    readonly kind: "effect";
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly run: (
      args: Readonly<Record<string, JsonValue>>,
      ctx: EffectContext<TQuery>,
    ) => Promise<EffectOutcome<TOp>>;
  };

/**
 * 就是 AgentPlatform 的四件事去掉 apply —— effect 跑在 Operator DO 里，
 * 它手上只有 AgentPlatform，没有 DocumentTypeContext（那是 Editor DO 的东西）。
 * 用 readBlob/writeBlob 而不是 makeSBlob/openSBlob，内核不需要新造管道。
 */
export interface EffectContext<TQuery> {
  readonly query: (q: SValueType<TQuery>) => Promise<{ data: SValue; version: number }>;
  readonly readBlob: (blob: SBlob) => Promise<SBlobBytes>;
  readonly writeBlob: (data: SBlobBytes) => Promise<SBlob>;
  readonly signal: AbortSignal;
}

export interface EffectOutcome<TOp> {
  /** 空数组 = 什么都不改。此时不产生 delta、不 bump 版本。 */
  readonly ops: readonly SValueType<TOp>[];
  readonly result: AgentToolResult;
  readonly description?: string;
}
```

不变量：`effect` 做完 IO 后**产出的仍然是普通 op**。像素在 op 被创建之前就已落进 CAS，
所以 `apply` 保持纯函数，确定性重放不受影响。

**前置缺口**：`writeBlob` 今天没接通 —— `cloudflare-sdk/src/agent-platform-do.ts:132` 直接抛
`"writeBlob is not wired yet: no provider returns binary content"`，编辑器 DO 也只有
`resolve_blob`（按 hash 造引用）和 `read_blob`（读字节），没有"给我字节、返回 SBlob"那条路由。
本设计是它的第一个调用方，必须先补上 `/_internal/write_blob`。

### 2.2 PSD 领域：`ImageEditor` 端口

`packages/doctype-psd/src/image/editor.ts`

```ts
export interface Coverage { width: number; height: number; data: Uint8ClampedArray }

export interface ImageEditor {
  readonly id: string;
  readonly capabilities: EditorCapabilities;
  edit(req: EditRequest, signal: AbortSignal): Promise<EditResult>;
}

export interface EditorCapabilities {
  readonly mask: "required" | "optional" | "unsupported";
  readonly minPixels: number;
  readonly maxPixels: number;
  /** 输出是否自带隐形水印；true 时差异蒙版不可信 */
  readonly watermarked: boolean;
}

export interface EditRequest {
  readonly source: Pixels;          // RGBA，任意尺寸
  readonly mask?: Coverage;         // 白=改，黑=别动
  readonly instruction: string;
  readonly seed?: number;
}

export type EditResult =
  | { readonly ok: true;
      readonly pixels: Pixels;       // 后置条件：与 source 严格同尺寸，alpha 已还原
      readonly changed: Coverage | null;
      readonly provenance: { model: string; seed: number; prompt: string } }
  | { readonly ok: false;
      readonly reason: "refused" | "needs_mask" | "timeout" | "provider_error";
      readonly detail: string };
```

**契约由消费方的需要定义，不由各家 provider 能力的交集定义。**
消费方要的是："给你一个图层的像素和一句指令，还我同尺寸、alpha 完好的像素。"
所有护栏——尺寸阶梯、padding、最小像素下限、异步轮询、RGB↔RGBA、色彩校正——
由这条后置条件**逼进适配器内部**。若按交集定义，Seedream 的任意尺寸能力会被 Gemini 的离散阶梯砍掉。

关于"要不要蒙版"：类型层面它是可抽象的（`mask?` + `capabilities.mask` 三态）。
真正抽不掉的只有一个**默认行为**决定——当调用方没给蒙版而 provider 要求蒙版时怎么办
（拒绝 / 自动分割 / 降级整层）。这是个便宜且可逆的行为决定，不是类型决定。
本轮取 `mask: "optional"`。

### 2.3 扩展点：契约测试套件

`packages/doctype-psd/src/testing/image-editor-contract.ts`，沿用仓库既有的
`packages/doctype-server-common/src/testing/port-contract.ts` 的 `runPortContract` 写法。

```ts
export function runImageEditorContract(
  label: string,
  factory: () => Promise<ImageEditor>,
  opts: { live: boolean },
): void
```

### 2.4 本轮不做，但接口已预留

图层分解（Qwen-Image-Layered 一类）是**另一个端口**，不塞进 `ImageEditor`：

```ts
export interface LayerDecomposer {
  decompose(source: Pixels, opts: { layers?: number }): Promise<readonly Pixels[]>;
}
```

`psdAgent` 由常量改为工厂 `psdAgent({ editor })`，注入点在此。

## 3. 数据流

```
用户: "把帽子删掉"  (web-psd 附带 <<selection bounds=[...] layers=["人像"]>>)
  |
  +-1 getLayers / getDoc      -> 拿到 layerId 与 bounds        (query, 纯)
  +-2 editPixels {layerId, instruction}                        (effect, 新)
  |     +- ctx.query(getLayerPixels) -> 该层原生分辨率 RGBA + bounds + parentId/index
  |     +- editor.edit({source, instruction}) -> 适配器内部:
  |     |     合成到哨兵底色 -> 尺寸压进像素预算 -> 调模型 -> 立刻下载 OSS
  |     |     -> 重采样还原原尺寸 -> 哨兵反推 alpha -> 后置条件断言
  |     +- 差异蒙版 changed = |after - before| > 阈值(16)，膨胀 2px + 羽化 2px
  |     +- 蒙版烘进结果层 alpha（见下）
  |     +- ctx.writeBlob(after PNG) 落 CAS
  |     +- return { ops:[generative_fill(PixelRef)], result: after 预览图 }
  +-3 模型看到 after 预览，确认或再来一轮
```

25 轮 -> 2~3 轮。`apply` 依然纯。

### 3.1 结果怎么落地

落地物是**一个新的 raster 图层**，插在源层正上方（图层数组 bottom-to-top，所以是
源层 `index + 1`），bounds 与源层完全一致。源层一个像素都不动。

差异蒙版**烘进这个新层自己的 alpha 通道**，而不是做成一个 `Mask` 对象：
改动区不透明，其余区域全透明，下面的原层原样露出来。

- 为什么必须有这个蒙版：模型返回的是**整层重绘**，未编辑区域也被重画了一遍。
  实测色偏只有 -1.94/-1.62/+0.52，但整层无遮挡地盖上去，就等于给全图蒙了一层
  不可见的偏色。烘进 alpha 之后，没动的那 97.7% 像素仍然是原层的原始字节。
- 为什么不做成 `Mask`：`Mask.pixels` 的类型是**驻留的** `Pixels`
  （`model/types.ts:17`，注释明说合成器仍读 `pixels`），不接受 PixelRef。走 `Mask`
  就意味着把一整张 RGBA 蒙版塞进 op —— 1600x1200 的层是 7.7 MB 进 delta，每编辑
  一次涨一次。烘进 alpha 视觉上完全等价，且 delta 里只有一个引用。
  代价：在 Photoshop 里看到的是"一个带透明区的图层"而不是"图层 + 蒙版"，
  蒙版本身不能单独再编辑。要恢复可编辑蒙版，需要先把 `Mask.pixels` 放宽成
  `PixelSource` —— 那是另一件事，本轮不做。

结果层的像素以 **PixelRef**（`{width, height, hash, blob}`）进 op，不是驻留 RGBA：
字节已经在 CAS 里，op 只带引用。

### 3.2 新增的内部 query

`getLayerPixels {layerId}` -> `{ image, width, height, bounds, parentId, index }`。

`getPreview` 永远经过 `fitToBudget`（约 720 KiB 上限），拿不到原生分辨率 —— 预览是给
模型的眼睛看的，压到 768 正合适；编辑要的是原始像素，压了就再也还原不回去。
所以另开一条 query。它**不进工具表**：模型读不了裸 RGBA，只有 effect 用得上。

## 4. 错误处理与降级

| 情况 | 处理 |
|---|---|
| `ok:false, reason:"refused"` | 不产生 op（`ops: []`，不 bump 版本），detail 原样回给模型，让它改措辞重试 |
| `reason:"needs_mask"` | 提示模型先 `getPreview {rect}` 定位、再带 `rect` 缩小范围 |
| `reason:"timeout"` / `"provider_error"` | 同样不落 op；effect 自身不重试，重试交给模型判断 |
| `changed === null`（差异蒙版不可信，如水印模型） | 降级整层替换（alpha 不裁剪），`provenance.maskDerivation = "none"` |
| 后置条件断言失败（尺寸/alpha 不符） | 视为 `provider_error`；适配器的 bug 不许污染文档 |

关键：**effect 的失败是一次普通的工具返回，不是异常**。不写文档、不涨版本，模型收到一段可读文本。

## 5. 测试策略

1. **纯函数护栏**（无网络）：尺寸阶梯对齐、哨兵色 alpha 反推、差异蒙版阈值——固定像素数组黄金测试。
2. **适配器录制回放**：真实探测响应存 fixture，打桩 `fetch`，验证 OSS URL 解析、超时、错误码映射。
3. **端口契约套件**：`live:false` 跑桩实现；`live:true` 才打真 API（需 env 有 key，CI 默认跳过）。
   契约只断言后置条件——同尺寸、alpha 完整、provenance 齐全——不断言画得好不好看。

## 6. 模型选型：实测结论

### 6.1 可用模型清单（DashScope，2026-09-01 实测拉取）

`GET https://dashscope.aliyuncs.com/compatible-mode/v1/models` 返回 247 个模型，其中：

- **图像编辑**：`qwen-image-edit-max`、`qwen-image-edit-plus`
  （快照 `-2025-10-30`、`-2025-12-15`、`-2026-01-16`）
- **文生图**：`qwen-image-3.0` / `3.0-pro`、`qwen-image-2.0` / `2.0-pro`、`qwen-image-max`、
  `qwen-image-plus`、`wan2.7-image`、`wan2.7-image-pro`、`z-image-turbo`
- **仅视觉理解**：`qwen-vl-*`、`qwen3-vl-*`

其中 `qwen-image-3.0-pro`、`wan2.7-image-pro`、`z-image-turbo` 比能找到的公开文档都新。

### 6.2 调用路由（重要）

OpenAI 兼容端点**不能生图**：`/compatible-mode/v1/images/generations` 与 `/images/edits`
均返回 HTTP 404 空体。可用路由是原生 AIGC：

```
POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
{ "model": "qwen-image-edit-plus",
  "input": { "messages": [{ "role": "user", "content": [
      { "image": "data:image/png;base64,..." },
      { "text": "删掉人物头上的红色帽子…" } ]}]},
  "parameters": { "watermark": false } }
```

同步返回，给的是一个**会过期的 OSS URL（约 24h）**，适配器必须立即下载。

### 6.3 一次真实编辑的实测数据

输入 613x457 RGBA 人像，指令"删掉帽子"：

| 指标 | 实测 |
|---|---|
| 延迟 | 6.3s（同步，无需轮询） |
| 输出 | 1184x896 **RGB**（尺寸与宽高比都没保持：1.3414 -> 1.3214） |
| alpha | 丢失，被合成到黑底 |
| 未编辑区域色偏 | -1.94 / -1.62 / +0.52（每通道） |
| 差异@阈值16 | 全图 2.3%；帽子框内 49.5%；框外 0.3% |
| 视觉 | 帽子干净移除，头顶补全成完整圆形，身体未动 |
| 成本 | 约 ¥0.2 / 次 |

### 6.4 三个坑的裁决

- **坑 2 色偏——实测不存在**（±2 灰阶）。差异蒙版方案可行。
  原先担心的 Gemini/SynthID 那种否决级风险在这里不适用。
- **坑 1 尺寸——真实但可解**。所有上面这些好指标都是 LANCZOS 缩回原尺寸**之后**测的，
  重采样噪声已被阈值吸收。
- **坑 3 alpha——真实，需适配器处理**。方案：**哨兵底色**（合成到图中不存在的颜色，如品红），
  再把变更区域内接近哨兵色的像素判为透明。**尚未验证。**

### 6.5 单一实现选型

选 `qwen-image-edit-plus`。理由：色偏近零、6.3s 同步、$0.03/次、key 已在手。
（原纸面推荐是 Seedream 5.0 Pro，被实测推翻。）

值得注意的是：换掉推荐模型没有引起 `ImageEditor` 接口的任何改动——这反过来验证了契约设计。

## 7. 安全

DashScope API key 走 `.dev.vars` / 环境变量，**不进代码、不进提交**。
会话中曾明文出现过的 key 建议轮换。

## 8. 本轮范围

按用户决定："先把接口定义定好，预备好扩展，但是本次只实现一个实现"。

做：`effect` 工具形态 + `ImageEditor` 端口 + 契约套件 + `qwen-image-edit-plus` 一个适配器 + `editPixels` 工具。
不做：`LayerDecomposer` 实现、多适配器、自动分割兜底。

## 9. 已识别但未排期的省轮次改进（正交）

1. selection target 里带 `layerId`，省掉一次 `getLayers` 往返（`web-psd/src/ui/api.ts:63`）。
2. 写工具返回 after 预览，省掉一次显式 `getPreview`。
3. 用 `messages.ts` 已有的 `degrade()` 降级历史里的旧图，压住每轮 720 KiB 的重发。

## 10. 待验证

- 哨兵底色 alpha 还原（6.4 坑 3）——未测。
- Qwen-Image-Layered 的 amodal 补全：移除图层后底下是空洞还是补好的背景——未测。
