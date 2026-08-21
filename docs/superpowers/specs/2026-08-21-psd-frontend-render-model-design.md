# PSD 前端渲染模型 · 设计文档

- 日期：2026-08-21
- 状态：设计已定稿，待 review → 进入实现计划
- 相关包：`@unidocs/doctype-psd`（引擎子入口 + 新增量核）、`@unidocs/psd-client`（新增）、`@unidocs/web-psd`（演进）

## 目标与非目标

### 目标

前端从"纯服务端渲染 + 瘦客户端"（每次编辑等一张整图 PNG 往返）升级为**本地实时渲染的交互式编辑器**，同时满足三条：

1. **低编辑延迟** — 拖滑块 / 改可见性 / 变换图层即时反馈，不走服务端整图往返。
2. **富交互** — 画布上的直接操作（拖动/变换、缩放平移、画笔、遮罩编辑等）。
3. **渲染保真一致** — 前端预览与服务端 Photoshop 级合成**逐位一致**。

### 核心策略

**同一份代码，而非第二套实现**。`doctype-psd` 的渲染引擎（`composite.ts` / `blend.ts` / `pixel-source.ts` / 调整算法）是对 `Uint8ClampedArray` 的**纯 TS 像素运算**（`composite.ts` 顶部注明 "Pure TS, no canvas/wasm"），唯一依赖 `fast-png`（纯 JS，浏览器可用）；`ag-psd`（需 canvas-shim）只在 PSD 解析/导出路径、**渲染路径完全不碰**。因此该引擎可原样搬进浏览器：前端跑同一个 `render()`、解同一批 CAS blob、应用同一批 op → **保真几乎免费**。

### 非目标

- 不引入 GPU（WebGL/WebGPU）合成通道作为基线（那是第二套实现，破坏"保真免费"）。GPU **预览**加速仅作为未来对特定重交互的可选项，不在本 spec。
- 不引入 CRDT。冲突解决用"服务端权威 + 本地重放"的简化 OT（见 §2）。
- 不设计 PSD 解析/导出改动（沿用现有 `load`/`save`）。

### 外部依赖（已定为**单独先行任务**，本 spec 假设其就绪）

- **`GET …/ir` 端点 + KV 快照缓存**：返回**当前版本**的 IR JSON。现状 `SnapshotCache`（`ports.ts`）本就是"可丢弃快缓存"，每次 apply 后 `#saveSnapshotCache()` 写回当前版本；PSD 的 `save(doc, ctx)` 产出的是去字节的小 IR JSON（像素已在 CAS）。当年快照挪去 R2 是因含整幅图字节太大顶不住 KV；像素进 CAS 后压力消失，`SnapshotCache` 指回 KV 合适且更快，并**恰好提供"精确当前版本 IR"**（不受 20-delta 快照间隔影响）。
- **op-id 幂等去重**：服务端对携带相同 client 幂等 key 的重复 op 去重（见 §5 幂等）。

## 术语

- **IR** — `PsdDoc = { canvas, layers }` 的图层树；图层像素以 `PixelSource` 表示（resident `Pixels` 或懒 `PixelRef{width,height,hash}`）。
- **懒 doc** — 图层像素为 `PixelRef`、按需从 CAS fault-in 的 `PsdDoc`（`deserialize` 产出）。
- **`baseVersion`** — 客户端工作副本所基于的服务端版本号。命名与 `/apply` 请求的 `baseVersion` 字段一致，**不再引入 `contextVersion`**。
- **CAS blob** — 内容寻址的 PNG 编码像素字节，`GET /users/{u}/cas/nodes/{hash}/content` 读取。
- **tile** — 画布分块单元（如 256×256），增量合成与缓存的粒度。
- **段（segment）** — 扁平渲染序列按调整层/裁剪边界切出的连续区间，图层栈缓存的单位。

---

## §1 架构与模块边界

主线程负责 UI 与同步，Worker 负责像素合成。

