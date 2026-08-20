# 阶段 2:azure-sdk 与本地 Azure 栈 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 markdown 在本地 Azure 栈(Postgres + Azurite)上端到端跑通,并证明同一套行为测试能跑通 Cloudflare 与 Azure 两个后端。

**Architecture:** `server-core` 已有的四个存储端口新增 `withTransaction` 能力;`packages/azure-sdk` 提供 Postgres/Blob 实现;`editor-do.ts` 的 HTTP 路由与错误映射抽进 `server-core` 供两侧复用;阶段 0 的行为测试把存储断言抽到后端无关的 probe 后面,换 runtime 跑第二遍。

**Tech Stack:** TypeScript 5.9、vitest 3、Node 24、Postgres 18(docker)、Azurite(docker)、`pg` 8.23、`@azure/storage-blob` 12.33、Miniflare 4

## Global Constraints

- **`packages/server-core` 与 `packages/azure-sdk` 不得 import 任何 Cloudflare 类型**(`D1Database`/`R2Bucket`/`DurableObjectState`/`KVNamespace`/`Fetcher`/`DurableObjectNamespace`)。两者的 `tsconfig.json` 用 `"types": []`、`lib: ["ES2024", "DOM"]` —— **不要为了编译改这两个字段**,阶段 1 遇到过一次需要 `DOM.Iterable`,最后改用 `.forEach()` 绕开了。
- **阶段 0 的 49 个行为测试断言值一个字都不许改。** 只允许把取数方式从 Miniflare 专有 API 换成 probe(Task 8)。`git diff --stat main -- tests/` 必须始终为空 —— treespec 的 22 个 spec 本轮完全不动。
- **新增包必须遵守仓库的 workspace 解析约定**:`main`/`types`/`exports` 指向 `src/*.ts`,并配 `publishConfig` 还原 `dist/*`(见 README 的 Workspace package resolution)。不这么做,它的第一个消费者就会让 `pnpm -r test` 变红。
- **`typecheck` 脚本用 `tsc -b`**,不是 `tsc --noEmit`(项目引用解析不了未构建的依赖)。
- `pnpm install` 在这台机器上必须带 `--registry=https://repo.huaweicloud.com/repository/npm`(公网 npm 被 SNI 拦截)。
- 清理构建产物时**同时删 `dist/` 与 `*.tsbuildinfo`** —— 只删 `dist` 会让 `tsc` 以为产物是最新的而跳过 emit,造成"构建成功却没有输出"的假象。
- 每个 Task 结束时 `pnpm -r test`(从零产物状态)与 `pnpm test:local` 必须全绿才能提交。
- 提交信息用 conventional commits。

---

## File Structure

### 新增

| 文件 | 责任 |
|---|---|
| `scripts/port-probe-worker.js` | Miniflare 用的测试专用 Worker:导出一个把五个 Cloudflare 端口暴露成 HTTP 的 DO |
| `scripts/cf-port-contract.test.mjs` | 用 HTTP 代理把 `runPortContract` 跑到 Cloudflare 端口实现上 |
| `packages/server-core/src/session-handler.ts` | `createSessionHandler` —— 8 个 `/_internal/*` 路由 + 错误映射 |
| `packages/azure-sdk/src/pool.ts` | `pg.Pool` 创建与 Blob 客户端创建 |
| `packages/azure-sdk/src/ports-pg.ts` | `PgDeltaLog` / `PgDocIndex` / `PgDocIndexQuery` / `PgUnitOfWork` |
| `packages/azure-sdk/src/ports-blob.ts` | `BlobCasStore` / `BlobSnapshotCache` |
| `packages/azure-sdk/migrations/0001_init.sql` | 三张表 |
| `packages/azure-sdk/src/migrate.ts` | 迁移执行器(记账表 + 按文件名顺序) |
| `packages/azure-sdk/src/http-shell.ts` | `http.createServer` ↔ Web `Request`/`Response` 转换 |
| `packages/azure-gateway/src/main.ts` | Node 入口,复用 `createGatewayHandler` |
| `packages/azure-markdown/src/main.ts` | Node 入口,复用 `createDocTypeHandler` + `createSessionHandler` |
| `docker-compose.azure.yml` | postgres:18 + azurite |
| `scripts/azure-runtime.mjs` | `startAzureRuntime()` —— 起容器、跑迁移、拉起三个 Node 进程 |

### 修改

