# Azure Operator 对齐 Cloudflare —— 设计

**日期：** 2026-09-03
**状态：** 待 review

## 现状

Azure 上没有 agent。`azure-sdk/src/doc-type-service.ts:225` 挂的是
`createStubOperatorNamespace()`（`local-editor.ts:124`），`/run` 与 `/reset`
一律 501，markdown / docx / psd 三家都是。前端 `web-psd` 的聊天面板打过去就是 501。

这不是"漏配了 key"。`azure-psd/src/main.ts` 从头到尾没有调 `createPsdAgent`，
它自己的注释把这件事标成 future work。

好消息是循环本身早就云中立了：

| 事实 | 位置 |
|---|---|
| ReAct 循环 `AgentSession`，只依赖 `agent` / `platform` / `provider` 三个注入 | `doctype-server-common/src/agent/session.ts` |
| CF 的壳一共 365 行 | `operator-do-agent.ts` 181 + `agent-platform-do.ts` 174 + `operator-do.ts` 10 |
| 三个 doctype 都有 `agent.ts`，CF 三个 worker 都挂了 `createOperatorDO` | — |
| 唯一的 provider | `agent/providers/anthropic.ts` |

所以要补的是 **Azure 侧的壳**，外加一处两边共用的状态接缝。

## 核心问题：会话状态

CF 把 `AgentSession` **对象**放在 DO 实例的字段上（`operator-do-agent.ts:57`），
惰性建一次后跨请求存活（`:118` 注释：*"建成之后跨请求存活 —— 对话历史在它
里面，只有 /_internal/reset 清空"*）。Durable Object 同一个 docId 永远路由到
同一个实例，所以历史从不需要重建。

Azure 没有这个性质：`/run` 是一次普通 HTTP 请求，且容器是
**`minReplicas=2` / `maxReplicas=5`、无会话亲和**（线上实测 2 副本）。模块级
Map 也不行——第二次请求大概率落到另一个进程。每次 `/run` 必须重建
`AgentSession`，而新对象的 `#history` 是空的。

### 决定：本轮只开接缝、只让 Azure 持久化；CF 一行不动

不让 Azure 去模仿 DO（Azure 的等价物是 Durable Entities，属于 Azure Functions，
为会话模型换掉整个托管形态不值当）。接缝按"两边都能用"来设计，但**本轮只有
Azure 落地**：

```
AgentSession.snapshotHistory()  ──编码──►  Postgres        ← 本轮
  AgentSessionDeps.history      ◄─解码──

                                （CF: 不接，历史仍只在 DO 内存里）
```

**CF 本轮完全不动**：`#agentSession` 记忆化字段保留，历史继续只在内存里，
`OperatorDO` 的 `ctx` 继续丢弃。加到 `AgentSession` 上的两个新东西 CF 一个都不用，
行为逐字不变。

为什么先这样：CF 那条是在跑的生产路径，给它加持久化不是纯新增（每次 run 多一次
storage 写、多一条失败路径），而本轮真正要解决的问题是**Azure 上根本没有 agent**。
把两件事绑在一起，等于让一个"从无到有"的改动去承担一个"把好的改得更好"的风险。

**代价要说清楚：这么做会保留两条运行时差异，不是一条**（见下面「保留的差异」）。
统一推到以后，那时的工作量已经被这次的接缝压得很小：实现一个 `ctx.storage` 版的
store，去掉 `#agentSession` 记忆化，两处。

## 改动清单

### 1. `AgentSession` 开历史进出口（`doctype-server-common`）

三处新增，不改任何既有行为：

```ts
export interface AgentSessionDeps<TQuery, TOp> {
  …
  /** 起始对话历史。省略 = 空数组，即今天的行为。 */
  readonly history?: readonly AgentMessage[];
}

// 构造函数里唯一改动的一行：字段初始化挪进来
this.#history = deps.history ? [...deps.history] : [];

/** 只读快照。复制一份，不把内部数组交出去。 */
snapshotHistory(): readonly AgentMessage[] {
  return [...this.#history];
}
```

