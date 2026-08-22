# UniDocs Azure 阶段 3 设计

日期:2026-08-21
状态:已确认,待实施

上位文档:`docs/superpowers/specs/2026-08-20-azure-deployment-design.md`(第 6 节「阶段 3 — docx 上 Azure,CAS 走过渡形态」)。
前一阶段:`docs/superpowers/plans/2026-08-20-azure-phase2-azure-sdk.md`(含「阶段 3 交接说明」)。

本文在上位设计第 6 节那三行的基础上做两件事:把交接说明里的五条债务纳入范围并排序;把三行里被一带而过、实际动手才发现代价不对等的地方(treespec 容器化、CAS 端点位置、服务入口重复)写清楚。

## 1. 背景与目标

阶段 2 的结论是「49 个行为测试在 Miniflare 与本地 Azure 栈上各跑一遍全绿,断言逐字未改」。这句话是真的,但它**只在单副本拓扑下成立** —— `startAzureRuntime()` 只起一个 `azure-markdown` 进程。

这是个结构性问题,不是覆盖率问题。上位设计第 2 节的整个论证是:Cloudflare 上一个文档的状态由唯一的 Durable Object 实例独占,单线程串行,所以 `editor-do.ts` 里 `baseVersion === this.#version` 的内存比较成立;Azure 没有这个东西,N 个无状态副本共享 Postgres,同一个文档的两个请求可以**同时**落在不同副本上 —— 这才是把版本检查改成条件写的理由。而这个场景,阶段 2 一次都没跑过。也就是说:**一个设计错误的实现,在阶段 2 的测试下同样会全绿。**

**本轮验收终点**:

- 行为测试在 Miniflare 与**双副本** Azure 栈上各跑一遍全绿,断言逐字未改
- docx 在本地 Azure 栈上跑通含图片的 apply
- treespec 整棵树在两个网关(Miniflare / Azure)上都绿

**非目标**(与上位设计一致,本轮明确不做):

- 用户级 CAS 的 Azure 实现(`azure-cas`)—— 阶段 4
- 真实 Azure 订阅上的部署、Bicep、多区域
- Operator(ReAct 循环)的生产化
- 实时协同编辑

## 2. 范围与顺序

八个任务。顺序由硬约束推出,不是偏好:

本节的任务编号是**实施顺序**;下面各节按主题编号,两者不一一对应,故每行注明对应章节。

| # | 任务 | 详见 | 位置理由 |
|---|---|---|---|
| 1 | `pg.Pool` 四个超时 | §5 | 交接说明的硬前置:动任何新写路径之前必须先补 |
| 2 | `azure-sdk` 抽出 `runDocTypeService()` | §3 | `azure-docx` 存在之前必须先消灭可复制的正确性不变量 |
| 3 | 多副本拓扑 + 轮询代理 + 跨副本并发场景 | §4 | 地基验证;必须在 docx 之前,否则未验证面积翻倍 |
| 4 | 端口契约四个盲区 | §9 | 与 doctype 无关;任务 3 引入的并发前置在这里定型为契约的一部分 |
| 5 | CAS 过渡形态接线(含给 CAS worker 开端口) | §6 | docx 的前置 |
| 6 | `azure-docx` + `dev.mjs` 放开 docx | §7 | 依赖任务 2、5 |
| 7 | treespec:Postgres 进 e2e 镜像 + 每步双网关 | §8 | 依赖任务 6 |
| 8 | 五处无覆盖行为变更补测 + `migrate` script 修复 | §9 | 与其余任务无依赖,可最后做 |

## 3. `azure-sdk` 抽出服务入口

### 问题

`packages/azure-markdown/src/local-editor.ts`(117 行)**一行 markdown 的知识都没有** —— 它是 `<TDoc, TQuery, TOp>` 泛型的,只依赖 `@unidocs/core` 的 `DocumentType` 接口。它待在 `azure-markdown` 里是历史原因。