```
┌─ 主线程 (UI) ──────────────────────────────┐
│  EditorUI    图层面板 / 工具 / 输入事件         │
│  Viewport    pan/zoom 变换、算可见 tile、       │
│              把 Worker 回传的 tile 贴到 canvas   │
│  DocSession  懒 doc 工作副本 + baseVersion、     │
│              本地 applyOp、pending 队列、        │
│              提交 / 409 rebase 同步             │
└──────────────┬────────────────────────────┘
   postMessage │ (op / doc' / viewport / lod)    ▲ transferable tile bitmaps
┌──────────────▼────────────────────────────┐
│─ Worker 池 ───────────────────────────────│
│  IncrementalCompositor  脏 tile + 图层栈分段缓存 │
│  CasBlobStore (HTTP)    GET /cas/nodes/..       │
│  引擎复用: render/blend/effect/adjust 原样        │
└──────────────┬────────────────────────────┘
               ▼ HTTP
        Gateway → Editor DO (权威: apply / snapshot / ir / export)
                → Operator DO (agent 也在改同一个 doc)
```

### 包划分

1. **`@unidocs/doctype-psd`（改动）** — 新增**浏览器安全子入口** `doctype-psd/engine`：只导出 `render / renderRegion / ops(applyOne, apply, PsdOp) / model 类型 / ir 的 deserialize / 新增 IncrementalCompositor`。**不**从该子入口触达 `save.ts` / `load.ts` / `ag-psd`（否则会把 ag-psd 拖进浏览器 bundle）。`blend` / 效果 / 调整算法零改动复用。
   - **打包约定**：按仓库 `publishConfig` 惯例声明子入口 `exports`（`./engine` → `src/engine.ts`，publish 时重写到 `dist`）。
2. **`@unidocs/psd-client`（新增，框架中立、无 DOM 框架依赖）** — `CasBlobStore`、`DocSession`、`RenderWorkerPool`、worker 入口、`Viewport`。纯逻辑 + `<canvas>`。
3. **`@unidocs/web-psd`（演进）** — 现有瘦客户端壳升级为编辑器 app：消费 `psd-client`；保留既有 create（`POST …/`）、export（`GET …/export`）、agent-chat（`POST …/run`）流程（仍走服务端）。

### 单元职责（隔离自检）

| 单元 | 做什么 | 依赖 | 不碰 |
|---|---|---|---|
| `DocSession` | 版本 + op + 同步 | Gateway HTTP | 像素 |
| `IncrementalCompositor` | 给定 doc + 脏区域出像素 | 引擎、`BlobStore` | 网络、DOM |
| `CasBlobStore` | hash ↔ bytes | Gateway CAS HTTP | 渲染逻辑 |
| `Viewport` | 屏幕坐标 ↔ 画布坐标、贴 tile | canvas | 合成、网络 |
| `RenderWorkerPool` | 派发 op/viewport、收 tile | Worker | 业务语义 |

各单元通过窄接口通信，可独立测试。

---

## §2 数据模型与版本 / 同步协议

### 客户端状态（`DocSession`）

- `doc: PsdDoc` — 懒工作副本（图层 `PixelRef`，blob 按需 fault-in），**不可变**，每次 op 产出新引用。
- `baseVersion: number` — 工作副本所基于的服务端版本。
- `pending: PendingOp[]` — 已本地应用、尚未被服务端确认的 op（含幂等 key）。

### 冷启动

1. `GET /users/{u}/docs/{type}/{docId}/ir` → `{ version, ir }`（当前版本 IR JSON，来自 KV 快照缓存）。
2. `deserialize(ir, casBlobStore)` → 懒 doc；`baseVersion = version`。
3. 首帧：按可见 tile + 粗 LOD 出图，blob 到齐再精修（复用懒像素 fault-in）。

> `GET …/ir` 返回**当前版本**，不受"每 20 delta 才落快照"的稀疏性影响，保证 `baseVersion` 与拿到的 IR 对齐。

### 本地编辑回路（乐观）

```
用户操作 → 映射成 op
  → doc' = applyOne(doc, op)          // 同一份 op 代码，本地立即生效
  → 算脏区域 → IncrementalCompositor 重合成受影响的可见 tile → 上屏
  → pending.push({op, key})
  → 后台 POST …/apply {operations:[op], baseVersion}
       200 → baseVersion = res.version; pending.shift()
       409 → 进入 rebase
```

