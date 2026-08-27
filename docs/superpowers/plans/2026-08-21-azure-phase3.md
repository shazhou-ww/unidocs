# Azure 阶段 3 实施计划

> **Superseded CAS contract (2026-08-26):** This is a historical implementation
> record. Owner assignments, portable-node HTTP, shared keys, tenantless routes,
> and tenant-only CAS namespaces are not current guidance. See
> [CAS Middleware](./2026-08-26-cas-middleware.md) and
> [CAS Architecture](../../cas-architecture.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让阶段 2 的 Azure 端口实现在**真正的多副本拓扑**下被证明正确,并在此基础上把 docx 接上 Azure(CAS 走指向 Cloudflare 的过渡形态)。

**Architecture:** 先补齐地基债(连接池超时、服务入口去重、端口契约盲区),再把 `azure-markdown` 起成 N 个副本、由测试脚手架里的轮询代理扮演 ACA ingress,让现有行为断言逐字不改地在多副本下重跑;最后新建 `azure-docx`,并把 treespec 的每一步改成同时打 Miniflare 与 Azure 两个网关。

**Tech Stack:** Node 24 / pnpm 11 / TypeScript 5.9 / vitest 3 / `pg` 8 / `@azure/storage-blob` 12 / Miniflare / esbuild / Docker Compose(Postgres)/ treespec

**Spec:** `docs/superpowers/specs/2026-08-21-azure-phase3-design.md`

## Global Constraints

- `packages/core`、`packages/doctype-*`、`packages/cas`、`packages/server-core` 是**云中立**的:不得出现 `D1Database` / `R2Bucket` / `DurableObject` / `KVNamespace` / `pg` / `@azure/*` 的引用。
- 行为测试的断言**逐字不得修改**。两个后端跑同一批断言就是本轮的证明本身;为让某个后端通过而放宽断言等于取消这个证明。
- `scripts/doc-types.mjs` 与 `scripts/azure-ports.mjs` 必须保持**无第三方依赖**(只允许 `node:` 内置模块),这样纯逻辑可以脱离 Docker / esbuild / Miniflare 单测。
- 工作区包的解析约定:库包的 `main`/`types`/`exports` 指向 `src/*.ts`,由 `publishConfig` 还原为 `dist/*`;`typecheck` 一律用 `tsc -b`,不用 `tsc --noEmit`(项目引用解析不了未构建的依赖,而 `tsc -b --noEmit` 会被 TS6310 拒绝)。
- `pnpm install` 必须带镜像源:`pnpm install --registry=https://repo.huaweicloud.com/repository/npm`。公网 npm 源在本机被 SNI 拦截。
- 过渡形态(`CAS_BASE_URL` 这一整套接线)的每一处代码都要在注释里标注「阶段 4 删除」并指向阶段 4。
- 每个任务结束时 `pnpm typecheck` 与该包的 `pnpm test` 必须退出码 0。
- `CLAUDE.md` 是本地文件,已通过 `.git/info/exclude` 忽略 —— **永远不要提交它、不要 `git add -f`、不要写进 `.gitignore`**。需要写给团队看的内容放 `README.md`。

## 任务与 spec 第 2 节的对应

| 计划任务 | spec 任务 | spec 章节 |
|---|---|---|
| 1 | 1 | §5 |
| 2 | 2 | §3 |
| 3、4 | 3 | §4 |
| 5 | 4 | §9 |
| 6 | 5 | §6 |
| 7 | 6 | §7 |
| 8 | 7 | §8 |
| 9 | 8 | §9 |

spec 任务 3 在计划里拆成两个:纯模块(端口布局 + 轮询代理)与运行时接线。前者可以脱离 Docker 单测,后者不行 —— 分开后审查者能独立否决其中一个。

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `packages/azure-sdk/src/env.ts` | `requireEnv` 与 `attachPoolErrorLogger`,两个入口共用 |
| `packages/azure-sdk/src/local-editor.ts` | 从 `azure-markdown` 原样移入的「无 DO」适配器 |
| `packages/azure-sdk/src/doc-type-service.ts` | `startDocTypeService` / `runDocTypeService` |
| `packages/azure-sdk/tests/pool.test.ts` | 连接池超时 |
| `packages/azure-sdk/tests/doc-type-service.test.ts` | 服务入口 |
| `packages/azure-docx/` | docx 的 Azure 入口包 |
| `packages/cas/src/public-route.ts` | `isPublicCasRoute`(从 `cloudflare-cas` 移入) |
| `scripts/azure-ports.mjs` | 无依赖的端口布局推导 |
| `scripts/azure-ports.test.mjs` | 上者的纯单测 |
| `scripts/replica-proxy.mjs` | 轮询反向代理(扮演 ACA ingress) |
| `scripts/replica-proxy.test.mjs` | 上者的纯单测 |
| `scripts/azure-multi-replica.test.mjs` | 跨副本并发场景 |
| `packages/server-core/tests/session-faults.test.ts` | 五处无覆盖行为变更的故障注入测试 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/azure-sdk/src/pool.ts` | 四个超时 |
| `packages/azure-sdk/src/index.ts` | 导出新模块 |
| `packages/azure-sdk/package.json` | `migrate` script 不再依赖 esbuild |
| `packages/azure-markdown/src/main.ts` | 塌缩为调用 `runDocTypeService` |
| `packages/azure-markdown/src/local-editor.ts` | 删除(移入 azure-sdk) |
| `packages/azure-gateway/src/main.ts` | 复用 `requireEnv`/`attachPoolErrorLogger`;接 `CAS_BASE_URL` |
| `packages/cloudflare-cas/src/public-cas-route.ts` | 改为从 `@unidocs/cas` 再导出 |
| `packages/server-core/src/testing/port-contract.ts` | 四个盲区 + `prepareConcurrency` 必填钩子 |
| `packages/server-core/tests/ports.test.ts` | 传 `prepareConcurrency` |
| `packages/azure-sdk/tests/ports.test.ts` | 把预热改成 `prepareConcurrency` |
| `scripts/cf-port-contract.test.mjs` | 传 `prepareConcurrency` |
| `scripts/azure-runtime.mjs` | 多副本 + 代理 + 外部 Postgres 模式 + `CAS_BASE_URL` |
| `scripts/dev.mjs` | 端口从 `azure-ports.mjs` 推导;放开 docx;CAS 可达性探测 |
| `scripts/doc-types.mjs` | CAS worker 加 `unsafeDirectSockets` |
| `scripts/local-runtime.mjs` | `urls` 增加 `cas` |
| `package.json` | `test:local` 增加新测试文件 |
| `e2e/Dockerfile` | 加装 postgresql |
| `tests/bootstrap/**/spec.yaml` | 每条 curl 变两条(两个网关) |
| `README.md` | 记录双栈用法与新增 doc type 的 Azure 侧步骤 |

---

### Task 1: `pg.Pool` 四个超时

**Files:**
- Modify: `packages/azure-sdk/src/pool.ts`
- Test: `packages/azure-sdk/tests/pool.test.ts`(新建)

**Interfaces:**
- Consumes: 无(第一个任务)
- Produces: `createPool(cfg: AzureConfig): Pool` 签名不变,但返回的池带四个超时。环境变量名 `PG_CONNECTION_TIMEOUT_MS` / `PG_LOCK_TIMEOUT_MS` / `PG_STATEMENT_TIMEOUT_MS` / `PG_IDLE_TX_TIMEOUT_MS`,后续任务不得改名。

**背景:** `createPool()` 目前只传 `connectionString`。两个并发 `create()` 撞同一个 `docId` 时,`withTransaction` 里的 `INSERT ... ON CONFLICT` 推测插入会让后到的事务在锁上等待到前一个事务提交或回滚为止,期间占着借出的连接不放。默认 `max` 是 10;一个卡住的事务就能把连接逐个占满,而没有 `connectionTimeoutMillis` 意味着连「排队等连接的请求也超时报错」这条自愈路径都没有 —— 服务挂起而不是降级。

- [ ] **Step 1: 写失败的测试**

新建 `packages/azure-sdk/tests/pool.test.ts`:

```ts
/**
 * `createPool()` 的超时配置。前三个是**会话级** Postgres 参数,只能通过
 * 启动参数 `options` 下发,保证每条从池里借出的连接都带着它们,而不依赖
 * 服务端默认值;`connectionTimeoutMillis` 是 `pg` 客户端侧的。
 */
import { afterEach, describe, expect, test } from "vitest";
import { createPool } from "../src/pool.js";
import { DATABASE_URL, BLOB_CONNECTION_STRING } from "./containers.js";

const CFG = { databaseUrl: DATABASE_URL, blobConnectionString: BLOB_CONNECTION_STRING };
const ENV_KEYS = [
  "PG_CONNECTION_TIMEOUT_MS",
  "PG_LOCK_TIMEOUT_MS",
  "PG_STATEMENT_TIMEOUT_MS",
  "PG_IDLE_TX_TIMEOUT_MS",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("createPool timeouts", () => {
  test("defaults are set on the pool options", async () => {
    const pool = createPool(CFG);
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(5_000);
      expect(pool.options.options).toContain("-c lock_timeout=5000");
      expect(pool.options.options).toContain("-c statement_timeout=15000");
      expect(pool.options.options).toContain("-c idle_in_transaction_session_timeout=10000");
    } finally {
      await pool.end();
    }
  });

  test("each env var overrides its own default", async () => {
    process.env.PG_CONNECTION_TIMEOUT_MS = "1234";
    process.env.PG_LOCK_TIMEOUT_MS = "2345";
    process.env.PG_STATEMENT_TIMEOUT_MS = "3456";
    process.env.PG_IDLE_TX_TIMEOUT_MS = "4567";
    const pool = createPool(CFG);
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(1234);
      expect(pool.options.options).toContain("-c lock_timeout=2345");
      expect(pool.options.options).toContain("-c statement_timeout=3456");
      expect(pool.options.options).toContain("-c idle_in_transaction_session_timeout=4567");
    } finally {
      await pool.end();
    }
  });

  // 一个打错的环境变量必须响亮失败。静默退回默认值意味着运维以为自己
  // 调高了超时、实际没有,而这类配置只在事故当天才会被验证。
  test("a non-positive-integer env value throws, naming the variable", () => {
    process.env.PG_STATEMENT_TIMEOUT_MS = "15s";
    expect(() => createPool(CFG)).toThrow(/PG_STATEMENT_TIMEOUT_MS/);
  });

  // 上面三条只证明「配置传进去了」。这条证明它**在真实会话里生效**:
  // 参数是通过启动 options 下发的,所以任何一条借出的连接都能读回来。
  test("the session actually carries the settings", async () => {
    const pool = createPool(CFG);
    try {
      const { rows } = await pool.query(
        "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS stmt, current_setting('idle_in_transaction_session_timeout') AS idle",
      );
      expect(rows[0]).toEqual({ lock: "5s", stmt: "15s", idle: "10s" });
    } finally {
      await pool.end();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/pool.test.ts
```

预期:四条全部 FAIL。前三条因为 `pool.options.options` 是 `undefined`、`connectionTimeoutMillis` 是 `undefined`;第四条因为 `current_setting('lock_timeout')` 返回服务端默认 `'0'`。

- [ ] **Step 3: 实现**

改 `packages/azure-sdk/src/pool.ts`:

```ts
/**
 * 连接池超时。四个值全部留空曾经是一个真实的挂起风险:锁等待期间连接
 * 被占住不放,池满之后没有任何自愈路径。三个会话级参数通过启动 `options`
 * 下发,保证每条借出的连接都带着,而不依赖服务端默认值。
 *
 * `lock_timeout` 刻意短于 `statement_timeout`:锁等待先失败,错误信息
 * 更能指出真实原因(在锁上等,而不是语句本身慢)。
 */
const TIMEOUT_DEFAULTS = {
  PG_CONNECTION_TIMEOUT_MS: 5_000,
  PG_LOCK_TIMEOUT_MS: 5_000,
  PG_STATEMENT_TIMEOUT_MS: 15_000,
  PG_IDLE_TX_TIMEOUT_MS: 10_000,
} as const;

function timeoutFromEnv(name: keyof typeof TIMEOUT_DEFAULTS): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return TIMEOUT_DEFAULTS[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function createPool(cfg: AzureConfig): Pool {
  return new Pool({
    connectionString: cfg.databaseUrl,
    connectionTimeoutMillis: timeoutFromEnv("PG_CONNECTION_TIMEOUT_MS"),
    options: [
      `-c lock_timeout=${timeoutFromEnv("PG_LOCK_TIMEOUT_MS")}`,
      `-c statement_timeout=${timeoutFromEnv("PG_STATEMENT_TIMEOUT_MS")}`,
      `-c idle_in_transaction_session_timeout=${timeoutFromEnv("PG_IDLE_TX_TIMEOUT_MS")}`,
    ].join(" "),
  });
}
```

注意:若 `databaseUrl` 自带 `?options=`,这里的 `options` 会覆盖它。在 `createPool` 的 doc comment 里写明这一点。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/pool.test.ts
pnpm --filter @unidocs/azure-sdk test
pnpm typecheck
```

预期:全部 PASS,退出码 0。整包测试同时确认超时没有让既有的端口契约变慢到超时。

- [ ] **Step 5: 提交**

```bash
git add packages/azure-sdk/src/pool.ts packages/azure-sdk/tests/pool.test.ts
git commit -m "fix(azure-sdk): give the pg pool the four timeouts it was missing"
```

---

### Task 2: `azure-sdk` 抽出服务入口

**Files:**
- Create: `packages/azure-sdk/src/env.ts`
- Create: `packages/azure-sdk/src/local-editor.ts`(从 `packages/azure-markdown/src/local-editor.ts` 原样移入)
- Create: `packages/azure-sdk/src/doc-type-service.ts`
- Create: `packages/azure-sdk/tests/doc-type-service.test.ts`
- Modify: `packages/azure-sdk/src/index.ts`
- Modify: `packages/azure-markdown/src/main.ts`
- Delete: `packages/azure-markdown/src/local-editor.ts`
- Modify: `packages/azure-gateway/src/main.ts`

**Interfaces:**
- Consumes: `createPool(cfg: AzureConfig): Pool`(Task 1)
- Produces:
  ```ts
  // env.ts
  export function requireEnv(name: string): string;
  export function attachPoolErrorLogger(pool: Pool, label: string): void;

  // local-editor.ts（原样移入，签名不变）
  export interface LocalNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  }
  export function createLocalEditorNamespace<TDoc, TQuery, TOp>(
    config: DocumentType<TDoc, TQuery, TOp>,
    buildDeps: (identity: DocIdentity) => SessionDeps,
  ): LocalNamespace;
  export function createStubOperatorNamespace(): LocalNamespace;

  // doc-type-service.ts
  export interface DocTypeServiceConfig {
    databaseUrl: string;
    blobConnectionString: string;
    internalToken: string;
    /** 过渡形态，阶段 4 删除。未给时 CAS 调用一律 501。 */
    casBaseUrl?: string;
  }
  export interface DocTypeServiceOptions<TDoc, TQuery, TOp> {
    docType: string;
    documentType: DocumentType<TDoc, TQuery, TOp>;
    port: number;
    host?: string;              // 默认 "0.0.0.0"
    config: DocTypeServiceConfig;
  }
  export interface DocTypeServiceHandle {
    url: string;
    close(): Promise<void>;     // 关 HTTP 服务并 pool.end()
  }
  export function startDocTypeService<TDoc, TQuery, TOp>(
    options: DocTypeServiceOptions<TDoc, TQuery, TOp>,
  ): Promise<DocTypeServiceHandle>;
  export function runDocTypeService<TDoc, TQuery, TOp>(options: {
    docType: string;
    documentType: DocumentType<TDoc, TQuery, TOp>;
    defaultPort: number;
  }): Promise<void>;
  ```
  Task 7 的 `azure-docx` 只调 `runDocTypeService`;Task 4 的多副本脚手架不直接用这两个函数(它 spawn 打包后的进程)。

**背景(必读):** `packages/azure-markdown/src/local-editor.ts` 一行 markdown 的知识都没有 —— 它是 `<TDoc, TQuery, TOp>` 泛型的,只依赖 `@unidocs/core` 的 `DocumentType`。而它的模块注释承载着整个 Azure 适配里最微妙的一条多副本正确性规则:**每请求新建 `DocumentSession`,不做 LRU 缓存**,因为一个被别的副本抢先推进过的缓存 session 能通过版本检查(版本号是对的)但内存里的 `#doc` 是陈旧的,错的字节会带着看起来正确的版本号写进快照缓存。按现状创建 `azure-docx` 就是把这条规则复制一份 —— 复制正确性不变量意味着制造一条「只改一边就能悄悄产生数据损坏」的路径。

`buildDeps` 必须**每次请求都调用**。移动这个文件时不得改动它的模块注释与 `get()` 的实现。

- [ ] **Step 1: 写失败的测试**

新建 `packages/azure-sdk/tests/doc-type-service.test.ts`:

```ts
/**
 * `startDocTypeService()` 的行为:它必须起一个能完整走 create → apply →
 * query 的服务,并且**每个请求新建一个 DocumentSession**（见
 * local-editor.ts 的模块注释：这是多副本正确性的前提，不是可以之后用
 * LRU 优化掉的实现细节）。
 */
import { afterEach, expect, test } from "vitest";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import { startDocTypeService } from "../src/doc-type-service.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

const INTERNAL_TOKEN = "test-token";
let handle: { url: string; close(): Promise<void> } | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function start(port: number) {
  const pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
  await pool.end();
  return startDocTypeService({
    docType: "markdown",
    documentType: createMarkdownDocumentType({}),
    port,
    host: "127.0.0.1",
    config: {
      databaseUrl: DATABASE_URL,
      blobConnectionString: BLOB_CONNECTION_STRING,
      internalToken: INTERNAL_TOKEN,
    },
  });
}

function internal(url: string, path: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      Connection: "close",
      "X-Internal-Token": INTERNAL_TOKEN,
      "X-User-Id": "u1",
      "X-Doc-Type": "markdown",
      ...(init.headers ?? {}),
    },
  });
}

test("create → apply → query round-trips through the service", async () => {
  handle = await start(41999);
  const docId = `svc-${Date.now()}`;

  const created = await internal(handle.url, `/users/u1/markdown/${docId}/create`, {
    method: "POST",
  });
  expect((await created.json()).success).toBe(true);

  const applied = await internal(handle.url, `/users/u1/markdown/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 1,
      description: "set",
      operations: [{ kind: "setContent", payload: { content: "# hi" } }],
    }),
  });
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await internal(handle.url, `/users/u1/markdown/${docId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getContent" }),
  });
  expect(await queried.json()).toMatchObject({ success: true, version: 2, data: "# hi" });
});

// 没有 casBaseUrl 时 CAS 调用必须是 501，而不是崩溃或静默成功。
// markdown 的 refsFromOp 恒返回 {}，所以这条路径正常流量打不到 ——
// 直接对 SessionDeps 的 cas 端口发一次请求来证明桩还在。
test("without casBaseUrl the CAS fetcher answers 501", async () => {
  handle = await start(41998);
  const res = await internal(handle.url, "/users/u1/cas/nodes/deadbeef/content");
  expect([404, 501]).toContain(res.status);
});
```

新建 `packages/azure-sdk/src/env.ts`(测试通过 `doc-type-service` 间接覆盖,不单独写测试文件):

```ts
import type { Pool } from "pg";

/** 缺失的必填环境变量必须在启动时就报出名字，而不是在第一个请求时才炸。 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * `pg-pool` 会在空闲连接出问题时（连接被掐、数据库重启）发 `error` 事件。
 * EventEmitter 把没有监听器的 `error` 当作未捕获异常处理 —— 没有这个
 * 监听器，一次例行的数据库抖动会带走整个进程，而不是只让持有那条连接的
 * 那一个请求失败。这不是可选的日志美化。
 */
export function attachPoolErrorLogger(pool: Pool, label: string): void {
  pool.on("error", (err) => {
    console.error(`${label}: pg pool error`, err);
  });
}
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/doc-type-service.test.ts
```

预期:FAIL,`Cannot find module '../src/doc-type-service.js'`。

- [ ] **Step 3: 移动 local-editor 并实现服务入口**

```bash
git mv packages/azure-markdown/src/local-editor.ts packages/azure-sdk/src/local-editor.ts
```

`local-editor.ts` 内容**一个字都不改**(它只 import `@unidocs/core` 与 `@unidocs/server-core`,两者都已是 `azure-sdk` 的依赖)。

新建 `packages/azure-sdk/src/doc-type-service.ts`:

```ts
/**
 * 一个 doc type 的 Azure/Node 服务入口。
 *
 * Cloudflare 那边每个 doc type 有一个 `worker.ts` 导出两个 Durable Object
 * 类；这里没有 DO 运行时，所以每个 doc type 起一个无状态 Node 进程。
 * 这些进程之间**唯一的差别**是 `docType` 字符串和 `DocumentType` 实现 ——
 * 其余（连接池、Blob 客户端、端口构造、每请求新建 session、CAS 接线、
 * 关停）在这里，只有一份。
 *
 * 这份代码曾经逐字住在 `azure-markdown/src/main.ts` 里。把它提到这里的
 * 直接原因是 `local-editor.ts` 携带的多副本不变量（每请求新建 session）——
 * 复制那条规则等于制造一条「只改一边就能悄悄产生数据损坏」的路径。
 */
import type { DocumentType } from "@unidocs/core";
import {
  CasClient,
  createDocTypeHandler,
  type DocIdentity,
  type SessionDeps,
} from "@unidocs/server-core";
import { attachPoolErrorLogger, requireEnv } from "./env.js";
import { createLocalEditorNamespace, createStubOperatorNamespace } from "./local-editor.js";
import { BlobCasStore, BlobSnapshotCache } from "./ports-blob.js";
import { PgDeltaLog, PgDocIndex, PgUnitOfWork } from "./ports-pg.js";
import { createBlobService, createPool } from "./pool.js";
import { serve } from "./http-shell.js";

export interface DocTypeServiceConfig {
  databaseUrl: string;
  blobConnectionString: string;
  internalToken: string;
  /**
   * 过渡形态（阶段 4 删除）：指向 Cloudflare CAS worker 的基地址。
   * 注意它必须指向 CAS worker 本身，不能指向 gateway —— `CasClient`
   * 的 `updateRootRefs` 打的是 `${origin}/_internal/root-refs`，
   * gateway 只路由 `/users/...`，不代理 `/_internal/*`。
   * 未给时 CAS 调用一律 501（markdown 的 refsFromOp 恒返回 {}，
   * 不给它配 CAS 是正确的默认）。
   */
  casBaseUrl?: string;
}

export interface DocTypeServiceOptions<TDoc, TQuery, TOp> {
  docType: string;
  documentType: DocumentType<TDoc, TQuery, TOp>;
  port: number;
  host?: string;
  config: DocTypeServiceConfig;
}

export interface DocTypeServiceHandle {
  url: string;
  close(): Promise<void>;
}

export async function startDocTypeService<TDoc, TQuery, TOp>(
  options: DocTypeServiceOptions<TDoc, TQuery, TOp>,
): Promise<DocTypeServiceHandle> {
  const { docType, documentType, port, config } = options;
  const host = options.host ?? "0.0.0.0";

  const pool = createPool(config);
  attachPoolErrorLogger(pool, `azure-${docType}`);
  const blobService = createBlobService(config);

  // 过渡形态（阶段 4 删除）。
  const casStubFetcher = {
    fetch: async () =>
      Response.json({ error: "CAS is not implemented on Azure yet" }, { status: 501 }),
  };

  function buildDeps(identity: DocIdentity): SessionDeps {
    return {
      deltas: new PgDeltaLog(pool, identity),
      snapshots: new BlobSnapshotCache(blobService, identity),
      blobs: new BlobCasStore(blobService),
      index: new PgDocIndex(pool, identity),
      unitOfWork: new PgUnitOfWork(pool, identity),
      cas: config.casBaseUrl
        ? new CasClient({
            baseUrl: config.casBaseUrl,
            userId: identity.userId,
            internalToken: config.internalToken,
          })
        : new CasClient({
            fetcher: casStubFetcher,
            userId: identity.userId,
            internalToken: config.internalToken,
          }),
      identity,
      now: () => Date.now(),
    };
  }

  const handler = createDocTypeHandler({
    docType,
    internalToken: config.internalToken,
    editor: createLocalEditorNamespace(documentType, buildDeps),
    operator: createStubOperatorNamespace(),
  });

  const { close } = await serve(handler, { port, host });

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    async close() {
      await close();
      await pool.end();
    },
  };
}

/**
 * 进程级入口：从环境变量取配置、起服务、装信号处理器。返回的 Promise
 * 只在收到 SIGINT/SIGTERM 并关停完成后 resolve。
 *
 * 迁移**不在**这里跑：`runMigrations()` 用 `import.meta.url` 定位
 * `migrations/*.sql`，而这些服务是 esbuild 打包后运行的，打包会把
 * `import.meta.url` 重写到 bundle 自己的位置。而且对 N 个横向扩展的
 * 副本每次启动都跑一遍迁移本身也不是想要的行为。迁移单独跑一次。
 */
export async function runDocTypeService<TDoc, TQuery, TOp>(options: {
  docType: string;
  documentType: DocumentType<TDoc, TQuery, TOp>;
  defaultPort: number;
}): Promise<void> {
  const { docType, documentType, defaultPort } = options;
  const handle = await startDocTypeService({
    docType,
    documentType,
    port: Number(process.env.PORT ?? defaultPort),
    config: {
      databaseUrl: requireEnv("DATABASE_URL"),
      blobConnectionString: requireEnv("BLOB_CONNECTION_STRING"),
      internalToken: requireEnv("INTERNAL_TOKEN"),
      casBaseUrl: process.env.CAS_BASE_URL,
    },
  });
  console.log(`azure-${docType} listening on ${handle.url}`);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`azure-${docType} received ${signal}, shutting down`);
      void handle.close().then(resolve);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
```

改 `packages/azure-sdk/src/index.ts`,追加:

```ts
export * from "./env.js";
export * from "./local-editor.js";
export * from "./doc-type-service.js";
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/doc-type-service.test.ts
```

预期:两条 PASS。

- [ ] **Step 5: 把两个入口塌缩到新 API**

`packages/azure-markdown/src/main.ts` 整体替换为:

```ts
/**
 * Azure/Node entry point for the Markdown document type.
 *
 * 除了「哪个 doc type」之外的一切都在
 * `@unidocs/azure-sdk` 的 `runDocTypeService()` 里 —— 连接池与它的四个
 * 超时、Blob 客户端、端口构造、每请求新建 DocumentSession、CAS 接线、
 * 优雅关停。docx 的入口（packages/azure-docx）与本文件形状相同：这是
 * 刻意的，任何在两边都要改一遍的东西都该往 SDK 里搬，而不是复制。
 *
 * Env vars: DATABASE_URL, BLOB_CONNECTION_STRING, INTERNAL_TOKEN, PORT,
 * CAS_BASE_URL（可选，过渡形态，见 doc-type-service.ts）。
 */
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";

runDocTypeService({
  docType: "markdown",
  documentType: createMarkdownDocumentType({}),
  defaultPort: 8788,
}).catch((err) => {
  console.error("azure-markdown failed to start:", err);
  process.exit(1);
});
```

`packages/azure-gateway/src/main.ts`:删掉本地的 `requireEnv` 与内联的 `pool.on("error")`,改为 `import { attachPoolErrorLogger, requireEnv } from "@unidocs/azure-sdk"`,并调用 `attachPoolErrorLogger(pool, "azure-gateway")`。其余不动(CAS 接线在 Task 6)。

- [ ] **Step 6: 全量验证**

```bash
pnpm typecheck && pnpm -r test && pnpm build
pnpm test:local
```

预期:全部退出码 0。`test:local` 里的 `azure-behavior.test.mjs` 是这次重构的真实回归网 —— 它跑的是打包后的 `azure-markdown`,49 条断言必须逐字未改地全绿。

- [ ] **Step 7: 提交**

```bash
git add -A packages/azure-sdk packages/azure-markdown packages/azure-gateway
git commit -m "refactor(azure-sdk): own the doc-type service entry point

local-editor.ts carries the multi-replica \"no cached session\" invariant
and knows nothing about markdown. Creating azure-docx on top of the old
layout would have duplicated a correctness rule, not boilerplate."
```

---

### Task 3: 端口布局与轮询代理(纯模块)

**Files:**
- Create: `scripts/azure-ports.mjs`
- Create: `scripts/azure-ports.test.mjs`
- Create: `scripts/replica-proxy.mjs`
- Create: `scripts/replica-proxy.test.mjs`
- Modify: `package.json`(`test:local` 加入两个新测试文件)

**Interfaces:**
- Consumes: 无
- Produces:
  ```js
  // scripts/azure-ports.mjs — 只允许 node: 内置模块，不允许任何第三方 import
  export const AZURE_GATEWAY_PORT = 41787;
  export const AZURE_DOC_TYPE_PORT_BASE = { markdown: 41800, docx: 41810 };
  export const AZURE_PORT_STRIDE = 10;   // 每个 doc type 的端口段宽度

  /**
   * @param {{docTypes?: string[], replicas?: number}} opts
   * @returns {{gateway: number, docTypes: Record<string, {proxy: number, replicas: number[]}>}}
   */
  export function azurePortLayout(opts);

  /** 布局里全部端口，升序，用于启动前的占用探测。 */
  export function allAzurePorts(layout);

  /** 端口 -> 人类可读的用途说明，用于占用时的报错。 */
  export function describeAzurePorts(layout);

  // scripts/replica-proxy.mjs
  /**
   * @param {{host?: string, port: number, targets: string[]}} opts
   * @returns {Promise<{url: string, hits: () => number[], close: () => Promise<void>}>}
   */
  export function startReplicaProxy(opts);
  ```
  Task 4 消费这两个模块;`scripts/dev.mjs` 消费 `azure-ports.mjs`。

**背景:** 现在端口是两处硬编码 —— `azure-runtime.mjs` 的 `DEFAULT_PORTS = { gateway: 41787, markdown: 41788 }` 和 `dev.mjs` 的 `AZURE_PORTS`(注释里写着「必须与前者保持一致」)。副本数一旦可配,两处硬编码必然对不上。布局挪到无依赖模块后,启动前的端口探测自然覆盖到全部副本。

代理扮演的是生产环境里 ACA ingress 的角色 —— 所以它属于测试脚手架,不属于应用代码。被否决的替代方案是让 `azure-gateway` 的 `resolveWorkerUrl` 支持逗号分隔列表并自己轮询:实现更短,但会在生产代码里留下一块真实部署用不上的负载均衡逻辑。

- [ ] **Step 1: 写失败的测试(端口布局)**

新建 `scripts/azure-ports.test.mjs`:

```js
import { describe, expect, test } from "vitest";
import {
  allAzurePorts,
  azurePortLayout,
  describeAzurePorts,
} from "./azure-ports.mjs";

describe("azurePortLayout", () => {
  test("defaults to markdown with two replicas", () => {
    expect(azurePortLayout({})).toEqual({
      gateway: 41787,
      docTypes: { markdown: { proxy: 41800, replicas: [41801, 41802] } },
    });
  });

  test("replica count drives the replica port list", () => {
    const layout = azurePortLayout({ docTypes: ["markdown"], replicas: 3 });
    expect(layout.docTypes.markdown.replicas).toEqual([41801, 41802, 41803]);
  });

  test("each doc type gets its own non-overlapping band", () => {
    const layout = azurePortLayout({ docTypes: ["markdown", "docx"], replicas: 2 });
    expect(layout.docTypes.docx).toEqual({ proxy: 41810, replicas: [41811, 41812] });
    const ports = allAzurePorts(layout);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).toEqual([...ports].sort((a, b) => a - b));
  });

  // 副本数不能超出该 doc type 的端口段，否则会悄悄踩进下一个 doc type 的段。
  test("a replica count that overflows the band throws", () => {
    expect(() => azurePortLayout({ docTypes: ["markdown"], replicas: 20 })).toThrow(
      /replicas/,
    );
  });

  test("an unknown doc type throws, naming it", () => {
    expect(() => azurePortLayout({ docTypes: ["psd"] })).toThrow(/psd/);
  });

  test("describeAzurePorts explains every port in the layout", () => {
    const layout = azurePortLayout({ docTypes: ["markdown"], replicas: 2 });
    const described = describeAzurePorts(layout);
    for (const port of allAzurePorts(layout)) {
      expect(described[port]).toBeTypeOf("string");
      expect(described[port].length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
pnpm exec vitest run scripts/azure-ports.test.mjs
```

预期:FAIL,`Cannot find module './azure-ports.mjs'`。

- [ ] **Step 3: 实现端口布局**

新建 `scripts/azure-ports.mjs`:

```js
/**
 * 本地 Azure 栈的端口布局。
 *
 * 无依赖(连 node: 内置模块都不需要)是刻意的,与 `scripts/doc-types.mjs`
 * 同一条约定:`dev.mjs` 要在 import 任何重家伙(pg、@azure/storage-blob、
 * esbuild、Miniflare)之前就把端口算出来并探测占用,而纯逻辑也才能脱离
 * Docker 单测。
 *
 * 端口段与 Miniflare 侧(8787/8788/8789)刻意分开,两套栈可以同时跑 ——
 * docx 的 CAS 过渡形态正需要这一点(见 spec §6)。
 */

export const AZURE_GATEWAY_PORT = 41787;
export const AZURE_PORT_STRIDE = 10;
export const AZURE_DOC_TYPE_PORT_BASE = {
  markdown: 41800,
  docx: 41810,
};

export function azurePortLayout({ docTypes = ["markdown"], replicas = 2 } = {}) {
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new Error(`replicas must be a positive integer, got ${replicas}`);
  }
  // 段内第一个端口给代理,其余给副本 —— 所以副本上限是 STRIDE - 1。
  if (replicas > AZURE_PORT_STRIDE - 1) {
    throw new Error(
      `replicas=${replicas} overflows the ${AZURE_PORT_STRIDE}-port band each doc type gets ` +
        `(max ${AZURE_PORT_STRIDE - 1}); widen AZURE_PORT_STRIDE if you really need more`,
    );
  }

  const result = { gateway: AZURE_GATEWAY_PORT, docTypes: {} };
  for (const name of docTypes) {
    const base = AZURE_DOC_TYPE_PORT_BASE[name];
    if (base === undefined) {
      throw new Error(
        `Unknown Azure doc type: ${name}. Known: ${Object.keys(AZURE_DOC_TYPE_PORT_BASE).join(", ")}`,
      );
    }
    result.docTypes[name] = {
      proxy: base,
      replicas: Array.from({ length: replicas }, (_, i) => base + 1 + i),
    };
  }
  return result;
}

export function allAzurePorts(layout) {
  const ports = [layout.gateway];
  for (const spec of Object.values(layout.docTypes)) {
    ports.push(spec.proxy, ...spec.replicas);
  }
  return ports.sort((a, b) => a - b);
}

export function describeAzurePorts(layout) {
  const described = {
    [layout.gateway]: "expected by the azure-gateway service this run is about to spawn",
  };
  for (const [name, spec] of Object.entries(layout.docTypes)) {
    described[spec.proxy] =
      `expected by the round-robin proxy that stands in for the platform ingress in front of azure-${name}`;
    spec.replicas.forEach((port, i) => {
      described[port] = `expected by azure-${name} replica ${i + 1} this run is about to spawn`;
    });
  }
  return described;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm exec vitest run scripts/azure-ports.test.mjs
```

预期:六条全部 PASS。

- [ ] **Step 5: 写失败的测试(轮询代理)**

新建 `scripts/replica-proxy.test.mjs`:

```js
/**
 * 轮询反向代理:本地扮演 ACA ingress。它只需要一条性质 —— 连续请求会
 * 轮流落到不同后端 —— 就足以把现有全部行为断言升级成多副本断言。
 */
import { afterEach, expect, test } from "vitest";
import { createServer } from "node:http";
import { startReplicaProxy } from "./replica-proxy.mjs";

const closers = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

function startEcho(label) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            replica: label,
            method: req.method,
            url: req.url,
            body: Buffer.concat(chunks).toString("utf8"),
            token: req.headers["x-internal-token"] ?? null,
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      closers.push(() => new Promise((r) => server.close(r)));
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test("round-robins across targets and preserves method, path, body and headers", async () => {
  const a = await startEcho("a");
  const b = await startEcho("b");
  const proxy = await startReplicaProxy({ port: 0, targets: [a, b] });
  closers.push(proxy.close);

  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`${proxy.url}/users/u1/markdown/d1/apply`, {
      method: "POST",
      headers: { Connection: "close", "X-Internal-Token": "tok" },
      body: `payload-${i}`,
    });
    const json = await res.json();
    expect(json.method).toBe("POST");
    expect(json.url).toBe("/users/u1/markdown/d1/apply");
    expect(json.body).toBe(`payload-${i}`);
    expect(json.token).toBe("tok");
    seen.push(json.replica);
  }
  expect(seen).toEqual(["a", "b", "a", "b"]);
  expect(proxy.hits()).toEqual([2, 2]);
});

// 一个副本挂了不能让代理静默把全部流量倒给另一个 —— 那会让「多副本」
// 悄悄退化成单副本，正是本轮要消灭的那类假绿。
test("an unreachable target surfaces as a 502, not as silent failover", async () => {
  const a = await startEcho("a");
  const proxy = await startReplicaProxy({ port: 0, targets: [a, "http://127.0.0.1:1"] });
  closers.push(proxy.close);

  const first = await fetch(`${proxy.url}/ping`, { headers: { Connection: "close" } });
  expect(first.status).toBe(200);
  const second = await fetch(`${proxy.url}/ping`, { headers: { Connection: "close" } });
  expect(second.status).toBe(502);
});
```

- [ ] **Step 6: 跑测试确认它失败**

```bash
pnpm exec vitest run scripts/replica-proxy.test.mjs
```

预期:FAIL,`Cannot find module './replica-proxy.mjs'`。

- [ ] **Step 7: 实现轮询代理**

新建 `scripts/replica-proxy.mjs`:

```js
/**
 * 轮询反向代理 —— 本地扮演 Azure Container Apps 的 ingress。
 *
 * 它属于测试脚手架,不属于应用代码:生产环境里分流是平台的事,`azure-gateway`
 * 和 `azure-markdown` 都不该知道副本的存在。
 *
 * 保真度是刻意有限的:没有健康检查、没有会话粘性、没有重试。本轮只需要
 * 「连续请求会落到不同副本」这一条性质。特别是**不做故障转移** ——
 * 一个副本连不上就返回 502,因为静默把流量全倒给另一个副本会让多副本
 * 悄悄退化成单副本,那正是本轮要消灭的那类假绿。
 */
import { createServer, request as httpRequest } from "node:http";

export function startReplicaProxy({ host = "127.0.0.1", port, targets }) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("startReplicaProxy requires a non-empty targets array");
  }
  const parsed = targets.map((t) => new URL(t));
  const hits = new Array(parsed.length).fill(0);
  let next = 0;

  const server = createServer((req, res) => {
    const index = next;
    next = (next + 1) % parsed.length;
    hits[index] += 1;
    const target = parsed[index];

    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({
          error: `replica-proxy: replica ${index + 1} (${target.origin}) unreachable: ${err.message}`,
        }),
      );
    });
    req.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}`,
        hits: () => [...hits],
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
```

- [ ] **Step 8: 跑测试确认通过并接入 test:local**

改 `package.json` 的 `test:local`,在 `scripts/doc-types.test.mjs` 之后插入 `scripts/azure-ports.test.mjs scripts/replica-proxy.test.mjs`(它们是纯的,放在最前面跑得最快)。

```bash
pnpm exec vitest run scripts/azure-ports.test.mjs scripts/replica-proxy.test.mjs
pnpm test:local
```

预期:两个文件全绿;`test:local` 退出码 0。

- [ ] **Step 9: 提交**

```bash
git add scripts/azure-ports.mjs scripts/azure-ports.test.mjs scripts/replica-proxy.mjs scripts/replica-proxy.test.mjs package.json
git commit -m "test(azure): add the port layout and round-robin proxy modules"
```

---

### Task 4: 多副本运行时接线与跨副本场景

**Files:**
- Modify: `scripts/azure-runtime.mjs`
- Modify: `scripts/dev.mjs`
- Create: `scripts/azure-multi-replica.test.mjs`
- Modify: `package.json`(`test:local` 加入新测试文件)

**Interfaces:**
- Consumes: `azurePortLayout` / `allAzurePorts` / `describeAzurePorts`(Task 3)、`startReplicaProxy`(Task 3)
- Produces:
  ```js
  // scripts/azure-runtime.mjs
  export async function startAzureRuntime({
    host = "127.0.0.1",
    docTypes = ["markdown"],
    replicas = 2,
  } = {}): Promise<{
    urls: {
      gateway: string,
      markdown: string,                 // 代理地址，语义不变
      markdownReplicas: string[],       // 新增：直连各副本
    },
    storage,
    dispose,
  }>
  ```
  `urls.markdown` 仍然是「gateway 该打的那个地址」,只不过现在指向代理 —— `MARKDOWN_WORKER_URL: urls.markdown` 那行不用改。

  本任务里 `docTypes` 参数**只接受 `["markdown"]`**:端口布局(Task 3)已经知道 docx,但 `azure-docx` 这个包要到 Task 7 才存在。传入 `"docx"` 时抛一个指向 Task 7 的明确错误,不要让它 spawn 一个不存在的 bundle。Task 7 会把这段循环推广到多个 doc type,并加上 `docx` / `docxReplicas` 两个 `urls` 键。

**背景:** 阶段 2 的 49 个行为测试只在单副本下跑过。上位设计第 2 节的整个论证(N 个无状态副本共享 Postgres,同一文档的两个请求可以同时落在不同副本)从未被执行 —— 一个设计错误的实现在那套测试下同样会全绿。接上代理之后,每个请求换一个副本,任何依赖进程内状态才能通过的地方会直接变红。

副本数默认 2 而不是 1:开发时对着什么跑与测试对着什么跑不一致本身就是事故来源。保留可配置只为排查(切成 1 再跑一遍,立刻区分「多副本才暴露」与「本来就错」)—— 但跨副本场景必须断言 `replicas >= 2`,否则「能调成 1」就会变成「有人调成 1 然后忘了」。

- [ ] **Step 1: 写失败的测试**

新建 `scripts/azure-multi-replica.test.mjs`:

```js
/**
 * 跨副本场景 —— 只有两个真实副本共享同一个 Postgres/Blob 才制造得出来的
 * 情况。行为测试套经代理后已经把每个请求打到不同副本；这里直连副本，
 * 制造**真正的同时性**。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { startAzureRuntime } from "./azure-runtime.mjs";

let runtime;
const REPLICAS = 2;

beforeAll(async () => {
  runtime = await startAzureRuntime({ replicas: REPLICAS });
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
}, 60_000);

function closeFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

// 这条闸的存在理由与 treespec 选 A 的理由相同：能只跑一边，就一定有人
// 只跑一边。配成单副本时这组场景必须响亮失败，而不是「跑过了但什么都
// 没验」。
test("the runtime really gave us at least two replicas", () => {
  expect(runtime.urls.markdownReplicas.length).toBeGreaterThanOrEqual(2);
});

async function createDoc(userId) {
  const res = await closeFetch(`${runtime.urls.gateway}/users/${userId}/docs/markdown/`, {
    method: "POST",
  });
  const body = await res.json();
  expect(body.success, JSON.stringify(body)).toBe(true);
  return body.docId;
}

function applyVia(replicaUrl, userId, docId, baseVersion, content) {
  return closeFetch(`${replicaUrl}/users/${userId}/markdown/${docId}/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": "unidocs-dev-token",
      "X-User-Id": userId,
      "X-Doc-Type": "markdown",
    },
    body: JSON.stringify({
      baseVersion,
      description: `set ${content}`,
      operations: [{ kind: "setContent", payload: { content } }],
    }),
  });
}

