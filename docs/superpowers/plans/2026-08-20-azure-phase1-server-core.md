# 阶段 1:抽出 server-core 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `editor-do.ts` 里的版本/快照/回滚算法与 HTTP 路由迁进云中立的 `packages/server-core`,面向四个存储端口重写,使 `cloudflare-sdk` 退化为薄适配器 —— 为阶段 2 的 Azure 实现留出接口,且 Cloudflare 侧行为逐字不变。

**Architecture:** `server-core` 定义四个端口(`DeltaLog` / `SnapshotCache` / `BlobCas` / `DocIndex`)与一个 `DocumentSession` 类,后者持有全部算法但不认识任何云。`cloudflare-sdk` 提供端口的 DO/R2/D1 实现,`editor-do.ts` 只剩"构造依赖 + HTTP 路由 + 错误映射"。并发控制从"内存版本检查"改为"delta 日志条件写",正确性由主键约束保证而非排队逻辑。

**Tech Stack:** TypeScript 5.9(composite project references)、vitest 3、Node 24、Cloudflare Workers/Durable Objects、Miniflare 4

## Global Constraints

- **验收铁律:阶段 0 的 49 个测试与 22 个 treespec spec 全部通过,且 `tests/` 下一个文件都不改。** `git diff --stat main -- tests/` 必须为空。这是判断"重构没改坏"的唯一客观依据。
- `scripts/*.test.mjs` 里的断言同样不许放宽。唯一允许的例外见下方"预期的假警报"。
- `packages/core` 与 `packages/cas` 不改动 —— 它们已经是云中立的。
- `packages/server-core` **不得 import 任何 Cloudflare 类型**:不得出现 `D1Database`、`R2Bucket`、`DurableObjectState`、`KVNamespace`、`Fetcher`,`tsconfig.json` 的 `types` 必须是 `[]`。只允许 Web 标准 API(`Request`/`Response`/`URL`/`crypto.subtle`/`FormData`)。
- `packages/cloudflare-cas` 本轮不动。用户级 CAS 的 Azure 实现是阶段 4 的事。
- 每个 Task 结束时 `pnpm test:local` 必须全绿才能提交。
- 提交信息用 conventional commits(`feat:` / `refactor:` / `test:` / `chore:`)。

### 预期的假警报(阶段 0 交接说明已预告)

`scripts/editor-characterization.test.mjs` 与 `scripts/editor-restart.test.mjs` 里的 `expect(...).toEqual([1, 21])`。

`21 = 1 + DELTA_THRESHOLD`,其中的 `1` 来自 `/_internal/create` 立即写一次全局快照 —— 那是实现细节,不是不变量。**本计划要求保持这个行为**(Task 5 明确保留 create 时的 `saveSnapshot()`),因此这两处断言应当继续通过。如果它们红了:先确认"两次快照的间隔是否仍等于 20"。是,说明 create 的立即快照被丢了,**去把它加回来**,不要改断言。否,才是真回归。

---

## File Structure

### 新增 `packages/server-core/src/`

| 文件 | 责任 |
|---|---|
| `ports.ts` | 四个端口接口 + `Delta` / `DocRecord` / `SnapshotRef` / `DocIdentity` 类型 |
| `errors.ts` | 错误分类:`VersionConflictError` / `DeltaRejectedError` / `DocNotFoundError` / `DocExistsError` / `RootRefsError` |
| `hash.ts` | `computeHash(bytes)` —— 从 `editor-do.ts:95` 迁出,SHA-256 取前 8 字节 |
| `query-value.ts` | 从 `cloudflare-sdk` 整文件迁入(纯逻辑,零改动) |
| `cas-client.ts` | 从 `cloudflare-sdk` 迁入,`Fetcher` 换成自定义窄接口 |
| `session.ts` | `DocumentSession` —— 版本推进、快照阈值、回滚 replay、克隆采纳。算法主体 |
| `memory-ports.ts` | 四个端口的内存实现,供纯单测与端口契约测试使用 |
| `port-contract.ts` | `runPortContract(name, factory)` —— 导出给阶段 2 的 `azure-sdk` 复用的契约测试套 |
| `doc-type-handler.ts` | `createDocTypeHandler` —— 两个 doc-type worker.ts 的公共路由 |
| `gateway-handler.ts` | `createGatewayHandler` —— gateway 路由 + CAS allowlist 代理 |
| `operator.ts` | `OperatorSession` —— 从 `operator-do.ts` 迁入的 ReAct 循环,不新增功能 |
| `index.ts` | 公开导出 |

### 修改 `packages/cloudflare-sdk/src/`

| 文件 | 变化 |
|---|---|
| `editor-do.ts` | 671 行 → 只剩"构造四个端口实现 + HTTP 路由 + 错误→状态码映射",算法全部委托 `DocumentSession` |
| `ports-cf.ts`(新增) | `DoDeltaLog` / `DoSnapshotCache` / `R2BlobCas` / `D1DocIndex` 四个 CF 实现 |
| `cas-client.ts` | 删除,改为从 `server-core` re-export(保持 `index.ts` 的对外导出不变) |
| `query-value.ts` | 同上 |
| `operator-do.ts` | 退化为 `OperatorSession` 的 DO 外壳 |

### 端口实现的验证策略(重要)

`runPortContract` 只在**能脱离 DO 运行的实现**上跑:内存实现(本轮)与 Postgres/Blob 实现(阶段 2)。**Cloudflare 的四个端口实现不跑契约测试** —— DO storage 只在 workerd 里存在,为它搭测试外壳的成本远高于收益,而它已经被阶段 0 的 49 个 e2e 全链路覆盖。这是有意的取舍,不是遗漏。

---

## Task 1: server-core 骨架与端口定义

