# 阶段 2:azure-sdk 与本地 Azure 栈 设计

日期:2026-08-20
状态:已确认,待实施

本文细化 [Azure 部署设计](./2026-08-20-azure-deployment-design.md) 第 6 章的阶段 2,并纳入阶段 1 执行中发现、原设计未覆盖的决策。

## 1. 目标与范围

**目标**:让 markdown 文档类型在本地 Azure 栈(Postgres + Azurite)上端到端跑通,并证明**同一套行为测试能跑通两个后端**。

**范围内**:
- `packages/azure-sdk` —— 四个存储端口的 Postgres/Blob 实现
- `packages/azure-gateway`、`packages/azure-markdown` —— Node HTTP 入口
- docker-compose 本地栈
- 阶段 1 交接说明里的两件前置工作(见 3.4、3.5)

**范围外**:
- docx(依赖用户级 CAS)—— 阶段 3
- 用户级 CAS 的 Azure 实现 —— 阶段 4
- Bicep / ACA / Key Vault / Managed Identity —— 真实云部署,下一轮
- treespec 的 22 个 spec 不动 —— 它们锁的是 Cloudflare 部署

**终点**:阶段 0 的 49 个行为测试在 Miniflare 与本地 Azure 栈上各跑一遍全绿;`runPortContract` 在内存、Cloudflare、Postgres/Blob 三套实现上全绿。

## 2. 为什么 Azure 侧需要不同的并发与原子性处理

Cloudflare 上每个文档对应一个 Durable Object 实例,平台保证全球唯一,实例自带私有 SQLite。三个客户端从三地发来的请求,最终汇聚到同一个实例并由 `#requestTail` 排成队 —— 这是阶段 1 之前"内存版本检查"能成立的**全部**原因。Worker 那一层从不提供串行化:同一个 isolate 内的请求在每个 `await` 处都会交错。

Azure 侧这个汇聚点不存在。N 个无状态副本平起平坐,同时读到 `version = 5`,同时想写 `version = 6`。因此正确性下沉到数据库:`DeltaLog.append` 只接受 `head + 1`,检查与插入必须在一条语句内完成(阶段 1 已完成的改造)。

**反过来**,Azure 得到了 Cloudflare 没有的东西:`deltas` 与 `docs` 是同一个 Postgres 库的两张表,一个事务就能绑住。Cloudflare 上真相在 DO 私有库、索引在 D1,是两个物理分离的服务,跨不了事务 —— 这是结构性的,DO 之间互相调用也解决不了(那只是 RPC,各写各的库,还多出死锁风险)。

本设计**使用** Azure 这个优势,见 3.1。

## 3. 设计决策

### 3.1 新增 `withTransaction` 端口能力

```ts
interface TransactionalPorts {
  deltas: DeltaLog;
  index: DocIndex;
}

// SessionDeps 新增。两边都必须实现 —— 不设可选,避免 server-core 里出现分支。
withTransaction<T>(fn: (tx: TransactionalPorts) => Promise<T>): Promise<T>;
```

- **Postgres 实现**:从池中取一条连接、`BEGIN`,把**绑定在该连接上**的 `deltas` / `index` 实例传给回调;回调正常返回 `COMMIT`,抛出 `ROLLBACK`。
- **Cloudflare 实现**:`fn({ deltas: this.deltas, index: this.index })`,直接执行,行为与现在一致。

只有 `create()` 与 `initFromHash()` 使用它,包住三次写:`append` → `register` → `recordSnapshot`。Blob 与快照缓存在库外,不进事务。

**已知的行为差异(有意接受)**:Cloudflare 上 `register()` 失败仍会留下"有 delta、不在列表里"的文档;Azure 上不会。契约测试中 `create()` 的故障注入用例按后端给出不同期望,其余用例两边一致。

**为什么不靠调整写入顺序绕开事务**:试过。把幂等的索引写在前、真相写在最后,任何中途失败都等于"文档还没创建",重试即可干净恢复 —— 但快照缓存卡住了这条路,见 3.2。

### 3.2 `load()` 增加 BlobCas 回退

**这是 3.1 写入顺序安全的前提,不是可选优化。**

现状:`load()` 只读 `SnapshotCache`,读不到就从 `config.init()` 的空文档重放 delta。而 `create()` 写的 version 1 delta 的 `operations` 是空数组 —— 所以**快照缓存一丢,导入的文件内容就永久丢失**。

这逼出一个死结:
- 缓存写在 delta **之前**:失败时内容不丢,但会造出"缓存说版本 1、日志里却没有"的状态。`load()` 无条件信任缓存版本号,于是 `#doc !== null` 使重建被 `DocExistsError` 拒绝,而 `apply(baseVersion=1)` 又被 `head()=0` 的快速失败拒绝 —— 文档永久卡死。
- 缓存写在 delta **之后**:不会卡死,但中途失败会丢内容。

