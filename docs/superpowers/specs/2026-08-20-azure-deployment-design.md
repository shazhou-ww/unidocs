# UniDocs Azure 部署设计

日期:2026-08-20
状态:已确认,待实施

本文取代 2026-08-19 的同名设计(从未提交)。原设计写于 CAS 子系统落地之前,第 2、4、6 章与当前 main 不符,已在本文中对齐。

## 1. 背景与目标

UniDocs 目前完全构建在 Cloudflare 生态上:Workers 作为计算层,Durable Objects 承载单文档状态与用户级 CAS,R2 存快照与 CAS 节点字节,D1 做全局索引与 CAS 元数据,KV 做文档类型注册表。

**目标**:让同一套代码能部署到 Azure,与 Cloudflare 部署**并存** —— Cloudflare 继续承载公有云 SaaS,Azure 作为企业客户 / 私有化部署选项。

**非目标**(本设计明确不做):

- 替换或下线 Cloudflare 部署
- 多区域 / 跨区域复制
- 实时协同编辑(多人同时写同一文档仍然是"一个成功、其余 409 重试")
- Operator(ReAct 循环)的生产化 —— 它的 `llmProvider` 和 `getEditorStub` 目前都是抛异常的 stub
- **用户级 CAS 服务端的 Azure 实现** —— 见 3.3,留到下一轮

**本轮验收终点**:markdown 与 docx 在**本地 Azure 栈**(docker-compose 起 Postgres + Azurite)上端到端跑通,同一套行为测试在 Cloudflare 与 Azure 两个后端均通过。不写 Bicep,不碰 Azure 订阅。真实云部署是下一轮的事。

**部署形态假设**(为代码结构服务,本轮不落地):Azure Container Apps + 托管 PaaS(PostgreSQL Flexible Server、Blob Storage、Key Vault)。

## 2. 现状:Cloudflare 依赖面

代码里实际用到的平台能力有 8 项:

| Cloudflare 能力 | 代码位置 | 承担的职责 |
|---|---|---|
| Workers `fetch` handler | `cloudflare-gateway/src/worker.ts`、`cloudflare-{markdown,docx,cas}/src/worker.ts` | 纯 Web 标准 API(Request / Response / URL / crypto.subtle / FormData) |
| Editor DO `idFromName("{userId}:{docId}")` | 各 doc-type worker.ts 路由段 | 把一个文档的所有请求路由到唯一实例 |
| Editor DO 单线程 + `#requestTail` | `cloudflare-sdk/src/editor-do.ts:105,265` | 使内存中的 `baseVersion === this.#version` 检查成立 |
| Editor DO `ctx.storage.sql` | `editor-do.ts` 的 `deltas` / `snapshots` 表 | 每文档的 delta 日志 |
| Editor DO `ctx.storage.put/get` | `KEY_SNAPSHOT` / `KEY_DOC_TYPE` / `KEY_DOC_ID` / `KEY_USER_ID` | 最新快照字节 + 不可变元数据 |
| R2 / D1 / KV | `env.CAS` / `env.SNAPSHOTS_DB` / `env.REGISTRY` | 文档快照的内容寻址存储 / 全局索引 / 类型注册表 |
| **CAS DO(per-user)+ `CAS_DB` + `CAS_R2`** | `cloudflare-cas/src/cas/do.ts` | 用户级 CAS:lease 申领与续期、上传校验、child/root 引用计数、GC、usage |
| **Service binding `CAS_SERVICE`** | `cloudflare-gateway/src/worker.ts`、`editor-do.ts` | gateway 与 editor 调用 CAS worker |

`packages/core`、`packages/doctype-*` 与 `packages/cas` 已经是云中立的,本设计不触碰它们。

**术语澄清 1**:`editor-do.ts` 顶部注释把 DO 自带的私有键值存储写作 "KV",与 gateway 里真正的 KV Namespace(`REGISTRY`)同名但是两回事。重构时统一改用 `SnapshotCache` / `Registry` 指代,消除歧义。