| 文件 | 变化 |
|---|---|
| `packages/server-core/src/ports.ts` | 新增 `TransactionalPorts` 与 `UnitOfWork` |
| `packages/server-core/src/session.ts` | `load()` 加 blob 回退;`create()`/`initFromHash()` 改用事务与新写入序 |
| `packages/server-core/src/memory-ports.ts` | 内存版 `withTransaction` |
| `packages/server-core/src/testing/port-contract.ts` | 新增事务与 blob 回退相关的契约 |
| `packages/cloudflare-sdk/src/ports-cf.ts` | Cloudflare 版 `withTransaction`(直接执行) |
| `packages/cloudflare-sdk/src/editor-do.ts` | 路由与错误映射搬走,只剩装配 + 排队 + 调 handler |
| `scripts/editor-characterization.test.mjs` | 3 处存储断言改用 probe |
| `scripts/editor-restart.test.mjs` | 1 处存储断言改用 probe |
| `scripts/local-runtime.mjs` | 暴露 `storage` probe |

---

## Task 1: 给契约套件做体检 —— 对 Cloudflare 端口跑 runPortContract

阶段 1 结束时条件写的冲突分支**零自动化覆盖**:`runPortContract` 只跑内存实现;阶段 0 那条并发 e2e 被 `#requestTail` 串行化后,在 `apply()` 入口的快速失败处就返回 409,走不到条件插入。整个机制只靠一次人工实证支撑。

本任务的目的**不是"再测一遍 Cloudflare"**,而是验证契约套件本身抓得住东西 —— 它连已知正确的实现都验不住的话,拿它验 Postgres 就是自欺欺人。

**Files:**
- Create: `scripts/port-probe-worker.js`、`scripts/cf-port-contract.test.mjs`
- Modify: `package.json`(`scripts.test:local` 末尾追加新文件)

**Interfaces:**
- Consumes: `runPortContract(label, factory)` from `@unidocs/server-core/port-contract`;`DoDeltaLog` / `DoSnapshotCache` / `R2BlobCas` / `D1DocIndex` / `D1DocIndexQuery` from `packages/cloudflare-sdk/src/ports-cf.ts`
- Produces: 无(纯测试)

- [ ] **Step 1: 写探针 Worker**

`scripts/port-probe-worker.js` 导出一个 DO,把端口方法暴露成 HTTP。请求体形状 `{ port, method, args }`,响应 `{ ok, value }` 或 `{ ok: false, error }`。

要点:
- `port` 取值 `deltas` / `snapshots` / `blobs` / `index` / `indexQuery`
- 字节参数与返回值用 base64 传输(`Uint8Array` 过不了 JSON)
- **`VersionConflictError` 必须能穿过 HTTP 边界**:DO 侧捕获后返回 `{ ok:false, error:{ name:"VersionConflictError", currentVersion, attempted } }`
- DO 的 `#ensureTables` 等价物:首次请求时调 `DoDeltaLog.ensureTables(ctx)`
- `D1DocIndex` / `D1DocIndexQuery` 需要 `DocIdentity`,从请求头 `X-Doc-Type` / `X-Doc-Id` / `X-User-Id` 取

这个 Worker 只在测试里用,不进 `bundleTargets`,用 Miniflare 的内联 `script` 加载(参照 `scripts/doc-types.mjs` 里 `CAS_FAULT_SCRIPT` 的做法)。

- [ ] **Step 2: 写代理与测试文件**

`scripts/cf-port-contract.test.mjs`:启动一个只含探针 Worker 的 Miniflare 实例,构造五个实现端口接口的**代理对象**(每个方法 POST 到探针 DO),把它们喂给 `runPortContract`。

**关键**:`factory()` 每次调用必须给出**全新的空状态** —— 契约测试假设从零开始。做法是每次 `factory()` 生成一个新的 `docId`(例如递增计数器),代理把它放进请求头,DO 用 `idFromName` 路由到一个全新实例。

代理收到 `{ ok:false, error:{ name:"VersionConflictError", ... } }` 时,必须**重新抛出真正的 `VersionConflictError`** —— 契约测试用 `rejects.toThrow(VersionConflictError)` 断言类型。

```js
runPortContract("cloudflare ports", async () => makeCfPorts(mf, nextDocId()));
```

- [ ] **Step 3: 运行,确认全绿**

Run: `pnpm exec vitest run scripts/cf-port-contract.test.mjs`
Expected: 18 条契约测试全部 PASS(与内存实现同样的条数)。

红了先看是不是代理没把错误类型还原,或者 `factory()` 没给出干净状态。

- [ ] **Step 4: 变异验证 —— 证明这套契约真的抓得住东西**

这一步是本任务的**核心价值**,不能跳过。

