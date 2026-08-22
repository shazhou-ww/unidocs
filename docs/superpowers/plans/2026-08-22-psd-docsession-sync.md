# PSD 前端渲染 · 计划 5：DocSession 同步加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `web-psd` 现在"单槽合并 + 409→reload + chat→reload"的脆弱同步，换成一个真正的 `DocSession`：`baseVersion` + **每 op 的 pending 队列** + **op-id 幂等** + **409/agent rebase**（取新 base、重放 pending），且 rebase 时**保住 Worker 的热 PixelCache**（引擎新增 `reset(newDoc)`，换 doc 但复用已解码像素缓存），不做冷 re-init。

**Architecture:** `DocSession`（主线程）持权威本地 doc + `baseVersion` + `pending`。用户操作 → `applyLocal(op)`（`applyOne` 推进本地 doc + 入队 + 交 `RenderClient.applyOp` 即时出图）→ 后台按队列逐个 `POST /apply {op, opId, baseVersion}`。200→推进 baseVersion、出队；409 或 agent `/run` 改了 doc → **rebase**：取服务端最新 snapshot IR → `deserialize` 新 base → 重放 pending（`applyOne`，目标图层没了就丢弃）→ 新 doc；`RenderClient.reset(newDoc)`（**复用像素缓存**）重渲染。op 带 client `opId`，服务端对重复 opId 去重（丢包重试不双应用）。

**Tech Stack:** TypeScript、vitest（DocSession/引擎纯逻辑 + mock）、Vite（web-psd 集成靠 build + 运行验证）。

**Spec:** `docs/superpowers/specs/2026-08-21-psd-frontend-render-model-design.md` §2（baseVersion/op、409 rebase、agent 并发 reconcile）、§5（op-id 幂等、reconciliation 边界）。

## Global Constraints

- **像素正确**：`RenderClient.reset(newDoc)` 后 `composite()` 必须与 `render(newDoc)` 逐位一致（引擎 `IncrementalCompositor.reset` 复用已验证的合成）。
- **rebase 保热缓存**：rebase 用 `reset(newDoc)` **保留 ctx（store + PixelCache）**——内容寻址，未变图层的 blob（同 hash）命中缓存不重拉；**不得**冷 re-init（会重拉全部图层，正是 Plan 4 reviewer 点名要避免的）。
- **pending 是真队列**：每个 op 独立入队并逐个提交；**不得**单槽覆盖（现状会丢弃 in-flight 期间的不同 op——Plan 4 reviewer 已标）。
- **op-id 幂等**：每 op 带唯一 `opId`；服务端对已见过的 `opId` 跳过（返回当前版本），保证丢包重试不双应用。
- **权威真相仍是服务端**：DocSession 只是"某 baseVersion + 本地 pending"的乐观工作副本；rebase 永远以服务端为基。
- 复用 Plan 1-4：`applyOne`/`deserialize`/`IncrementalCompositor`、`CasBlobStore`/`loadDoc`/`RenderClient`。
- 工作区约定；`typecheck` 用 `tsc -b`。测试 `pnpm --filter <pkg> test`。

## File Structure

- **Modify** `packages/doctype-psd/src/render/incremental.ts` — 新增 `reset(newDoc)`（换 doc、清 tile/below 缓存、复用 ctx）。
- **Modify** `packages/doctype-psd/src/engine.ts` —（无新导出；reset 是 IncrementalCompositor 方法）。
- **Modify** `packages/psd-client/src/render-core.ts` — `reset(newDoc)` 透传。
- **Modify** `packages/psd-client/src/render-worker.ts` / `render-client.ts` — `{type:"reset", id, ir}` 消息 → `core.reset(deserialize(ir))`。
- **Create** `packages/psd-client/src/doc-session.ts` — `DocSession`。
- **Modify** `packages/psd-client/src/index.ts` — 导出 `DocSession`。
- **Modify** `packages/server-core/src/session.ts`（+ ports/handler）— op-id 幂等去重。
- **Modify** `packages/web-psd/src/main.ts` — 用 DocSession 替单槽同步 + chat reconcile 替 reload。
- **Create** tests：`incremental-reset.test.ts`、`doc-session.test.ts`、server-core 幂等测试。