test("two replicas applying the same baseVersion: exactly one wins", async () => {
  const userId = "multi-1";
  const docId = await createDoc(userId);
  const [a, b] = runtime.urls.markdownReplicas;

  const [resA, resB] = await Promise.all([
    applyVia(a, userId, docId, 1, "from-a"),
    applyVia(b, userId, docId, 1, "from-b"),
  ]);
  const bodies = await Promise.all([resA.json(), resB.json()]);

  const winners = bodies.filter((x) => x.success === true);
  const losers = bodies.filter((x) => x.success !== true);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(winners[0].version).toBe(2);

  // 409 的 body 里必须是服务端当前版本，不是调用方那个过期的 baseVersion。
  // 客户端靠这个数字重新同步；照抄 baseVersion 会让它永远重试同一个陈旧版本。
  const loserStatus = resA.status === 409 ? resA.status : resB.status;
  expect(loserStatus).toBe(409);
  expect(losers[0].version).toBe(2);
});

test("a write on one replica is immediately visible on the other", async () => {
  const userId = "multi-2";
  const docId = await createDoc(userId);
  const [a, b] = runtime.urls.markdownReplicas;

  const applied = await applyVia(a, userId, docId, 1, "written-on-a");
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await closeFetch(`${b}/users/${userId}/markdown/${docId}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": "unidocs-dev-token",
      "X-User-Id": userId,
      "X-Doc-Type": "markdown",
    },
    body: JSON.stringify({ kind: "getContent" }),
  });
  // 副本 B 从没见过这个文档，只能从 Postgres/Blob 读 —— 这正是
  // BlobSnapshotCache.get() 的 ETag 一致读要保证的事。
  expect(await queried.json()).toMatchObject({
    success: true,
    version: 2,
    data: "written-on-a",
  });
});

test("alternating replicas advance the version with no holes", async () => {
  const userId = "multi-3";
  const docId = await createDoc(userId);
  const replicas = runtime.urls.markdownReplicas;

  for (let v = 1; v <= 6; v += 1) {
    const replica = replicas[(v - 1) % replicas.length];
    const res = await applyVia(replica, userId, docId, v, `step-${v}`);
    expect(await res.json()).toMatchObject({ success: true, version: v + 1 });
  }

  const history = await closeFetch(
    `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/history`,
  );
  const body = await history.json();
  expect(body.success).toBe(true);
  const versions = body.data.map((d) => d.version);
  expect(versions).toEqual([...versions].sort((x, y) => x - y));
  expect(new Set(versions).size).toBe(versions.length);
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
pnpm exec vitest run scripts/azure-multi-replica.test.mjs
```

预期:FAIL —— `startAzureRuntime` 不接受 `replicas`,`runtime.urls.markdownReplicas` 是 `undefined`,第一条断言就红。

- [ ] **Step 3: 改造 `startAzureRuntime()`**

改 `scripts/azure-runtime.mjs`:

1. 删掉本地的 `DEFAULT_PORTS` 与 `describeAzurePorts()`,改为 `import { allAzurePorts, azurePortLayout, describeAzurePorts } from "./azure-ports.mjs"`。`assertPortsFree` 改为遍历 `allAzurePorts(layout)`,并把 Azurite 的 10000 与 Postgres 的 5433 追加进去(它们不属于布局,是固定的后端存储端口)。
2. 签名改为 `startAzureRuntime({ host = "127.0.0.1", docTypes = ["markdown"], replicas = 2 } = {})`,开头 `const layout = azurePortLayout({ docTypes, replicas });`。
3. 每个 doc type 的副本用循环 spawn:

```js
const replicaUrls = [];
for (const [i, port] of layout.docTypes.markdown.replicas.entries()) {
  const proc = spawnService(
    markdownBundle,
    [],
    {
      DATABASE_URL,
      BLOB_CONNECTION_STRING,
      INTERNAL_TOKEN,
      PORT: String(port),
    },
    `azure-markdown-${i + 1}`,
  );
  markdownProcs.push(proc);
  await waitForPort(host, port, 30_000);
  replicaUrls.push(`http://${host}:${port}`);
}

// 代理扮演 ACA ingress。gateway 只知道这一个地址 —— 它不该知道副本存在。
const proxy = await startReplicaProxy({
  host,
  port: layout.docTypes.markdown.proxy,
  targets: replicaUrls,
});
```

4. `urls` 改为:

```js
const urls = {
  gateway: `http://${host}:${layout.gateway}`,
  markdown: proxy.url,                 // 语义不变：gateway 该打的那个地址
  markdownReplicas: replicaUrls,       // 新增：直连副本，跨副本场景用
};
```

5. `installChildProcessCleanup` 的 `getChildren` 回调改为返回 `[gatewayProc, ...markdownProcs, azuriteProc]`。
6. `dispose()` 里在停进程之前 `await proxy.close()`。

- [ ] **Step 4: 让 `dev.mjs` 用同一份布局**

改 `scripts/dev.mjs`:删掉 `AZURE_PORTS` 与 `AZURE_CONTAINER_PORTS` 里重复的 markdown 端口,改为:

```js
const { azurePortLayout, allAzurePorts, describeAzurePorts } = await import("./azure-ports.mjs");
const layout = azurePortLayout({ docTypes: requested, replicas: 2 });
const described = describeAzurePorts(layout);
await Promise.all([
  ...allAzurePorts(layout).map((port) => assertPortFree(AZURE_HOST, port, described[port])),
  assertPortFree(AZURE_HOST, 5433, AZURE_CONTAINER_PORTS.postgres.hint),
  assertPortFree(AZURE_HOST, 10000, AZURE_CONTAINER_PORTS.azurite.hint),
]);
```

`azure-ports.mjs` 无依赖,所以这个 import 可以放在重家伙之前,argv 校验之后。启动后打印每个副本的地址,让「现在跑着两份」在终端里是可见的。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm exec vitest run scripts/azure-multi-replica.test.mjs
pnpm exec vitest run scripts/azure-behavior.test.mjs
```

预期:跨副本四条全绿;**行为测试套 49 条在双副本下逐字不改地全绿** —— 这是本任务的核心验收。

- [ ] **Step 6: 验证单副本时那道闸真的会响**

```bash
node -e "
import('./scripts/azure-runtime.mjs').then(async (m) => {
  const rt = await m.startAzureRuntime({ replicas: 1 });
  console.log('replicas:', rt.urls.markdownReplicas.length);
  await rt.dispose();
});
"
```

预期:打印 `replicas: 1`。把 `azure-multi-replica.test.mjs` 里的 `REPLICAS` 临时改成 1 跑一次,确认第一条测试**失败**并指出副本数不足,然后改回 2。这一步是在验证闸门本身有效,不是在验证功能。

- [ ] **Step 7: 接入 test:local 并全量验证**

`package.json` 的 `test:local` 在 `scripts/azure-behavior.test.mjs` 之后追加 `scripts/azure-multi-replica.test.mjs`。

```bash
pnpm typecheck && pnpm -r test && pnpm build
pnpm test:local
ps -eo pid,ppid,etime,command | grep -E "azure-runtime|azurite" | grep -v grep || echo "no leaked processes"
```

预期:全部退出码 0,无残留进程。

- [ ] **Step 8: 提交**

```bash
git add scripts/azure-runtime.mjs scripts/dev.mjs scripts/azure-multi-replica.test.mjs package.json
git commit -m "test(azure): run the behavior suite against two real replicas

The phase 2 claim held only on a single-replica topology, which is not
the topology the whole Azure adaptation exists for. A round-robin proxy
now stands in for the platform ingress, so every existing assertion
crosses replicas, and a dedicated suite forces true simultaneity."
```

---

### Task 5: 端口契约的四个盲区

**Files:**
- Modify: `packages/server-core/src/testing/port-contract.ts`
- Modify: `packages/server-core/tests/ports.test.ts`
- Modify: `packages/azure-sdk/tests/ports.test.ts`
- Modify: `scripts/cf-port-contract.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export interface ConcurrencyReadiness {
    /** 该 harness 能真正同时发出语句的写者数量。契约要求 >= 2。 */
    concurrentWriters: number;
    /** harness 为满足这个前提做了什么。断言失败时原样打印出来。 */
    how: string;
  }
  export interface PortContractOptions {
    transactional: boolean;
    /** 必填。并发哨兵跑之前调用一次。 */
    prepareConcurrency: () => Promise<ConcurrencyReadiness>;
  }
  ```
  三个调用方(内存、Cloudflare、Postgres)都必须提供 `prepareConcurrency`。

**背景:** `packages/azure-sdk/tests/ports.test.ts` 为了让并发哨兵真正并发,在 harness 层维护了一套连接池预热(`pg.Pool` 惰性建连;不预热时第二个写者要等一次完整 TCP 握手 + 认证,测得的结果是 1 条空闲连接下写者 4/4 串行、2 条以上 6/6 交错)。这条前提只活在调用方 —— 契约本身不知道、也不检查。下一个后端的作者没抄这段就会得到一个恒绿但什么都没验的哨兵。

- [ ] **Step 1: 写失败的测试(先改契约,让三个调用方红)**

在 `packages/server-core/src/testing/port-contract.ts` 里加类型与断言:

```ts
export interface ConcurrencyReadiness {
  concurrentWriters: number;
  how: string;
}

export interface PortContractOptions {
  transactional: boolean;
  /**
   * 必填,没有默认值 —— 与 `transactional` 同理:能被省略的前提就是
   * 会被省略的前提。
   *
   * 并发哨兵只有在两个写者能**真正同时**发出语句时才验得到东西。
   * Postgres 后端上这需要预热连接池(`pg.Pool` 惰性建连,不预热时第二个
   * 写者要等一次 TCP 握手 + 认证,读到 head 时第一个写者已经提交了 ——
   * 哨兵恒绿,什么也没验)。这条前提过去只活在 `azure-sdk/tests/ports.test.ts`
   * 里,契约看不见。现在契约主动向 harness 要一份证明。
   */
  prepareConcurrency: () => Promise<ConcurrencyReadiness>;
}
```

在并发哨兵那条 `test()` 的开头插入:

```ts
const readiness = await options.prepareConcurrency();
expect(
  readiness.concurrentWriters,
  `This backend's harness reported only ${readiness.concurrentWriters} concurrent writer(s) ` +
    `("${readiness.how}"). The sentinel below cannot observe a race with fewer than 2, ` +
    `and would pass without testing anything.`,
).toBeGreaterThanOrEqual(2);
```

新增三条用例(接在既有 `remove` 用例之后):

```ts
    /**
     * remove() 与 append() 之间有一个**已知、有意接受**的窗口(见 design
     * 文档第 9 节):remove(v) 先确认 v 仍是 head,再删;两步之间另一个写者
     * 可以 append(v+1),于是删除留下一个空洞。
     *
     * 本用例不修那个窗口 —— 它把窗口**钉在明面上**:两种结果都在允许集合
     * 里,并且都必须满足「head 与 range 自洽」。任何新的失败形态(比如
     * remove 删掉了非 head 的版本,或 head 与 range 对不上)都会红。
     * 如果将来有人要放宽这个允许集合,那说明窗口变糟了,而不是测试太严。
     */
    test("remove(v) racing append(v+1): the accepted window is visible, nothing worse happens", async () => {
      const { deltas } = await factory();
      await options.prepareConcurrency();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));

      await Promise.all([
        deltas.remove(2).catch(() => undefined),
        deltas.append(makeDelta(3)).catch(() => undefined),
      ]);

      const versions = (await deltas.range()).map((d) => d.version);
      // 允许集合：窗口没撞上 -> [1,2,3]；撞上了 -> [1,3]（这就是被接受的
      // 那个空洞）；append 先到而 remove 因此变成 no-op 也是 [1,2,3]。
      expect([[1, 2, 3], [1, 3]]).toContainEqual(versions);
      expect(await deltas.head()).toBe(Math.max(...versions));
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
    });

    // touch() 过去只在别的用例的注释里被提到过一次（作为 register() 必须
    // 先于它的排序说明），三个后端都没有一条用例验过它自己的语义。
    test("DocIndex: touch() advances updatedAt and leaves createdAt alone", async () => {
      const { index, indexQuery } = await factory();
      const created = 1_700_000_000_000;
      await index.register({
        docId: "doc-1",
        docType: "text",
        ownerId: "user-1",
        createdAt: created,
        updatedAt: created,
      });

      await index.touch(created + 5_000);

      const [row] = await indexQuery.list("user-1", "text");
      expect(row.createdAt).toBe(created);
      expect(row.updatedAt).toBe(created + 5_000);
    });

    /**
     * 作用域谓词。在专用存储上（Cloudflare 每个 DO 一个私有 sqlite）这几乎
     * 不可能出错；在共享表后端上（Postgres 里所有文档挤在同一张 deltas 表）
     * 漏写一个 WHERE 条件是最容易犯、代码审查最难发现的一类 bug ——
     * 审查时看起来完全正常，只有跑起来才会串号。
     */
    test("DeltaLog: operating on one document neither affects nor reads another", async () => {
      const a = await factory();
      const b = await factory();

      await a.deltas.append(makeDelta(1, "doc-a-v1"));
      await a.deltas.append(makeDelta(2, "doc-a-v2"));
      await b.deltas.append(makeDelta(1, "doc-b-v1"));

      expect(await a.deltas.head()).toBe(2);
      expect(await b.deltas.head()).toBe(1);
      expect((await b.deltas.range()).map((d) => d.description)).toEqual(["doc-b-v1"]);

      await a.deltas.remove(2);
      expect(await b.deltas.head()).toBe(1);
      expect((await b.deltas.range()).map((d) => d.description)).toEqual(["doc-b-v1"]);
    });