**解法**:`load()` 在缓存为空时回退到 `latestSnapshotRef()` + `blobs.get(hash)` 再重放,与 `rollback()` 现有做法对称(阶段 1 的审查指出过这两者不对称)。

于是快照缓存**真正成为可丢的一层** —— 这正是端口契约声称的语义 —— 写入顺序可以改成:

```
1. blobs.putIfAbsent(hash, bytes)   —— 内容寻址,孤儿无害且可 GC
2. withTransaction(append v1 → register → recordSnapshot)
3. snapshots.put(version, bytes)    —— 纯缓存,尽力而为
```

失败模式:
- 第 1 步失败 → 什么都没写,重试完全正常
- 第 2 步失败 → 只剩一个可回收的孤儿 blob,重试完全正常
- 第 3 步失败 → `load()` 从 blob 回退,内容不丢

**顺带修好 Cloudflare 侧**:今天 CF 上 `register()` 失败会让上传内容丢失;有了 blob 回退,只剩"不在列表里"这一个后果。事务修不了 CF 的索引孤儿,但内容丢失这条被消掉了。

### 3.3 抽出 `createSessionHandler`

把 `editor-do.ts` 的 8 个 `/_internal/*` 路由解析与错误 → 状态码映射搬进 `server-core`:

```ts
function createSessionHandler<TDoc, TQuery, TOp>(cfg: {
  session: DocumentSession<TDoc, TQuery, TOp>;
  identity: DocIdentity;
}): (request: Request) => Promise<Response>;
```

`identity` 单独传入而不是从 session 上取,是因为 403 校验发生在把请求交给 session 之前。

`editor-do.ts` 只剩三件事:装配端口、`#requestTail` 排队、调 handler。

**为什么必须先于 Azure 入口**:`#errorResponse` 是纯云中立的"类型化错误 → 状态码 + body 字段"映射,而它正是 49 个 e2e 与 22 个 treespec 逐字断言的东西。顺序反了就会有两份状态码表,漂移只是时间问题。

身份 403 校验(比对请求头 `X-User-Id` 与存储里的 owner)一并搬过去 —— Azure 没有 DO 名绑定,那边更需要它。

### 3.4 给契约套件做体检:对 Cloudflare 端口跑 `runPortContract`

阶段 1 结束时,**条件写的冲突分支零自动化覆盖**:`runPortContract` 只跑内存实现;阶段 0 那条并发 e2e 看似在验它,实际被 `#requestTail` 串行化后在 `apply()` 入口的快速失败处就返回 409,走不到条件插入。整个机制只靠一次人工实证支撑。

做法:在 Miniflare 里起一个**测试专用的 DO 外壳**,暴露一组内部端点驱动端口方法,把 `runPortContract` 跑到 `DoDeltaLog` / `DoSnapshotCache` / `R2BlobCas` / `D1DocIndex` / `D1DocIndexQuery` 上。

**目的不是"再测一遍 Cloudflare",而是验证契约套件本身抓得住东西** —— 它连已知正确的实现都验不住的话,拿它验 Postgres 实现就是自欺欺人。

### 3.5 行为测试的存储断言需要后端无关

阶段 0 的测试直接调 `runtime.mf.getD1Database(...)` / `getR2Bucket(...)`,是 Miniflare 专有 API,无法指向 Postgres/Azurite。抽到一个小接口后面:

```ts
interface StorageProbe {
  snapshotIndex(docType: string, docId: string): Promise<SnapshotRef[]>;
  blobExists(hash: string): Promise<boolean>;
}
```

`startLocalRuntime()` 与新增的 `startAzureRuntime()` 各提供一份实现,测试只用 probe。同一批断言,换 runtime 跑第二遍。

## 4. 包结构

```
packages/azure-sdk/        四端口的 Postgres/Blob 实现 + withTransaction + 迁移执行器
packages/azure-gateway/    Node HTTP 入口,复用 createGatewayHandler
packages/azure-markdown/   Node HTTP 入口,复用 createDocTypeHandler + createSessionHandler
```

对称于现有的 `cloudflare-*`。新增包按仓库既定约定配置 `exports` 指向 `src/*.ts` + `publishConfig` 还原 `dist/*`(见 README 的 Workspace package resolution),否则递归测试会红。

**Node 入口壳**:`http.createServer` ↔ Web `Request`/`Response` 的转换,约 30 行,三个服务共用。Node 24 原生支持 `Request`/`Response`/`FormData`/`crypto.subtle`,因此 handler 一行不用改。

## 5. Postgres 与 Blob 的落地