---

## Task 1: `IncrementalCompositor.reset(newDoc)` — 换 doc、保热缓存

**Files:** Modify `packages/doctype-psd/src/render/incremental.ts`, `packages/psd-client/src/render-core.ts`. Test `packages/doctype-psd/tests/incremental-reset.test.ts`.

**Interfaces:**
- Produces: `IncrementalCompositor.reset(newDoc: PsdDoc): void` —— 设 `#doc = newDoc`；清 `#cache`（tile 成品）、`#belowChk`、重置 `#activeIndex`、`#cachedW/H = newDoc.canvas.{width,height}`；**保留 `#ctx`（store + PixelCache 不动）**。之后 `composite()`/`applyOp` 基于 newDoc，未变图层 blob 命中已存像素缓存。
  - `RenderCore.reset(newDoc)` 透传到 `compositor.reset`。

- [ ] **Step 1: 写测试** —— 构造懒 doc A（几层 PixelRef）+ mock store 计 get 次数；`core.composite()`（fault 全部，记 get 数）；`core.reset(docB)`，其中 docB **共享 A 的部分图层 hash**、改了一层的 props/去掉一层；断言：(a) `core.composite()` 逐位等于 `render(docB)`；(b) 共享 hash 的图层**不重新 fetch**（get 计数只对 docB 新增的 hash 增长）；(c) reset 后旧 doc 的独有图层不再影响输出。

- [ ] **Step 2-4: 验证失败 → 实现 → 通过.** 在 `incremental.ts` 加 `reset`；`render-core.ts` 加 `reset`。`pnpm --filter @unidocs/doctype-psd test incremental-reset` + `pnpm --filter @unidocs/psd-client typecheck`。全量 `pnpm --filter @unidocs/doctype-psd test` 保持绿。

- [ ] **Step 5: 提交** `feat(doctype-psd): IncrementalCompositor.reset(newDoc) — swap doc, keep warm PixelCache`

---

## Task 2: `RenderClient.reset` 消息（worker 接线）

**Files:** Modify `render-worker.ts`, `render-client.ts`. （无独立 vitest——消息胶水，靠 Task 5 build/运行验证；但类型要对。）

**Interfaces:**
- `WorkerRequest` 加 `{ type:"reset"; id:number; ir:Uint8Array }`；worker：`core.reset(deserialize(ir, store))`（复用 init 时建的 store）→ 回 `{type:"resetDone", id}`。
- `RenderClient.reset(ir: Uint8Array): Promise<void>`（走 id-correlated pending map，同 applyOp）。

- [ ] **Step 1-3: 实现 + typecheck + build.** 加 reset 到协议/worker/client；`pnpm --filter @unidocs/psd-client typecheck` + `test`（现有 15 保持绿）。
- [ ] **Step 4: 提交** `feat(psd-client): RenderClient.reset — rebase render without cold re-init`

---

## Task 3: `DocSession` — baseVersion + pending 队列 + 409/agent rebase + op-id

**Files:** Create `packages/psd-client/src/doc-session.ts`, `tests/doc-session.test.ts`. Modify `src/index.ts`.