**Files:**
- Create: `packages/server-core/package.json`、`tsconfig.json`、`src/ports.ts`、`src/errors.ts`、`src/hash.ts`、`src/memory-ports.ts`、`src/port-contract.ts`、`src/index.ts`、`tests/ports.test.ts`
- Modify: `tsconfig.json`(根,加 references)、`scripts/local-runtime.mjs`(加 workspace alias)

**Interfaces:**
- Produces:(后续每个 Task 都依赖这些名字,逐字使用)

```ts
export interface Delta {
  version: number;
  timestamp: number;
  description: string;
  operations: unknown[];
}

export interface SnapshotRef { version: number; hash: string }

export interface DocIdentity { docType: string; docId: string; userId: string }

export interface DocRecord {
  docId: string; docType: string; ownerId: string;
  createdAt: number; updatedAt: number;
}

export interface DeltaLog {
  append(d: Delta): Promise<void>;          // 版本冲突抛 VersionConflictError
  head(): Promise<number>;                  // 无 delta 时返回 0
  since(v: number): Promise<Delta[]>;
  range(from?: number, to?: number): Promise<Delta[]>;
  remove(v: number): Promise<void>;
  latestSnapshotRef(atOrBefore?: number): Promise<SnapshotRef | null>;
  recordSnapshot(v: number, hash: string, timestamp: number): Promise<void>;
  countSince(v: number): Promise<number>;
}

export interface SnapshotCache {
  get(): Promise<{ version: number; bytes: Uint8Array } | null>;
  put(v: number, bytes: Uint8Array): Promise<void>;
}

export interface BlobCas {
  putIfAbsent(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | null>;
}

export interface DocIndex {
  register(rec: DocRecord): Promise<void>;
  touch(at: number): Promise<void>;
  recordSnapshot(version: number, hash: string, timestamp: number): Promise<void>;
}

export interface DocIndexQuery {
  list(userId: string, docType: string): Promise<DocRecord[]>;
}
```

**注意 `DeltaLog.recordSnapshot` 与 `DocIndex.recordSnapshot` 是两回事**,签名相同但落到不同的地方:前者写**每文档私有**的快照索引(CF 上是 DO sqlite 的 `snapshots` 表,rollback 靠它找最近快照),后者写**全局共享**的索引(CF 上是 D1 的 `snapshots` 表,给跨文档查询用)。现有代码在 `#saveSnapshot()` 里两处都写,迁移后仍然两处都写。别合并它们。

错误类(`errors.ts`),全部继承 `Error` 并带 `name`:

```ts
export class VersionConflictError extends Error {   // → HTTP 409,body 带当前 version
  constructor(readonly currentVersion: number, readonly attempted: number) { ... }
}
export class DeltaRejectedError extends Error {}    // → HTTP 400,config.apply 抛出
export class DocNotFoundError extends Error {}      // → HTTP 404
export class DocExistsError extends Error {}        // → HTTP 409
export class RootRefsError extends Error {}         // → HTTP 502
```

- [ ] **Step 1: 建包**

`packages/server-core/package.json` 照抄 `packages/cas/package.json` 的结构,改 `name` 为 `@unidocs/server-core`、`description` 为 `Cloud-neutral document session core for UniDocs`。依赖只有 `devDependencies`:`typescript ^5.9.0`、`vitest ^3.2.0`。

`packages/server-core/tsconfig.json` 照抄 `packages/core/tsconfig.json`(注意 `"types": []`,这是"禁止 Cloudflare 类型"的机器保障),并加 `references` 指向 `../core` 与 `../cas`。

- [ ] **Step 2: 写端口与错误定义**

按上面 **Interfaces** 块逐字创建 `src/ports.ts` 与 `src/errors.ts`。`src/hash.ts` 把 `packages/cloudflare-sdk/src/editor-do.ts:95` 的 `computeHash` 原样搬过来并导出。`src/index.ts` 导出这三个模块的全部公开符号。

- [ ] **Step 3: 写内存实现**

`src/memory-ports.ts` 导出 `createMemoryPorts(): { deltas, snapshots, blobs, index, indexQuery }`。要点:

- `MemoryDeltaLog.append` 必须在 version 已存在时抛 `VersionConflictError(head(), d.version)` —— 这是模拟主键约束,后续所有并发测试都依赖它
- `head()` 空日志返回 `0`
- `countSince(v)` 返回 `version > v` 的条数
- `latestSnapshotRef(atOrBefore)` 返回不晚于该版本的最近快照,无则 `null`
- `MemoryBlobCas.putIfAbsent` 已存在同 hash 时静默成功(内容寻址)

- [ ] **Step 4: 写端口契约测试套**

`src/port-contract.ts` 导出:

```ts
export function runPortContract(
  label: string,
  factory: () => Promise<{ deltas: DeltaLog; snapshots: SnapshotCache; blobs: BlobCas }>,
): void
```

内部用 `describe(label, ...)` + `test(...)`(从 `vitest` import),覆盖:

1. 空日志 `head()` 为 0;append version 1 后为 1
2. 重复 append 同一 version → 抛 `VersionConflictError`,且 `err.currentVersion` 是当前 head
3. `since(v)` 只返回 version > v 且按升序
4. `range(from, to)` 边界包含两端;两个参数都省略时返回全部
5. `remove(v)` 后 `head()` 回落到前一个版本
6. `recordSnapshot` + `latestSnapshotRef()` 返回最新;`latestSnapshotRef(n)` 返回不晚于 n 的那个;早于所有快照时返回 `null`
7. `countSince(v)` 计数正确
8. `SnapshotCache` 空时 `get()` 为 `null`;`put` 后 `get` 返回同一 version 与字节
9. `BlobCas.putIfAbsent` 两次同 hash 不报错,`get` 返回字节;未知 hash 返回 `null`

- [ ] **Step 5: 让契约测试跑在内存实现上**