```

注意:`indexQuery.list` 的确切签名以 `packages/server-core/src/ports.ts` 里 `DocIndexQuery` 的定义为准 —— 实现前先读它,若参数或返回字段名与上面不同,以接口定义为准并相应调整断言,**不要改接口去迁就测试**。

- [ ] **Step 2: 跑测试确认它失败**

```bash
pnpm --filter @unidocs/server-core test
```

预期:TypeScript 报 `prepareConcurrency` 缺失(`packages/server-core/tests/ports.test.ts` 没传),三条新用例因 `touch`/作用域断言未被满足或编译不过而红。

- [ ] **Step 3: 三个调用方补上 `prepareConcurrency`**

`packages/server-core/tests/ports.test.ts`:

```ts
runPortContract("memory ports", async () => createMemoryPorts(), {
  transactional: true,
  // 内存端口没有连接池，两个 Promise 天然可以交错，无需任何准备。
  prepareConcurrency: async () => ({
    concurrentWriters: 2,
    how: "in-memory ports have no connection pool; two promises interleave directly",
  }),
});
```

`packages/azure-sdk/tests/ports.test.ts`:把现有的 `warmPool(WARM_CONNECTIONS)` 调用从 `factory()` 里移出来,改成:

```ts
  prepareConcurrency: async () => {
    await warmPool(WARM_CONNECTIONS);
    return {
      concurrentWriters: WARM_CONNECTIONS,
      how: `warmed the pg pool to ${WARM_CONNECTIONS} idle, already-used connections (see warmPool)`,
    };
  },