Class A op 后**不回读 CAS**：后台 apply 仅持久化，客户端信任本地渲染（同代码 → 同结果）。`GET /cas/nodes/{hash}/content` 只在冷启动、409 rebase、Class B 新像素三处使用。

### 冲突 / agent 并发（409 rebase）

Operator DO（agent）也在改同一个 doc，故服务端版本可能领先。

```
409 → GET …/ir 取新 base(version) 作为新工作副本基
     → base' = deserialize(newIR, casBlobStore)
     → 把 pending 逐个 applyOne 重放到 base'（按提交顺序）
          某 op 重放失败(如目标图层已被 agent 删) → 丢弃该 op + 非致命提示
     → doc = 重放结果; baseVersion = newVersion
     → 全量重合成可见 tile
     → 从 pending 头重新提交
```

op 多按 `layerId` 定位、粗粒度，重放通常可交换 → 简化 OT 足够，MVP 不上 CRDT。

### 产生新像素的 op（Class B）

`generative_fill` 等本地无法算像素：提交后目标区域显示占位/loading，apply 返回带**新 `PixelRef` hash** 的图层 → `GET` 新 blob 精修。**不做像素乐观预览，只做占位乐观**。

### 客户端产生的像素（画笔 / 导入图层）

client 先 `fast-png` 编码 → `POST /users/{u}/cas/nodes/{hash}`（lease-with-content）入 CAS → 用该 hash 构造 `add_layer` / `mask_edit` op 提交。本地已持有像素，直接合成，无需回读。

---

## §3 op 分类与本地 apply

复用 `applyOne(doc, op)`（`structuredClone` 不可变，产出新 doc）。当前 op 集（`ops/index.ts` 的 `HANDLERS`）：`init / add_layer / remove_layer / reorder / set_props / crop / transform / adjust / mask_edit / generative_fill`。

### Class A — 纯本地（`applyOne` + 增量重合成，不回读服务端，后台 apply 仅持久化）

| op | 本地处理 | 脏区域 |
|---|---|---|
| `set_props` | 可见性/opacity/blend/fillOpacity/name/locked/clipping/效果参数 — 纯 IR，像素在手 | 图层 bounds + 效果外扩（投影 distance+size、描边 size） |
| `reorder` | 纯图层树重排 | 该图层 bounds（跨调整层则加宽，见 §4 分段） |
| `remove_layer` | 纯 | 该图层 bounds |
| `adjust` | 调整层参数（brit/blwh/hue2）— 纯，重合成时对 backdrop 现算 | 调整层 mask/clip 范围，无 mask 则整画布 |
| `crop` | 画布/图层几何 | 整画布（尺寸变 → 重建金字塔） |
| `transform` | 移动=改 bounds；翻转/缩放/旋转=改像素字节，客户端已持 resident 像素可本地算 | union(旧 bounds, 新 bounds) |
| `mask_edit` | 画笔改 mask 像素，本地产出 | 编辑到的 mask 区域 |
| `add_layer` | 新像素客户端提供：`fast-png` 编码 → CAS `POST` → 引用 hash；本地有像素立即合成 | 新图层 bounds |

**规则**：对**会改像素字节**的 Class A op（`transform` 翻转/重采样、`mask_edit` 画笔），先确保目标图层像素已 fault-in 成 resident，再 `applyOne`（服务端为此有 `resolveLayerPixels` 预处理；客户端因渲染时已解出像素而天然满足）。

> **实现时验证**：`geometry-ops` 的缩放/旋转重采样确为纯 TS、无 node/canvas 依赖（预期成立，与渲染引擎同风格）。

### Class B — 服务端产像素（客户端仅乐观占位）

| op | 流程 |
|---|---|
| `generative_fill` | 提交 → 目标区域占位/loading → apply 返回新 `PixelRef` hash → `GET` 新 blob 精修 |

---

## §4 性能管线（大画布 4000px+ / 上百图层，仍要流畅）

纯 CPU 逐像素引擎不可能每帧全量重合成到 60fps。以下机制在**不引入第二套实现**的前提下把工作量降下来。

### IncrementalCompositor（前后端共享的新增量核；blend/效果/调整算法零改动复用）

