# Phase 3 实施计划:持久化接线(IR 快照 + CAS 每层 blob + 按需渲染)

> **已被 2026-08-21 SValue 协议取代。** 本文仅保留为历史实现记录。当前 snapshot 固定为 canonical `PsdStoredDoc` SValue;JSON IR 是 doctype 内部 materialization 适配层,不是 snapshot format;PSD format 只用于导入导出。以 [CAS Architecture](../../../docs/cas-architecture.md) 为准。

> **给执行者:** 必需子技能:superpowers:subagent-driven-development。步骤用 `- [ ]` 勾选。

**目标(一句话):** 让 editor-do 用 **IR 快照(小 JSON + 每层 PNG blob 进 R2 CAS)** 取代"每次 apply 重编码整个 23MB PSD",并把 BlobStore 接进渲染/查询路径,使**懒加载文档能在生产中真正跑起来、峰值内存被 bound 住**。

**架构:** 复用已有的 `serialize`/`deserialize`(Phase 2 产出)+ 已有的 `computeHash`/`Env.CAS`。快照存的是 `serialize(doc, store)` 的字节(IR JSON,结构+每层像素哈希),像素本体是 CAS 里按内容寻址的 PNG blob(未变的层天然去重、跳过重编码)。渲染/预览通过注入的 `RenderCtx{store,cache}` 按需 fault-in 像素。

**Spec:** 本计划 + `memory-architecture-plan.md` 的「Phase 3 必备输入」节(4 条),即最终评审的载入项。

## 全局约束
- **保真度不回退**:`pnpm --filter @unidocs/doctype-psd exec vitest run fidelity` 三数不变(sample 0.000 / landing ≤0.2 / fashion ≤0.3)。
- **像素绝不内联进 op/JSON**(SQLITE_TOOBIG);进 CAS。
- **向后兼容**:生产里已有的**旧 PSD 二进制快照**必须仍能加载(用 magic 区分:PSD 以 `8BPS` 开头,IR JSON 以 `{` 开头)。
- 跨包:改动在 `cloudflare-sdk`(editor-do、新 blob-store)、`core`(query 签名)、`doctype-psd`(cache/ops/queries)。core/sdk 改后需 `pnpm --filter @unidocs/<pkg> run build` 重建 dist。

---

### Task 1: R2 BlobStore 适配器(cloudflare-sdk)
**Files:** Create `packages/cloudflare-sdk/src/blob-store.ts`; Test `packages/cloudflare-sdk/tests/blob-store.test.ts`
**Interfaces:** Produces `createR2BlobStore(cas: R2Bucket): BlobStore`（`BlobStore` 从 `@unidocs/core` 导入）。`put(bytes)`: `hash=computeHash(bytes)`(复用 editor-do 的同款 SHA-256→16hex,抽到共享处或复制)、`cas.put(hash,bytes)`、返回 hash(内容寻址、幂等)。`get(hash)`: `const o=await cas.get(hash); return o? new Uint8Array(await o.arrayBuffer()) : null`。
- [ ] Step1 失败测试:用一个内存 R2 桩(`put/get/head` 的 Map 版)验证 put 返回内容哈希、相同字节同哈希、get 取回一致、缺失返回 null。
- [ ] Step2 跑,失败。 - [ ] Step3 实现。 - [ ] Step4 绿。 - [ ] Step5 提交 `feat(sdk): R2-backed BlobStore adapter`。

### Task 2: PixelCache 改按字节预算(doctype-psd,修最终评审 Finding 1)
**Files:** Modify `packages/doctype-psd/src/render/pixel-source.ts`; Modify `packages/doctype-psd/tests/pixel-source.test.ts`; Modify `packages/doctype-psd/src/render/composite.ts`(`defaultCtx` 的默认预算)
**Interfaces:** `new PixelCache(maxBytes: number)` —— 容量按**解码字节数**(`pixels.data.length`)计,插入后循环淘汰 LRU 直到 `totalBytes<=maxBytes`;单个超预算的图层仍可临时驻留(否则无法渲染),但用完即被下一次淘汰挤出。`get` 刷新 recency。
- [ ] Step1 改测试:`PixelCache(bytes)` 语义——放入两张已知字节数的图,超预算时最久未用被淘汰(用 store.gets 验证重新拉取);`get` 刷新 recency 改变淘汰顺序。删掉旧的"按条目数=4"断言。
- [ ] Step2 失败。 - [ ] Step3 实现字节预算 LRU;`defaultCtx()` 用一个合理默认(如 `64*1024*1024`)。 - [ ] Step4 全绿+保真不变。 - [ ] Step5 提交 `refactor(psd): byte-budget PixelCache`。