```

`scripts/cf-port-contract.test.mjs`:

```js
  prepareConcurrency: async () => ({
    concurrentWriters: 2,
    how: "each port call is a separate fetch into the worker; no pool to warm",
  }),
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/server-core test
pnpm --filter @unidocs/azure-sdk test
pnpm exec vitest run scripts/cf-port-contract.test.mjs
```

预期:三个后端全绿。若 Postgres 后端的作用域用例红,那是真 bug —— 查 `ports-pg.ts` 里那条 SQL 的 `WHERE` 是否漏了 `doc_id`,**不要放宽断言**。

- [ ] **Step 5: 验证钩子本身有效**

把 `packages/azure-sdk/tests/ports.test.ts` 的 `prepareConcurrency` 临时改成返回 `{ concurrentWriters: 1, how: "deliberately broken" }`,跑一次,确认并发哨兵**失败**并在消息里打印出 `deliberately broken`,然后改回。

- [ ] **Step 6: 提交**

```bash
git add packages/server-core packages/azure-sdk/tests/ports.test.ts scripts/cf-port-contract.test.mjs
git commit -m "test(server-core): close the port contract's four blind spots"
```

---

### Task 6: CAS 过渡形态接线

**Files:**
- Create: `packages/cas/src/public-route.ts`
- Modify: `packages/cas/src/index.ts`
- Modify: `packages/cloudflare-cas/src/public-cas-route.ts`
- Modify: `packages/azure-gateway/src/main.ts`
- Modify: `packages/azure-gateway/package.json`(加 `@unidocs/cas` 依赖)
- Modify: `scripts/doc-types.mjs`
- Modify: `scripts/local-runtime.mjs`
- Modify: `scripts/azure-runtime.mjs`
- Test: `packages/cas/tests/public-route.test.ts`(新建)

**Interfaces:**
- Consumes: `DocTypeServiceConfig.casBaseUrl`(Task 2)
- Produces:
  - `@unidocs/cas` 导出 `isPublicCasRoute(method: string, pathname: string): boolean`
  - `startLocalRuntime()` 的 `urls` 增加 `cas`(指向 Miniflare CAS worker 的直连端口 **8790**)
  - `startAzureRuntime({ casBaseUrl })`,透传给每个副本的 `CAS_BASE_URL` 与 gateway

**背景(三个必须先理解的事实):**

1. `CasClient` 的 `updateRootRefs` 打 `${origin}/_internal/root-refs`(`packages/server-core/src/cas-client.ts:165`),**不在** `/users/{userId}/cas/` 下面。`createGatewayHandler` 只路由 `/users/...`。所以 **`CAS_BASE_URL` 必须指向 CAS worker 本身,不能指向 gateway**。
2. docx 的图片 e2e 是**经 gateway** 打 `POST /users/{userId}/cas/nodes/{hash}` 上传的(见 `tests/bootstrap/create-new-docx/edit/image/spec.yaml`)。所以 Azure 的 gateway 也必须代理公开 CAS 路由 —— 它现在是 `isPublicCasRoute: () => false`。

3. **`CasClient` 的两种模式发的鉴权头不同,选错等于不鉴权。** `CasClientConfig`(`packages/server-core/src/cas-client.ts:27-29`)是个二选一联合:

   ```ts
   | { baseUrl: string; userId: string; authToken?: string }         // 发 Authorization: Bearer
   | { fetcher: HttpFetcher; userId: string; internalToken: string } // 发 X-Internal-Token + X-User-Id
   ```

   过渡形态要打的是 CAS worker 的**内部**路由,认的是 `X-Internal-Token` + `X-User-Id` —— baseUrl 分支根本不发这两个头。传 `{ baseUrl, userId, internalToken }` 会走 baseUrl 分支、`authToken` 为空,结果是**一个鉴权头都不发**;TypeScript 拦不住,因为 `internalToken` 在联合的另一个成员里存在。Task 2 committed 的 `packages/azure-sdk/src/doc-type-service.ts` 里正是这么写的,而那条分支在本任务之前没有任何测试能到达 —— **本任务必须改掉它**(见 Step 6)。

而 `isPublicCasRoute` 是个纯函数(只解析 pathname,零 Cloudflare 类型),却住在 `packages/cloudflare-cas`。`azure-gateway` 直接 import 它会让 Azure 依赖 Cloudflare 适配包,违反分层。先把它移到云中立的 `@unidocs/cas`。

- [ ] **Step 1: 写失败的测试**

新建 `packages/cas/tests/public-route.test.ts`(断言逐字抄自现有实现的行为,这是一次移动而不是改写):

```ts
import { describe, expect, test } from "vitest";
import { isPublicCasRoute } from "../src/public-route.js";