**写回时机是 `finally`，不是成功路径。** `session.ts:81` 的
`this.#history.push({ role: "user", content })` 在 try 之前，所以 CF 今天的行为是
**失败的那一轮也留在历史里**，用户重试时模型看得见上一轮。两边都必须照此写回，
否则"重试时模型看到什么"会不一致，而这种不一致最难查。

### 2. 历史编解码器（`doctype-server-common/src/agent/history-codec.ts`，新增）

```ts
export function encodeHistory(history: readonly AgentMessage[]): JsonValue;
export function decodeHistory(raw: JsonValue): AgentMessage[];
```

`AgentContentPart` 的 image 变体带 `blob: SBlob`。编码只写
`{ type: "image", hash: blob.hash }`，解码时 `createSBlob(hash)`。**不存字节**
——blob 本来就在 CAS 里，历史里存的一直是引用（`messages.ts:61-70` 的
`materializeMessages` 在调用模型时才按需拉字节）。

未知的 part 类型解码时抛错，不静默丢弃：一条被悄悄吞掉的图片消息，会让模型
在后续轮次里引用一张它其实没看到的图。

### 3. 提 `agent-platform-do.ts` 为共用（`doctype-server-common/src/agent/platform-http.ts`）

Cloudflare 特异性只有**一个类型、四个位置**（`:18` `:35` `:45` `:53` `:139`），
其余 170 行的 import 全是 `@unidocs/*`。抽象成：

```ts
export interface EditorFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
```

- **CF**：`DurableObjectStub.fetch(url, init)` 结构上就满足它，stub 直接传，
  运行时零变化。`cloudflare-sdk` 保留 `createCloudflareAgentPlatform` 作为再导出
  别名 → `operator-do-agent.ts:124` 一个字不改。
- **Azure**：`LocalNamespace.get(id)` 返回 `{ fetch(request: Request) }`，收的是
  Request 对象，差一层适配：

```ts
const editorFetcher = (name: string): EditorFetcher => ({
  fetch: (url, init) =>
    editorNamespace.get(editorNamespace.idFromName(name)).fetch(new Request(url, init)),
});
```

于是 Azure **不需要写 AgentPlatform**。

### 4. 存储：只有 Azure 一个实现，所以不抽接口

本轮只有 Postgres 一个实现，`PgAgentSessionStore`（`azure-sdk`）就是具体类，
**不预先抽 `AgentHistoryStore` 接口**——一个实现的接口是凭空猜出来的抽象，
等 CF 那份真的要写时再提取，那时才知道两者的公因子究竟长什么样。

### 5. Azure 的表：历史与租约共用一行

`packages/azure-sdk/migrations/0004_agent_sessions.sql`：

| 列 | 类型 | 用途 |
|---|---|---|
| `tenant_id`, `doc_type`, `doc_id` | text | 复合主键，与 CF 的 DO 对象名 `{tenant}:{docType}:{docId}` 同构 |
| `history` | jsonb | `encodeHistory()` 的产物 |
| `running_until` | timestamptz null | 租约 |
| `updated_at` | timestamptz | 排查用 |

`/run` 的第一步就是抢租约：

```sql
UPDATE agent_sessions
   SET running_until = now() + interval '1800 seconds', updated_at = now()
 WHERE tenant_id = $1 AND doc_type = $2 AND doc_id = $3
   AND (running_until IS NULL OR running_until < now())
RETURNING history;
```

`rowCount = 0` → **409**。行不存在则先 `INSERT ... ON CONFLICT DO NOTHING` 再抢。

跑完（`finally`）写回 `history` 并把 `running_until` 置 null。

**租约 1800 秒**取自 `/run` 自己的能力票窗口（`gateway-common/src/capability-policy.ts:74-80`，
注释：*"窗口必须覆盖整次 run"*）——票过期后这次 run 再写也是 401，所以它就是
一次 run 的硬上限，没有比它更合适的值。代价是进程崩溃后同文档最多 30 分钟拿不到
租约；**`/reset` 强制清空租约**，作为明确的人工逃生口。