临时把 `packages/cloudflare-sdk/src/ports-cf.ts` 的 `DoDeltaLog.append` 从条件插入改成朴素的两步写法(先 `SELECT MAX(version)` 判断、再无条件 `INSERT`),重跑上面的测试,**确认并发哨兵那一条变红**。然后改回原样,确认恢复全绿。

红灯输出与恢复后的绿灯输出都要贴进报告。如果变异之后测试**仍然全绿**,说明契约套件在 Cloudflare 实现上是失效的 —— 那才是本任务真正要发现的东西,立刻停下来报告。

- [ ] **Step 5: 全量验证并提交**

Run: `pnpm test:local`
Expected: 8 文件全绿(原 7 个 + 新增 1 个)。

```bash
git add scripts/port-probe-worker.js scripts/cf-port-contract.test.mjs package.json
git commit -m "test(cloudflare-sdk): run the port contract against the Cloudflare implementations"
```

---

## Task 2: 抽出 createSessionHandler

`editor-do.ts` 的 `#errorResponse` 是纯云中立的"类型化错误 → 状态码 + body 字段"映射,而它正是 49 个 e2e 与 22 个 treespec 逐字断言的东西。**必须先于 Azure 入口抽出来**,否则会有两份状态码表,漂移只是时间问题。

**Files:**
- Create: `packages/server-core/src/session-handler.ts`
- Modify: `packages/cloudflare-sdk/src/editor-do.ts`、`packages/server-core/src/index.ts`

**Interfaces:**
- Produces:

```ts
export function createSessionHandler<TDoc, TQuery, TOp>(cfg: {
  session: DocumentSession<TDoc, TQuery, TOp>;
  identity: DocIdentity;
  /** 请求方声称的 userId;与 identity.userId 不符时返回 403。 */
  requesterId: string | null;
}): (request: Request) => Promise<Response>;
```

`identity` 与 `requesterId` 分开传,是因为 403 校验发生在把请求交给 session 之前。

- [ ] **Step 1: 迁移路由与错误映射**

把 `packages/cloudflare-sdk/src/editor-do.ts` 的这两段原样搬进新文件:

- `#errorResponse(err, version)`(约 217-259 行)—— 七个错误类的状态码与 body 字段
- `#handleRequest(request)`(约 285 行起)的 8 个端点分支 —— `create`、`init_from_hash`、`export`、`query`、`apply`、`history`、`rollback`、`snapshot`,以及"文档未初始化"守卫与 unknown-endpoint 兜底

`#requireUser` 的比对逻辑一并搬过去,改用 `requesterId` 参数。

**下列文案一个字都不能改**(有测试逐字断言):`Delta failed:`、`CAS root-refs failed:`、`Snapshot ${hash} not found in R2`、`Document already exists`、`Document not initialized. POST /{docType}/ to create.`、`Clone should be handled at worker level`、`Version N not found`、`Unknown endpoint: ${endpoint}`。

- [ ] **Step 2: editor-do.ts 改为调用它**

`editor-do.ts` 只剩三件事:装配端口构造 `DocumentSession`、`#requestTail` 排队、调 handler。`createEditorDO(config)` 的签名与 `Env` 接口**逐字不变**。

`#requestTail` 上方那段注释保留 —— 它说明了 `remove()` 的补偿动作仍依赖排队,阶段 2 之前不能去掉。

- [ ] **Step 3: 验证**

Run: `pnpm exec vitest run scripts/editor-characterization.test.mjs`
Expected: 7 passed。

Run: `pnpm test:local`
Expected: 8 文件全绿。