`packages/server-core/tests/ports.test.ts`:

```ts
import { runPortContract } from "../src/port-contract.js";
import { createMemoryPorts } from "../src/memory-ports.js";

runPortContract("memory ports", async () => createMemoryPorts());
```

Run: `pnpm --filter @unidocs/server-core test`
Expected: 9 个测试全部 PASS。

- [ ] **Step 6: 接进构建与本地运行时**

1. 根 `tsconfig.json` 的 `references` 数组加 `{ "path": "packages/server-core" }`。**顺带补上缺失的 `{ "path": "packages/cas" }`** —— 现在根 tsconfig 漏了它,`packages/cloudflare-sdk/tsconfig.json` 却引用了它。
2. `scripts/local-runtime.mjs` 的 `WORKSPACE_ALIASES` 加一行:
   `"@unidocs/server-core": join(ROOT, "packages/server-core/src/index.ts"),`

- [ ] **Step 7: 全量验证**

Run: `pnpm build && pnpm typecheck && pnpm test:local`
Expected: 构建与类型检查通过;`test:local` 仍是 7 文件 49 测试全绿(此时还没人使用 server-core)。

- [ ] **Step 8: 提交**

```bash
git add packages/server-core tsconfig.json scripts/local-runtime.mjs
git commit -m "feat(server-core): define storage ports and contract test suite"
```

---

## Task 2: 迁入纯逻辑模块(query-value 与 CasClient)

先搬不含算法的两个模块,把风险摊开。`cloudflare-sdk` 保留同名文件做 re-export,对外导出面逐字不变。

**Files:**
- Create: `packages/server-core/src/query-value.ts`、`src/cas-client.ts`、`packages/server-core/tests/query-value.test.ts`
- Modify: `packages/cloudflare-sdk/src/query-value.ts`、`src/cas-client.ts`(改为 re-export)、`src/index.ts`、`tsconfig.json`(references 加 `../server-core`)
- Delete: `packages/cloudflare-sdk/tests/query-value.test.ts`(随实现迁到 server-core)、`packages/cloudflare-sdk/tests/cas-client.test.ts`(同)

**Interfaces:**
- Consumes: Task 1 的 `@unidocs/server-core` 包
- Produces:

```ts
// server-core/src/cas-client.ts —— 替换掉 Cloudflare 的 Fetcher 类型
export interface HttpFetcher {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export type CasClientConfig =
  | { baseUrl: string; userId: string; authToken?: string }
  | { fetcher: HttpFetcher; userId: string; internalToken: string };

export class CasClient implements CasReadContext { /* 迁入,逻辑零改动 */ }
export class CasClientError extends Error { readonly status: number }
export function aggregateRefs<TOp>(ops, refsFromOp): CasReferences
export function leaseOpRefs<TOp>(ops, refsFromOp, cas): Promise<CasReferences>
export function commitRootRefsOrRollback(cas, requestId, changes, rollback): Promise<void>
```

- [ ] **Step 1: 整文件迁移 query-value**

`git mv packages/cloudflare-sdk/src/query-value.ts packages/server-core/src/query-value.ts`,内容零改动(它只用 `btoa`/`Uint8Array`,已经是云中立的)。测试同样 `git mv` 到 `packages/server-core/tests/query-value.test.ts`,改 import 路径为 `../src/query-value.js`。

- [ ] **Step 2: 迁移 CasClient 并去掉 Fetcher**

`git mv packages/cloudflare-sdk/src/cas-client.ts packages/server-core/src/cas-client.ts`,然后只做一处改动:在文件顶部加上面 **Interfaces** 里的 `HttpFetcher` 接口,把 `CasClientConfig` 里的 `Fetcher` 换成 `HttpFetcher`。**其余逻辑一行不动。** 测试 `git mv` 到 `packages/server-core/tests/cas-client.test.ts`,改 import 路径。

`Fetcher` 是结构化兼容的:Cloudflare 的 service binding 有 `fetch(input, init)`,直接赋给 `HttpFetcher` 类型的字段即可,调用方不需要断言。

- [ ] **Step 3: cloudflare-sdk 侧改为 re-export**

`packages/cloudflare-sdk/src/query-value.ts` 与 `src/cas-client.ts` 改为纯 re-export,例如:

```ts
export * from "@unidocs/server-core";
```

不要这样写 —— 会把无关符号也带出来。逐个具名 re-export:

```ts
// packages/cloudflare-sdk/src/cas-client.ts
export {
  CasClient,
  CasClientError,
  aggregateRefs,
  leaseOpRefs,
  commitRootRefsOrRollback,
} from "@unidocs/server-core";
export type { CasClientConfig, HttpFetcher } from "@unidocs/server-core";
```

`src/index.ts` 的对外导出**保持逐字不变**(它现在从 `./cas-client.js` 与 `./query-value.js` 导出,这两个文件仍在,只是内容变成了 re-export)。

`packages/cloudflare-sdk/tsconfig.json` 的 `references` 加 `{ "path": "../server-core" }`。

- [ ] **Step 4: 验证**

Run: `pnpm build && pnpm typecheck`
Expected: 通过。

Run: `pnpm --filter @unidocs/server-core test`
Expected: query-value 与 cas-client 的测试都在 server-core 下跑通。

Run: `pnpm test:local`
Expected: 7 文件 49 测试全绿。

- [ ] **Step 5: 提交**

```bash
git add -A packages/server-core packages/cloudflare-sdk
git commit -m "refactor(server-core): move query-value and CasClient out of the Cloudflare SDK"
```

---

## Task 3: DocumentSession —— 算法迁入并改为条件写

本计划的核心。把 `editor-do.ts` 里的算法搬进 `server-core`,面向端口重写,并**在新代码里直接采用条件写**(设计 3.2),不保留内存版本检查。