1. **分块 tile**：画布切固定 tile（如 256×256），每 tile 缓存当前版本的合成 RGBA。op 脏 rect → 脏 tile 集合 → **只重合成脏 tile**（复用 `renderRegion` 风格的区域合成）。

2. **图层栈分段缓存**（最大收益）：把扁平渲染序列按**调整层/裁剪边界**切成**段**（调整层读整个 backdrop，是天然屏障）。段内按 tile 缓存该段合成贡献。改图层 L 只失效 **L 所在段** 的脏 tile；下方段作 backdrop 保持缓存，上方段在新 backdrop 上重合成。常见情形（改一 raster 图层 opacity、其上无调整层）退化为 `下方缓存 → 重混 L → 上方缓存`。

   > **最难点 / 风险**：调整层输出依赖其下方全部内容 → 改调整层**下方**任意内容会失效"该调整段及以上"。保守规则：段边界设在每个调整层；改第 k 段 → 失效第 k 段到顶的脏 tile。保正确；最坏（调整层在最底）退化为近全量重合成 — 可接受且少见。调整层密集的文档收益打折。

3. **拖拽 LOD**：手势进行中（按下/拖滑块/拽手柄）脏 tile 按降采样（½ 或 ¼）合成给即时反馈；手势结束（落定）对同一批脏 tile 跑全分辨率。**同代码、更粗采样 → 精确收敛**。

4. **分辨率金字塔**：合成只做当前 zoom 层级。缩小 → 合成降采样画布。工作量由**视口像素**而非**画布像素**决定 —— 4000px+ 画布的命门。

5. **内存有界**：复用现有 `PixelCache` 字节预算管解码后的图层像素；tile / 段缓存按 可见 tile × 金字塔层级 以 LRU 限额。

### Worker 池

- Worker 内跑 引擎 + doc + IncrementalCompositor + CasBlobStore；主线程发 op + viewport，Worker 回**脏 tile 的 ImageBitmap（transferable）** → 主线程贴到单个 `<canvas>`。
- **单写纪律**：`DocSession`（主线程）独占权威工作副本，向 Worker 发**不可变 doc 快照 + op**（`structuredClone` 已给新引用）。Worker 是 `(doc, viewport, dirtyRect, lod) → tiles` 的**纯函数**，无共享可变状态 → 无竞态。
- **图层像素只读共享**：优先 **SharedArrayBuffer**（避免大 blob 在多 Worker 间复制）——**需 COOP/COEP 响应头**（跨源隔离，部署注意）。**降级方案**：每 Worker 各自 `PixelCache` 拉自己需要的 blob（多点内存/网络，但简单，无需特殊头）。选型见"未决/部署"。
- **tile 并行**：独立脏 tile 分发到多 Worker；分段缓存是 per-tile 的 → tile 间独立 → 干净并行。

### 一次编辑的数据流（落定）

```
input → DocSession.applyOp(op)                 [主]
      → doc'(不可变), dirtyRect
      → post {doc', dirtyRect, viewport, lod}   [主→Worker]
      → Worker 用分段缓存+引擎重合成脏的可见 tile  [Worker]
      → tile bitmaps(transferable) 回 → Viewport 贴图   [Worker→主]
      → 后台 POST …/apply {op, baseVersion}      [主]
```

---

## §5 错误处理与 reconciliation 边界

1. **blob 缺失 / 拉取失败**：镜像服务端 `renderCached` "失败即丢槽、不缓存坏结果" —— **绝不 brick 文档**。该 tile 显示占位（棋盘/上一帧好图），退避重试；某图层 blob 永久缺失 → 非致命的逐图层错误提示，其余合成照常。

2. **409 rebase 边界**（补 §2）：
   - `GET …/ir` 取新 base → `deserialize` → 按提交顺序重放 pending。
   - **重放丢弃**：pending 某 op 目标 layerId 已被删 → 丢弃 + 非致命提示（"对图层 X 的改动已作废：它已不存在"）。
   - **at-most-once 幂等**：某次提交响应丢包但服务端已入库 → 重试 409，rebase 的新 base 已含该 op，重放本地副本会**双重应用**。缓解：每个 op 带 **client 幂等 key**，服务端对重复 op id 去重（对后端的小依赖）。