而它承载的恰恰是整个 Azure 适配里最微妙的一条多副本正确性规则(该文件模块注释,原文):

> 每请求新建 `DocumentSession`,不做 LRU 缓存。`apply()` 只把 delta 日志的 `head()` 与调用方传来的 `baseVersion` 比,从不与缓存实例自己的 `#version` 比;一个被**别的副本**抢先推进过的缓存 session 能通过这个检查(版本号是对的),但它内存里的 `#doc` 不是 —— 错的字节会带着一个看起来正确的版本号写进快照缓存,下游没有任何东西能拦。

按现状创建 `azure-docx`,就是把这段规则**复制一份**。CLAUDE.md 里已有一条同类记录(「两个 doc-type `worker.ts` 近乎相同 by design,改路由要两边都改」),但那是路由样板;这一条是正确性不变量,复制它等于制造一个「只改一边就能悄悄产生数据损坏」的路径。

同样被复制的还有:`requireEnv`、`pool.on("error")` 监听器(不加则一次 DB 抖动会以未捕获异常杀掉整个进程 —— 现有注释里写着「见 azure-markdown 里为什么这是必需的」,跨文件引用本身就是重复的信号)、SIGINT/SIGTERM 关停块、`buildDeps` 的端口构造、CAS 桩。

### 方案

`local-editor.ts` 整体移入 `packages/azure-sdk`。`azure-sdk` 新增:

```ts
export interface DocTypeServiceOptions<TDoc, TQuery, TOp> {
  docType: string;
  documentType: DocumentType<TDoc, TQuery, TOp>;
  defaultPort: number;
}

export function runDocTypeService<TDoc, TQuery, TOp>(
  options: DocTypeServiceOptions<TDoc, TQuery, TOp>,
): Promise<void>;
```

`runDocTypeService()` 内部拥有:env 读取与校验、`createPool()`(含第 5 节的超时)、`pool.on("error")`、`createBlobService()`、`buildDeps` 的端口构造、`CasClient` 接线(第 6 节)、`createDocTypeHandler()`、`serve()`、SIGINT/SIGTERM 关停。

`azure-markdown/src/main.ts` 塌缩为选 doctype + 调用;`azure-docx/src/main.ts` 是同样的形状。**没有可复制的东西,也就没有可漂移的东西。**

`azure-gateway` 不并入这个入口 —— 它不构造 session、不碰 Blob,职责不同。但 `requireEnv` 与 `pool.on("error")` 从 `azure-sdk` 导出供它复用。

## 4. 多副本拓扑

### 分流由谁做

生产环境是 Azure Container Apps 的 ingress:单个 FQDN 前置 N 个副本。本地由**测试脚手架**扮演这个角色,不是应用代码 —— `scripts/` 里一个极小的轮询反向代理,`azure-gateway` 与 `azure-markdown` 一行不改。

被否决的方案:让 `azure-gateway` 的 `resolveWorkerUrl` 支持逗号分隔的 URL 列表并自己轮询。实现更短,但会在生产代码里留下一块真实部署用不上的负载均衡逻辑。

### 副本数

`startAzureRuntime({ replicas })`,**默认 2**。默认取 2 而不是 1,是因为「开发时对着什么跑」与「测试对着什么跑」不一致本身就是事故来源 —— `pnpm dev --azure` 同样默认起两份。

保留可配置的唯一理由是排查:一条测试红了,切成单副本再跑一遍,立刻能区分「多副本才暴露的问题」与「本来就错」。

但这带来一个与本轮要修的病同源的陷阱:**能调成 1,就会有人调成 1 然后忘了。** 因此:

- 跨副本并发场景在 setup 里断言 `replicas >= 2`,配成 1 时**失败并说明原因**,而不是「跑过了但什么都没验」
- 行为测试套不传这个参数,永远拿默认值

### 端口布局

端口改为推导,不再硬编码:

```
gateway               41787
markdown 代理          41800      <- urls.markdown 仍指这里
markdown 副本 1..N     41801, 41802, ...
docx     代理          41810
docx     副本 1..N     41811, 41812, ...
```

`urls.markdown` 的含义不变(「gateway 该打的那个地址」),`MARKDOWN_WORKER_URL: urls.markdown` 那行不用动。测试要直连特定副本时用新增的 `urls.markdownReplicas[i]`。

端口布局挪到**无依赖**的 `scripts/azure-ports.mjs`,`azure-runtime.mjs` 与 `dev.mjs` 都从它推导。这同时修掉一处已知重复:`dev.mjs` 的 `AZURE_PORTS` 目前是抄 `azure-runtime.mjs` 的 `DEFAULT_PORTS`(注释里写着「必须保持一致」)—— 副本数一旦可配,两处硬编码必然对不上。启动前的端口探测由此自然覆盖全部副本。

该模块无依赖的约定与 `scripts/doc-types.mjs` 相同(CLAUDE.md:纯逻辑放这里,而不是放进 `startLocalRuntime()`),使端口推导可以脱离 Docker 与 esbuild 单测。

### 新增的跨副本场景

行为测试套经代理后,每个请求换一个副本 —— 现有全部断言免费升级为多副本断言:任何依赖进程内状态才能通过的地方会直接变红。在此之上新增一组专门场景,直连副本以制造真正的同时性:

- 同一 `baseVersion` 的两个 apply 分别打到副本 A 与副本 B,断言恰好一个成功、一个 409,且 409 响应体里的 `version` 是服务端当前版本
- 副本 A 写入后,副本 B 立即读 —— 断言 `BlobSnapshotCache.get()` 的 ETag 一致读拿到的是新值而非陈旧快照
- 副本 A 与副本 B 交替 apply 若干轮,断言版本严格递增无空洞

## 5. `pg.Pool` 超时

`packages/azure-sdk/src/pool.ts` 的 `createPool()` 目前只传 `connectionString`,四个超时全部留空。后果(交接说明原文):两个并发 `create()` 撞同一个 `docId` 时,`withTransaction` 里的推测插入会让后到的事务在锁上等待,等的是**前一个事务提交或回滚为止**,期间占着借出的连接不放;默认 `max` 是 10,一个卡住不提交的事务就能让连接被逐个占满,而没有 `connectionTimeoutMillis` 意味着连「排队等连接的请求也超时报错」这条自愈路径都没有 —— 服务会挂起而不是降级。

补上:

| 参数 | 值 | 理由 |
|---|---|---|
| `connectionTimeoutMillis` | 5000 | 池耗尽时请求快速失败,而不是无限排队 |
| `lock_timeout` | 5000 | 刻意短于 `statement_timeout`:锁等待先失败,错误信息更能指出真实原因 |
| `statement_timeout` | 15000 | 兜底,防止单条语句无限期占用连接 |
| `idle_in_transaction_session_timeout` | 10000 | 卡住的事务不许一直占着连接 |

四个值均可用环境变量覆盖(`PG_CONNECTION_TIMEOUT_MS`、`PG_LOCK_TIMEOUT_MS`、`PG_STATEMENT_TIMEOUT_MS`、`PG_IDLE_TX_TIMEOUT_MS`),默认值写在代码里而不是只写在文档里。

`lock_timeout` / `statement_timeout` / `idle_in_transaction_session_timeout` 是会话级参数,通过 `Pool` 的 `options` 字段以 `-c` 形式下发,保证每条从池里借出的连接都带着它们,而不依赖服务端默认值。

## 6. CAS 过渡形态

### 关键事实:端点不在 gateway 后面

`CasClient` 的多数路由是 `${origin}/users/{userId}/cas/...`,但 `updateRootRefs` 打的是 **`${origin}/_internal/root-refs`**(`packages/server-core/src/cas-client.ts:165`),不在 `/users/{userId}/cas/` 下面。`createGatewayHandler` 只路由 `/users/...`,不代理 `/_internal/*` —— 在 Cloudflare 上 editor 通过 service binding `CAS_SERVICE` 直连 CAS worker,`origin` 只是占位符。