**Files:**
- Create: `packages/server-core/src/session.ts`、`packages/server-core/tests/session.test.ts`
- Modify: `packages/server-core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的端口与错误,Task 2 的 `CasClient`
- Produces:

```ts
export interface CasGateway extends CasReadContext {
  leaseExisting(hash: string): Promise<unknown>;
  updateRootRefs(update: { requestId: string; changes: CasReferences }): Promise<void>;
}

export interface SessionDeps {
  deltas: DeltaLog;
  snapshots: SnapshotCache;
  blobs: BlobCas;
  index: DocIndex;
  cas: CasGateway;
  identity: DocIdentity;
  now: () => number;        // 注入时钟,纯单测才能断言 timestamp
}

export const DELTA_THRESHOLD = 20;

export class DocumentSession<TDoc, TQuery, TOp> {
  constructor(config: DocumentType<TDoc, TQuery, TOp>, deps: SessionDeps);

  /** 从快照 + replay 重建内存状态。幂等,重复调用直接返回。 */
  load(): Promise<void>;

  get version(): number;
  get initialized(): boolean;

  create(input?: { bytes?: Uint8Array }): Promise<{ docId: string; version: number }>;
  initFromHash(hash: string, sourceVersion: number): Promise<{ docId: string; version: number }>;
  query(q: TQuery): Promise<{ data: WireQueryValue; version: number }>;
  apply(ops: readonly TOp[], description: string, baseVersion: number): Promise<{ version: number }>;
  history(from?: number, to?: number): Promise<HistoryEntry<TOp>[]>;
  rollback(target: number): Promise<{ version: number }>;
  snapshot(): Promise<{ hash: string; version: number; docType: string; docId: string }>;
  exportBytes(): Promise<{ bytes: Uint8Array; contentType: string }>;
}
```

`HistoryEntry` 从 `packages/cloudflare-sdk/src/history.ts` 整体迁入 `server-core`(该文件只有类型)。

- [ ] **Step 1: 写 apply 的失败路径单测(先红)**

`packages/server-core/tests/session.test.ts`,用 `createMemoryPorts()` 与一个极简的假 `DocumentType`(文档就是一个字符串,`apply` 遇到 `{kind:"boom"}` 就抛),覆盖:

1. `baseVersion` 与当前版本不符 → 抛 `VersionConflictError`,`currentVersion` 是当前 head,**delta 日志长度不变**
2. `config.apply` 抛出 → 抛 `DeltaRejectedError`,**delta 日志长度不变、版本不变、内存文档不变**(多操作批次:第一条成功、第二条抛)
3. `updateRootRefs` 抛出 → 抛 `RootRefsError`,且**刚写入的 delta 已被 remove**,`head()` 回到调用前的值
4. 两个 `apply` 用同一个 `baseVersion` **并发**(`Promise.allSettled`)→ 恰好一个 fulfilled、一个 rejected 且为 `VersionConflictError`

第 4 条是设计 3.2 的核心验收:它在纯内存里就能跑,不需要 Miniflare。

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm --filter @unidocs/server-core exec vitest run tests/session.test.ts`
Expected: FAIL —— `session.js` 不存在。

- [ ] **Step 3: 实现 DocumentSession**

从 `packages/cloudflare-sdk/src/editor-do.ts` 迁移,逐个方法对应:

| 源 | 目标 | 改动 |
|---|---|---|
| `#ensureLoaded()` (148-192) | `load()` | sqlite 建表语句删掉(端口负责);`storage.get(KEY_SNAPSHOT)` → `deps.snapshots.get()`;replay 查询 → `deps.deltas.since(v)` |
| `#saveSnapshotKV()` (196-201) | `#saveSnapshotCache()` | → `deps.snapshots.put(version, bytes)` |
| `#shouldSnapshot()` (207-220) | `#shouldSnapshot()` | → `deps.deltas.latestSnapshotRef()` + `deps.deltas.countSince(ref?.version ?? 0)` |
| `#saveSnapshot()` (222-260) | `#writeSnapshot()` | R2 put → `deps.blobs.putIfAbsent`;D1 两张表 → `deps.index.recordSnapshot` + `deps.index.touch`;本地 sqlite snapshots → `deps.deltas.recordSnapshot` |
| `/_internal/create` 分支 (282-343) | `create()` | HTTP 解析留在适配器,这里只收 `bytes?`。**保留创建时立即 `#writeSnapshot()` 的行为**(见 Global Constraints 的假警报说明) |
| `/_internal/init_from_hash` (346-417) | `initFromHash()` | R2 get → `deps.blobs.get`,取不到抛 `DocNotFoundError` |
| `/_internal/export` (418-428) | `exportBytes()` | 直接返回字节与 `config.contentType` |
| `/_internal/query` (430-437) | `query()` | 保留 `encodeQueryValue` |
| `/_internal/apply` (439-521) | `apply()` | **见下方写入顺序** |
| `/_internal/history` (523-552) | `history()` | → `deps.deltas.range(from, to)` |
| `/_internal/rollback` (556-641) | `rollback()` | 快照加载 → `deps.deltas.latestSnapshotRef(target)` + `deps.blobs.get(hash)`;replay → `deps.deltas.range(baseVersion + 1, target)` |
| `/_internal/snapshot` (645-663) | `snapshot()` | 同 `#writeSnapshot()` 后返回 hash |

`apply()` 的写入顺序**必须逐字保持**(设计 4.3):