### 6. Azure 的 operator 命名空间

新增 `azure-sdk/src/local-operator.ts` 的 `createLocalOperatorNamespace(...)`，
替换 `doc-type-service.ts:225` 那一行。端点与 CF 逐字对齐：
`POST /_internal/run`、`POST /_internal/reset`。

每次请求：抢租约 → `decodeHistory` → `new AgentSession({..., history})` →
`run()` → `finally` 里 `snapshotHistory()` → `encodeHistory` → 写回 + 释放租约。

### 7. 接线

- 三个 `azure-{type}/main.ts` 各传自己的 agent。
- psd 额外按 env 接图像模型，**沿用 CF 的条件化**
  （`cloudflare-psd/src/worker.ts:36-52`）：没有 `IMAGE_EDIT_API_KEY` 就不注入
  editor，于是工具表里没有 `editPixels`、提示词里也没有。
  `doctype-psd/src/agent.ts:23-26` 的注释记着这条的由来：只条件化其中一个会得到
  一个"提示词里有、工具表里没有"的幽灵工具，那是线上真实发生过的故障。
- `runDocTypeService()` 新增两个可选参数，**都是值不是工厂**——Azure 侧
  `process.env` 在 `main.ts` 里就能读，不需要 CF 那种"env 只在 DO 构造时才拿得到"
  的延迟构造：

  ```ts
  interface DocTypeServiceConfig<…> {
    …
    /** 省略 = operator 维持 501 stub，markdown/docx 可以分批接。 */
    readonly documentAgent?: DocumentAgent<TQuery, TOp>;
    /** 省略 = 同上。两个必须同时给，只给一个在启动期抛错。 */
    readonly llmProvider?: LlmProvider;
  }
  ```

  psd 的 `main.ts` 因此长这样（图像模型的条件化在调用方，与 CF 同形）：

  ```ts
  documentAgent: createPsdAgent(
    process.env.IMAGE_EDIT_API_KEY
      ? { editor: createQwenImageEditor({ apiKey: process.env.IMAGE_EDIT_API_KEY, observe: consoleObserver, … }) }
      : {},
  ),
  llmProvider: createAnthropicProvider(process.env, fetch, { observe: consoleObserver }),
  ```

### 8. 基础设施

`service.bicep` 新增 env，值走 Key Vault secret：

| env | 必需 | 说明 |
|---|---|---|
| `LLM_API_KEY` | 是（否则 provider 在第一次调用抛错） | `anthropic.ts:186` 也接受 `ANTHROPIC_API_KEY` |
| `LLM_MODEL` | 否 | 默认 `claude-opus-5`（`anthropic.ts:187`） |
| `LLM_BASE_URL` | 否 | 默认 `https://api.anthropic.com` |
| `IMAGE_EDIT_API_KEY` | 否（psd 专用） | 不给就没有 `editPixels` |
| `IMAGE_EDIT_MODEL` / `IMAGE_EDIT_BASE_URL` | 否 | 默认见 `qwen-editor.ts:55` |

## 保留的差异（两条，明确记录）

### 差异一：会话持久性 —— CF 驱逐即丢，Azure 不丢

CF 维持 *"in-memory session (lost on DO eviction)"*：用户聊到一半 DO 被驱逐，
上下文静默消失。Azure 落库，重启不丢。

这是本轮**刻意保留**的，不是疏忽。后果要认下来：

- **同一个功能在两条运行时上表现不同**，排查问题时得先问"这是哪条栈"。
- **编解码器只有 Azure 一条路径在跑。** `AgentMessage` 带 `SBlob`，编解码要是有
  bug，CF 永远不会暴露它。缓解办法只能是测试——所以下面把编解码器的往返测试
  列为权重最高的一项，并要求变异验证。