**术语澄清 2**:代码里有**两个都叫 CAS 的东西**,必须分清:

| | 文档快照 CAS | 用户级 CAS |
|---|---|---|
| 位置 | `env.CAS`(R2 bucket) | `packages/cloudflare-cas` |
| key | 裸 hash(SHA-256 前 8 字节,16 位十六进制) | `users/{userId}/nodes/{完整 SHA-256}` |
| 用户隔离 | 无 | 有 |
| 引用计数 / lease / GC | 无 | 有 |
| 本设计中的处置 | 抽成 `BlobCas` 端口,Azure 用 Blob container | 服务端不动,客户端提到 `server-core`(见 3.3) |

**跨脚本绑定**:原设计称"没有跨脚本 DO 绑定,一律 plain fetch"。这句话对 gateway → doc-type worker 仍然成立(走 URL + `fetch`),但对 CAS 已不成立 —— gateway 和 editor 都通过 service binding `CAS_SERVICE` 调用 CAS worker。见 3.3 的处置。

## 3. 核心技术决策

### 3.1 Durable Object 不是一个可以"找替代实现"的端口

R2 / D1 / KV 是**被调用的资源**,可以干净地抽象成接口并提供两套实现。

Durable Object 不是资源,它是**代码运行的容器** —— `createEditorDO()` 返回的 class 本身就是一个 DO。因此它不能靠"实现一个 Azure 版 DO 端口"来解决,只能拆解为三件独立的事:

| DO 提供的能力 | 处理方式 |
|---|---|
| 私有存储(sqlite + 键值) | 抽象成 `DeltaLog` + `SnapshotCache` 两个端口,两套实现 |
| 按 key 路由到固定实例 | 取消。文档改为按需从快照 + delta 重建,无需实例亲和性 |
| 单线程排队(那把锁) | 用数据库唯一键约束替代,见 3.2 |

最终是**四个端口**,没有"DO 端口"这种东西。

### 3.2 并发控制:从内存版本检查改为条件写

**现状机制**(`editor-do.ts:474,482`):

```js
if (body.baseVersion !== this.#version) return 409;   // ① 检查
const newDoc = await config.apply(body.operations, this.#doc);
const newVersion = await this.#getNextVersion();      // ② 读 MAX(version)+1
this.#ctx.storage.sql.exec(`INSERT INTO deltas ...`); // ③ 写入
```

① 与 ③ 之间有多个 `await`,JS 会让出控制权。正确性依赖两层保护:Cloudflare 保证全局只有一个 Editor DO 实例处理该文档,`#requestTail` 保证该实例内请求不交叉。去掉任一层都会出现"两个请求都读到 version=5,都写 version=6,先写的编辑丢失且双方都收到成功"的竞态。

Azure 侧代码运行在 N 个无状态副本中,两层保护都不存在。

**新机制**:取消内存版本检查,由 `server-core` 显式计算 `nextVersion = baseVersion + 1`,直接条件写入 delta 日志:

```sql
INSERT INTO deltas (doc_type, doc_id, version, timestamp, description, operations)
VALUES ($1, $2, $3, $4, $5, $6)
-- PRIMARY KEY (doc_type, doc_id, version) —— 主键冲突即 409
```

检查与写入合并为一个原子操作,中间没有可乘之隙,副本数量无关紧要。

**为什么这比现状更严格**:现状的正确性依赖"排队逻辑写对了"这一运行时性质;新机制的正确性由数据库约束保证,代码写错也破坏不了。

**为什么 Cloudflare 侧也改**:DO 的 `deltas.version` 已经是 PRIMARY KEY,同一条语句在 SQLite 与 Postgres 上语义一致。两边跑同一套逻辑,避免维护两份并发模型。相应地,`#getNextVersion()`(读 `MAX(version)+1`,`editor-do.ts:202`)与 `AUTOINCREMENT`(`editor-do.ts:154`)一并移除 —— version 由调用方显式给出。

