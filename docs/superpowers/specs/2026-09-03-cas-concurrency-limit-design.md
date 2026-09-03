# CAS 并发上限下沉到客户端 —— 设计

**日期：** 2026-09-03
**状态：** 待 review

## 要解决的问题

一次 psd 保存会连打两轮**无上限**的 CAS 扇出，而且都是**递归**的（组里还有组）：

| 位置 | 扇出 | 每个任务 |
|---|---|---|
| `packages/doctype-psd/src/psd/ir.ts:122` + `:84` | 图层数 + 蒙版数 | `store.put(png)` → `ctx.makeSBlob({data})` → CAS 上传 |
| `packages/doctype-psd/src/state.ts:97` + `:137` | 图层数 + 蒙版数 | `storePixels` → `makeSBlob(hash,…)` → `#ensure` → `cas.leaseNode()` |
| `packages/doctype-psd/src/psd/ir.ts:136` + `:108` | 图层数 | `store.get(hash)`（蒙版拉字节，`ir.ts:49`） |

这正是 `0795252` 修过的模式。当时生产 docx create 报
*"Durable Object's isolate exceeded its memory limit and was reset"*，根因是**每个在途的 CAS 子请求都在调用方 isolate 里持有一份大缓冲**。那次的修法是就地止血：

- `sblob-context.ts:172-178`：ref 租约 `Promise.all` → `for await` **完全串行**
- `doctype-docx/src/docx.ts:39`：`PART_IO_CONCURRENCY` 8 → 2

psd 自己在**图层这一层**的扇出当时没被覆盖到，至今无上限。

现状是四套机制、三个数值、没有一处能统一推理 isolate 内存：

```
docx        PART_IO_CONCURRENCY = 2      （openSBlob/makeSBlob，即 CAS 调用）
sblob-context  硬串行 = 1                （CAS ref 租约）
psd resolve.ts FaultConcurrency = 8      （像素 fault）
psd 其余扇出   ∞
```

## 决定：限制放进 CAS 客户端，并发数作为参数暴露

放进 `packages/doctype-server-common/src/sblob-context.ts` 的 `SBlobRuntime`，
经 `SBlobContextOptions` 暴露，由两条运行时各自赋值。

### 为什么是这里

1. **资源边界对得上。** 被保护的是「本 isolate 在途的 CAS 子请求数」——那是 CAS
   客户端的属性，不是某个 doctype 的。崩的是 docx，无上限的是 psd；放在任一
   doctype 里都要求下一个 doctype 记得再抄一份。
2. **两条运行时的正确取值本来就不同。** CF 跑在 128MB 的 DO isolate 里；Azure
   内存宽得多，而且 psd 导出是**跨云**的（doc service 在 southeastasia，CAS 是
   CF Worker，单次往返 ~1.3s，见 `resolve.ts:38-44`），它要的是更大的并发。
   硬编码一个常数表达不了这个差异。
3. **`createSBlobContext` 已经是两条运行时唯一的共同构造点**，且 `SBlobContextOptions`
   已经是「每运行时一个旋钮」的既有形状：

   | 构造点 | 现在传的 options |
   |---|---|
   | `packages/cloudflare-sdk/src/editor-do-svalue.ts:192` | `{ maxReadBytes: MAX_SVALUE_ROOT_BYTES }` |
   | `packages/azure-sdk/src/doc-type-service.ts:170` | **没传**（吃 8MB 默认值） |

4. **顺手把硬串行换成受限并发，是提速不是补丁。** `#store` 现在为了躲 OOM 退化成
   完全串行；有了带上限的限流器，它可以回到并发但受控——比现状更快，且同样安全。

### 为什么不放在 psd 里

先前已按「psd 全局信号量」写了一版（见下「已存在的改动」）。它能挡住 8^深度，但
每个 doctype 都得自己来一份，且无法按运行时取不同值。放弃。

## 接口

```ts
// packages/doctype-server-common/src/sblob-context.ts
export interface SBlobContextOptions {
  readonly maxReadBytes?: number;
  /**
   * 本 SBlob 上下文同时在途的 CAS 子请求上限。省略时取 DEFAULT_CAS_CONCURRENCY。
   * 0 不合法（会死锁），走 validLimit 的既有校验并额外拒绝 0。
   */
  readonly casConcurrency?: number;
}

/** 没传时的保守默认：比今天的无上限严，比崩过的 8 松。 */
export const DEFAULT_CAS_CONCURRENCY = 4;
```