### 差异二：并发 —— CF 排队，Azure 409

CF 的 `#requestTail`（`operator-do-agent.ts:56`）是单线程 isolate 里的一条
promise 链，等待不占任何资源——这是 DO 模型自带的性质。Azure 上跨副本的等待
必然要占 Postgres 连接（`pg_advisory_lock`，几个等待者就能吃干连接池、拖垮同一
副本上不相干的请求）或占 HTTP 请求槽（轮询租约，最长 30 分钟）。没有便宜的
等价物。

在这条轴上收敛只有两个走法，都更差：让 Azure 也等（用 30 分钟请求槽换一个多标签
页边角场景），或让 CF 也 409（把一个免费且正确的行为改坏）。

实际影响很小：`web-psd/src/ui/panels/composer.tsx:58,100` 在 `busy` 时禁用发送，
同一标签页不可能并发；撞车只发生在多标签/多设备。

## 已知局限：租约没有持有者校验（2026-09-03 决定本轮不修）

`release()` 与 `clear()` 是无条件 UPDATE，不校验自己是否仍是租约持有者。

触发条件是**单次 run 超过 1800 秒**：租约到期后系统判定持有者已死、放第二个 run
进来；而第一个其实只是慢，它跑完后迟来的 `release()` 会用自己那份旧历史覆盖掉
第二个已经写回的新历史，并拔掉第二个正在持有的租约。静默，无告警。

这是所有**带过期时间的锁**共有的问题——「过期」本质上是在赌持有者已经死了，而
数据库里区分不了"进程崩了"与"进程很慢"。标准解法是给锁发编号（fencing token），
持有者还锁时校验编号还是不是自己的，赌输的一方安静退出。

修法已知且很小：`agent_sessions` 加一列 `lease_id`，`acquire` 生成并返回它，
`release` 的 WHERE 加 `AND lease_id = $5`。`clear()` 保持无条件——它是 `/reset`
的强制清场逃生口，无视锁是设计意图。

本轮不做是明确决定，不是疏漏。

## 非目标

- **CF 侧的持久化。** 本轮不动 CF。以后要统一，工作量是：写一个 `ctx.storage` 版
  的 store（单键 `"agent:history"`，`OperatorDO` 的 `ctx` 现在就在手上，
  `operator-do-agent.ts:62` 只是丢弃了它），去掉 `#agentSession` 记忆化字段，
  然后把 `PgAgentSessionStore` 与它的公因子提成接口。
- **轮询等待。** 用的是同一张租约表，以后要加不必改存储。
- **Durable Entities。** 换托管形态的代价远大于收益，见上。
- **新 provider。** 只有 anthropic。
- **不动 `minReplicas` / `maxReplicas`。**
- **不改 `/run` 的 HTTP 契约。** 仍然只收 instruction，历史在服务端。

## 测试

- **编解码器**：往返一致，含带 `SBlob` 的 image part；未知 part 类型抛错而非静默
  丢弃。这是两边共用的那一份，权重最高。
- **`AgentSession`**：传 `history` 能续上对话（第二次 run 的 messages 里含第一次
  的内容）；`snapshotHistory()` 返回的是副本（改它不影响内部）；不传 `history`
  时行为与今天逐字一致。
- **写回时机**：`run()` 抛错时历史仍被写回，且包含失败那轮的 user 消息。
- **租约**：并发两个 `/run` 只有一个拿到，另一个 409；租约过期后可再抢；
  `/reset` 清空租约。
- **Azure operator**：`/run` 与 `/reset` 走通，返回体与 CF 同形。
- **回归**：`pnpm typecheck`、各包测试、`tests/unit` + `tests/integration/cloudflare`。

**验收证据：** 编解码器与租约两项要跑变异验证并贴结果——把 `SBlob` 编码改成存
字节、把租约的 `WHERE running_until IS NULL OR running_until < now()` 条件去掉，
各自都必须至少挂掉一条测试。不挂的测试视为无效，重写。