**`#requestTail` 的去留**:Cloudflare 侧保留,但降级为纯性能优化(避免同文档请求互相重复 replay),正确性不再依赖它。Azure 侧不需要。

**行为差异**(可接受):现状下并发的第二个请求会排队干等第一个跑完再拿 409;新机制下两个请求并行执行各自的 `config.apply()`,在写入时分胜负。可选优化:入口处先读一次 `DeltaLog.head()`,不匹配直接 409,省掉文档解析开销 —— 这只是快速失败,正确性仍由主键约束兜底。

### 3.3 用户级 CAS:客户端一份实现,服务端本轮不动

CAS 分两层,两层的处置完全不同:

**内核 `@unidocs/cas`** —— 已经是云中立的叶节点(`package.json` 只依赖 typescript/vitest,`src/` 对 `D1Database`/`R2Bucket`/`DurableObject` 零引用)。二进制格式、digest、校验、类型全在这层。**不动。**

**服务端 `packages/cloudflare-cas`** —— 100% 绑死 Cloudflare(`cas/do.ts` 587 行,29 处直接打 D1/R2/DO)。它的串行化需求与文档不同:lease 申领 vs GC 删除决策是"读—判断—删"三步,3.2 的条件写替代不了,Azure 侧需要 Postgres advisory lock 或可串行化事务。**这是下一轮的工作**,本轮不做。

**客户端 `CasClient`** —— 这是本轮要动的部分。CAS 对消费者只暴露 7 条 HTTP:

```
GET  /users/{userId}/cas/nodes/{hash}/content
GET  /users/{userId}/cas/nodes/{hash}/metadata
POST /users/{userId}/cas/nodes/{hash}          # lease with content
POST /users/{userId}/cas/nodes/{hash}/lease    # 续期
GET  /users/{userId}/cas/usage
POST /users/{userId}/cas/gc
POST /_internal/root-refs                      # 仅 Editor,不对外
```

HTTP 客户端天生云中立,**不为它设第五个端口**。处置:

1. `CasClient` 从 `cloudflare-sdk` 移到 `server-core`,**只保留一份实现**;
2. `CasClientConfig` 的 `Fetcher`(唯一残留的 Cloudflare 类型)换成自定义窄接口 `{ fetch(input, init): Promise<Response> }`;
3. CF 侧注入 `{ fetcher: env.CAS_SERVICE, internalToken }`,Azure 侧注入 `{ baseUrl, authToken }` —— 现有的 `CasClientConfig` union 已经支持这两种形态,不需要新增分支。

**Azure 侧 CAS 的过渡形态**:docx 上 Azure 时,`baseUrl` 指向现有的 Cloudflare CAS worker,先把文档核心端到端跑通。这是**过渡态,不是终态** —— 它与"私有化部署时数据不出客户自己的云"这一目标冲突,下一轮的 `azure-cas` 落地后即废弃。markdown 不受影响,它的 `refsFromOp` 返回空,整条 CAS 路径是 no-op。

## 4. 架构

### 4.1 包结构

```
packages/core/              不变 —— DocumentType 契约 + CasReadContext
packages/cas/               不变 —— CAS 内核(云中立)
packages/doctype-*/         不变 —— 文档语义
packages/server-core/       新增 —— 版本/快照/回滚算法 + 四个端口定义 + HTTP 路由 + CasClient
packages/cloudflare-sdk/    退化为薄适配器(DO storage / R2 / D1)
packages/azure-sdk/         新增 —— 同样四个端口(Postgres / Blob)
packages/cloudflare-cas/    本轮不动 —— 下一轮拆出 azure 对应实现
packages/cloudflare-*/      worker.ts 复用 server-core 的路由
packages/azure-*/           新增 —— Node HTTP 入口,复用同一路由
```

`server-core` 不含任何 Cloudflare 或 Azure 类型,可脱离 Miniflare 单测。

### 4.2 端口定义

四个端口。实例在构造时即绑定 `(docType, docId, userId)`,因此接口签名中不出现这三个参数 —— Cloudflare 实现忽略它们(DO 天然按文档隔离),Azure 实现将其填入 SQL 的 WHERE / VALUES。