```
1. refs = leaseOpRefs(ops, config.refsFromOp, deps.cas)   —— 失败原样抛出,由适配器映射状态码
2. newDoc = await config.apply(ops, doc, ctx)             —— 抛出则包成 DeltaRejectedError,不写任何东西
3. nextVersion = baseVersion + 1
   await deps.deltas.append({version: nextVersion, ...})  —— 冲突时端口抛 VersionConflictError,直接向上抛
4. commitRootRefsOrRollback(deps.cas, `apply:${userId}:${docId}:${nextVersion}`, refs,
       () => deps.deltas.remove(nextVersion))             —— 失败则包成 RootRefsError
5. this.#doc = newDoc; this.#version = nextVersion
6. await this.#saveSnapshotCache()
7. if (await this.#shouldSnapshot()) await this.#writeSnapshot()
```

**不要保留** `#getNextVersion()`(读 `MAX(version)+1`)。版本号由调用方的 `baseVersion + 1` 决定,这是条件写的全部要点。

第 5 步必须在第 4 步**之后** —— 若 root-refs 失败,内存文档不能被污染。

`rollback()` 的合成 delta 版本号同样不能读 `MAX+1`:用 `await deps.deltas.head() + 1`,并且 append 冲突时向上抛(rollback 与 apply 并发时,让一个失败)。

- [ ] **Step 4: 补齐正常路径单测**

在同一个测试文件里继续追加:

5. `create()` → 版本 1、写了一条 "Document created" 的空 delta、`blobs` 里有快照、`index.register` 被调用
6. 连续 apply 21 次 → `deltas.latestSnapshotRef()` 的版本是 21(创建时快照 1,阈值 20)
7. `rollback(target)` → 加载不晚于 target 的快照 + replay,版本向前推进,历史保留全部 delta,合成 delta 的 `operations` 为 `[]`、`description` 为 `Rollback to version ${target}`
8. `load()` 从快照 + replay 重建:预置 snapshots 与 deltas,断言恢复后的版本与内容
9. `initFromHash()` → 版本 1、`description` 含源 hash 与 source version

- [ ] **Step 5: 运行,确认全绿**

Run: `pnpm --filter @unidocs/server-core exec vitest run tests/session.test.ts`
Expected: 9 个测试全部 PASS。

- [ ] **Step 6: 确认没有 Cloudflare 类型漏进来**

Run: `grep -rE "D1Database|R2Bucket|DurableObject|KVNamespace|Fetcher\b" packages/server-core/src/`
Expected: 无输出。

Run: `pnpm --filter @unidocs/server-core typecheck`
Expected: 通过(`types: []` 意味着如果引用了 Cloudflare 全局类型,这里就会报错)。

- [ ] **Step 7: 提交**

```bash
git add packages/server-core
git commit -m "feat(server-core): add DocumentSession with conditional-write concurrency"
```

---

## Task 4: Cloudflare 端口实现

**Files:**
- Create: `packages/cloudflare-sdk/src/ports-cf.ts`
- Modify: `packages/cloudflare-sdk/src/index.ts`(导出新类型)

**Interfaces:**
- Consumes: Task 1 的端口接口
- Produces:

```ts
export class DoDeltaLog implements DeltaLog {
  constructor(ctx: DurableObjectState);
  static ensureTables(ctx: DurableObjectState): void;   // 建表,由 DO 首次加载时调用
}
export class DoSnapshotCache implements SnapshotCache { constructor(ctx: DurableObjectState) }
export class R2BlobCas implements BlobCas { constructor(bucket: R2Bucket) }
export class D1DocIndex implements DocIndex {
  constructor(db: D1Database, identity: DocIdentity);
}
export class D1DocIndexQuery implements DocIndexQuery { constructor(db: D1Database) }
```

- [ ] **Step 1: 实现四个端口**

逐条对应现有 SQL,**语句本身不要改写**,只是换个位置:

- `DoDeltaLog.append` → `INSERT INTO deltas (version, timestamp, description, operations) VALUES (?,?,?,?)`。**捕获主键冲突**:workerd 的 sqlite 在 PK 重复时抛错,`catch` 后查一次 `head()` 并抛 `VersionConflictError(head, d.version)`。判定方式用 `String(err).includes("UNIQUE")` 或 `.includes("constraint")`,两者都匹配才安全 —— 实现时先写一个 append 重复版本的临时脚本确认真实错误文案,并把文案记进 report。
- `DoDeltaLog.ensureTables` → 把 `#ensureLoaded()` 里的两条 `CREATE TABLE IF NOT EXISTS` 搬来。**`deltas.version` 去掉 `AUTOINCREMENT`,保留 `INTEGER PRIMARY KEY`** —— 版本号现在由调用方给出。

  已存在的文档不受影响:`CREATE TABLE IF NOT EXISTS` 不会改动已建好的表,那些 DO 的 `deltas` 表会继续带着 `AUTOINCREMENT`。这没有问题 —— 我们现在总是显式给出 version,`AUTOINCREMENT` 只在 version 省略时才起作用,主键冲突检测两种表都一样。**不要为此写数据迁移**。
- `DoSnapshotCache` → `ctx.storage.get/put(KEY_SNAPSHOT)`,`KEY_SNAPSHOT` 常量保持 `"snapshot"` 不变(**改了会让现有文档读不到快照**)。
- `R2BlobCas.putIfAbsent` → `bucket.put(hash, bytes)`(R2 覆盖同 key 是幂等的,内容寻址下同 hash 同内容);`get` → `bucket.get(hash)` 后 `.bytes()`,不存在返回 `null`。
- `D1DocIndex` → 现有的 `INSERT OR REPLACE INTO snapshots`、`INSERT OR REPLACE INTO docs`、`UPDATE docs SET updated_at`。**建表语句暂时保留在这里**,Task 8 才改成 migrations。

- [ ] **Step 2: 验证类型**

Run: `pnpm --filter @unidocs/cloudflare-sdk typecheck`
Expected: 通过。此时还没有人使用这些类,不会改变任何运行时行为。

- [ ] **Step 3: 全量验证**