**Interfaces:**
- `class DocSession`：
  - `constructor(opts: { gw; user; type; docId; doc: PsdDoc; version: number; store: BlobStore; render: RenderLike; fetchImpl?: typeof fetch })`，其中 `RenderLike = { applyOp(op):Promise<Rect>; reset(ir:Uint8Array):Promise<void> }`（`RenderClient` 满足；测试用 mock）。
  - `get doc(): PsdDoc`、`get version(): number`。
  - `applyLocal(op: PsdOp): Promise<Rect>` —— `#doc = applyOne(#doc, op)`；`pending.push({op, opId: genId()})`；`const rect = await render.applyOp(op)`；触发后台 `#drain()`；返回 rect。
  - `reconcile(): Promise<void>` —— 供 chat `/run` 之后调用（服务端已改 doc）：执行一次 rebase（取新 base + 重放 pending + `render.reset`）。
  - 内部 `#drain()`：串行提交 pending 头 → `POST …/apply {operations:[op], baseVersion:#version, opId}`；200→`#version=res.version`、`pending.shift()`；409→`#rebase()` 后继续。
  - 内部 `#rebase()`：`GET …/snapshot`→`{version,hash}`→`store.get(hash)`→`deserialize`=newBase；`#doc = pending.reduce((d,{op})=>tryApply(d,op), newBase)`（`tryApply` catch→丢弃该 op + 记一条 warn，并从 pending 移除）；`#version = version`；`await render.reset(irBytesOfNewDocState)`。
    > 渲染 reset 需要"新 doc 状态"的 IR bytes。最简：rebase 后用引擎 `serialize` 不可行（客户端无 blobstore write）。改为：`render.reset` 接收**重放后的 doc**而非 IR——给 `RenderClient.reset` 一个"发 doc（结构化克隆，PixelRef 图层）"的变体，worker 直接 `core.reset(doc)`（doc 里 PixelRef 的 hash 让 worker 的 store 按需 fault）。即 `RenderLike.reset(doc: PsdDoc)`（Task 2 相应改为发 doc 而非 ir——postMessage 可结构化克隆普通对象；Uint8Array mask/pixel 数据在 PixelRef 懒 doc 里没有 resident 大数组，克隆便宜）。**实现时按此**：reset 传 doc，不传 ir。

- `genId()`：`${sessionNonce}-${counter++}`（sessionNonce 一次性随机，用 index 变化避免跨会话碰撞；测试可注入）。

- [ ] **Step 1: 写 DocSession 测试（mock fetch + mock render）**——覆盖：
  1. `applyLocal` 推进 doc + 调 `render.applyOp` + 后台 POST /apply 带 opId + baseVersion；200 推进 version。
  2. **pending 队列不丢 op**：连续三次 `applyLocal`（不同 op）在提交前入队，三个都被 POST（不是单槽覆盖）。
  3. **409 rebase**：POST 返回 409 → 取新 snapshot IR → 重放 pending → `render.reset(newDoc)` 被调 → version 更新 → 重新提交。
  4. **重放丢弃**：pending 里某 op 目标图层在新 base 不存在 → 丢弃、其余保留、不抛。
  5. **op-id 幂等（客户端侧）**：同一 op 重试用同一 opId（丢包重试不产生新 id）。
  6. `reconcile()`（agent 后）走同一 rebase 路径。

- [ ] **Step 2-4: 验证失败 → 实现 → 通过.** `pnpm --filter @unidocs/psd-client test doc-session` + typecheck。
- [ ] **Step 5: 提交** `feat(psd-client): DocSession — baseVersion + pending queue + 409/agent rebase (op-id, warm reset)`

---

## Task 4: 服务端 op-id 幂等去重

**Files:** Modify `packages/server-core/src/session.ts`（apply 路径）+ `session-handler.ts`（接 `opId`）+ ports（记 applied opId）。Test：server-core 幂等测试（复用其 vitest）。

**Interfaces:**
- `/apply` body 增加可选 `opId?: string`。`session.apply(operations, ctx, opId?)`：若 `opId` 已在"已应用 opId 集合"中 → **跳过应用**，返回当前 version（幂等）；否则应用 delta 并记录该 opId。
- 存储：把 applied opId 记进 delta 元数据或一个有界的近期-opId 集合（DO storage / sqlite）。**有界**即可（只需覆盖"丢包重试"窗口，不必永久）——例如最近 N 个 opId 或按版本。