## 风险

1. **CF 侧只剩一处结构调整。** `platform-http.ts` 的提取是 `git mv` + 换 4 处类型
   + 一行再导出，CF 调用点（`operator-do-agent.ts:124`）不变、运行时零变化。
   仍要跑 CF 完整回归，但风险比"给 CF 加持久化"低一个量级。
2. **编解码器缺一条验证路径。** 见「差异一」：只有 Azure 在跑它。
3. **租约锁死。** 进程崩溃后最多 30 分钟拿不到租约，靠 `/reset` 逃生。
4. **Azure 侧首次有了"不丢的历史"。** 用户在 Azure 上可能看到一段很旧的对话
   （CF 上同样场景早就被驱逐清掉了）。`/reset` 是明确的清除入口。


---

## 后续项（本轮明确不做，按分量排）

实现完成后记录，供接手者参考。每条都写明了触发条件与修法，不必重新推演。

### 1. 租约没有持有者校验（Critical，已在上面「已知局限」详述）

修法：`agent_sessions` 加 `lease_id` 列，`acquire` 生成并返回，`release` 的 WHERE 加
`AND lease_id = $5`。`clear()` 保持无条件（`/reset` 的强制清场是设计意图）。

### 2. psd 的 `maxIterations` 在 Azure 上是默认 10，Cloudflare 是 25

**这一条必须和第 1 条同一个 PR 做。** 全分支评审指出：提到 25 会让最坏墙钟时间约 ×2.5，
真的够得到 1800 秒租约——在没有 fencing token 的前提下提高迭代上限，等于把第 1 条从
"理论风险"变成"可触达"。

### 3. 历史无上限增长

`ByteLru` 每请求重建，导致每次 run 冷拉全部历史图片；token 成本随对话轮次单调增长，
最终越过 provider 的图片数量上限后，该会话永久 400。需要历史裁剪或图片引用的滑动窗口。

### 4. `LLM_BASE_URL` / `IMAGE_EDIT_BASE_URL` 未参数化

代码侧（`anthropic.ts:185`、`qwen-editor.ts`）已经读这两个 env，只缺 bicep 注入。
Cloudflare 侧已列为可配置项。生产若需走代理/专线访问模型端点会卡住。纯加法。

### 5. `BlobUnavailableError` 的降级契约不可达（既有，两条运行时都有）

CAS 的 404 在到达 `agent/platform-http.ts:126` 之前，已被编辑器的外层 catch 映射成 400
（CF `editor-do-svalue.ts:795` 与 Azure `session-handler.ts:102` 是同一套三分映射）。
所以 `platform-http` 里那个 `response.status === 404` 判断从未触发，
`packages/protocol/src/types.ts` 中描述该机制的注释（提交 `63f997b` 的背景）描述的是一个
不存在的行为。

**本轮刻意不修**：改它会让降级路径在 Cloudflare 上开始触发 = 改变 CF 运行时行为。
而且当前行为落在安全侧——blob 真丢时是整次 run 响亮失败，而不是静默把图换成一行文字，
这恰好是 `63f997b` 想要的结果。

### 6. 一个会在修好别的 bug 之后才引爆的测试

`tests/integration/azure/azure-psd.test.mjs:62-83` 用裸 `Content-Type: application/json`
调 `getPreview`，不带 `Accept: SValueContentType`；而 `getPreview` 的结果携带 SBlob。
按本轮改后的 `/_internal/query` 语义（`valueResponse` 内容协商），这条路径应当返回 **406**。

它现在没有失败，只是因为被一个无关的既有缺陷（该测试的 CAS 写权限 403）挡在更早一步。
**一旦有人单独修掉那个 CAS 权限问题，这条测试会转为 406 失败，而失败原因看起来与 CAS
修复毫无关系。** 修法：给该调用补上 `Accept: SValueContentType` 头——生产侧唯一的调用方
`agent/platform-http.ts` 本来就是这么做的。