限流器实现搬用已写好的 `packages/doctype-psd/src/cas-concurrency.ts`，改为
`SBlobRuntime` 的**实例**字段（不再是模块级全局）——每个 `createSBlobContext`
一个闸门，与 `maxReadBytes` 同一个生命周期。

关键实现约束（朴素写法有真实越界，见「测试」）：许可**直接移交**，
`release()` 在队列非空时不减 `active`；`acquire()` 在队列非空时一律排队、不许插队。

### 取值

| 运行时 | 值 | 依据 |
|---|---|---|
| Cloudflare (`editor-do-svalue.ts:192`) | `2` | 128MB DO isolate；OOM 发生在并发 8。2 正是 `doctype-docx` 当时自己压到的值，本地限流撤掉后取值移到这里，docx 在 CF 上行为逐字节不变 |
| Azure (`doc-type-service.ts:170`) | `8` | 内存宽松、跨云延迟主导；8 是 psd `FaultConcurrency` 已在这条路上发的值 |
| 库默认 | `4` | 新运行时忘了设也仍然有界 |

## 包裹哪些调用

`SBlobCasAdapter`（`sblob-context.ts:24-34`）四个方法里的三个进闸门：

- `leaseNodeContent(...)` ✅
- `leaseNode(hash)` ✅
- `storeBlob(source)` ✅
- `openBlob(hash)` ✅ —— **只包裹 openBlob 本身，不包裹随后的流式读取**

最后一条是有意的：`open()` 返回的 handler 由调用方持有，读多久由调用方决定。把
许可攥在整个流的生命周期上，会在调用方迟迟不读时把闸门锁死。代价见「已知局限 1」。

## 连带改动

1. **`#store` 的硬串行改回并发**（`sblob-context.ts:172-178`）：
   `for (const ref of ...) await leaseNode(ref)` → 经闸门的并发 map。这里遍历的是
   `new Set(refs)` 且返回值全部丢弃，**不需要保序**，与 `ir.ts`/`state.ts` 那些
   承载图层 z 序的 `Promise.all` 不同。注释里
   0795252 的理由要改写成「上限现在由闸门保证」，不能删——那段历史是这行存在的原因。
2. **撤掉 psd 里的模块级信号量**：删 `packages/doctype-psd/src/cas-concurrency.ts`，
   还原 `psd/cas-blobstore.ts`（put/get）与 `state.ts`（storePixels）三处包裹。
3. **撤掉 `doctype-docx` 的 `PART_IO_CONCURRENCY = 2`**（`docx.ts:39`）以及只服务于它的
   `mapConcurrent` 助手。

   > **更正（本设计初稿写错了）。** 初稿把这一条列进「非目标」，理由是「它限的是
   > OpenXML part 的物化缓冲，不是 CAS 调用，本来就是另一个旋钮」。**这是事实错误。**
   > 它包的两处正是 `context.openSBlob(blob)`（materialize）与
   > `context.makeSBlob({data, contentType})`（storeState）——就是 CAS 调用本身，
   > 和本设计限的是同一个资源；它自己的注释也写着 *"each CAS subrequest from a
   > Durable Object holds a large in-flight buffer (see sblob-context.ts)"*。

   留着它的结果是同一批调用上套两层限流器，紧的那层（2）生效：docx 拿不到任何
   收益，而「上限到底是多少」失去单一出处，doctype 侧那份也拿不到运行时的正确
   取值（CF 的 DO isolate 与 Azure 差一个数量级）。

   **取值的落点：** CF 的 `casConcurrency` 定为 **2** —— 正是 docx 本地限流当时压到
   的那个值。于是 docx 在 CF 上的行为**逐字节不变**，这次改动对它是纯粹的"上限换了
   个持有者"，不承担任何新的内存风险。

   把它提上去（修复清单第 4 项，标为 Deferred、要求「revisit only with the memory
   fix」，见 `docs/superpowers/plans/2026-09-01-stack-oauth-standardization.md:186-190`）
   是另一件事：应当单独做，并用 `scripts/measure-create-latency.mjs` 带生产实测，
   不搭在这次重构里。

   **副作用要记下来：** CF 上的 psd 也会跟着收到 2。它此前是「读 ≤ 8
   （`resolve.ts` 的池）、写无上限」。写这一侧收紧正是本设计的目的；读这一侧
   8 → 2 是连带的，会让 CF 上的 psd 导出变慢。生产 psd 跑在 Azure（8），所以
   影响面限于 CF 这条路。