```ts
interface Delta {
  version: number;
  timestamp: number;
  description: string;
  operations: unknown[];
}

interface DeltaLog {                                  // CF: DO sqlite | Azure: Postgres
  append(d: Delta): Promise<void>;                    // 版本冲突时抛 VersionConflictError
  head(): Promise<number>;
  since(v: number): Promise<Delta[]>;
  remove(v: number): Promise<void>;                   // root-refs 失败时回滚刚写入的 delta
  latestSnapshotRef(atOrBefore?: number): Promise<{ version: number; hash: string } | null>;
  recordSnapshot(v: number, hash: string): Promise<void>;
}

interface SnapshotCache {                             // CF: DO storage | Azure: Blob
  get(): Promise<{ version: number; bytes: Uint8Array } | null>;
  put(v: number, bytes: Uint8Array): Promise<void>;
}

interface BlobCas {                                   // CF: R2(env.CAS) | Azure: Blob + If-None-Match
  putIfAbsent(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | null>;
}

interface DocIndex {                                  // CF: D1 | Azure: Postgres
  register(rec: DocRecord): Promise<void>;            // 文档实例侧
  touch(at: number): Promise<void>;                   // 文档实例侧
}

interface DocIndexQuery {                             // gateway 侧,不绑定单个文档
  list(userId: string, docType: string): Promise<DocRecord[]>;
}
```

`BlobCas` 指的是**文档快照 CAS**(`env.CAS`),不是用户级 CAS —— 后者见 3.3,不走端口。

`DocIndex` 与 `DocIndexQuery` 指向同一张表,但使用者不同:前者由文档实例写入,后者由 gateway 的 `listDocuments()` 读取。拆开是因为 gateway 不属于任何单个文档,拿不到构造时绑定的 `(docType, docId, userId)`。两者可由同一个适配器类实现。

`VersionConflictError` 由 `server-core` 定义,两套适配器负责把各自后端的唯一键冲突翻译成它。`server-core` 捕获后返回 409 并附带当前 `version`(保持现有响应格式)。

### 4.3 保留的不变量

以下性质在重构后必须原样保持:

- **delta 原子性**:`config.apply()` 全部成功或全部不生效,任何抛出都拒绝整批并返回 400,版本不动
- **apply 的完整写入顺序**(原设计漏了 CAS 两步,这是重构最易踩坏处):

  ```
  1. leaseOpRefs        —— 逐个 ref 调 CAS leaseExisting,失败返回 leaseFailure
  2. config.apply()     —— 内存计算,抛出即 400
  3. delta 写入         —— 真相来源;条件写,主键冲突即 409
  4. updateRootRefs     —— 失败则删除第 3 步的 delta 并返回 502
  5. 快照缓存写入
  6. 每 20 个 delta    —— BlobCas 写入 + 全局索引写入
  ```

  与 3.2 条件写的共存:第 3 步撞主键返回 409 时,第 1 步已申领的 lease 无害(lease 自然过期),第 4 步不执行。

- **崩溃语义**:快照最多落后一个 delta,绝不出现不一致
- **快照阈值**:`DELTA_THRESHOLD = 20`
- **回滚语义**:加载不晚于目标版本的最近快照 → replay → 追加一条合成 delta。版本只增不减
- **克隆编排**:在 worker 层完成,源文档 `/snapshot` 取 hash → 新文档 `/init_from_hash` 采纳;`/_internal/create` 明确拒绝 `sourceId`
- **查询线格式**:`encodeQueryValue` 的 `{$unidocs:{type:"bytes",base64}}` 包装与 `$unidocs` 键转义

### 4.4 HTTP 入口统一

`cloudflare-{markdown,docx}/src/worker.ts` 目前"设计上近乎相同"(CLAUDE.md 已注明改路由需同改两处)。重构中抽成 `server-core` 的纯函数:

```ts
function createDocTypeHandler(cfg): (req: Request) => Promise<Response>
function createGatewayHandler(cfg): (req: Request) => Promise<Response>
```

- Cloudflare 侧:`export default { fetch: handler }`
- Azure 侧:`http.createServer` → Web `Request` 的转换壳(Node 24 原生支持 Request/Response/FormData/crypto.subtle),约 30 行,所有服务共用

`createGatewayHandler` 必须带上现有的两条职责,不能只搬 doc-type 路由:

1. `/users/{userId}/docs/{docType}/*` → 查注册表 → 转发到 doc-type worker
2. `/users/{userId}/cas/*` → `isPublicCasRoute()` allowlist 校验 → 转发到 CAS(CF 侧走 `CAS_SERVICE`,Azure 侧走 URL)

这同时消除了"改路由要改两个文件"这一既有问题。

### 4.5 Azure 拓扑(本轮只落地本地等价物)

```
客户端 → [Front Door(可选)] → ACA: unidocs-gateway (external ingress)
                                    ↓ 内部 DNS
                             ACA: unidocs-markdown (internal ingress)
                             ACA: unidocs-docx     (internal ingress)
                                    ↓
                    PostgreSQL Flexible Server + Blob Storage
```

- 三个 Container App 均可 `minReplicas = 0`(不使用 Dapr Actor,因其不支持缩容到零)
- **注册表不需要额外服务**:gateway 的 `resolveWorkerUrl()` 已内置 `{TYPE}_WORKER_URL` 环境变量回退路径,Azure 侧直接指向 ACA 内部 FQDN(`http://unidocs-markdown.internal.<env>.azurecontainerapps.io`)。KV 的角色由平台 DNS 承担
- `INTERNAL_TOKEN` 存 Key Vault,经 ACA secret 引用 + Managed Identity 读取
- 数据库与存储账号的访问统一走 Managed Identity,不下发连接字符串密码
- CAS 暂不在此拓扑内 —— 本轮由 `CAS_BASE_URL` 指向 Cloudflare CAS worker(见 3.3)

**本轮实际落地的是它的本地等价物**:docker-compose 起 Postgres + Azurite,三个服务以 Node 进程运行。上述 Bicep / ACA / Key Vault / Managed Identity 属于下一轮。

## 5. 数据模型

### 5.1 PostgreSQL

```sql
CREATE TABLE deltas (
  doc_type    TEXT    NOT NULL,
  doc_id      TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  timestamp   BIGINT  NOT NULL,
  description TEXT,
  operations  JSONB   NOT NULL,
  PRIMARY KEY (doc_type, doc_id, version)     -- 并发控制的全部依据
);

CREATE TABLE doc_snapshots (
  doc_type  TEXT    NOT NULL,
  doc_id    TEXT    NOT NULL,
  version   INTEGER NOT NULL,
  hash      TEXT    NOT NULL,
  timestamp BIGINT  NOT NULL,
  PRIMARY KEY (doc_type, doc_id, version)
);

CREATE TABLE docs (
  doc_id     TEXT   NOT NULL,
  doc_type   TEXT   NOT NULL,
  owner_id   TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (doc_id, doc_type)
);
CREATE INDEX docs_owner_type_idx ON docs (owner_id, doc_type, updated_at DESC);
```

`doc_snapshots` 与 `docs` 的列与现有 D1 表保持一致,便于比对。Cloudflare 侧 DO sqlite 的 `deltas` / `snapshots` 表不含 `doc_type` / `doc_id` 列(DO 天然隔离),差异由适配器吸收。

CAS 的三张表(`cas_nodes` / `cas_edges` / `cas_root_ref_requests`)不在本轮范围,它们的 Postgres 版本随下一轮的 `azure-cas` 一起设计。

**建表方式变更(两边都改)**:现在 `editor-do.ts`、gateway 与 CAS worker 在请求路径里反复执行 `CREATE TABLE IF NOT EXISTS`,每次请求都付一次往返。改为显式迁移脚本:

- Azure:迁移脚本在部署时执行
- Cloudflare:D1 改用 `wrangler d1 migrations`;DO sqlite 的建表保留在 `#ensureLoaded()` 中(DO 首次加载本就只跑一次,且无法在部署时预建)
- CAS worker 的 `migrateCasSchema()` 本轮不动

这属于阶段 1 的范围 —— 它改变了 Cloudflare 侧的部署流程,需要在阶段 1 的验收中确认 D1 表结构未变。

### 5.2 Blob Storage

| 容器 | Blob 名 | 内容 | 写入方式 |
|---|---|---|---|
| `cas` | `{hash}` | 完整文档快照字节 | `If-None-Match: *`,已存在则视为成功(内容寻址,同 hash 同内容) |
| `snapshots` | `{docType}/{docId}/latest` | 最新快照字节,metadata 带 `version` | 无条件覆盖 |

此处的 `cas` 容器对应 `BlobCas` 端口,即文档快照 CAS,与用户级 CAS 无关。hash 沿用现有算法:SHA-256 取前 8 字节,16 位十六进制。

快照缓存允许被并发覆盖成较旧版本 —— 加载时以 metadata 中的 `version` 为准并 replay 其后的 delta,因此陈旧只影响速度,不影响正确性。这与现有"快照可能落后一个 delta"的不变量一致。

## 6. 分阶段实施

### 阶段 0 — 建立安全网(不改产品代码)

重构前必须先锁住当前行为。现有覆盖情况:

| 位置 | 覆盖 |
|---|---|
| `editor-do.ts`(671 行,重构主战场) | **0 个单元测试** |
| `cloudflare-sdk/tests/` | 2 个,覆盖 `query-value.ts` 与 `cas-client.ts` |
| `scripts/local-runtime.test.mjs` | 路由 / 注册表层面 |
| `tests/bootstrap/`(treespec) | 22 个 e2e,唯一真正覆盖 `editor-do` 的东西 |

e2e 的三个盲点恰好都在重构要动的位置:

1. `DELTA_THRESHOLD = 20` 的自动快照路径从未触发 —— 每条分支最多 2 次 apply,版本最高到 5
2. `conflict/spec.yaml` 的两个 curl 顺序执行,验证的是"陈旧 baseVersion 被拒"与"delta 原子性",**不是并发竞态**
3. `operator-do.ts` 零覆盖

以 `startLocalRuntime()`(进程内 Miniflare,不需要 Docker,已包含 CAS worker)为载体补充表征测试:

- 连续 apply 25 次 → 断言第 20 个 delta 处产生 BlobCas 对象与全局索引记录
- 重启运行时 → 断言从快照 + replay 恢复后版本与内容一致
- 并发发送两个 `baseVersion` 相同的 apply → 断言恰好一个成功、一个 409 —— **这是那把锁的验收标准,重构前后都必须通过**
- rollback 后的 replay、clone 走 hash 路径、export/import 往返
- **docx 带图片的 apply** → 断言 lease → apply → root-refs 顺序成立;并断言 `updateRootRefs` 失败时 delta 被删除、版本不变(注入失败的 CAS)

这批测试在阶段 2 会换后端重跑,是"两边行为一致"的同一套断言。

**验收**:新测试全绿;22 个 treespec e2e 全绿。

### 阶段 1 — 重构,不接触 Azure

1. 新建 `packages/server-core`,定义四个端口 + `VersionConflictError` + `Delta` 等类型
2. 将 `editor-do.ts` 的算法迁入 `server-core`,面向端口重写
3. `CasClient` 从 `cloudflare-sdk` 移入 `server-core`,`Fetcher` 换成自定义窄接口(3.3)
4. `apply` 的版本检查改为条件写(3.2);移除 `#getNextVersion()` 与 `AUTOINCREMENT`
5. 抽出 `createDocTypeHandler` / `createGatewayHandler`(含 CAS 代理路径),三个 worker.ts 改为复用
6. `cloudflare-sdk` 退化为四个端口的 DO / R2 / D1 实现
7. 为 `server-core` 补纯单元测试(此时已可脱离 Miniflare)