Run: `git status --short tests/`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add packages/server-core packages/cloudflare-sdk
git commit -m "refactor(server-core): move the editor HTTP routes and error mapping into a shared handler"
```

---

## Task 3: load() 增加 BlobCas 回退

**这是 Task 4 写入顺序安全的前提。**

现状:`load()` 在缓存为空时从 `config.init()` 的空文档重放。而 `create()` 写的 version 1 delta 的 `operations` 是空数组 —— 所以**快照缓存一丢,导入的文件内容就永久丢失**。

**Files:**
- Modify: `packages/server-core/src/session.ts`(`load()`,约 154-193 行)
- Test: `packages/server-core/tests/session.test.ts`

**Interfaces:**
- Consumes: `deps.deltas.latestSnapshotRef(atOrBefore?)`、`deps.blobs.get(hash)`(均已存在)
- Produces: 无接口变化

- [ ] **Step 1: 写失败的测试**

在 `packages/server-core/tests/session.test.ts` 追加:

预置一个"有 delta、有持久快照(blob + `recordSnapshot`)、但快照缓存为空"的存储状态,内容是非空文档;断言 `load()` 之后 `session.version` 与内容**与快照一致**,而不是空文档。

再加一条:快照缓存与持久快照**都**为空、只有 delta 时,行为与现在一致(从 `init()` 重放)—— 保证这次改动没有改掉既有路径。

- [ ] **Step 2: 运行,确认第一条失败**

Run: `pnpm --filter @unidocs/server-core exec vitest run tests/session.test.ts`
Expected: 新增的第一条 FAIL(拿到的是空文档),第二条 PASS。

- [ ] **Step 3: 实现回退**

`load()` 里,`snapshots.get()` 返回 `null` 时,在退回 `config.init()` **之前**先试持久快照:

```
ref = await deps.deltas.latestSnapshotRef()
if (ref) {
  bytes = await deps.blobs.get(ref.hash)
  if (bytes) { doc = await config.load(bytes, ctx); version = ref.version }
}
```

取不到 blob(或没有 ref)时才走现有的 `config.init()` + 从 0 重放。之后的 `since(version)` 重放逻辑不变。

保留现有那段解释"缓存是可丢的一层"的注释,并补一句说明持久快照才是兜底。

- [ ] **Step 4: 运行,确认全绿**

Run: `pnpm --filter @unidocs/server-core exec vitest run tests/session.test.ts`
Expected: 全部 PASS。

Run: `pnpm test:local`
Expected: 8 文件全绿 —— **特别注意 `editor-restart.test.mjs` 那条 rollback replay 测试**,它也走快照路径。

- [ ] **Step 5: 提交**

```bash
git add packages/server-core
git commit -m "fix(server-core): fall back to the durable snapshot when the cache is empty"
```

---

## Task 4: withTransaction 端口能力与新的创建写入序

**Files:**
- Modify: `packages/server-core/src/ports.ts`、`src/session.ts`、`src/memory-ports.ts`、`src/testing/port-contract.ts`、`packages/cloudflare-sdk/src/ports-cf.ts`、`packages/cloudflare-sdk/src/editor-do.ts`(装配处)、`scripts/cf-port-contract.test.mjs`(见 Step 4)
- Test: `packages/server-core/tests/session.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TransactionalPorts {
  deltas: DeltaLog;
  index: DocIndex;
}

export interface UnitOfWork {
  /**
   * 把回调里的写入作为一个原子单元执行。回调正常返回则提交,抛出则回滚。
   * 回调**必须**使用参数里的端口实例,不能用闭包外的 —— Postgres 实现靠
   * 这一点把所有语句绑到同一条连接上。
   */
  withTransaction<T>(fn: (tx: TransactionalPorts) => Promise<T>): Promise<T>;
}
```

`SessionDeps` 新增 `unitOfWork: UnitOfWork`。**必填,不设可选** —— 可选会在 `server-core` 里引出分支。

- [ ] **Step 1: 写失败的测试**

在 `packages/server-core/tests/session.test.ts` 追加两条:

1. 注入一个 `register()` 必抛的 `DocIndex`,断言 `create()` 抛出后 **delta 日志为空**(`head() === 0`)—— 事务回滚了。这条在内存实现上要成立,内存版 `withTransaction` 必须真的能回滚。
2. `create()` 成功后,断言 blob 里有快照对象、全局索引有 version 1 的记录、快照缓存有内容 —— 三者齐全。

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm --filter @unidocs/server-core exec vitest run tests/session.test.ts`
Expected: FAIL —— `unitOfWork` 未定义。

- [ ] **Step 3: 实现内存版事务**

`memory-ports.ts` 的 `withTransaction`:进入时对 `deltas` 与 `index` 的内部状态**做一份快照**,回调抛出时还原。这是内存实现能提供的最简单的真回滚,契约测试要靠它。

`createMemoryPorts()` 的返回值加上 `unitOfWork`。

- [ ] **Step 4: 实现 Cloudflare 版**

`ports-cf.ts` 新增:

```ts
export class DirectUnitOfWork implements UnitOfWork {
  constructor(private ports: TransactionalPorts) {}
  withTransaction<T>(fn: (tx: TransactionalPorts) => Promise<T>): Promise<T> {
    return fn(this.ports);
  }
}
```

注释里写明:Cloudflare 上真相在 DO 私有 sqlite、索引在 D1,是两个物理分离的服务,跨不了事务 —— 这是结构性的,不是没实现。

`editor-do.ts` 的装配处补上 `unitOfWork: new DirectUnitOfWork({ deltas, index })`。