4. **`resolve.ts` 的 worker 池保留**，`FaultConcurrency = 8` 恢复为自有常数。
   保留的理由是它顺带做**在途哈希去重**（`resolve.ts:60-67`），闸门给不了——闸门只
   排队，不认识哈希。两层叠加不冲突。

## 非目标

- **不做按字节的预算限流。** 8 个 48MB 图层和 8 个 4KB 节点不是一回事，按个数是
  粗糙代理。先落地个数版并把参数留出来，字节预算等有证据再说。
- **不动浏览器那条。** `render/incremental.ts:163` 的 `prefetch()` 是无上限的
  `Promise.all`，但唯一调用方是 `packages/psd-client/src/render-worker.ts:68`，
  跑在浏览器里、用的是另一个 BlobStore 实现，不占 DO isolate。另案。
- **不解决 `resolveDoc` 的全量驻留。** 见「已知局限 2」。

## 已知局限（明确记下来，不假装解决了）

1. **限住的是调用数，不是内存。** 只包裹 `openBlob` 意味着「读取 + 解码」那段
   缓冲不在闸门内。psd 主读路径仍由 `resolve.ts` 的 worker 池（8）兜住，但
   `ir.ts:108/136` 的蒙版反序列化没有。字节预算版才真正关上这个口子。
2. **`resolveDoc` 用的是 `PixelCache(Infinity)`**（`resolve.ts:105`），终态把所有
   图层驻留在内存里。这是导出路径固有的内存上限，闸门管不着。

## 测试

**限流器单元测试**（`packages/doctype-server-common/tests/`）：

- 在途数不超过上限；且 > 1（否则 `concurrency = 1` 的实现也能过）。
- `fn` 抛错时许可归还、错误原样冒泡；连抛 N 次后闸门不会永久关死。
- **后到者不许插队 —— 必须是确定性构造，不能靠压力测试。** 先前那版用「交错到达
  的压力循环」写，朴素实现照样全绿，等于恒真。改成手工 deferred 驱动：
  上限 2 → 启动 A、B 占满 → 启动 C、D 排队 → resolve A → `await Promise.resolve()`
  让 A 的 `finally` 跑完（此时朴素实现已 `active--` 且唤醒了 C，但 C 尚未恢复）
  → **同步**发起 E。朴素实现让 E 插队（`active` 1<2），C 恢复后 `active` 到 3，
  峰值 3 > 2 而失败；正确实现里 E 因队列非空而排队，峰值恒为 2。

**验收证据：** 上述每条都要跑变异验证并贴结果——
(a) 闸门改成直通 `return fn()`；(b) `acquire`/`release` 换成朴素写法。
两个变异都必须**至少挂掉一条**测试；不挂的测试视为无效，重写。

**集成测试：**

- psd 保存路径（嵌套两层组、每层 6 个图层）经计数 CAS 适配器，峰值 ≤ 上限且 > 1
  —— 钉住 8^深度 这个缺陷。
- `#store` 的 ref 租约确实并发了（峰值 > 1）且受限（≤ 上限）——钉住第 1 项连带改动。
- `pnpm typecheck`、`doctype-psd` / `doctype-server-common` / `cloudflare-sdk` /
  `web-psd` 各包测试、`tests/unit` + `tests/integration/cloudflare` 全绿。

## 死锁审计

闸门是可重入死锁的经典来源，所以立一条不变量：**持有许可期间不得再发起 CAS 调用。**
现有代码逐条核过：

- `#store`：`leaseNode` 循环与 `leaseNodeContent` 是先后独立的 `await`，各自取还，无嵌套。
- `#ensure`：只调 `leaseNode`，失败后走 `store()`，两者不重叠。
- `open()`：只在 `openBlob` 期间持有；流式读取在许可之外（见上）。

新增代码必须维持这条不变量。

## 已存在的改动（本设计要撤掉的）

工作区里已按「psd 全局信号量」写了一版，**尚未提交**：

```
新增  packages/doctype-psd/src/cas-concurrency.ts
新增  packages/doctype-psd/tests/cas-concurrency.test.ts
改动  packages/doctype-psd/src/psd/cas-blobstore.ts
改动  packages/doctype-psd/src/state.ts
改动  packages/doctype-psd/src/resolve.ts
```

限流器实现本身可直接搬进 `sblob-context.ts`；那份测试里「不许插队」一条已证明恒真，
按上面的确定性写法重写。