因此:**Azure 的 `CAS_BASE_URL` 必须指向 CAS worker 本身,不能指向 Miniflare 的 gateway。**

而 `scripts/doc-types.mjs` 的 `buildWorkers()` 里,CAS worker **没有** `unsafeDirectSockets` —— 它目前只能通过 service binding 访问,进程外不可达。

### 方案

选定形态:**两套栈共存**。`pnpm dev`(Miniflare)与 `pnpm dev --azure` 同时跑,Azure 侧的 `CAS_BASE_URL` 指向 Miniflare 栈里已有的 CAS worker。Miniflare 用 8787/8788/8789,Azure 用 41787/418xx,端口不冲突。

- `scripts/doc-types.mjs`:CAS worker 加 `unsafeDirectSockets`(端口 **8790**);`startLocalRuntime()` 返回的 `urls` 多一项 `cas`
- `runDocTypeService()` 读 `CAS_BASE_URL`:给了就构造 baseUrl 模式的 `CasClient`(附 `INTERNAL_TOKEN`),没给就保持现有的 501 桩 —— markdown 的 `refsFromOp` 恒返回 `{}`,不给它配 CAS 是正确的默认
- `pnpm dev --azure docx` 启动时**探一次** `CAS_BASE_URL` 可达性,不可达则响亮失败并提示「另开一个终端跑 `pnpm dev`」,而不是等到某次带图片的 apply 才 ECONNREFUSED

被否决的方案:在 `startAzureRuntime()` 里内嵌一个只含 CAS worker 的 Miniflare 实例(会让「Azure 栈」里长出一个 workerd 进程);指向真实部署的 Cloudflare CAS worker(需要凭据与公网,本地与 CI 都跑不了离线,行为测试会变成依赖外部服务的不稳定测试)。

### 生命周期

这一整块在阶段 4 连同 `azure-cas` 一起删除。`CAS_BASE_URL` 的读取处、`doc-types.mjs` 里新开的端口、`dev.mjs` 的可达性探测,**代码注释里逐处标注为过渡形态并指向阶段 4**,避免它沉淀成默认架构。

## 7. `azure-docx`

`packages/azure-docx`,`src/main.ts` 依第 3 节塌缩为选 doctype + 调用 `runDocTypeService()`。

`scripts/dev.mjs` 现在硬拒绝 markdown 以外的 doc type(理由是 docx 依赖用户级 CAS)。改为:docx 允许,但要求 `CAS_BASE_URL` 且启动时探测可达性(第 6 节)。

CLAUDE.md「新增 document type」的第 4 步补上 Azure 侧的对应条目(`scripts/azure-ports.mjs` 的端口布局行)。

## 8. treespec 指向 Azure 栈

### 现状与障碍

`tests/bootstrap/` 是一棵 treespec 树:每个目录是一步,`spec.yaml` 里是 curl 命令加 `jsonata`/`regex` 断言,`primary` 表示继续、`branches` 表示分叉,合计 22 条 e2e 断言。整棵树跑在 `e2e/Dockerfile` 构建的容器里(`node:24-slim` + curl):容器内拷仓库、`pnpm install`、`pnpm -r build`,然后 `nohup node scripts/dev.mjs` 起 Miniflare,再 curl `http://localhost:8787`。

障碍:Miniflare 只是个 npm 包,workerd 跑在进程内,装完依赖就自带;Azure 栈需要 Postgres,本地是 `docker compose` 起的,而**这个测试容器内部没有 docker**。

### 方案

- `e2e/Dockerfile` 加装 postgresql 包(约 150MB)。Azurite 用已有的 npm 依赖,与 `startAzureRuntime()` 现在的做法一致
- `startAzureRuntime()` 新增「用外部已在跑的 Postgres、不走 docker compose」模式(由配置项选择,不是自动探测 —— 自动探测会让「compose 没起来」这类故障静默降级)
- `tests/bootstrap/spec.yaml` 同时起两套栈(Miniflare + Azure),每个下游 step 的每条 curl 变成两条:一条打 8787、一条打 41787,断言逐字相同