3. **本地 apply 抛错（坏 op / 校验失败）**：**不推进** doc、**不入队**，直接报错。`applyOne` "克隆后改、返回前抛"，旧 doc 引用不受影响 → 天然安全（对齐"apply 必须完整校验否则坏 op brick 文档"）。

4. **Class B pending 失败**（生成填充报错）：清占位、恢复图层原态、报错。仅乐观占位、无预览像素，无需回滚像素。

5. **Worker 崩溃**：`RenderWorkerPool` 重启 Worker；Worker 是 doc 的纯函数 → 重发当前 doc、重合成可见 tile 即可，**无状态丢失**（权威 doc 在主线程）。

6. **离线 / 提交积压**：pending 驻内存，UI 显示"N 项未同步"；指数退避重试；本地编辑继续（乐观）。重连后排空队列（按需 409 rebase）。可选：pending 非空时 unload 前告警。

7. **agent 并发编辑**（Operator DO）：agent 每次 apply 推高服务端版本。**MVP**：客户端下次提交时以 409 发现 → rebase 拉入。**可选增强**（不入 MVP）：服务端推送（WebSocket/SSE）版本变更，让空闲客户端主动 rebase。

8. **画布 resize（`crop`）**：脏 = 整画布，重建 tile / 金字塔（全量重合成，直接但少见）。

---

## §6 测试 / 保真策略

**命门**：增量合成器与全量 `render()` **逐位一致**。复用现有 fidelity harness（`tests/support/fidelity.ts` + PSD 保真基线）。

1. **增量 ≡ 全量（属性测试，最核心）**：fixture 文档跑随机 op 序列，每步断言 `IncrementalCompositor.composite() === render(doc)`（同代码，目标精确相等）。这是**分段缓存失效正确性**（尤其调整层）的安全网。
2. **分块 ≡ 整幅**：per-tile 合成 == 整画布合成。
3. **LOD 收敛**：粗帧（½/¼）→ 落定帧 === 全分辨率 `render(doc)`（粗帧只断言"忠实降采样"）。
4. **客户端渲染 ≡ 服务端渲染（跨环境）**：同一 doc 在 node（服务端 `render`）与浏览器/worker 测试环境（同代码 + mock CAS BlobStore）一致，守住"保真免费"不被环境漂移（fast-png 解码、TypedArray 行为）破坏；现有"render() vs PSD 内嵌 PS 合成"保真检查也过一遍客户端路径。
5. **同步 / 版本协议测试**（`DocSession`，不含渲染）：乐观 apply 推进 `baseVersion`；409 rebase 正确重放；重放丢弃；幂等（丢包重试不双应用）；agent 并发经 rebase 合入。
6. **op 分类测试**：每个 Class A op 本地渲染 == 服务端 round-trip（服务端 apply 后 GET preview）；Class B 验证占位 → 正确 blob。
7. **错误路径**：blob 缺失 → 占位不 brick；本地 apply 抛错 → doc 不变；worker 崩溃 → 重启且合成正确；离线 → 入队后排空。
8. **性能冒烟（非硬门槛，基准）**：4000px×N 图层 fixture，量落定帧 / 动中帧在各 LOD 的延迟，跟踪回归。

**TDD 顺序**：先写 `IncrementalCompositor` 的**增量≡全量属性测试**（红）再实现（它是所有缓存机巧的安全网）；再 `DocSession` 同步测试；最后 worker / viewport 集成。

---

## 未决 / 待实现时确认

- **SharedArrayBuffer vs 每 Worker 自持 PixelCache**：取决于 Gateway/部署能否加 COOP/COEP 头。不能则走降级路线。
- **`geometry-ops` 重采样纯度**：确认缩放/旋转无 node/canvas 依赖。
- **tile 尺寸 / 金字塔层数 / LOD 比例 / Worker 数**：按性能冒烟实测调参。
- **可选增强**（不入 MVP）：服务端版本推送（主动 rebase）、GPU 预览加速。

## 依赖的先行任务

1. `GET …/ir`（当前版本 IR）+ `SnapshotCache` 指回 KV。
2. op-id 幂等去重（服务端）。