**Task 1 建的 `scripts/cf-port-contract.test.mjs` 也要跟着改**:它的 `factory()` 现在必须在返回值里带上 `unitOfWork`(用 `DirectUnitOfWork` 包住那两个代理端口),否则类型对不上。调用处显式传 `{ transactional: false }`,并在注释里写明原因 —— Cloudflare 跨不了 DO sqlite 与 D1 的事务,这是结构性的。

- [ ] **Step 5: 改写创建路径的写入序**

`session.ts` 的 `create()` 与 `initFromHash()` 改成:

```
1. await this.#writeBlob()                 —— 内容寻址,孤儿无害且可 GC
2. await deps.unitOfWork.withTransaction(async (tx) => {
     await tx.deltas.append({ version: 1, ... })
     await tx.index.register({ ... })
     await tx.index.recordSnapshot(1, hash, timestamp)
   })
3. await this.#saveSnapshotCache()         —— 纯缓存,尽力而为
```

内存状态(`#doc` / `#version`)在第 2 步**成功之后**才提交 —— 与 `apply()` 同一条规则。

`register()` 仍必须在 `recordSnapshot()` 之前(阶段 1 的一条 Critical 修复,`DocIndex` 契约明文要求)。

- [ ] **Step 6: 给契约套件加事务测试**

`port-contract.ts` 新增两条:

1. `withTransaction` 内 `append` + `register` 后回调抛出 → `deltas.head()` 回到调用前的值,`indexQuery.list()` 里没有那条记录
2. `withTransaction` 正常返回 → 两者都可见

**注意**:Cloudflare 实现**不满足**第 1 条(它没有事务)。所以这两条要放进一个独立的、由 `factory` 标记是否支持事务来控制的分组:

```ts
export function runPortContract(
  label: string,
  factory: () => Promise<{ ...; unitOfWork: UnitOfWork }>,
  options: { transactional: boolean } = { transactional: false },
): void
```

`transactional: false` 时跳过这两条并在测试名里标注原因。内存与 Postgres 传 `true`,Cloudflare 传 `false`。

**这是本设计里唯一一处两边行为分叉,不要扩大它。**

- [ ] **Step 7: 运行,确认全绿**

Run: `pnpm --filter @unidocs/server-core test`
Expected: 全部 PASS。

Run: `pnpm exec vitest run scripts/cf-port-contract.test.mjs`
Expected: 全部 PASS(事务两条被跳过)。

Run: `pnpm test:local`
Expected: 8 文件全绿。

- [ ] **Step 8: 提交**

```bash
git add packages/server-core packages/cloudflare-sdk
git commit -m "feat(server-core): add the withTransaction port and make document creation atomic where the backend allows"
```

---

## Task 5: azure-sdk 骨架、迁移与本地容器

**Files:**
- Create: `packages/azure-sdk/package.json`、`tsconfig.json`、`src/pool.ts`、`src/migrate.ts`、`migrations/0001_init.sql`、`tests/migrate.test.ts`、`docker-compose.azure.yml`
- Modify: 根 `tsconfig.json`(references)、`package.json`(新增 azure 相关脚本)

**Interfaces:**
- Produces:

```ts
export interface AzureConfig {
  databaseUrl: string;      // postgres://...
  blobConnectionString: string;
}
export function createPool(cfg: AzureConfig): Pool;                     // pg.Pool
export function createBlobService(cfg: AzureConfig): BlobServiceClient;
export function runMigrations(pool: Pool): Promise<void>;               // 幂等
```

- [ ] **Step 1: 建包**

`packages/azure-sdk/package.json` 照 `packages/server-core/package.json` 的结构写:`exports` 指向 `src/index.ts`、配 `publishConfig` 还原 `dist`、`typecheck` 用 `tsc -b`。依赖 `pg@^8.23.0`、`@azure/storage-blob@^12.33.0`、`@unidocs/server-core`;devDependencies 加 `@types/pg`。

`tsconfig.json` 照 `packages/server-core/tsconfig.json`,`references` 指向 `../server-core`、`../core`。

根 `tsconfig.json` 的 `references` 加 `{ "path": "packages/azure-sdk" }`。

装依赖:`pnpm install --registry=https://repo.huaweicloud.com/repository/npm`

- [ ] **Step 2: 写建表 SQL**

`packages/azure-sdk/migrations/0001_init.sql` —— 三张表,**逐字照抄**设计文档 5.1 节(`docs/superpowers/specs/2026-08-20-azure-deployment-design.md`):`deltas`、`doc_snapshots`、`docs`,含 `docs_owner_type_idx` 索引。

`deltas` 的主键 `(doc_type, doc_id, version)` 是并发控制的结构性兜底,列定义不要改。