- [ ] **Step 1: 写幂等测试** —— 同一 `opId` 提交两次：第二次不改变 doc、返回第一次的/当前 version；不同 opId 正常各自应用。用 server-core 现有测试基座（memory ports）。
- [ ] **Step 2-4: 验证失败 → 实现 → 通过.** 最小实现：session 维护一个近期 opId→version 的有界 map；apply 前查。`pnpm --filter @unidocs/server-core test`（+ 若 Cloudflare/Azure ports 需同步接口，改端口契约）。
  > 注意 server-core 有 memory/azure/cloudflare 多后端 + port-contract；opId 记录若入 port 层需同步三实现 + port-contract 测试。**优先**放在 session 内存层（DO 生命周期内的有界 map）以最小化改动——丢包重试窗口很短，DO 内存足够；持久化跨 DO 重启不是本任务目标（可 later）。
- [ ] **Step 5: 提交** `feat(server-core): op-id idempotency — dedup retried applies within the session`

---

## Task 5: 接进 web-psd（DocSession 替单槽同步 + chat reconcile 替 reload）

**Files:** Modify `packages/web-psd/src/main.ts`.

- [ ] **Step 1: 用 DocSession**
  - cold start 后：`session = new DocSession({ gw:GW,user:USER,type:TYPE,docId, doc, version, store, render: renderClient })`。
  - `dispatch(op)`：改为 `await session.applyLocal(op)` → 拿 dirty rect → 请求脏 tile 重绘（本地即时）；DocSession 内部管后台提交 + rebase。删掉 `syncOpToServer` 单槽 + `version` 全局（移进 session）。
  - 图层面板读 `session.doc`。
  - chat `/run` 成功后：`await session.reconcile()`（取服务端新 doc、重放本地 pending、`render.reset` 重渲染）——**删掉 `location.reload()`**。
  - 409 不再 reload（DocSession rebase 处理）。
- [ ] **Step 2: 验证** `pnpm --filter @unidocs/web-psd typecheck` + `build`（worker/DocSession 打包通过）；`pnpm --filter @unidocs/psd-client test` 保持绿。运行验证由 controller 做（`pnpm dev psd`：多 op 快速编辑不丢、chat 后不闪整页 reload、大文档编辑仍本地即时）。
- [ ] **Step 3: 提交** `feat(web-psd): DocSession sync — durable per-op queue + agent reconcile (no full reload)`

---

## Self-Review

- **Spec coverage**：§2 baseVersion/op、409 rebase、agent reconcile → Task 3/5；§5 op-id 幂等 → Task 3(client)+Task 4(server)、reconciliation 丢弃边界 → Task 3。warm-reset（保热缓存）→ Task 1/2。
- **Placeholder scan**：无 TBD；纯逻辑任务给测试骨架，集成/运行验证明确标注。
- **Type consistency**：`DocSession(...).applyLocal/reconcile/doc/version`、`RenderLike.{applyOp,reset(doc)}`、`IncrementalCompositor.reset(newDoc)`、opId `string` 全一致。
- **风险**：(a) rebase 的 reset 传 doc（结构化克隆懒 doc）而非 ir——懒 doc 无大 resident 数组，克隆便宜；实现时确认 PixelRef 图层不含 resident `data`。(b) 服务端 opId 放 session 内存层（有界、DO 生命周期内）——覆盖丢包重试窗口，不追求跨重启持久（later）。(c) DocSession 的 #doc 与 worker doc 双副本一致性：applyLocal 两边同 op、rebase 两边同 newDoc（session 重放 + render.reset(同 doc)）→ 锁步。

## 后续（非本计划）

- 拖拽 LOD（满画布图层切换/超大图的动中降采样）——修 Plan 4 bench 里"满画布切换仍 ~秒级"的极端项。
- Worker 池（多 worker 并行 tile）。
- 画笔/导入（`CasBlobStore.put` + `add_layer`/`mask_edit` 客户端产像素）。
- Class B `generative_fill` 占位→新 blob 精修。
- op-id 跨 DO 重启持久化。