Run: `pnpm test:local`
Expected: 7 文件 49 测试全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/cloudflare-sdk
git commit -m "feat(cloudflare-sdk): implement server-core storage ports on DO/R2/D1"
```

---

## Task 5: editor-do 退化为适配器

**风险最高的一步。** 前四个 Task 都没有改变任何运行时行为;这一步才真正切换。

**Files:**
- Modify: `packages/cloudflare-sdk/src/editor-do.ts`(671 行 → 预计 200 行以内)
- Delete: `packages/cloudflare-sdk/src/history.ts`(类型已迁入 server-core,改为从 index.ts re-export)

**Interfaces:**
- Consumes: Task 3 的 `DocumentSession`、Task 4 的四个 CF 端口实现
- Produces: `createEditorDO(config)` 的签名与 `Env` 接口**逐字不变** —— 两个 doc-type worker 不需要改动

- [ ] **Step 1: 重写 editor-do.ts**

保留在 DO 里的只有四件事:

1. `#requestTail` 排队 —— **保留,但降级为性能优化**。在它上面加注释说明:正确性现在由 `DeltaLog.append` 的主键约束保证,这里只是避免同文档请求重复 replay。
2. 构造依赖:从 `ctx`/`env`/请求头拼出 `SessionDeps`。`docType`/`docId`/`userId` 仍然存在 DO storage 里(`KEY_DOC_TYPE`/`KEY_DOC_ID`/`KEY_USER_ID` 三个常量与值都不变),`create`/`init_from_hash` 时从请求头取并写入,其余请求从 storage 读。
3. HTTP 路由:8 个 `/_internal/*` 端点解析请求体 → 调 `DocumentSession` 的对应方法。
4. **错误 → 状态码映射**(集中一处):

```ts
VersionConflictError → 409  { success: false, version: err.currentVersion, error: ... }
DeltaRejectedError   → 400  { success: false, version: session.version, error: `Delta failed: ...` }
DocNotFoundError     → 404
DocExistsError       → 409  { success: false, error: "Document already exists" }
RootRefsError        → 502  { success: false, version: session.version, error: `CAS root-refs failed: ...` }
CasClientError       → 409/400/502(照抄现有 #leaseFailure 的三分支映射)
其他                  → 500
```

**响应体的字段与文案必须逐字保持** —— `scripts/cas-rollback.test.mjs` 断言 `error` 含 `CAS root-refs failed`,阶段 0 的原子性测试断言含 `Delta failed`,treespec 也断言了若干文案。改一个字都会红。

"文档未初始化"的守卫(现 `editor-do.ts:414`)保留,文案 `Document not initialized. POST /{docType}/ to create.` 不变。

- [ ] **Step 2: 逐个端点跑测试**

先跑最快的:

Run: `pnpm exec vitest run scripts/editor-characterization.test.mjs`
Expected: 7 passed。

红了先看错误文案与状态码 —— 90% 的失败会是映射写漏了某个分支。

- [ ] **Step 3: 全量验证**

Run: `pnpm test:local`
Expected: 7 文件 49 测试全绿。

Run: `pnpm build && pnpm typecheck`
Expected: 通过。

- [ ] **Step 4: 确认 treespec 未被触碰**

Run: `git status --short tests/`
Expected: 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-sdk
git commit -m "refactor(cloudflare-sdk): reduce EditorDO to a port adapter over DocumentSession"
```

---

## Task 6: 抽出 createDocTypeHandler

`packages/cloudflare-{markdown,docx}/src/worker.ts` 目前"设计上近乎相同",CLAUDE.md 明确写了改路由要同改两处。这一步消掉它。

**Files:**
- Create: `packages/server-core/src/doc-type-handler.ts`
- Modify: `packages/cloudflare-markdown/src/worker.ts`、`packages/cloudflare-docx/src/worker.ts`、两个包的 `tsconfig.json`(references 加 `../server-core`)、`packages/server-core/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface DocTypeHandlerConfig {
  docType: string;                                   // "markdown" | "docx"
  internalToken: string;
  editor: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
  operator: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
}

export function createDocTypeHandler(
  cfg: DocTypeHandlerConfig,
): (request: Request) => Promise<Response>;
```

`editor`/`operator` 的结构化类型刻意不写 `DurableObjectNamespace` —— server-core 不许 import Cloudflare 类型,而 CF 的 namespace 结构上兼容这个形状。

- [ ] **Step 1: 迁移路由逻辑**

把 `packages/cloudflare-docx/src/worker.ts:55-130` 的逻辑原样搬进 `createDocTypeHandler`:token 校验、路径解析 `["users", userId, docId?, method?]`、`EDITOR_METHODS` / `OPERATOR_METHODS` 集合、`X-Doc-Type`/`X-User-Id`/`X-Doc-Id` 头注入、`/_internal/{method}` 路径改写、创建时的 `X-Doc-Id` 生成(`crypto.randomUUID()`)。

`EDITOR_METHODS` 与 `OPERATOR_METHODS` 的成员逐字保持:
```
EDITOR_METHODS  = apply, query, export, history, rollback, snapshot, init_from_hash
OPERATOR_METHODS = run, reset
```

- [ ] **Step 2: 两个 worker.ts 改为调用它**

每个 `worker.ts` 只剩 DO 类导出 + 一个 `fetch` 委托,例如 docx:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "docx",
      internalToken: env.INTERNAL_TOKEN,
      editor: env.DOCX_EDITOR,
      operator: env.DOCX_OPERATOR,
    })(request);
  },
};
```

- [ ] **Step 3: 验证**

Run: `pnpm test:local`
Expected: 7 文件 49 测试全绿。