- [ ] **Step 3: 写 docker-compose**

`docker-compose.azure.yml`:

- `postgres:18`,库名 `unidocs`,用户/密码 `unidocs`/`unidocs`,端口映射到 **5433**(避开本机可能已有的 5432)
- `mcr.microsoft.com/azure-storage/azurite`,只起 blob 服务,端口 **10000**

两个服务都不挂持久卷 —— 测试环境每次起干净的。

- [ ] **Step 4: 写迁移执行器与它的测试**

`src/migrate.ts`:建一张 `schema_migrations(name TEXT PRIMARY KEY, applied_at BIGINT)` 记账表,读 `migrations/*.sql` 按文件名排序,跳过已记录的,其余在**一个事务里**执行并记账。

`tests/migrate.test.ts`:起容器(`docker compose -f docker-compose.azure.yml up -d`),连库,跑两次 `runMigrations`,断言第二次不报错且三张表存在。测试结束后 `down`。

这个测试需要 Docker,超时给 120 秒。

- [ ] **Step 5: 运行**

Run: `pnpm --filter @unidocs/azure-sdk test`
Expected: PASS。

- [ ] **Step 6: 全量验证并提交**

Run: `pnpm -r test`(先清 `dist` 与 `*.tsbuildinfo`)
Expected: 退出码 0。

```bash
git add packages/azure-sdk docker-compose.azure.yml tsconfig.json package.json pnpm-lock.yaml
git commit -m "feat(azure-sdk): add the package skeleton, schema migrations and the local container stack"
```

---

## Task 6: 四个端口的 Postgres/Blob 实现

**Files:**
- Create: `packages/azure-sdk/src/ports-pg.ts`、`src/ports-blob.ts`、`tests/ports.test.ts`
- Modify: `packages/azure-sdk/src/index.ts`

**Interfaces:**
- Consumes: `DeltaLog` / `SnapshotCache` / `BlobCas` / `DocIndex` / `DocIndexQuery` / `UnitOfWork` / `DocIdentity` from `@unidocs/server-core`
- Produces:

```ts
export class PgDeltaLog implements DeltaLog {
  constructor(q: Queryable, identity: DocIdentity);
}
export class PgDocIndex implements DocIndex { constructor(q: Queryable, identity: DocIdentity) }
export class PgDocIndexQuery implements DocIndexQuery { constructor(q: Queryable) }
export class PgUnitOfWork implements UnitOfWork { constructor(pool: Pool, identity: DocIdentity) }
export class BlobCasStore implements BlobCas { constructor(svc: BlobServiceClient) }
export class BlobSnapshotCache implements SnapshotCache {
  constructor(svc: BlobServiceClient, identity: DocIdentity);
}

/** pg.Pool 与 pg.PoolClient 的公共子集,让端口既能用池也能用事务连接。 */
type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };
```

- [ ] **Step 1: 实现 PgDeltaLog**

`append` 用条件插入:

```sql
INSERT INTO deltas (doc_type, doc_id, version, timestamp, description, operations)
SELECT $1,$2,$3,$4,$5,$6
WHERE (SELECT COALESCE(MAX(version),0) FROM deltas WHERE doc_type=$1 AND doc_id=$2) = $3 - 1
```

`rowCount === 0` 即冲突:重读 head,抛 `VersionConflictError(head, d.version)`。

`remove` 带 head 条件,非 head 时静默 no-op(不抛):

```sql
DELETE FROM deltas WHERE doc_type=$1 AND doc_id=$2 AND version=$3
  AND version = (SELECT MAX(version) FROM deltas WHERE doc_type=$1 AND doc_id=$2)
```

其余方法(`head`/`since`/`range`/`latestSnapshotRef`/`recordSnapshot`/`countSince`)按 `packages/cloudflare-sdk/src/ports-cf.ts` 里同名方法的语义直译成 SQL。`operations` 列是 `JSONB`,读出来已经是对象,不要再 `JSON.parse`。

- [ ] **Step 2: 实现 PgDocIndex / PgDocIndexQuery**

`register` 用 `INSERT ... ON CONFLICT (doc_id, doc_type) DO UPDATE`(幂等,契约要求 `register` 可重复调用)。

`list` **必须**带 `ORDER BY updated_at DESC` —— 契约明文要求,阶段 1 漏过一次。

`snapshots(docType, docId)` 按 version 升序。

- [ ] **Step 3: 实现 PgUnitOfWork**

从池里 `connect()` 一条连接,`BEGIN`,用**这条连接**构造新的 `PgDeltaLog` / `PgDocIndex` 传给回调,正常返回 `COMMIT`、抛出 `ROLLBACK`,`finally` 里 `release()`。