这里刻意接受的代价:每个 `spec.yaml` 长一倍,每一轮 e2e 都要付两套栈的启动时间,且两个平台**不能分开跑**。换来的是:硬编码的期望版本号只有一份,不会漂移;而「两种部署形态对客户端不可区分」这个结论不会因为某一边长期不跑而悄悄失效。

被否决的方案:新增一条 azure 分支、复制一套 markdown/docx 子树(约 15 个逐字重复的 spec 文件,硬编码版本号两份,改一边忘另一边是时间问题);把网关地址参数化后跑两遍(需要 treespec 支持给单次运行传参,且「能只跑一边」意味着迟早只跑一边)。

注:本轮与 PR #21(削减本地栈镜像体积)方向相反 —— 那次删掉 Azurite 镜像是为了让 `pnpm test:local` 在冷环境不超时;这里是 e2e 镜像,是另一条链路,但**冷构建时间会变长,任务 7 的验收必须包含一次冷环境计时**。

## 9. 补测清单

### 端口契约的四个盲区

均在 `packages/server-core/src/testing/port-contract.ts`,与 doctype 无关:

1. **并发前置钩子**。`packages/azure-sdk/tests/ports.test.ts` 为了让并发哨兵真正并发,在 harness 层维护了一套连接池预热(`pg.Pool` 惰性建连,不预热的话第二个写者要等一次完整 TCP 握手,「并发」退化成串行)。这条前提只活在调用方,契约本身不知道也不检查。改为**必填**的前置钩子:契约在跑并发哨兵前主动向 harness 要一份「并发前提已满足」的证明,而不是指望每个新后端的作者想起来抄这段。
2. **`remove()` 并发哨兵**。契约里 `remove` 只有串行用例,而 `remove` 与 `append` 之间那个已知、有意接受的窗口恰恰是并发场景。补一条与 `append` 哨兵同构的并发用例 —— 本轮不修窗口本身(上位设计第 9 节已记录为接受),但让盲区可见。
3. **`DocIndex.touch()` 语义**。三个后端都没有一条用例直接验 `touch()`:断言它推进 `updatedAt` 而不动 `createdAt`。
4. **文档作用域谓词**。目前每条用例只操作一个文档,「操作文档 A 不影响也读不到文档 B」从未被直接验证。在专用存储(每 DO 一个私有 sqlite)上几乎不可能出错,但在共享表后端(Postgres 上所有文档挤在同一张 `deltas` 表)上,漏写一个 `WHERE` 条件是最容易犯、代码审查最难发现的一类 bug。

### 五处无覆盖的 Cloudflare 侧行为变更

阶段 2 为了让 `create()`/`initFromHash()` 能安全接入 `withTransaction` 而改动了 `packages/server-core/src/session.ts`,Cloudflare 与 Azure 共用这份代码,但现有 e2e 都打不到这几条分支。用**内存端口做故障注入**补测,不碰 Miniflare:

1. `load()` 的 blob 回退分支:快照缓存未命中时回退到 `latestSnapshotRef()` + `blobs.get()` 重放
2. 「有 ref 无 blob」fail-closed:断言抛 `StorageCorruptError` → 500,而不是静默返回空文档(阶段 2 之前是静默吞掉数据丢失)
3. 创建路径快照缓存写的 best-effort:断言缓存写失败时创建仍返回 200(阶段 2 之前是 500),且随后的 `load()` 靠 blob 回退拿到正确内容
4. 新建文档 `updatedAt === createdAt`:阶段 2 起这是保证的行为而非巧合
5. `#persistIdentity` 抛异常时的 `errorResponse` 兜底:身份已算出但持久化失败的时机,断言落到 500 而不是崩溃