**验收**:阶段 0 全部测试通过 + 22 个 treespec e2e 通过,**且一个 spec 文件都不修改**。

### 阶段 2 — 本地 Azure 栈(markdown 优先)

1. `packages/azure-sdk`:四个端口的 Postgres / Blob 实现 + 迁移脚本
2. Node HTTP 入口壳 + `packages/azure-gateway`、`packages/azure-markdown`
3. 本地开发环境:docker-compose 起 Postgres + Azurite,新增独立的启动命令(不动 `pnpm dev`)
4. 阶段 0 的测试套参数化后端,对 Azure 栈重跑

**验收**:同一套行为测试在 Cloudflare 与本地 Azure 栈两个后端上均通过(markdown)。

### 阶段 3 — docx 上 Azure,CAS 走过渡形态

1. `packages/azure-docx`
2. `CAS_BASE_URL` 指向 Cloudflare CAS worker,打通 docx 图片路径
3. `tests/bootstrap/` treespec 增加指向本地 Azure 栈的运行方式

**验收**:docx 在本地 Azure 栈上跑通含图片的 apply。

### 阶段 4 — `azure-cas`(下一轮,不在本设计范围)

用户级 CAS 的 Postgres / Blob 实现,含 lease vs GC 的串行化机制(Postgres advisory lock 或可串行化事务)。届时废弃阶段 3 的跨云过渡形态。

## 7. 测试策略

- **纯逻辑**:`server-core` 的版本推进、快照阈值、回滚 replay —— 普通 vitest 单测,无运行时依赖
- **端口契约**:一套共享的契约测试,`cloudflare-sdk` 与 `azure-sdk` 的实现都必须通过,保证两边语义一致
- **集成**:`startLocalRuntime()`(Miniflare)与 docker-compose(Postgres + Azurite)两套,跑同一批断言
- **端到端**:`tests/bootstrap/` treespec 保持不变,新增本地 Azure 栈运行方式

`scripts/doc-types.mjs` 的无依赖约定保持不变;新增 doc type 的步骤(CLAUDE.md 第 4 步)在阶段 2 后需要补充 Azure 侧的对应条目。

## 8. 风险与未决事项

| 项 | 说明 | 处置 |
|---|---|---|
| 重构回归 | `editor-do.ts` 无单测,改动面大 | 阶段 0 先补表征测试;阶段 1 不许改 e2e spec |
| main 移动快 | 8-18 至 8-20 两天内 main 前进 17 个提交,重构期间可能有并发改动 | 阶段 1 尽量短;开工前 rebase,`editor-do.ts` 有他人改动时先合并再继续 |
| 跨云过渡态 | 阶段 3 的 docx 依赖 Cloudflare 的 CAS | 明确标注为过渡态;阶段 4 废弃。私有化部署在阶段 4 前不可交付 |
| 冷启动开销 | 失去 DO 常驻内存,每次冷请求需 load 快照 + replay。docx 要过 `@ariadng/office` 解 zip | 按 `(docId, version)` 做进程内 LRU,但以 `DeltaLog.head()` 校验,正确性不依赖缓存 |
| 成本 | Postgres 常驻是主要成本项,ACA 可缩容到零 | 本轮不涉及;下一轮起步用 Burstable 层 |
| 本地开发变重 | 现在 `pnpm dev` 一个 Miniflare 进程,Azure 侧需 Postgres + Azurite 两个容器 | 保持 `pnpm dev` 走 Miniflare 不变,新增独立的 Azure 本地命令 |
| Operator 未覆盖 | `llmProvider` / `getEditorStub` 均为 stub | 本轮不处理,`operator-do.ts` 按同样方式迁入 `server-core` 但不新增功能 |
| Azure 中国区 | 若未来需要世纪互联版本,服务清单与 API 版本存在差异 | 本设计按 Azure 全球版;端口抽象使后续适配局限在 `azure-sdk` |