- [ ] **Step 4: 实现两个 Blob 端口**

`BlobCasStore.putIfAbsent`:上传时带 `conditions: { ifNoneMatch: "*" }`,捕获 `BlobAlreadyExists` / 409 / 412 视为成功。`get` 取不到返回 `null`。容器名 `cas`,blob 名就是 hash。

`BlobSnapshotCache`:容器 `snapshots`,blob 名 `{docType}/{docId}/latest`,无条件覆盖,version 存 metadata。`get()` 读 metadata 里的 version。

两个类都要在首次使用时 `createIfNotExists()` 容器。

- [ ] **Step 5: 跑契约测试**

`packages/azure-sdk/tests/ports.test.ts`:

```ts
runPortContract("postgres + blob ports", async () => makeAzurePorts(nextDocId()), { transactional: true });
```

`factory()` 每次用新的 `docId`,保证干净状态,返回值必须包含 `unitOfWork: new PgUnitOfWork(pool, identity)`。测试前起容器 + 跑迁移,结束后关闭池。

Run: `pnpm --filter @unidocs/azure-sdk test`
Expected: 全部契约测试 PASS(含事务两条)。

- [ ] **Step 6: 变异验证条件写**

和 Task 1 同样的手法:临时把 `PgDeltaLog.append` 改成 `SELECT MAX(version)` + 无条件 `INSERT` 两步写法,确认**并发哨兵变红**,再改回来。红灯与恢复后的绿灯输出都贴进报告。

这一步是 Postgres 实现能不能信的唯一证据。

- [ ] **Step 7: 提交**

```bash
git add packages/azure-sdk
git commit -m "feat(azure-sdk): implement the storage ports on Postgres and Blob Storage"
```

---

## Task 7: Node 入口壳与两个 Azure 服务

**Files:**
- Create: `packages/azure-sdk/src/http-shell.ts`、`packages/azure-gateway/**`、`packages/azure-markdown/**`
- Modify: 根 `tsconfig.json`(references)

**Interfaces:**
- Produces:

```ts
// azure-sdk
export function serve(
  handler: (req: Request) => Promise<Response>,
  opts: { port: number; host?: string },
): Promise<{ close(): Promise<void> }>;
```

- [ ] **Step 1: 写 HTTP 壳**

`http.createServer` 的请求转成 Web `Request`(方法、URL、头、body 流),把 handler 的 `Response` 写回。Node 24 原生支持 `Request`/`Response`/`FormData`,不需要 polyfill。

注意 body:`POST` 带 multipart 的创建请求要能正确透传,`Request` 的 body 用 `Readable.toWeb(req)`。

- [ ] **Step 2: azure-markdown**

`packages/azure-markdown/src/main.ts`:从环境变量读 `DATABASE_URL`、`BLOB_CONNECTION_STRING`、`INTERNAL_TOKEN`、`PORT`;建池与 Blob 客户端;用 `createDocTypeHandler` 处理路由,把 editor 端点转给 `createSessionHandler`。

**每请求新建 `DocumentSession`** —— 不做进程内 LRU。设计第 9 节的风险表写明了原因:`apply()` 不比较 `head()` 与 `#version`,复用陈旧 session 会写进"版本号正确但内容错误"的快照。

`createDocTypeHandler` 需要 `editor`/`operator` 两个"按名字取实例"的对象。Azure 侧没有 DO,所以这里传一个**本地适配器**:`idFromName` 直接返回名字字符串,`get(name)` 返回一个 `{ fetch }` 对象,内部用该文档的端口构造 session 并调 `createSessionHandler`。operator 端点本轮返回 501。

- [ ] **Step 3: azure-gateway**

`packages/azure-gateway/src/main.ts`:用 `createGatewayHandler`,`resolveWorkerUrl` 从环境变量 `{TYPE}_WORKER_URL` 读(设计 4.5 说明 Azure 侧用平台 DNS 代替 KV 注册表),`docIndex` 传 `PgDocIndexQuery`,`casFetcher` 本轮传一个所有请求都返回 501 的桩(CAS 是阶段 4),`isPublicCasRoute` 传一个恒 `false` 的函数。

- [ ] **Step 4: 验证两个服务能起来**

手工验证即可(自动化在 Task 8):起容器、跑迁移、`node packages/azure-markdown/dist/main.js` 与 gateway,用 curl 建一个文档、apply 一次、query 回来。命令与输出贴进报告。

- [ ] **Step 5: 提交**