### `migrate` script

`packages/azure-sdk/package.json` 的 `migrate` 是 `node scripts/bundle-migrate-cli.mjs && node dist/migrate-cli.js` —— 每次调用都用 esbuild 重新打包再运行,而 `esbuild` 在这个包里是 `devDependency`。生产安装(`pnpm install --prod`)后没有 esbuild,`migrate` 会在 `import * as esbuild from "esbuild"` 直接失败。改为运行构建期固化的 `dist/migrate-cli.js`(`build` 负责产出,`migrate` 只负责运行)。

## 10. 验收标准

- 行为测试在 **Miniflare** 与 **双副本 Azure 栈**上各跑一遍全绿,**断言逐字未改**
- 新增的跨副本并发场景全绿;把 `replicas` 配成 1 时这组场景**失败并给出原因**
- docx 含图片的 apply 在本地 Azure 栈上跑通(经 `CAS_BASE_URL` 指向 Miniflare 栈的 CAS worker)
- treespec 整棵树在两个网关上都绿;冷环境构建时间已实测并记录
- 端口契约新增的四条用例在内存、Cloudflare、Postgres 三个后端上全绿
- `pnpm typecheck` / `pnpm -r test` / `pnpm build` / `pnpm test:local` 全部退出码 0
- `packages/azure-markdown/src/` 与 `packages/azure-docx/src/` 中不存在逐字重复的 session 构造逻辑

## 11. 风险与未决事项

| 项 | 说明 | 处置 |
|---|---|---|
| 双栈 DX | docx 上 Azure 需要同时跑 `pnpm dev` 与 `pnpm dev --azure` | 明确接受;启动时探测 `CAS_BASE_URL` 可达性并给出可操作的提示,而不是深处 ECONNREFUSED。阶段 4 消失 |
| e2e 时间变长 | 每轮 e2e 要起两套栈,且镜像多装 postgresql | 明确接受(理由见第 7 节);任务 7 验收含一次冷环境计时 |
| `remove()`/`append()` 窗口 | 本轮补哨兵使其可见,但不修 | 沿用上位设计第 9 节的既有决定 |
| 副本数可配 | 调成 1 会静默丢失多副本覆盖 | 跨副本场景断言 `replicas >= 2`;行为测试套不传该参数 |
| 过渡形态沉淀 | `CAS_BASE_URL` 这套接线可能被当成最终架构 | 每处代码注释标注过渡形态并指向阶段 4 |
| Postgres 装进 e2e 镜像 | 与 PR #21 削减镜像体积的方向相反 | 不同链路(e2e 镜像 vs `pnpm test:local`);后者不受影响,前者以计时验收 |
| `web-psd` 的 409 处理有 bug | `packages/web-psd/src/main.ts:116-119` 读的是 `e.currentVersion`,而服务端 409 body 里的字段是 `version` —— resync 从未发生,版本号永远停在过期值;且 `continue` 时 `pending` 已置空,注释声称的「重试」也没发生,该 op 被静默丢弃。合起来:第一次冲突之后每次编辑都 409 且静默丢失,状态栏仍显示正常版本号。单副本下几乎撞不到,多副本会真正走到 | 本轮不修(属 PSD 那条线,PR #23 在改同一个包)。记录在此,多副本上线前必须由 PSD 那边修掉 |
| 轮询代理的保真度 | 本地轮询代理不等于 ACA ingress(无健康检查、无粘性、无重试) | 本轮只要求「请求会落到不同副本」这一条性质;更真实的 ingress 行为不在本轮范围 |
| `#persistIdentity` 兜底路径仍无覆盖 | 该分支在 `packages/cloudflare-sdk/src/editor-do.ts`,不在 `session.ts`,需要 DO storage 层的故障注入,内存端口够不到 | 本轮不覆盖。spec §9 列的五处里其余四处已由 `packages/server-core/tests/session-faults.test.ts` 钉住 |