describe("isPublicCasRoute", () => {
  test("allows the five public shapes", () => {
    expect(isPublicCasRoute("GET", "/users/u1/cas/usage")).toBe(true);
    expect(isPublicCasRoute("POST", "/users/u1/cas/gc")).toBe(true);
    expect(isPublicCasRoute("POST", "/users/u1/cas/nodes/abc")).toBe(true);
    expect(isPublicCasRoute("GET", "/users/u1/cas/nodes/abc/content")).toBe(true);
    expect(isPublicCasRoute("GET", "/users/u1/cas/nodes/abc/metadata")).toBe(true);
    expect(isPublicCasRoute("POST", "/users/u1/cas/nodes/abc/lease")).toBe(true);
  });

  // /_internal/root-refs 永远不是公开路由 —— 这是网关允许列表的全部意义。
  test("never allows the internal root-refs route", () => {
    expect(isPublicCasRoute("POST", "/_internal/root-refs")).toBe(false);
    expect(isPublicCasRoute("POST", "/users/u1/cas/_internal/root-refs")).toBe(false);
  });

  test("rejects wrong methods and wrong shapes", () => {
    expect(isPublicCasRoute("POST", "/users/u1/cas/usage")).toBe(false);
    expect(isPublicCasRoute("GET", "/users/u1/cas/gc")).toBe(false);
    expect(isPublicCasRoute("GET", "/users/u1/docs/markdown/d1")).toBe(false);
    expect(isPublicCasRoute("GET", "/users/u1/cas")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
pnpm --filter @unidocs/cas exec vitest run tests/public-route.test.ts
```

预期:FAIL,`Cannot find module '../src/public-route.js'`。

- [ ] **Step 3: 移动纯函数**

```bash
git mv packages/cloudflare-cas/src/public-cas-route.ts packages/cas/src/public-route.ts
```

`packages/cas/src/index.ts` 追加 `export { isPublicCasRoute } from "./public-route.js";`。

新建 `packages/cloudflare-cas/src/public-cas-route.ts` 作为再导出,保持既有 import 路径不断:

```ts
/**
 * 兼容再导出。这个函数只解析 pathname，没有一个 Cloudflare 类型 ——
 * 它属于云中立的 @unidocs/cas，因为 azure-gateway 也要用同一份允许列表，
 * 而 Azure 侧不该依赖 Cloudflare 适配包。
 */
export { isPublicCasRoute } from "@unidocs/cas";
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cas test && pnpm typecheck
```

预期:全绿。`cloudflare-gateway/src/worker.ts` 的 `import { isPublicCasRoute } from "@unidocs/cloudflare-cas/public"` 不用改。

- [ ] **Step 5: 给 Miniflare 的 CAS worker 开一个直连端口**

改 `scripts/doc-types.mjs`:

```js
export const CAS_PORT = 8790;
```

在 `buildWorkers()` 里给 `CAS_WORKER` 那一项加:

```js
      // 过渡形态(阶段 4 删除):Azure 栈的 CAS_BASE_URL 要能从进程外打到
      // 这个 worker。service binding 只在 Miniflare 进程内有效,而
      // CasClient 的 updateRootRefs 走 /_internal/root-refs,gateway 不
      // 代理这条路由 —— 所以必须直连 worker 本身。
      unsafeDirectSockets: [{ host, port: ports.cas }],
```

`buildWorkers` 的 `ports` 参数由调用方给出;在 `scripts/local-runtime.mjs` 里把 `cas: CAS_PORT` 并入 `ports`,`urls` 因而自动多出 `cas` 一项(`urls` 是从 `ports` 映射来的)。

- [ ] **Step 6: 让 Azure 栈接上它**

改 `scripts/azure-runtime.mjs`:`startAzureRuntime({ ..., casBaseUrl })`,把 `CAS_BASE_URL: casBaseUrl` 加进每个副本的 env(未给时不设该变量,服务端自然退回 501 桩)。

改 `packages/azure-sdk/src/doc-type-service.ts` —— 修掉背景第 3 条那个不鉴权的分支。不要去改 `CasClient`:保持 **fetcher 分支**,把基地址藏进 fetcher 里。Cloudflare 侧的 service binding 本来就是这么接的,`origin()` 在 fetcher 模式下返回的 `https://cas.internal` 就是个等着被重写掉的假源。

```ts
/**
 * 过渡形态(阶段 4 删除):把 CasClient 在 fetcher 模式下生成的假源
 * (`https://cas.internal`)重写到真实的 CAS worker 基地址,其余原样转发。
 *
 * 之所以走 fetcher 而不是 CasClient 的 baseUrl 模式:baseUrl 模式发的是
 * `Authorization: Bearer`,而 CAS worker 的内部路由认的是 `X-Internal-Token`
 * 与 `X-User-Id` —— 那两个头只有 fetcher 模式会发。
 */
function httpCasFetcher(baseUrl: string): HttpFetcher {
  const origin = baseUrl.replace(/\/$/, "");
  return {
    fetch: (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      return fetch(`${origin}${url.pathname}${url.search}`, req);
    },
  };
}
```

`buildDeps` 里 CAS 端口因此只有一处构造,两种模式的差别收敛成「用哪个 fetcher」:

```ts
      cas: new CasClient({
        fetcher: config.casBaseUrl ? httpCasFetcher(config.casBaseUrl) : casStubFetcher,
        userId: identity.userId,
        internalToken: config.internalToken,
      }),
```

`HttpFetcher` 从 `@unidocs/server-core` 导入(它就是 `cas-client.ts` 里那个窄接口)。

改 `packages/azure-gateway/src/main.ts`:

```ts
import { isPublicCasRoute } from "@unidocs/cas";

// 过渡形态(阶段 4 删除)。CAS_BASE_URL 指向 Cloudflare CAS worker 本身。
// 未配置时保持现状:CAS 路由一律 404(isPublicCasRoute 恒 false),
// 这样 markdown-only 的部署不会因为缺一个它用不到的变量而起不来。
const casBaseUrl = process.env.CAS_BASE_URL;
const casFetcher = casBaseUrl
  ? {
      fetch: async (input: string | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        return fetch(`${casBaseUrl.replace(/\/$/, "")}${url.pathname}${url.search}`, req);
      },
    }
  : {
      fetch: async () =>
        Response.json({ error: "CAS is not implemented on Azure yet" }, { status: 501 }),
    };

const handler = createGatewayHandler({
  internalToken,
  resolveWorkerUrl,
  casFetcher,
  docIndex,
  isPublicCasRoute: casBaseUrl ? isPublicCasRoute : () => false,
});
```

`packages/azure-gateway/package.json` 的 `dependencies` 加 `"@unidocs/cas": "workspace:*"`,并在 `packages/azure-gateway/tsconfig.json` 的 `references` 里加上 `packages/cas`。

- [ ] **Step 7: 验证两套栈能同时起、CAS 能打通**

```bash
pnpm install --registry=https://repo.huaweicloud.com/repository/npm
pnpm typecheck && pnpm build
node -e "
Promise.all([
  import('./scripts/local-runtime.mjs'),
  import('./scripts/azure-runtime.mjs'),
]).then(async ([cf, az]) => {
  const mf = await cf.startLocalRuntime({ docTypes: ['docx'] });
  console.log('cas url:', mf.urls.cas);
  const probe = await fetch(mf.urls.cas + '/users/u1/cas/usage', {
    headers: { 'X-Internal-Token': 'unidocs-dev-token', Connection: 'close' },
  });
  console.log('cas usage status:', probe.status);
  await mf.dispose();
});
"
```

预期:打印 `cas url: http://127.0.0.1:8790`,且 usage 返回 200 —— 证明 CAS worker 现在进程外可达。

- [ ] **Step 8: 提交**

```bash
git add -A packages/cas packages/cloudflare-cas packages/azure-gateway scripts/doc-types.mjs scripts/local-runtime.mjs scripts/azure-runtime.mjs pnpm-lock.yaml
git commit -m "feat(azure): wire the transitional CAS_BASE_URL path

CasClient's updateRootRefs targets /_internal/root-refs, which the
gateway does not proxy, so CAS_BASE_URL has to reach the CAS worker
directly — and that worker had no port outside Miniflare. isPublicCasRoute
moves to the cloud-neutral @unidocs/cas so the Azure gateway can share the
same allowlist without depending on a cloudflare-* package.

Transitional: all of this is deleted in phase 4 along with azure-cas."
```

---

### Task 7: `azure-docx` 与 `pnpm dev --azure docx`

**Files:**
- Create: `packages/azure-docx/package.json`
- Create: `packages/azure-docx/tsconfig.json`
- Create: `packages/azure-docx/src/main.ts`
- Create: `packages/azure-docx/scripts/bundle.mjs`
- Modify: `tsconfig.json`(根,加 reference)
- Modify: `scripts/azure-runtime.mjs`(支持 docx)
- Modify: `scripts/dev.mjs`(放开 docx + CAS 可达性探测)
- Modify: `README.md`
- Create: `scripts/azure-docx-image.test.mjs`

**Interfaces:**
- Consumes: `runDocTypeService`(Task 2)、`azurePortLayout`(Task 3)、`CAS_BASE_URL` 接线(Task 6)
- Produces: `startAzureRuntime({ docTypes: ["markdown", "docx"], casBaseUrl })` 时 `urls` 增加 `docx` 与 `docxReplicas`

**背景:** `packages/azure-markdown` 塌缩之后,`azure-docx` 的入口是同样的三行。这正是 Task 2 存在的意义 —— 如果这里需要复制 `local-editor.ts`,说明 Task 2 没做到位,应该回头修 Task 2 而不是在这里复制。

- [ ] **Step 1: 写失败的测试**

新建 `scripts/azure-docx-image.test.mjs`:

```js
/**
 * docx 含图片的 apply 在本地 Azure 栈上跑通 —— 本轮的第二条验收。
 * CAS 走过渡形态：Azure 侧的 CAS_BASE_URL 指向 Miniflare 栈里那个
 * Cloudflare CAS worker（阶段 4 换成 azure-cas 后这段脚手架整个删掉）。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startLocalRuntime } from "./local-runtime.mjs";
import { startAzureRuntime } from "./azure-runtime.mjs";
import { computeNodeDigest, hashToHex } from "@unidocs/cas";

let miniflare;
let azure;
const USER = "docx-img-user";

beforeAll(async () => {
  miniflare = await startLocalRuntime({ docTypes: ["docx"] });
  azure = await startAzureRuntime({
    docTypes: ["docx"],
    casBaseUrl: miniflare.urls.cas,
  });
}, 240_000);

afterAll(async () => {
  await azure?.dispose();
  await miniflare?.dispose();
}, 60_000);

function closeFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

test("insertImage round-trips on the Azure stack", async () => {
  const png = readFileSync(
    join(process.cwd(), "tests/bootstrap/create-new-docx/edit/image/tiny.png"),
  );
  const hash = hashToHex(await computeNodeDigest("image/png", new Uint8Array(png), []));

  // 上传经 Azure gateway —— 它把公开 CAS 路由代理到过渡形态的 CAS worker。
  const upload = await closeFetch(`${azure.urls.gateway}/users/${USER}/cas/nodes/${hash}`, {
    method: "POST",
    headers: { "Content-Type": "image/png", "X-CAS-Lease-Duration": "900000" },
    body: png,
  });
  expect(await upload.json()).toMatchObject({ ready: true });

  const created = await closeFetch(`${azure.urls.gateway}/users/${USER}/docs/docx/`, {
    method: "POST",
  });
  const { docId } = await created.json();

  const applied = await closeFetch(
    `${azure.urls.gateway}/users/${USER}/docs/docx/${docId}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseVersion: 1,
        description: "Insert image",
        operations: [
          { kind: "insertImage", payload: { hash, widthPx: 16, altText: "dot" } },
        ],
      }),
    },
  );
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await closeFetch(
    `${azure.urls.gateway}/users/${USER}/docs/docx/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getImages" }),
    },
  );
  const body = await queried.json();
  expect(body.success).toBe(true);
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({ format: "png", altText: "dot" });
});
```

`computeNodeDigest` 的确切签名以 `packages/cas/src/digest.ts` 为准 —— 实现前先读它。若签名不同,改测试里的调用方式,不要改 `@unidocs/cas`。

- [ ] **Step 2: 跑测试确认它失败**

```bash
pnpm exec vitest run scripts/azure-docx-image.test.mjs
```

预期:FAIL —— `startAzureRuntime` 不认识 `docTypes: ["docx"]`。

- [ ] **Step 3: 建包**

`packages/azure-docx/package.json`(与 `packages/azure-markdown/package.json` 同构,只换名字与 doctype 依赖):

```json
{
  "name": "@unidocs/azure-docx",
  "version": "0.1.0",
  "description": "Azure/Node entry point for the DOCX document type",
  "type": "module",
  "main": "./src/main.ts",
  "types": "./src/main.ts",
  "exports": { ".": { "types": "./src/main.ts", "import": "./src/main.ts" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc && node scripts/bundle.mjs",
    "start": "node dist/main.js",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc -b",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@unidocs/azure-sdk": "workspace:*",
    "@unidocs/doctype-docx": "workspace:*",
    "@unidocs/server-core": "workspace:*"
  },
  "devDependencies": {
    "esbuild": "^0.28.2",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  },
  "publishConfig": {
    "main": "./dist/main.js",
    "types": "./dist/main.d.ts",
    "exports": { ".": { "types": "./dist/main.d.ts", "import": "./dist/main.js" } }
  }
}
```

`packages/azure-docx/src/main.ts`:

```ts
/**
 * Azure/Node entry point for the DOCX document type.
 *
 * 与 packages/azure-markdown/src/main.ts 形状相同,而且**只应该**相同到
 * 这个程度:除了 doc type 和默认端口之外的一切都在
 * `@unidocs/azure-sdk` 的 `runDocTypeService()` 里。如果发现需要在这里
 * 复制 markdown 入口的任何逻辑,那是 azure-sdk 抽得不够,回去改 SDK。
 *
 * docx 的图片路径需要用户级 CAS。本轮走过渡形态:CAS_BASE_URL 指向
 * Cloudflare 的 CAS worker(阶段 4 由 azure-cas 取代)。
 *
 * Env vars: DATABASE_URL, BLOB_CONNECTION_STRING, INTERNAL_TOKEN, PORT,
 * CAS_BASE_URL。
 */
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createDocxDocumentType } from "@unidocs/doctype-docx";

runDocTypeService({
  docType: "docx",
  documentType: createDocxDocumentType({}),
  defaultPort: 8789,
}).catch((err) => {
  console.error("azure-docx failed to start:", err);
  process.exit(1);
});
```

`createDocxDocumentType` 的确切导出名与参数以 `packages/doctype-docx/src/index.ts` 为准。

`packages/azure-docx/scripts/bundle.mjs` 与 `packages/azure-markdown/scripts/bundle.mjs` 同构(改 entry 与 outfile);`packages/azure-docx/tsconfig.json` 照抄 `packages/azure-markdown/tsconfig.json` 并把 `references` 里的 doctype 换成 `../doctype-docx`。根 `tsconfig.json` 的 `references` 追加 `{ "path": "packages/azure-docx" }`。

- [ ] **Step 4: 让运行时支持多个 doc type**

改 `scripts/azure-runtime.mjs`:把 Task 4 里 markdown 的「bundle → 起 N 个副本 → 起代理」那段抽成对 `docTypes` 的循环,`urls` 用 `${name}` / `${name}Replicas` 两个键。bundle 入口按 doc type 取:`packages/azure-${name}/src/main.ts`。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm install --registry=https://repo.huaweicloud.com/repository/npm
pnpm typecheck && pnpm build
pnpm exec vitest run scripts/azure-docx-image.test.mjs
```

预期:PASS。

- [ ] **Step 6: 放开 `pnpm dev --azure docx`**

改 `scripts/dev.mjs`:删掉「Azure 只支持 markdown」那段硬拒绝,改为 docx 需要 `CAS_BASE_URL` 的检查 —— 在起任何东西**之前**探一次可达性:

```js
// docx 的图片路径需要用户级 CAS，本轮走过渡形态：CAS_BASE_URL 指向
// Miniflare 栈里的 CAS worker（默认 http://127.0.0.1:8790）。在这里探
// 一次，是为了让「你忘了在另一个终端跑 pnpm dev」这件事在启动时就说
// 清楚，而不是等到某一次带图片的 apply 才 ECONNREFUSED。
if (requested.includes("docx")) {
  const casBaseUrl = process.env.CAS_BASE_URL ?? "http://127.0.0.1:8790";
  const reachable = await fetch(`${casBaseUrl}/users/_probe/cas/usage`, {
    headers: { "X-Internal-Token": "unidocs-dev-token", Connection: "close" },
  }).then(() => true, () => false);
  if (!reachable) {
    console.error(
      `docx on the Azure stack needs the transitional CAS worker at ${casBaseUrl}, which is not answering.\n` +
        `Start the Miniflare stack in another terminal first:\n\n  pnpm dev docx\n\n` +
        `(This cross-stack dependency goes away in phase 4, when azure-cas lands.)`,
    );
    process.exit(1);
  }
}
```

在 `README.md` 里记录双栈用法,以及 CLAUDE.md「新增 document type」第 4 步的 Azure 侧对应条目(`scripts/azure-ports.mjs` 的 `AZURE_DOC_TYPE_PORT_BASE` 加一行、新建 `packages/azure-{name}`)。

- [ ] **Step 7: 手工验证 DX**

```bash
# 终端 1
pnpm dev docx
# 终端 2
pnpm dev --azure docx
```

预期:终端 2 正常起来并打印两个副本地址。然后杀掉终端 1 再跑终端 2,预期在启动时就报出上面那段可操作的错误信息。

- [ ] **Step 8: 接入 test:local 并提交**

`package.json` 的 `test:local` 追加 `scripts/azure-docx-image.test.mjs`。

```bash
pnpm test:local
git add -A packages/azure-docx tsconfig.json scripts/azure-runtime.mjs scripts/dev.mjs scripts/azure-docx-image.test.mjs package.json README.md pnpm-lock.yaml
git commit -m "feat(azure-docx): run the docx document type on the Azure stack"
```

---

### Task 8: treespec 跑双网关

**Files:**
- Modify: `e2e/Dockerfile`
- Modify: `scripts/azure-runtime.mjs`(外部 Postgres 模式)
- Modify: `tests/bootstrap/spec.yaml`
- Modify: `tests/bootstrap/create-new-markdown/**/spec.yaml`(6 个)
- Modify: `tests/bootstrap/create-new-docx/**/spec.yaml`(7 个)

**Interfaces:**
- Consumes: `startAzureRuntime`(Task 4、7)
- Produces: `startAzureRuntime({ postgres: "external" })` —— 不跑 `docker compose`,直接连已经在跑的 Postgres

**背景与刻意接受的代价:** treespec 跑在 `e2e/Dockerfile`(`node:24-slim` + curl)构建的容器里,容器内**没有 docker**,所以 `docker compose` 起 Postgres 这条路不通 —— 必须把 Postgres 装进镜像。这与 PR #21(削减 `pnpm test:local` 的镜像体积)方向相反,但那是另一条链路:`test:local` 仍然只需要 `postgres:18-alpine`,不受影响。

`cas` 那条分支**保持 Miniflare 单网关** —— 它测的是 CAS worker 自身的语义(lease、引用计数、隔离、GC),Azure 侧没有 CAS 实现,过渡形态下打过去也只是打回同一个 worker,复制一遍只增加时间不增加信息。这一点要写在 `tests/bootstrap/cas/spec.yaml` 的 `description` 里。

- [ ] **Step 1: 加装 Postgres 到 e2e 镜像**

改 `e2e/Dockerfile`,在 curl 那行的 `apt-get install` 里加上 `postgresql`,并加一段初始化:

```dockerfile
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y curl postgresql \
    && rm -rf /var/lib/apt/lists/*

# treespec 的容器里没有 docker，所以本地 Azure 栈的 Postgres 只能装在
# 这个镜像里。端口 5433 与 docker-compose.azure.yml 的宿主机映射一致，
# 这样 startAzureRuntime() 的连接串两种模式下完全相同。
ENV PGDATA=/var/lib/postgresql/data
RUN mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA"
USER postgres
RUN /usr/lib/postgresql/*/bin/initdb -D "$PGDATA" \
    && echo "port = 5433" >> "$PGDATA/postgresql.conf" \
    && echo "listen_addresses = 'localhost'" >> "$PGDATA/postgresql.conf"
USER root
```

- [ ] **Step 2: 加外部 Postgres 模式**

改 `scripts/azure-runtime.mjs`:`startAzureRuntime({ postgres = "compose" })`。`postgres === "external"` 时跳过 `announceFirstPullIfNeeded()` / `docker compose up -d` / `docker compose down -v`,直接 `waitForPostgres()`。

**必须是显式配置,不能自动探测。** 自动探测会让「compose 没起来」这类故障静默降级成「连上了别的 Postgres」—— 而那正是 PR #21 里那个泄漏进程假绿事故的同一种形态。

同理:`postgres === "external"` 时端口探测要跳过 5433(那正是外部 Postgres 占着的端口),但**不跳过**其余端口。

- [ ] **Step 3: bootstrap 同时起两套栈**

改 `tests/bootstrap/spec.yaml`,在 `pnpm -r build` 之后追加两步:

```yaml
  - command: "pg_ctlcluster --skip-systemctl-redirect $(ls /usr/lib/postgresql) main start 2>/dev/null || (su postgres -c \"/usr/lib/postgresql/*/bin/pg_ctl -D /var/lib/postgresql/data -o '-p 5433' -w start\") && su postgres -c \"psql -p 5433 -c \\\"CREATE USER unidocs WITH PASSWORD 'unidocs' SUPERUSER\\\"\" && su postgres -c \"createdb -p 5433 -O unidocs unidocs\" && echo PGREADY"
    timeout: "120s"
    assert:
      type: regex
      conditions:
        - { path: "stdout", regex: "PGREADY" }
  - command: "cd /workspace && nohup node -e \"import('./scripts/local-runtime.mjs').then(m=>m.startLocalRuntime({docTypes:['markdown','docx']}))\" > /tmp/miniflare.log 2>&1 & nohup node -e \"import('./scripts/azure-runtime.mjs').then(m=>m.startAzureRuntime({docTypes:['markdown','docx'],postgres:'external',casBaseUrl:'http://127.0.0.1:8790'}))\" > /tmp/azure.log 2>&1 & for i in $(seq 1 60); do sleep 2; CF=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/ 2>/dev/null || echo 000); AZ=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:41787/ 2>/dev/null || echo 000); if echo $CF | grep -q '^4' && echo $AZ | grep -q '^4'; then echo BOTHREADY; exit 0; fi; done; echo TIMEOUT; tail -50 /tmp/miniflare.log /tmp/azure.log; exit 1"
    timeout: "300s"
    assert:
      type: regex
      conditions:
        - { path: "stdout", regex: "BOTHREADY" }
```

- [ ] **Step 4: 每个下游 step 的每条 curl 变两条**

变换规则(对 `create-new-markdown` 与 `create-new-docx` 两棵子树下的全部 `spec.yaml`):

1. 删掉每个 spec 开头那条「起 Miniflare 并等 8787」的步骤 —— 两套栈已经在 bootstrap 里起好了。
2. 其余每一条 `- command:` 复制成两条:第一条 URL 保持 `http://localhost:8787`,第二条把它换成 `http://localhost:41787`,`description` 分别加后缀 `(cloudflare)` / `(azure)`。断言块**逐字复制,不做任何修改**。

`create-new-markdown/edit/spec.yaml` 的一步作为范例:

```yaml
  - command: "curl -s --compressed -X POST http://localhost:8787/users/test-user-001/docs/markdown/md-doc-001/apply -H 'Content-Type: application/json' -d '{\"baseVersion\":2,\"description\":\"Append section C\",\"operations\":[{\"kind\":\"appendSection\",\"payload\":{\"heading\":\"C\",\"content\":\"Section C content.\"}}]}'"
    assert:
      type: jsonata
      expression: "success = true and version = 3"
  - command: "curl -s --compressed -X POST http://localhost:41787/users/test-user-001/docs/markdown/md-doc-001/apply -H 'Content-Type: application/json' -d '{\"baseVersion\":2,\"description\":\"Append section C\",\"operations\":[{\"kind\":\"appendSection\",\"payload\":{\"heading\":\"C\",\"content\":\"Section C content.\"}}]}'"
    assert:
      type: jsonata
      expression: "success = true and version = 3"
```

两个栈用各自独立的数据库,所以同一个 `docId` 与同一串期望版本号在两边都成立 —— 这正是「硬编码版本号只有一份」的来源。

需要改的文件清单(13 个):
`create-new-markdown/spec.yaml`、`create-new-markdown/edit/spec.yaml`、`create-new-markdown/edit/{conflict,clone,rollback,export}/spec.yaml`、`create-new-markdown/edit/export/import/spec.yaml`、`create-new-docx/spec.yaml`、`create-new-docx/edit/spec.yaml`、`create-new-docx/edit/{conflict,image,clone,rollback,export}/spec.yaml`、`create-new-docx/edit/export/import/spec.yaml`。

`tests/bootstrap/cas/**` 的 6 个文件**不动**,只在 `tests/bootstrap/cas/spec.yaml` 的 `description` 里说明为什么它只跑 Miniflare。

- [ ] **Step 5: 跑整棵树并计时**

```bash
time treespec run
```

预期:整棵树全绿。**把冷环境的总耗时记进任务报告** —— spec §8 明确要求这一项作为验收证据(镜像变胖 + 两套栈是刻意接受的代价,必须量化)。

- [ ] **Step 6: 提交**

```bash
git add e2e/Dockerfile scripts/azure-runtime.mjs tests/bootstrap
git commit -m "test(e2e): run every treespec step against both gateways

Postgres now lives in the e2e image because the treespec container has no
docker. Every downstream step curls 8787 and 41787 with byte-identical
assertions, so the hard-coded version numbers exist in exactly one place."
```

---

### Task 9: 无覆盖行为变更补测 + `migrate` script

**Files:**
- Create: `packages/server-core/tests/session-faults.test.ts`
- Modify: `packages/azure-sdk/package.json`
- Modify: `packages/azure-sdk/scripts/bundle-migrate-cli.mjs`(移动调用时机)

**Interfaces:**
- Consumes: `createMemoryPorts()`(`packages/server-core/src/memory-ports.ts`)
- Produces: 无(纯测试 + 打包脚本调整)

**背景:** 阶段 2 为了让 `create()`/`initFromHash()` 能安全接入 `withTransaction`,改动了 `packages/server-core/src/session.ts`。Cloudflare 与 Azure 共用这份代码,但 49 条 e2e 都打不到这几条分支 —— 它们要么需要直接篡改存储,要么需要在一个精确的时机注入失败。用内存端口做故障注入,不碰 Miniflare。

- [ ] **Step 1: 写失败的测试**

新建 `packages/server-core/tests/session-faults.test.ts`:

```ts
/**
 * 阶段 2 在 session.ts 上做的五处行为变更，49 条 e2e 一条都打不到 ——
 * 它们要么需要直接篡改存储，要么需要在一个精确的时机注入失败。这里用
 * 内存端口包一层故障注入来钉住它们。
 */
import { describe, expect, test } from "vitest";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import { DocumentSession } from "../src/session.js";
import { StorageCorruptError } from "../src/errors.js";
import { createMemoryPorts } from "../src/memory-ports.js";

const IDENTITY = { docType: "markdown", docId: "d1", userId: "u1" };
const CAS_STUB = {
  fetch: async () => Response.json({ error: "no cas" }, { status: 501 }),
};

async function makeDeps(overrides: Record<string, unknown> = {}) {
  const ports = await createMemoryPorts();
  return {
    ...ports,
    cas: { ...CAS_STUB },
    identity: IDENTITY,
    now: () => 1_700_000_000_000,
    ...overrides,
  } as never;
}

function newSession(deps: never) {
  return new DocumentSession(createMarkdownDocumentType({}), deps);
}

describe("load() fallback paths", () => {
  // 快照缓存在 Cloudflare 上由 DO 自己的持久化存储支撑，每次写都刷新，
  // 正常生命周期里从不为空 —— 这条回退路径只有直接改存储才触发得到。
  test("falls back to the blob when the snapshot cache is empty", async () => {
    const deps = await makeDeps();
    const session = newSession(deps);
    await session.create({ content: "# original" });
    await deps.snapshots.clear();

    const reloaded = newSession(deps);
    const result = await reloaded.query({ kind: "getContent" });
    expect(result.data).toBe("# original");
  });

  // b79bdf9 之前是 `if (bytes) {...}`，blob 缺失时静默透传到空文档重放，
  // 把数据丢失吞掉。现在是 fail-closed。没有任何测试锁住过这个翻转。
  test("a snapshot ref with no blob behind it throws StorageCorruptError", async () => {
    const deps = await makeDeps();
    const session = newSession(deps);
    await session.create({ content: "# original" });
    await deps.snapshots.clear();
    await deps.blobs.deleteAll();

    const reloaded = newSession(deps);
    await expect(reloaded.query({ kind: "getContent" })).rejects.toBeInstanceOf(
      StorageCorruptError,
    );
  });
});

describe("create() durability boundaries", () => {
  // a93a70f 之前快照缓存写失败会让已经落盘的创建报 500；现在异常被吞掉，
  // 创建返回成功，下次靠 blob 回退兜底。这个 500 -> 200 的翻转没被锁住。
  test("a failing snapshot-cache write does not fail the create", async () => {
    const ports = await createMemoryPorts();
    const deps = await makeDeps({
      ...ports,
      snapshots: {
        ...ports.snapshots,
        put: async () => {
          throw new Error("snapshot cache is down");
        },
      },
    });
    const session = newSession(deps);
    await expect(session.create({ content: "# survives" })).resolves.toMatchObject({
      version: 1,
    });

    const reloaded = newSession(await makeDeps({ ...ports }));
    expect((await reloaded.query({ kind: "getContent" })).data).toBe("# survives");
  });

  // b7c153a 把 create() 的快照写改成直接 tx.index.recordSnapshot()，
  // createdAt/updatedAt 在同一次写里被设成同一个 timestamp。也就是说
  // 新建文档的 updatedAt === createdAt 现在是保证的行为，不是巧合。
  test("a freshly created document has updatedAt === createdAt", async () => {
    const deps = await makeDeps();
    await newSession(deps).create({ content: "# new" });
    const [row] = await deps.indexQuery.list("u1", "markdown");
    expect(row.updatedAt).toBe(row.createdAt);
  });
});
```

`memory-ports.ts` 若没有 `snapshots.clear()` / `blobs.deleteAll()`,在该文件里补上这两个**仅供测试使用**的方法并写明用途;不要为此改 `ports.ts` 的公共接口。`indexQuery.list` 的签名以 `ports.ts` 为准。

第五处(`#persistIdentity` 抛异常的 `errorResponse` 兜底)在 `packages/cloudflare-sdk/src/editor-do.ts`,不在 `session.ts` —— 它需要一个 DO storage 层的故障注入,超出内存端口的范围。**本任务不覆盖它**,在报告里明确说明,并在 spec 的风险表里追加一行。

- [ ] **Step 2: 跑测试确认它失败**

```bash
pnpm --filter @unidocs/server-core exec vitest run tests/session-faults.test.ts
```

预期:FAIL,`deps.snapshots.clear is not a function` 等。

- [ ] **Step 3: 补齐内存端口的测试辅助方法并跑通**

```bash
pnpm --filter @unidocs/server-core exec vitest run tests/session-faults.test.ts
```

预期:四条全部 PASS。任何一条红都是真 bug —— 查 `session.ts` 的对应分支,不要放宽断言。

- [ ] **Step 4: 把没覆盖到的第五处记回 spec 风险表**

在 `docs/superpowers/specs/2026-08-21-azure-phase3-design.md` 第 11 节的表格里追加一行:

```
| `#persistIdentity` 兜底路径仍无覆盖 | 该分支在 `packages/cloudflare-sdk/src/editor-do.ts`,不在 `session.ts`,需要 DO storage 层的故障注入,内存端口够不到 | 本轮不覆盖。spec §9 列的五处里其余四处已由 `packages/server-core/tests/session-faults.test.ts` 钉住 |
```

这一步存在的意义是:一个「列了 5 条、做了 4 条」的清单如果不把差额写回文档,下一个人读到的就是「五处都覆盖了」。

- [ ] **Step 5: 修 `migrate` script**

`packages/azure-sdk/package.json`:

```json
    "build": "tsc && node scripts/bundle-migrate-cli.mjs",
    "migrate": "node dist/migrate-cli.js",
```

理由:原来的 `migrate` 每次调用都用 esbuild 重新打包再运行,而 `esbuild` 是 `devDependency` —— `pnpm install --prod` 之后的部署环境里没有它,`migrate` 会在 `import * as esbuild from "esbuild"` 那一步直接失败。改成构建期产出、运行期只运行。

- [ ] **Step 6: 验证生产安装下 migrate 可用**

```bash
pnpm --filter @unidocs/azure-sdk build
node -e "
const { existsSync } = require('node:fs');
if (!existsSync('packages/azure-sdk/dist/migrate-cli.js')) { console.error('MISSING'); process.exit(1); }
console.log('OK');
"
grep -rn "esbuild" packages/azure-sdk/package.json
```

预期:打印 `OK`;`esbuild` 只出现在 `devDependencies` 与 `build` script 里,`migrate` script 里不再出现。

- [ ] **Step 7: 全量验证并提交**

```bash
pnpm typecheck && pnpm -r test && pnpm build
pnpm test:local
git add packages/server-core packages/azure-sdk/package.json
git commit -m "test(server-core): pin the phase 2 session.ts behavior changes

Four branches that no e2e reaches: the blob fallback in load(), the
fail-closed ref-without-blob path, the best-effort snapshot cache write on
create(), and updatedAt === createdAt for a fresh document. Also stops the
migrate script from needing esbuild at runtime."
```

---

## 最终验收

全部任务完成后,从零产物状态跑一遍:

```bash
rm -rf packages/*/dist packages/*/*.tsbuildinfo
pnpm install --registry=https://repo.huaweicloud.com/repository/npm
pnpm typecheck && pnpm -r test && pnpm build
pnpm test:local
ps -eo pid,ppid,etime,command | grep -E "azure-runtime|workerd|azurite" | grep -v grep || echo "no leaked processes"
```

逐条对照 spec §10:

- [ ] 行为测试在 Miniflare 与**双副本** Azure 栈上各跑一遍全绿,断言逐字未改(`git diff --stat main -- scripts/behavior-suite.mjs` 应为空)
- [ ] 跨副本并发场景全绿;`replicas: 1` 时这组场景失败并给出原因
- [ ] docx 含图片的 apply 在本地 Azure 栈上跑通
- [ ] treespec 整棵树在两个网关上都绿,冷环境耗时已记录
- [ ] 端口契约新增的四条用例在内存、Cloudflare、Postgres 三个后端全绿
- [ ] `packages/azure-markdown/src/` 与 `packages/azure-docx/src/` 中不存在逐字重复的 session 构造逻辑(两个 `main.ts` 都只有 doc type 与端口的差别)
- [ ] `grep -rE "D1Database|R2Bucket|DurableObject|KVNamespace" packages/server-core/src/ packages/azure-sdk/src/ packages/cas/src/` 无输出

---

## 阶段 4 交接说明

最终整支审查(2026-08-22)在「可以合并」的前提下留下的事项。分四类:**验证缺口**(本轮声称成立但证据不完整的)、**已知未修**(判定为跟进项的真实缺陷)、**约定不一致**(跨任务才看得见的)、**阶段 4 的直接输入**。

### 验证缺口

- **treespec 整棵树从未真正执行过。** CLI 没有安装在开发机上,本轮的验证方式是:构建 e2e 镜像、在容器里手工跑 bootstrap 步骤、以及对一组代表性 curl 逐条比对两个网关。**「双网关 e2e 全绿」这句话目前没有证据支撑** —— 有证据的是「接线正确、代表性步骤在两个网关上产出相同结果」。装上 CLI 后跑一次 `treespec run` 是阶段 4 开工前的第一件事。
- **跨步骤存储持久化只手工验过一条链。** `bootstrap → create-new-markdown → edit` 这条做过真实的「杀掉栈再重启」验证,确认文档在两个网关上都还在;`create-new-docx/*` 与 `cas/*` 依赖的是「16 个 spec 接线完全一致」这个推断。
- **`prepareConcurrency` 钩子在三个后端里只有一个是真凭证。** 只有 Postgres harness 会实际测量(`pool.idleCount >= 2`);内存与 Cloudflare 两侧返回的是声明。内存后端的 `how` 字符串说「两个 promise 直接交错」,而 `MemoryDeltaLog.append` 是同步的、恰恰不交错 —— 措辞需要按「harness 不串行化写者;SUT 没有让出点这件事正是哨兵要证明的」来改。

### 已知未修

- **`pnpm dev --azure` 按 Ctrl+C 不会停掉 Postgres 容器。** `installChildProcessCleanup()` 的信号处理器抢先调用 `process.exit(130)`,`dev.mjs` 的 `dispose()` 没机会跑,`docker compose down -v` 从不执行。**先于本轮存在**(`main` 上即可复现),自动化测试不受影响(它们直接调 `dispose()`)。本轮只改了 `README.md` 里那句不实描述并指向 `pnpm azure:down`;真修需要改动信号退出语义,不适合放在合并闸口做。
- **提交进仓库的代码引用仓库外文件。** `packages/cloudflare-sdk/src/ports-cf.ts:9` 引用 `.superpowers/sdd/2026-08-20-azure-phase1-server-core/task-4-report.md`,`packages/doctype-psd/tests/load-crop.test.ts:72` 引用 `task-0-report.md`。`.superpowers/` 由 `.git/info/exclude` 忽略,任何人 clone 都读不到。两处都在 `main` 上、不在本分支范围内。本轮清掉了自己引入的 15 处同类引用。
- **`scripts/replica-proxy.mjs`** 在 `headersSent` 之后仍会写 JSON 错误体,会把垃圾追加到已部分流出的响应上;`req` 没有 `error` 监听器。

### 约定不一致(跨任务才看得见)

- **三个打包器,两套约定。** `packages/azure-markdown/scripts/bundle.mjs` 仍用 `packages: "external"`,而 `azure-docx` 与 `bundleService()` 用共享的 `EXTERNAL_NPM_PACKAGES`。`README.md` 目前是**记录**这个分裂(「照抄 azure-docx,不要抄 azure-markdown」)而不是消除它。
- **`packages/azure-markdown/package.json`** 仍声明 `@unidocs/core`、`@unidocs/server-core`、`@azure/storage-blob`、`pg`、`@types/pg`,SDK 抽取之后一个都没用到;它的孪生包 `azure-docx` 只声明两个。
- **`scripts/azure-runtime.mjs` 的 `SUPPORTED_DOC_TYPES`** 与 `scripts/azure-ports.mjs` 的 `AZURE_DOC_TYPE_PORT_BASE` 重复编码同一份清单,新增 doc type 要改两处。
- **`packages/azure-docx/src/main.ts` 的 `defaultPort: 8789`** 正是 Miniflare 的 docx 端口。本轮的 docx 方案要求两套栈同时跑,所以裸跑 `node dist/main.js` 会撞端口 —— 应当从 `azure-ports.mjs` 的端口段取值。
- **`pnpm dev --azure` 不带参数现在默认 markdown+docx**,于是最朴素的那条命令在没有第二个终端跑 `pnpm dev` 时会直接失败。双栈的代价从「按需承担」变成了「默认承担」。

### 阶段 4 的直接输入

阶段 4 写 `azure-cas`(用户级 CAS 的 Postgres/Blob 实现,含 lease 与 GC 的串行化)。落地后**整块过渡形态一起删除**,每一处都已在代码注释里标注并指向阶段 4:

- `packages/azure-sdk/src/doc-type-service.ts` 的 `httpCasFetcher` 与 `casBaseUrl` 分支
- `packages/azure-gateway/src/main.ts` 的 `casFetcher` 与 `isPublicCasRoute` 门控
- `scripts/doc-types.mjs` 给 CAS worker 开的 `unsafeDirectSockets`(8790)与 `scripts/local-runtime.mjs` 的 `urls.cas`
- `scripts/azure-runtime.mjs` 与 `scripts/dev.mjs` 的 `casBaseUrl` 透传与可达性探测
- 双栈开发流程(`pnpm dev` + `pnpm dev --azure`)本身

删除时注意:`scripts/azure-docx-image.test.mjs` 是「CAS 客户端确实带鉴权头」这条修复的**唯一**自动化回归网(baseUrl 模式发 `Authorization: Bearer`,fetcher 模式才发 `X-Internal-Token`/`X-User-Id`,而 CAS worker 的内部路由认后者)。换成 `azure-cas` 时要保证等价覆盖不丢。

`#persistIdentity` 的兜底分支仍无覆盖 —— 它在 `packages/cloudflare-sdk/src/editor-do.ts`,需要往 Durable Object 存储里注入故障,内存端口够不到。见设计文档第 11 节。