Run: `pnpm build && pnpm typecheck`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add packages/server-core packages/cloudflare-markdown packages/cloudflare-docx
git commit -m "refactor(server-core): share one HTTP handler across doc-type workers"
```

---

## Task 7: 抽出 createGatewayHandler

**Files:**
- Create: `packages/server-core/src/gateway-handler.ts`
- Modify: `packages/cloudflare-gateway/src/worker.ts`、其 `tsconfig.json`、`packages/server-core/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface GatewayHandlerConfig {
  internalToken: string;
  resolveWorkerUrl(docType: string): Promise<string | null>;
  casFetcher: HttpFetcher;                 // CF: env.CAS_SERVICE;Azure: URL 版
  docIndex: DocIndexQuery;
  isPublicCasRoute(method: string, pathname: string): boolean;
}

export function createGatewayHandler(
  cfg: GatewayHandlerConfig,
): (request: Request) => Promise<Response>;
```

`isPublicCasRoute` 作为参数注入,而不是让 server-core 依赖 `@unidocs/cloudflare-cas` —— 后者是 Cloudflare 包,server-core 不能依赖它。

- [ ] **Step 1: 迁移路由逻辑**

把 `packages/cloudflare-gateway/src/worker.ts` 的两条职责搬进来:

1. `/users/{userId}/cas/*` → `isPublicCasRoute` allowlist 校验 → 注入 `X-Internal-Token`/`X-User-Id` → `casFetcher.fetch`
2. `/users/{userId}/docs/{docType}/*` → `resolveWorkerUrl` → 转发;`docId` 缺省时 POST 转创建、GET 走 `docIndex.list()`

错误响应文案逐字保持,包括:
- `Use /users/{userId}/docs/{docType}/* or /users/{userId}/cas/* endpoints`
- `Unknown document type: ${docType}`
- `Unknown CAS endpoint`
- `Unknown endpoint: ${method}`

`scripts/local-runtime.test.mjs` 断言了第二条,`scripts/docx-image-e2e.test.mjs` 断言了第三条。

- [ ] **Step 2: gateway worker.ts 改为调用它**

`resolveWorkerUrl` 的实现(KV 查 `docType:{type}`,回退到 `{TYPE}_WORKER_URL` 环境变量)留在 gateway 包里,作为闭包传入。`docIndex` 传 Task 4 的 `D1DocIndexQuery`。`isPublicCasRoute` 仍从 `@unidocs/cloudflare-cas/public` import,在 gateway 包里 import 是合规的。

- [ ] **Step 3: 验证**

Run: `pnpm test:local`
Expected: 7 文件 49 测试全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/server-core packages/cloudflare-gateway
git commit -m "refactor(server-core): move gateway routing and CAS proxy into shared handler"
```

---

## Task 8: operator 迁入与 D1 migrations

两件收尾工作,都不改变行为。

**Files:**
- Create: `packages/server-core/src/operator.ts`、`migrations/0001_init.sql`
- Modify: `packages/cloudflare-sdk/src/operator-do.ts`、`packages/cloudflare-sdk/src/ports-cf.ts`、`wrangler.toml`、`scripts/local-runtime.mjs`

**Interfaces:**
- Produces: `OperatorSession`,承载现有 ReAct 循环(最多 10 次迭代、`query_`/`apply_` 前缀分派、记录 query 返回的 version 作为下次 apply 的 baseVersion、未 query 前拒绝写)。**不新增任何功能**,`llmProvider` 与 `getEditorStub` 保持抛异常的 stub。

- [ ] **Step 1: 迁移 operator**

把 `packages/cloudflare-sdk/src/operator-do.ts` 的循环逻辑搬进 `server-core/src/operator.ts`,`operator-do.ts` 只剩 DO 外壳(会话存内存、HTTP 路由 `/_internal/run` 与 `/_internal/reset`)。`createOperatorDO` 的签名与 `OperatorConfig` 类型不变。

- [ ] **Step 2: D1 建表改 migrations**

创建 `migrations/0001_init.sql`,内容是现在散落在代码里的两条建表语句(逐字复制,不要改列定义):

```sql
CREATE TABLE IF NOT EXISTS snapshots (hash TEXT NOT NULL, doc_type TEXT NOT NULL, doc_id TEXT NOT NULL, version INTEGER NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY (doc_type, doc_id, version));
CREATE TABLE IF NOT EXISTS docs (doc_id TEXT NOT NULL, doc_type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (doc_id, doc_type));
```

`wrangler.toml` 的 D1 配置加 `migrations_dir = "migrations"`。

从 `D1DocIndex` 里删掉请求路径上的 `CREATE TABLE IF NOT EXISTS` 调用。

**本地 Miniflare 需要单独处理**:`scripts/local-runtime.mjs` 在 `mf.ready` 之后、seed registry 的同时,对 `SNAPSHOTS_DB` 执行一次 `migrations/0001_init.sql`(读文件 + `db.exec` 逐条)。gateway 与 doc-type worker 共享这一个库,执行一次即可。

**注意**:`packages/cloudflare-cas` 的 `migrateCasSchema()` 本轮不动(设计 5.1 明确),它有自己的库 `CAS_DB`。

- [ ] **Step 3: 验证**

Run: `pnpm test:local`
Expected: 7 文件 49 测试全绿。**特别确认 `local-runtime.test.mjs` 里"从共享 D1 列出文档"那条仍然通过** —— 它依赖 `docs` 表存在,现在改由 migration 建表。

Run: `pnpm build && pnpm typecheck`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add packages/server-core packages/cloudflare-sdk migrations wrangler.toml scripts/local-runtime.mjs
git commit -m "refactor: move operator into server-core and create D1 tables via migrations"
```

---

## 阶段 1 完成判据

- [ ] `pnpm test:local` 全绿(7 文件 49 测试),且 `scripts/*.test.mjs` **一个断言都没改**
- [ ] `pnpm build && pnpm typecheck` 通过
- [ ] `git diff --stat main -- tests/` **输出为空** —— 22 个 treespec spec 一个都没改
- [ ] `grep -rE "D1Database|R2Bucket|DurableObject|KVNamespace" packages/server-core/src/` 无输出
- [ ] `packages/cloudflare-sdk/src/editor-do.ts` 不再包含 `#getNextVersion`,`deltas` 表不再有 `AUTOINCREMENT`
- [ ] `packages/cloudflare-{markdown,docx}/src/worker.ts` 不再各自持有一份路由逻辑

有 Docker 的话跑一次完整 treespec 作为兜底;没有则以上面第三条为准。

## 交给阶段 2 的东西

`server-core` 导出的 `runPortContract(label, factory)` 就是阶段 2 的验收工具:`azure-sdk` 的 Postgres/Blob 实现必须原样通过它。`DocumentSession` 与两个 handler 到阶段 2 时一行不用改,只是换一套端口实现注入。

---

## 阶段 2 交接说明

阶段 1 执行中发现的、会影响阶段 2 的事项。**开工前读这一节。**

### 1. 条件写的冲突分支目前零自动化覆盖(优先级最高)

`DoDeltaLog.append` 的冲突分支**没有任何自动化测试执行过**:

- `runPortContract` 只跑内存实现,五个 Cloudflare 端口类零覆盖;
- `scripts/editor-characterization.test.mjs` 那条并发 e2e 看起来在验它,**实际不是** —— `#requestTail` 把两个请求串行化,后到的那个在 `DocumentSession.apply()` 开头的 `head()` 快速失败处就返回 409 了,根本走不到条件插入。

整个阶段的立身之本目前只靠一次人工实证支撑(真实 workerd 下 `INSERT...SELECT...WHERE <false>` 的 `cursor.rowsWritten` 确为 0)。

**开工第一件事**:用 Miniflare 或 vitest-pool-workers 起一个 DO,把 `runPortContract` 跑到 `DoDeltaLog` / `DoSnapshotCache` / `R2BlobCas` / `D1DocIndex` / `D1DocIndexQuery` 上。契约测试套已通过 `@unidocs/server-core/port-contract` 子路径导出,可以直接 import。

### 2. 先抽 `createSessionHandler` 再写 Azure 入口

`editor-do.ts` 的 `#errorResponse` 是纯云中立的"类型化错误 → 状态码 + body 字段"映射,而它正是 49 个 e2e 与 22 个 treespec 逐字断言的东西。顺序反了就会有两份状态码表,漂移只是时间问题。

同理,`createDocTypeHandler` 的 `DoNamespaceLike`(`idFromName` / `get`)本质是"按名字路由到有状态实例",正是设计 3.1 说 Azure 没有的能力。设计 4.4 承诺的"两侧共用同一路由"目前只兑现了 Cloudflare 侧的去重。

### 3. 端口没有事务/工作单元概念

Azure 侧 `DeltaLog` 与 `DocIndex` 是同一个 Postgres 库,但端口把 `append` / `register` / `recordSnapshot` / `touch` 拆成四次独立 await。**`create()` 在 Postgres 上无法做成原子的**,只能沿用现在的补偿窗口。

设计文档没说这是有意取舍还是遗漏。开工前要定:要么给端口加一个可选的工作单元概念,要么明确接受补偿语义并写进设计。

### 4. `DocumentSession` 不得跨请求复用,除非宿主自己 revalidate

`apply()` 只比较 `head()` 与 `baseVersion`,从不比较 `head()` 与 `#version`;`load()` 被 `#loaded` 标志设成一次性。所以"session 存活期内 `#version === head()`"只在单写者或每请求新建 session 时成立。

设计第 8 节的冷启动缓解措施写着 Azure 要"按 `(docId, version)` 做进程内 LRU"—— 一旦复用 session,`baseVersion` 来自另一个副本的新版本,`head()` 检查会通过而 `#doc` 是旧的,ops 被应用到陈旧文档上,append 还会成功(version 算对了),最后往快照缓存里写进一份**打着正确版本号的错误字节**,全链路无处报错。

契约已写进 `DocumentSession` 的类注释。要做 LRU 就必须先实现 revalidate。

### 5. `runPortContract` 挡不住什么

- **同进程之外的竞态**:哨兵只抓同进程内的让出点。用进程内锁串行化 `append`、或对单连接跑契约而真实竞态在跨进程的实现,都能蒙混过关。**Azure 实现 review 时必须直接看建表语句有没有主键/唯一约束。**
- **`remove()` 的非条件性**:唯一那条 remove 哨兵是单线程的。Postgres 实现照抄 `DELETE WHERE version = $1` 会在多副本下直接产生空洞。
- **`touch()` 零覆盖**。
- **`putIfAbsent` 的两种语义**:内存实现真的"若存在则跳过",`R2BlobCas` 无条件覆盖。内容寻址下无害,但契约没写明允许哪种。
- **`SnapshotCache.put` 写入虚高版本号**:`load()` 会无条件信任缓存里的 version 并 `since(v)`,一个虚高的 version 会静默跳过真实 delta。

### 6. `DeltaLog.append` 的冲突检测在两朵云上机制不同

Cloudflare 侧靠条件插入 + `rowsWritten === 0`。Azure 侧要换 etag `If-Match` 或唯一键捕获 duplicate-key 来满足同一份契约。契约本身(只接受 `head + 1`、检查与插入必须原子)不变。

### 7. 身份 403 校验现在在 Cloudflare 适配器里

`editor-do.ts` 的 `#requireUser` 比对请求头 `X-User-Id` 与存储里的 owner。阶段 2 把路由搬进 `server-core` 时必须跟着搬 —— 否则 Azure 入口会重新丢掉它,而 Azure 没有 DO 名绑定,那边正是最需要它的地方。