```bash
git add packages/azure-sdk packages/azure-gateway packages/azure-markdown tsconfig.json pnpm-lock.yaml
git commit -m "feat(azure): add the Node HTTP shell and the gateway/markdown services"
```

---

## Task 8: 行为测试跑两个后端

**Files:**
- Create: `scripts/azure-runtime.mjs`、`scripts/azure-behavior.test.mjs`
- Modify: `scripts/local-runtime.mjs`、`scripts/editor-characterization.test.mjs`、`scripts/editor-restart.test.mjs`、`package.json`

**Interfaces:**
- Produces:

```ts
interface StorageProbe {
  snapshotIndex(docType: string, docId: string): Promise<SnapshotRef[]>;
  blobExists(hash: string): Promise<boolean>;
}
// 两个 runtime 的返回值都新增 storage: StorageProbe
export async function startAzureRuntime(opts?): Promise<{ urls: { gateway: string }, storage: StorageProbe, dispose(): Promise<void> }>
```

- [ ] **Step 1: 给 Miniflare runtime 加 probe**

`scripts/local-runtime.mjs` 的返回值加 `storage`,内部实现就是现在测试里那两行 `getD1Database` / `getR2Bucket`。

- [ ] **Step 2: 把三处存储断言改用 probe**

- `scripts/editor-characterization.test.mjs:86` 与 `:94`
- `scripts/editor-restart.test.mjs:120`

**只改取数方式,断言值逐字不动。** 例如 `[1, 21]` 仍然是 `[1, 21]`。

Run: `pnpm test:local`
Expected: 8 文件全绿 —— 改完先在 Miniflare 上确认没改坏,再往下走。

- [ ] **Step 3: 写 startAzureRuntime**

`scripts/azure-runtime.mjs`:`docker compose -f docker-compose.azure.yml up -d` → 轮询等 Postgres 可连 → 跑迁移 → `spawn` 起 gateway 与 markdown 两个 Node 进程 → 轮询等端口就绪 → 返回 `{ urls, storage, dispose }`。

`dispose()` 关进程 + `docker compose down -v`。

`storage` probe 用 `pg` 与 `@azure/storage-blob` 直接查。

- [ ] **Step 4: 让行为测试跑 Azure 后端**

`scripts/azure-behavior.test.mjs`:import `scripts/editor-characterization.test.mjs` 里那批测试**不可行**(vitest 文件是自包含的),所以把共享的测试体抽成一个导出函数:

新建 `scripts/behavior-suite.mjs`,导出 `runBehaviorSuite(getRuntime)`,内部用 `describe`/`test` 定义那 7 条 markdown 相关的行为测试(并发 409、快照阈值、delta 原子性、create 拒绝 sourceId、rollback、clone、export/import)。`editor-characterization.test.mjs` 改为调用它,`azure-behavior.test.mjs` 也调用它。

**断言值不变。** docx 相关的两个文件(`cas-rollback`、`docx-image-e2e`)本轮不进 Azure 套件 —— CAS 是阶段 4。

Run: `pnpm exec vitest run scripts/azure-behavior.test.mjs`
Expected: 7 条全绿。

红了先看是不是端口实现的语义差异,不要改断言 —— 断言是判据本身。

- [ ] **Step 5: 全量验证**

Run: `pnpm test:local`
Expected: 9 文件全绿。

Run: `pnpm -r test`(先清产物)
Expected: 退出码 0。

Run: `git diff --stat main -- tests/`
Expected: 输出为空。

- [ ] **Step 6: 提交**

```bash
git add scripts package.json
git commit -m "test: run the behavior suite against both the Miniflare and Azure backends"
```

---

## 阶段 2 完成判据

- [ ] `runPortContract` 在三套实现上全绿:内存、Cloudflare、Postgres/Blob
- [ ] **Cloudflare 与 Postgres 两侧的条件写都做过变异验证**(把 `append` 改成两步写法,并发哨兵必须变红)
- [ ] 阶段 0 的行为测试在 Miniflare 与本地 Azure 栈上各跑一遍全绿,**断言值一个字未改**
- [ ] `pnpm -r test` 从零产物状态退出码 0
- [ ] `git diff --stat main -- tests/` 输出为空
- [ ] `grep -rE "D1Database|R2Bucket|DurableObject|KVNamespace" packages/server-core/src/ packages/azure-sdk/src/` 无输出

## 交给阶段 3 的东西

docx 上 Azure 需要用户级 CAS。按设计,阶段 3 先让 `CAS_BASE_URL` 指向现有的 Cloudflare CAS worker 打通链路,阶段 4 再写 `azure-cas`。`CasClient` 已经是一份实现两边通用,届时只换 baseUrl。