### Task 3: 把 BlobStore 接进查询/渲染路径(core+doctype+sdk,修 Finding 2)
**Files:** Modify `packages/core/src/types.ts`（`query` 签名加可选 ctx）; Modify `packages/doctype-psd/src/queries.ts`; Modify `packages/doctype-psd/src/doctype.ts`; Modify `packages/cloudflare-sdk/src/editor-do.ts`（`/_internal/query` 处构造并传入 ctx）
**Interfaces:**
- core: `query: (query: TQuery, doc: TDoc, ctx?: QueryCtx) => Promise<QueryValue>`,新增 `export interface QueryCtx { store: BlobStore; cache: PixelCache }`（`PixelCache` 也需在 core 有个最小类型,或 ctx 用 `unknown` 由 doctype 内部断言——优先在 core 定义 `QueryCtx { store: BlobStore }` 只放 store,cache 由 doctype 侧的 render ctx 持有;editor-do 持有一个长生命周期 cache 传给 render)。**决策:** `QueryCtx = { store: BlobStore; cache?: PixelCache-like }`;为避免 core 依赖 doctype 的 PixelCache,core 只声明 `store: BlobStore`,doctype 的 `runQuery` 内部再补一个自己的 cache 或从 ctx 里拿 store 构 RenderCtx。执行时以"core 只认 BlobStore,cache 归 doctype/editor 持有"为准,消除跨包类型泄漏。
- doctype `runQuery(query, doc, ctx?)`: getPreview 分支把 `ctx.store` + 一个 cache 组成 `RenderCtx` 传给 `renderCached/renderRegion/renderLayer`;无 ctx 时保持现默认(resident 文档)。删掉 queries.ts 里 "arrives in Task 4" 过时注释。
- editor-do `/_internal/query`: 构造 `const store = createR2BlobStore(this.#env.CAS)`,复用 DO 实例上持有的一个 `#renderCache: PixelCache`(长生命周期,跨查询复用解码结果),`config.query(q, this.#doc, { store, cache })`。
- [ ] Step1 失败测试(doctype):`runQuery(getPreview, lazyDoc, {store,cache})` 能渲染出含 `PixelRef` 层的文档(之前无 ctx 会抛 NO_STORE)。
- [ ] Step2 失败。 - [ ] Step3 实现(含 core/sdk dist 重建)。 - [ ] Step4 三包 tsc + 全绿 + 保真不变。 - [ ] Step5 提交 `feat: thread BlobStore into query/render path`。

### Task 4: editor-do 快照改用 IR serialize/deserialize(sdk)
**Files:** Modify `packages/cloudflare-sdk/src/editor-do.ts`
**做法:**
- `#saveSnapshotKV`/`#saveSnapshot`:`const store=createR2BlobStore(this.#env.CAS); const bytes = config.serialize ? await config.serialize(this.#doc, store) : await config.save(this.#doc);`(有 serialize 用之,像素 blob 已在 put 时进 CAS;IR JSON 字节再 `computeHash`+`CAS.put`+KV 指针)。
- `#ensureLoaded`:取回 snapshot 字节后,`config.deserialize ? await config.deserialize(bytes, store) : await config.load(bytes)`;**向后兼容**:先判 magic——首字节 `0x38 '8'`('8BPS')→ 走 `config.load`(旧 PSD 快照);首非空字符 `{` → 走 `deserialize`。
- 导入路径(`create`/`init_from_hash`):`config.load(psdBytes)` 得 resident doc → 用它 `serialize` 铺 CAS blob;把**原始 PSD 二进制**归档到独立 key(如 `CAS.put(psdHash, psdBytes)` 并在 D1/KV 记 `originalHash`,非状态路径,供重导出/保真对比);v1 delta 记为 `{kind:"init", payload: <IR 结构>}`(IR = deserialize 后的懒结构;payload 不含像素字节)。
- [ ] Step1:加/改 editor-do 测试(用内存 R2+内存 storage 桩或既有测试脚手架)——import→apply(set_props)→query(getPreview) 全程不调用 `config.save`(PSD 全量重编码),快照字节是 IR JSON(以 `{` 开头),apply 后 CAS 里未变图层的 blob 数不增长。旧 PSD 快照仍能 `#ensureLoaded`。
- [ ] Step2 失败。 - [ ] Step3 实现。 - [ ] Step4 sdk tsc + 测试绿。 - [ ] Step5 提交 `feat(sdk): IR-based snapshots (JSON + per-layer CAS blobs); archive original PSD`。