### 5.1 条件写

```sql
INSERT INTO deltas (doc_type, doc_id, version, timestamp, description, operations)
SELECT $1,$2,$3,$4,$5,$6
WHERE (SELECT COALESCE(MAX(version),0) FROM deltas WHERE doc_type=$1 AND doc_id=$2) = $3 - 1
```

`rowCount === 0` 即冲突:重读 head,抛 `VersionConflictError(head, attempted)`。

主键 `(doc_type, doc_id, version)` 作为**结构性兜底** —— 即使上面这条被改坏,主键也不会让两个同版本写入都成功。阶段 1 的经验是:契约测试的并发哨兵只抓同进程内的让出点,真正的保证必须写在 schema 里。**Review 时直接看建表语句。**

`remove(v)` 同样带 head 条件:

```sql
DELETE FROM deltas WHERE doc_type=$1 AND doc_id=$2 AND version=$3
  AND version = (SELECT MAX(version) FROM deltas WHERE doc_type=$1 AND doc_id=$2)
```

非 head 时静默 no-op,不抛错 —— 它跑在已经失败的补偿分支上。

### 5.2 表结构

照 [Azure 部署设计](./2026-08-20-azure-deployment-design.md) 5.1 的 `deltas` / `doc_snapshots` / `docs` 三张表,逐字不改。

**迁移**:`packages/azure-sdk/migrations/*.sql` + 一个记账表 + 按文件名顺序执行的小执行器。容器启动时跑一次,测试 setup 里也跑一次。

### 5.3 Blob

| 容器 | Blob 名 | 写入方式 |
|---|---|---|
| `cas` | `{hash}` | `ifNoneMatch: "*"`,已存在(409/412)视为成功 |
| `snapshots` | `{docType}/{docId}/latest` | 无条件覆盖,version 存 metadata |

### 5.4 连接管理

进程级一个 `pg.Pool`。端口实例每请求构造、绑定 `(docType, docId, userId)`,共享连接池。`withTransaction` 从池中取一条连接、`BEGIN`,把绑在该连接上的端口实例传给回调 —— 事务内的所有语句必须走同一条连接,这是实现的核心约束。

## 6. 本地栈

docker-compose 起两个服务:

- `postgres:18`(本机已有该镜像)
- `mcr.microsoft.com/azure-storage/azurite`

三个应用作为 Node 进程运行。`pnpm dev` 保持走 Miniflare **不变**,新增独立的 Azure 本地命令。

依赖:`pg`、`@types/pg`、`@azure/storage-blob`(均已确认可从镜像源安装)。

## 7. 测试策略

| 层 | 跑什么 | 覆盖的实现 |
|---|---|---|
| 端口契约 | `runPortContract` | 内存、**Cloudflare(新增)**、**Postgres/Blob(新增)** |
| 纯逻辑 | `server-core` 现有单测 | 不变 |
| 行为 | 阶段 0 的 49 个 e2e | Miniflare + **本地 Azure 栈(新增)** |

treespec 的 22 个 spec 不动。

## 8. 实施顺序

前两项是阶段 1 的交接前置工作,排在最前 —— 不做就会在后面加倍偿还。

1. **契约套件体检**(3.4)—— 决定了后续所有验收能不能信
2. **抽 `createSessionHandler`**(3.3)—— 必须先于 Azure 入口
3. **`withTransaction` + `load()` blob 回退**(3.1、3.2)—— 两边都改,Cloudflare 行为不变
4. **`packages/azure-sdk`** —— 四端口实现 + 迁移,通过 `runPortContract`
5. **Node 入口壳 + `azure-gateway` + `azure-markdown`**
6. **docker-compose 本地栈 + 行为测试参数化**(3.5)

## 9. 风险

| 项 | 说明 | 处置 |
|---|---|---|
| 契约套件抓不住跨进程竞态 | 哨兵只抓同进程让出点。用进程内锁串行化、或对单连接跑契约的实现都能蒙混过关 | 主键约束是真正的保证;review 必须看建表语句(5.1) |
| `withTransaction` 在 CF 上是空实现 | 每加一个写路径都要判断"要不要进事务",而 CF 侧永远无差别 | 只有 `create`/`initFromHash` 用它;新增写路径时在 review 清单里显式过一遍 |
| session 跨请求复用 | `apply()` 不比较 `head()` 与 `#version`,复用陈旧 session 会写进"版本号正确但内容错误"的快照 | 阶段 1 已把契约写进类注释;本轮 Azure 入口**每请求新建 session**,不做 LRU |
| 行为测试改造面 | 存储断言抽 probe 会动到阶段 0 的测试文件 | 只改取数方式,断言值逐字不动;改完先在 Miniflare 上跑绿再接 Azure |
