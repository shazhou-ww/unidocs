# Phase 3 (完成版):IR 快照 + 每层像素进 CAS,接到 server-core

> 分支 `feat/psd-cas-snapshots`(基于已 reconcile 到 server-core 的 render 引擎)。

**目标:** 让 PSD 的 `save` 产出 **IR JSON(结构 + 每层像素哈希)**、每层 PNG 进 **CAS 服务**;`load` 得到 lazy 文档(`PixelRef`),渲染按需 `ctx.cas.read` fault-in;快照因此从 23MB PSD 变成小 JSON,未变的层内容寻址去重。复用 Phase 3 已写好的 `ir.ts`/`pixel-source.ts`/`resolve.ts`(都基于 `BlobStore` 抽象)。

**架构关键点(已核实 main 代码):**
- `DocumentType.save/load/apply/query(…, ctx?)`;`ctx.cas: CasReadContext { read(ref), metadata(ref) }`(只读)。运行时 `ctx.cas` 其实是 `CasClient`(有 `ensureNode(hash,content,contentType,refs?)` 上传、`read`、`leaseExisting`、`updateRootRefs`)。
- `refsFromSnapshot(bytes): CasReferences` 在 interface 里定义但 **server-core 从未调用**(GC 接线是 main 的 TODO)。
- 快照字节走 `BlobCas`(R2);被引用的内容走 CAS 服务(带 lease/root-refs/GC)。每层像素属于"被引用内容" → 进 CAS 服务,用 `refsFromSnapshot` 声明、root-ref 保活。
- `computeHash` 在 `server-core/hash.ts`。

## 全局约束
- 保真度不回退(sample 0.000 / landing 0.114 / fashion 0.104)。
- 整个 workspace `pnpm -r build` + `pnpm -r test` 全绿。
- server-core 改动要小、贴合其风格(它是共享平台代码);优先"补全 main 已定义的 TODO"。

---

### Task 1: server-core — 给 doctype 暴露 CAS 写入
**Files:** `packages/core/src/types.ts`(`CasReadContext` 加可选写法或新增 `CasWriteContext`); `packages/server-core/src/cas-client.ts`(在 `CasClient` 上加 `store(bytes, contentType): Promise<string>` = `computeHash`+`ensureNode`); `packages/server-core/src/session.ts`(`#context()` 暴露写能力); `packages/server-core/src/memory-ports.ts`(内存 CAS 也支持)。
- **决策:** 在 `core` 的 `CasReadContext` 增加可选 `store?(bytes: Uint8Array, contentType: string): Promise<string>`(返回内容哈希)。`CasClient.store` 实现:`const h = await computeHash(bytes); await this.ensureNode(h, bytes, contentType); return h;`。session 的 `#context()` 原样把 `this.#deps.cas`(CasClient)传下去 —— 它已实现 `store`,只是类型现在暴露出来。
- Test:cas-client 单测 `store` 返回哈希、内容可 `read` 回来;memory CAS 同样。

### Task 2: server-core — 把 `refsFromSnapshot` 接进快照 root-refs(补全 main TODO)
**Files:** `packages/server-core/src/session.ts`(`#writeSnapshot`)
- `#writeSnapshot` 里 `config.save` 之后:`const refs = this.#config.refsFromSnapshot(bytes);` 若非空,`commitRootRefsOrRollback`(或 `cas.updateRootRefs`)把这些 hash 提交为 root-refs(保证被引用的每层 blob 不被 GC)。注意写序与 apply 一致、失败回滚。
- Test:session 契约测试 —— 一个 `refsFromSnapshot` 返回若干 hash 的假 config,快照后这些 hash 出现在 root-refs 更新里。

### Task 3: doctype-psd — BlobStore 适配器 over ctx.cas,save/load 走 IR
**Files:** `packages/doctype-psd/src/psd/cas-blobstore.ts`(新;`casBlobStore(ctx): BlobStore`,`put`→`ctx.cas.store(bytes,"image/png")`,`get(hash)`→`ctx.cas.read({kind:"cas",hash})`); `src/doctype.ts`(`save`/`load` 改用 `serialize`/`deserialize` + 适配器); `src/psd/ir.ts`(已存在,复用); `refsFromSnapshot` 实现(解析 IR JSON 收集每层/mask 的 hash)。
- `save(doc, ctx)`:有 `ctx?.cas?.store` 时 `serialize(doc, casBlobStore(ctx))` → IR bytes;否则回退旧 `writePsd`(无 ctx 的场景/测试)。
- `load(bytes, ctx)`:IR JSON(首字节 `{`)→ `deserialize(bytes, casBlobStore(ctx))`(lazy);PSD(`8BPS`)→ 旧 `load`(导入原始 PSD)。
- `refsFromSnapshot(bytes)`:仅当是 IR JSON 时解析收集 hash,返回 `{hash:1,...}`;PSD/空 → `{}`。
- Test:`save`(带内存 cas ctx)→ bytes 是 JSON、cas 里有每层 blob;`load` → lazy;`refsFromSnapshot` 收集到全部 hash。

### Task 4: doctype-psd — 渲染 fault-in via ctx.cas + apply flip-resolve 复原
**Files:** `src/queries.ts`(getPreview 用 `casBlobStore(ctx)` 组 RenderCtx);`src/ops/index.ts`(apply 带 ctx 时,flip 前 `resolveLayerPixels` via 适配器)。
- runQuery getPreview:`const rc = ctx?.cas ? { store: casBlobStore(ctx), cache: new PixelCache(DEFAULT_CACHE_BYTES) } : undefined; renderCached(doc, rc)`。lazy 文档能渲染;resident 仍走默认。
- apply flip:恢复 Stage-1a 移除的"flip 前解析目标层"逻辑,用 `casBlobStore(ctx)`。
- Test:lazy doc(serialize→deserialize via 内存 cas)getPreview 渲染 byte-identical to resident;flip on lazy layer via ctx 成功。

### Task 5: 端到端验收
- doctype-psd 全绿 + 保真不变;`pnpm -r build`/`test` 全绿。
- 断言:import PSD → 快照字节是 IR JSON(`{` 开头,远小于 PSD);编辑后未变层的 CAS blob 不重复上传(内容寻址);lazy 渲染 byte-identical + 内存 bound(复用 Phase 3 的 lazy-render-verification 思路)。
- 更新 PR/新开 PR。

## 自查
- server-core 改动 = 1 个新可选方法(运行时已支持)+ 补全 refsFromSnapshot TODO,均小而贴合。
- doctype-psd 复用既有 ir/pixel-source/resolve(BlobStore 抽象),只加一个 CAS 适配器 + 重接 save/load/render。
- 向后兼容:magic-byte 分流(PSD 导入 vs IR 快照);无 ctx 场景回退旧行为。

## Follow-ups
- **I3 (tracked, not fixed): root-refs 只增不减 → 无界增长。** 每次 `#writeSnapshot` / 克隆 pin 都对 `refsFromSnapshot` 的 hash 提交 +1 的 root-ref,但旧版本的 root-ref 从不 -1。属于过度保留(over-retention),merge-safe(不丢数据、不破坏正确性),但会让被引用 blob 的引用计数随版本单调增长。后续:快照 supersession —— 写新版本快照时,retire/decrement 旧版本 root-refs,让 GC 能回收不再被任何存活快照引用的层 blob。