### Task 5: init 校验 + flip-on-ref 报错(doctype-psd,修 Finding 3 & f)
**Files:** Modify `packages/doctype-psd/src/ops/index.ts`（init 校验）; Modify `packages/doctype-psd/src/ops/geometry-ops.ts`（flip）; Test 各自
- init handler:校验 payload 结构——`canvas` 是含数字 width/height 的对象、`layers` 是数组,否则 `throw new Error("init: malformed payload")`(在 applyOne commit 前抛,避免 brick,呼应 [[unidocs-editor-commits-before-save]])。
- geometry flip:`if (flip && layer.pixels)` 若 `isRef(layer.pixels)` 则 `throw new Error("transform flip: pixels not resolved (PixelRef) — resolve before edit")`,与 save.ts 一致的 loud 策略,替换现在的静默 no-op。
- [ ] Step1 失败测试:init 拿到 `{canvas:undefined}` / `{layers:"x"}` 抛错且不改 doc;flip 一个 PixelRef 层抛错。
- [ ] Step2 失败。 - [ ] Step3 实现。 - [ ] Step4 绿+保真不变。 - [ ] Step5 提交 `fix(psd): validate init payload; loud flip on unresolved PixelRef`。

### Task 6: 端到端内存/回归验收
**Files:** Test（doctype-psd 或 sdk,env-gated 大文件可选）
- 构造一个"全 PixelRef"的懒文档(serialize→deserialize landing)在内存 R2 上,`renderCached(doc,{store,cache: PixelCache(64MB)})` 采样峰值 arrayBuffers,断言远小于"全量常驻(~174MB)";隐藏层的 blob `get` 计数为 0。保真度对懒文档仍逐字节等于 resident 渲染。
- [ ] Step1-4 实现+跑通。 - [ ] Step5 提交 `test(psd): lazy-doc bounded-memory + parity verification`。

## 自查
- 覆盖:Finding1→T2;Finding2→T3;Finding3&f→T5;snapshot 重编码→T4;内存兑现→T6;基础 blob→T1。
- 向后兼容:T4 magic 分流旧 PSD 快照。
- 类型一致:`BlobStore` 单一源在 core;`QueryCtx` 只带 store,cache 归 editor/doctype。
- 安全网:每任务保真三数不变;T6 量化内存下界。

---

## 完成后残留(评审判定可推迟,记录以免遗漏)
Phase 3 已完成并通过整支评审(常驻文档保真逐字节不变,doctype 98 + sdk 18 测试全绿)。以下为已判定"可推迟"的后续项:
- **DO 集成测试**:目前没有 DurableObject/D1/R2 的处理器级测试;clone/rollback/export/cold-reload 的端到端行为由纯 helper 单测 + doctype 级测试 + tsc + 评审覆盖。补一个轻量 editor-do 处理器测试(import→apply(flip)→丢弃内存态强制 lazy 重载→export→rollback across flip)是值得做的后续。
- **I2 热会话重编码**:导入后 `this.#doc` 保持常驻,每次 apply→`#saveSnapshotKV`→`serialize` 会把所有常驻层重新 PNG 编码(CAS.put 幂等,不涨存储,但 CPU 花掉)。"未改动层跳过重编码"只在 cold-reload 后(文档变 lazy)才兑现。可选优化:首次 serialize 后把 `this.#doc` rehydrate 成 lazy(引用),后续 apply 靠已加的 store-resolve 支持。
- **originalHash 未被读取**:导入时归档了原始 PSD(`originalHash`),但目前无处读取;留待"重新导出原图"功能或删除。
- **T6 测试**:合成用例无重叠图层(全画布平铺已覆盖 lazy 取用路径);真实 landing/~174MB 内存场景仅 existsSync-gated、CI 不跑;硬编码个人路径应改环境变量/提交夹具。
