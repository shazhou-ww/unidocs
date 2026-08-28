# 大文档异步创建设计

**Issue:** [#35](https://git.shazhou.work/shazhou/unidocs/issues/35)
**日期:** 2026-08-28
**状态:** 待实现

## 1. 问题

`create` 是同步的：网关一直等 doc service 把整个导入做完才返回，而网关给这次
转发挂了 `AbortSignal.timeout(deadlineSeconds * 1000)`。`create` 的
`deadlineSeconds` 是 90，**已经是 `capability-policy.ts` 里
`15 | 30 | 60 | 90` 这个类型允许的最大值**。

一个 237MB 的 PSD 实测总耗时 82–91 秒，卡在这条线上，成功率约一半。

### 已经排除的方向

实测该文件走 `packages/doctype-psd/src/psd/load.ts` 的 `load()`：

| 指标 | 值 |
| --- | --- |
| 解析耗时 | 0.2 秒 |
| 峰值 RSS | 567 MB（含 237MB 输入本身） |
| 画布 / 图层 | 3556×2000 / 6 层 |

**不是 CPU、不是内存、不是解析速度。** 网关与 psd 现在都是 2.0 CPU / 4.0Gi。
时间花在两处：约 60 秒网络传输，其余是把 6 个图层像素跨网络推到 CAS。

### 为什么调大截止时间不是解法

能力票默认寿命 120 秒（`DefaultCapabilityLifetimeSeconds`），deadline 超过票
的寿命就没有意义。这条路最多再买 30 秒，而 CAS 推送耗时随文件大小线性增长
—— 一个 400MB 的文件约需 140 秒，无论如何过不去。

## 2. 现有架构（比 issue 里描述的完整得多）

调查后确认，异步所需的骨架**大部分已经存在**：

| 组件 | 位置 | 状态 |
| --- | --- | --- |
| 状态机 `creating`/`ready`/`failed` | `gateway-common/src/document-directory.ts` | 完整，含非法迁移守卫 |
| 幂等键 | `reserve()` 的 `idempotencyKey` | 已有 |
| 重试自愈 | `reconcileCreatingDocument()` | 同 key 重试时问 doc service `/status`，真建好了就 `markReady` |
| 客户端轮询端点 | `GET /tenants/{t}/docs/{type}/{docId}` | 返回 `{state, version, ...}` |
| 非 ready 文档的操作 | 409 `{error:"Document is creating", state}` | 已有 |

缺的只是：**第一次 create 不返回 `creating`，而是同步等到超时**。

### 调查中发现的一个独立缺陷

`azure-gateway/src/document-directory.ts:78`：

```sql
SELECT * FROM gateway_documents
WHERE tenant_id = $1 AND doc_type = $2 AND state = 'ready'
```

列表只返回 `ready`，且 `listDocuments()` 的映射里根本没有 `state` 字段。所以
一篇卡住的 `creating` 文档在界面上完全不可见——用户既看不到也无从处理。这在
异步化之后会从边缘情况变成常态。

## 3. 决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 目标范围 | 支持任意大的文档 | 加时长只能买 30 秒，CAS 推送随体积线性增长 |
| 上传字节的持久化 | 先进 CAS，任务只存 hash | 内容寻址使重试天然幂等，副本死了不丢 |
| 后台导入的驱动 | 轮询驱动，无队列 | 复用已有的 reconcile 形态，零基础设施 |
| 停在 creating 的文档 | 列表显示并带 state，用户自己重试/删除 | 可见即可操作，不需要扫描任务 |

## 4. 数据流

```
① 浏览器本地算 CAS 哈希，直传 CAS
   POST /tenants/{t}/cas/nodes/{hash}          （已有路由）
   网关只签发能力票与转发，不碰字节

② POST /tenants/{t}/docs/psd/  { uploadHash }
   网关 reserve() → creating，立即返回 {docId, state:"creating"}
   请求体只有几十字节

③ 浏览器轮询 GET /tenants/{t}/docs/psd/{docId}
   网关见 creating 且当前无导入在飞 → fire-and-forget 踢一次
   doc service /_internal/import：cas.read(hash) → session.create({bytes})
   完成后 markReady

④ 副本中途死了 → 下次轮询自然重启
```

**为什么不再有时长限制**：第 ② 步秒级返回；第 ③ 步每次踢都有完整的 90 秒
预算，而导入可重入，跑不完下次接着来。

**原始上传 blob 的生命周期**：导入后它成为孤儿（文档真正引用的是图层 blob），
CAS 的 GC 自然回收——不需要额外清理逻辑，只要租约活得比一次导入久。

## 5. 为什么 decode 不共用，但几乎不写新代码

`initFromHash` 看起来像可复用的对象，实际不是：它 `decodeSValue(bytes)` 适配
的是**已经规范化的文档快照**（克隆用），而导入要的是
`formats[fmt].load(bytes)` ——把外部格式翻译成文档。两者语义与失败模式都不同
（前者是数据损坏，后者是用户传了不支持的格式），合并会把两个概念揉成一个。

但异步导入**根本不需要碰 decode**。它要的解码就是今天 `create` 用的那个，
差别只有字节来源：

```js
// 今天
const bytes = new Uint8Array(await file.arrayBuffer());   // 来自 multipart
await session.create({ bytes });

// 异步导入
const bytes = await cas.read({ kind: "cas", hash });       // 来自 CAS
await session.create({ bytes });                           // 同一个方法，一字不改
```

`#writeBlob` → pin refs → 事务这一整套随 `create()` 自动复用。

> `create` 与 `initFromHash` 之间那段 pin refs + 事务的逐字重复是既有问题，
> 与本次改动无关，不在本 PR 范围内动它。

## 6. 改动清单

### 新增契约（唯一一处）

`doctype-server-common/src/session-handler.ts`：

```
POST /_internal/import   { hash: string }
  → bytes = await deps.cas.read({ kind: "cas", hash })
  → return session.create({ bytes })
```

失败语义沿用 `create` 既有的：`DocExistsError` → 409（这正是重入幂等的来源），
CAS 读不到 → 400。

### 网关（`gateway-common`，两朵云共享）

- create 分支识别 JSON body 的 `uploadHash`：`reserve()` 后立即返回
  `{docId, state:"creating"}`，**不转发**。原有 multipart 路径保留不动。
- `GET .../{docId}` 见 `creating` 时 fire-and-forget 踢一次 import。
- `listDocuments()` 暴露 `state`。

**踢的去重**：用 `idempotencyKey` 加一个进程内的「在飞集合」。副本重启后集合
清空——这不是缺陷，正是重入所依赖的：新副本重新踢，而 CAS 内容寻址 +
`DocExistsError` 使重复导入无害。

**怎么在返回响应之后继续跑**（本设计唯一的新平台抽象）：网关目前没有任何后台
执行钩子——`createGatewayHandler` 只返回 `Promise<Response>`，
`cloudflare-gateway/src/worker.ts` 的 `fetch(request, env)` 连 `ctx` 都没接。
两朵云的行为在这里**不一样**，不能靠一个裸 promise 蒙混过去：

- **Cloudflare Worker**：响应返回后仍在跑的 promise 会被直接杀掉，必须
  `ctx.waitUntil`。
- **Node / Azure**：浮动 promise 正常继续。

所以加一个云中立的端口，与仓库既有的 ports 风格一致：

```ts
// GatewayHandlerConfig
/** 运行一个比响应活得久的任务。Cloudflare 必须走 ctx.waitUntil；Node 直接浮动。 */
runAfterResponse?(work: Promise<unknown>): void;
```

- `cloudflare-gateway/src/worker.ts`：`fetch` 签名补上 `ctx`，传
  `work => ctx.waitUntil(work)`
- `azure-gateway/src/main.ts`：传 `work => { void work.catch(logError); }`
- 不提供该端口时退化为「不踢」——纯同步行为，与今天一致。

### 目录层

- `document-directory.ts`：`ReserveGatewayDocumentInput` 与 record 加 `uploadHash`
- `azure-gateway/src/document-directory.ts`：Pg 加列；**去掉 `AND state = 'ready'`**
- Cloudflare 的 D1 实现同理，加一支 migration

### 前端 `web-psd`

上传流程改为：算哈希 → 直传 CAS → `POST create { uploadHash }` → 轮询到 `ready`。
需要给 `psd-client` 的 `CasBlobStore` 加 `put`，并从 `@unicas/server-common`
引入 `computeNodeDigest` / `encodeHeader` / `hashToHex`（无 Node 内置依赖，
浏览器可用）。

## 7. 测试

- `session-handler`：`/_internal/import` 的成功、CAS 缺失、重复导入返回 409
- `gateway-handler`：`{uploadHash}` 立即返回 creating 且不转发；status 触发踢
  且去重；list 暴露 state
- 集成：`tests/integration/cloudflare/` 加一条 psd 异步创建全流程
  （上传 CAS → create → 轮询到 ready）

## 8. 外部依赖（阻塞落地）

**CAS 目前有 100MB 的 HTTP 请求体上限**，而它自己跑在 Cloudflare Worker 上。
本设计要求客户端把原始文件作为单个 CAS 节点直传，因此超过 100MB 的文件在该
限制解除前无法走这条路径。

- 流式**不能**绕过它：流式改变的是接收方内存占用，100MB 管的是总字节数。
- CAS 规范明确把分块列为非目标（`docs/cas-binary-format.md:15`：
  "no built-in large-file chunking or directory model"）。

由 CAS 负责人处理。在此之前本设计可实现、可测试（用小于限制的文件），但大
文件的端到端收益要等限制解除。

> 附带说明：当前架构之所以能跑 237MB，是因为大文件只经 Azure 网关进入
> doc service（Azure 入口无此限制），解析后进 CAS 的永远是各自约 28MB 的
> **图层**。系统已经隐含依赖「单个 blob < 100MB」，只是从未写下来。

## 9. 已知限制（不在本次范围）

- **浏览器需约两倍文件大小的内存来算哈希。** WebCrypto 的
  `crypto.subtle.digest` 没有流式 API，`computeNodeDigest` 还要拼一个等长的
  canonical 数组。237MB 文件峰值约 475MB。桌面可接受，移动端或更大文件会成
  问题。解决要引入流式 SHA-256 实现，是独立一件事。
- **`session-handler.ts` 的导入路径仍然整文件驻留内存。** PR #34 只给它加了
  上限（`maxUploadBytes`），没有去掉缓冲。
- **停滞的 creating 没有超时清理。** 本设计靠「列表可见 + 用户重试」覆盖，
  不引入扫描任务。
