# Azure 部署隔离与单服务解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Azure 专属的非包资产收进 `azure/` 单一目录、把 Azure 集成测试移出默认门禁,并把 `infra/main.bicep` 拆成四个可独立部署的单元 —— 用 Postgres 注册表取代网关对其它模块 output 的依赖,使新增/更新一个 doc type 不必改任何中心文件、不必重启网关。

**Architecture:** 部署资产按"运维 vs 代码"分界:`azure/` 存 Bicep、Dockerfile、部署与本地栈脚本,`packages/azure-*` 只存代码。Bicep 拆成 bootstrap(身份与仓库)/ platform(数据库与环境)/ service(单个 doc type)/ gateway 四个顶层模板,各用独立 deployment 名。服务启动时把自己的内部 FQDN upsert 进 `doc_types` 表,网关带 30 秒 TTL 缓存查它。

**Tech Stack:** Bicep、Azure CLI、Container Apps、PostgreSQL、Node 24、pnpm 11、vitest

**设计文档:** `docs/superpowers/specs/2026-08-25-azure-deploy-isolation-design.md`(下称"设计")。**本计划与设计冲突时以设计为准,并停下来报告冲突。**

## Global Constraints

- **npm 源**:公网 registry 被 SNI 拦截。任何 `pnpm install` / `npm install` 必须带 `--registry=https://repo.huaweicloud.com/repository/npm/`(命令行参数,不是环境变量)。
- **不得执行任何 `az` 写操作**,除非该任务的步骤明确要求。用户当前持有通过 PIM 激活的订阅级 Owner,权限是活的 —— 手滑会真的改动线上资源。只读的 `az bicep build` / `az ... show` / `az ... list` 不受限。
- **不得执行 `docker system prune` 或删除任何镜像/容器** —— 本机有别的项目的容器在跑。
- **不得提交 `CLAUDE.md`**(由 `.git/info/exclude` 忽略),也不得写进 `.gitignore`。任何提交的文件都不得引用 `.superpowers/` 下的路径。
- **不得把任何密钥、连接串写进任何文件或日志。**
- 提交信息用中文,与仓库既有风格一致。**不要**加 `Co-Authored-By` 或任何 Claude 署名。
- **`.dockerignore` 必须留在仓库根**:Docker 只读构建上下文根目录的那一份,它同时服务 `azure/deploy/Dockerfile` 与 `tests/treespec/Dockerfile`。搬走不会报错,只会让排除规则静默失效。
- **`migrate-job.bicep` 必须保留为独立模块**,不得并入 `platform.bicep`。它的存在理由是模块边界:`@secure()` 参数拼出的连接串一旦内联进外层模板,`what-if` 会把明文打进终端与日志。
- 每个任务结束时 `pnpm build`、`pnpm typecheck`、`pnpm test` 必须通过。

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `azure/deploy/{bootstrap,platform,service,gateway,container-app,migrate-job}.bicep` | 四个部署单元 + 两个共用模块 | 1(搬迁)、3(拆分) |
| `azure/deploy/Dockerfile` | 四个 azure 服务镜像的构建配方 | 1 |
| `azure/deploy/deploy.mjs`、`smoke.mjs` | 部署编排与验收 | 1(搬迁)、5(选择器与并发) |
| `azure/local/{runtime,replica-proxy,ports}.mjs` | 本地 Azure 栈 | 1 |
| `azure/README.md` | 目录约定、`.dockerignore` 的坑、并发用法 | 1 |
| `packages/azure-sdk/docker-compose.yml` | 端口契约测试的 Postgres | 1 |
| `packages/azure-sdk/migrations/0002_doc_types.sql` | 注册表建表 | 2 |
| `packages/azure-sdk/src/registry-pg.ts` | `PgDocTypeRegistry`(读写两端) | 2 |
| `packages/azure-sdk/tests/registry.test.ts` | 注册表契约测试 | 2 |
| `packages/azure-{markdown,docx,gateway}/azure.service.json` | 各服务的部署参数 | 4 |
| `packages/azure-gateway/src/main.ts` | `resolveWorkerUrl` 改查注册表 | 4 |

---

### Task 1: 搬迁与门禁隔离

实现设计 §2。**纯搬迁,不改任何逻辑。** 这一步做完 `azure/` 目录成型,后续任务的改动面显著变小。

**背景**:Azure 的部署资产现在散在根目录 `infra/`(名字云中立、内容全是 Azure)、`scripts/azure-*.mjs`(与本地开发脚本混在一起)、根 `Dockerfile`、根 `docker-compose.azure.yml`。同时 Azure 集成测试挂在 `pnpm test:local` 默认门禁里。

**Files:**
- Move: `infra/*.bicep` → `azure/deploy/`
- Move: `Dockerfile` → `azure/deploy/Dockerfile`
- Move: `scripts/azure-deploy.mjs` → `azure/deploy/deploy.mjs`
- Move: `scripts/azure-smoke.mjs` → `azure/deploy/smoke.mjs`
- Move: `scripts/azure-runtime.mjs` → `azure/local/runtime.mjs`
- Move: `scripts/replica-proxy.mjs` → `azure/local/replica-proxy.mjs`
- Move: `scripts/azure-ports.mjs` → `azure/local/ports.mjs`
- Move: `docker-compose.azure.yml` → `packages/azure-sdk/docker-compose.yml`
- Create: `azure/README.md`
- Modify: `package.json`(`test:local` / `test:azure` / `azure:up` / `azure:down`)
- Modify: 所有引用上述路径的文件(见 Step 1 的清单)

**Interfaces:**
- Produces:`azure/deploy/deploy.mjs` 与 `azure/deploy/smoke.mjs` 的新路径,Task 5 在此基础上加选择器;`azure/deploy/*.bicep` 的新路径,Task 3 在此基础上拆分

- [ ] **Step 1: 先枚举全部引用点,不要边搬边找**

```bash
grep -rln "azure-runtime\|replica-proxy\|azure-ports\|azure-deploy\|azure-smoke\|docker-compose\.azure\|infra/\|--file Dockerfile" \
  --include="*.mjs" --include="*.ts" --include="*.json" --include="*.md" --include="*.yaml" --include="*.yml" \
  . 2>/dev/null | grep -v node_modules | grep -v "^./docs/superpowers" | sort
```

把输出存下来当清单。**特别注意 `tests/treespec/` 下的 16 个 `spec.yaml`** —— 它们在 shell 命令字符串里硬编码 `scripts/azure-runtime.mjs`,既不会被类型检查捕获,也不会被 import 解析捕获,是本次最容易漏的一批。

- [ ] **Step 2: 用 `git mv` 搬迁,保留历史**

```bash
mkdir -p azure/deploy azure/local
for f in infra/*.bicep; do git mv "$f" azure/deploy/; done
git mv Dockerfile azure/deploy/Dockerfile
git mv scripts/azure-deploy.mjs azure/deploy/deploy.mjs
git mv scripts/azure-smoke.mjs azure/deploy/smoke.mjs
git mv scripts/azure-runtime.mjs azure/local/runtime.mjs
git mv scripts/replica-proxy.mjs azure/local/replica-proxy.mjs
git mv scripts/azure-ports.mjs azure/local/ports.mjs
git mv docker-compose.azure.yml packages/azure-sdk/docker-compose.yml
rmdir infra
```

**用 `git mv` 而不是 `mv` + `git add`** —— 前者让 `git log --follow` 能追溯文件历史,这些文件里有大量解释"为什么"的注释,历史断了会让它们失去出处。

- [ ] **Step 3: 修正所有引用**

按 Step 1 的清单逐个改。已知的关键几处:

`azure/deploy/deploy.mjs` 里 Bicep 与 Dockerfile 的路径:

```js
"-f", "azure/deploy/bootstrap.bicep",     // 原 "infra/bootstrap.bicep"
"--file", "azure/deploy/Dockerfile",      // 原 "Dockerfile"
```

**构建上下文仍是仓库根(`.`),不要改**。`az acr build` 的 `--file` 与上下文本就可以分离;把上下文也搬进 `azure/deploy/` 会让它看不到 `packages/`。

`azure/deploy/deploy.mjs` 里对 smoke 的调用:

```js
run("node", ["azure/deploy/smoke.mjs", "--gateway", `https://${gatewayFqdn}`, ...]);
```

`azure/local/runtime.mjs` 与 `packages/azure-sdk/tests/containers.ts` 里的 compose 路径,两者都要指向 `packages/azure-sdk/docker-compose.yml`。注意 `containers.ts:43` 现在是 `path.resolve(__dirname, "../../../docker-compose.azure.yml")`,搬迁后它与 compose 文件同在 `packages/azure-sdk/` 下,相对深度变了。

16 个 `tests/treespec/**/spec.yaml` 里的 `scripts/azure-runtime.mjs` → `azure/local/runtime.mjs`。

- [ ] **Step 4: 改 `package.json` 的门禁**

```json
"test:local": "vitest run --fileParallelism=false tests/unit tests/integration/cloudflare tests/integration/shared",
"test:azure": "vitest run --fileParallelism=false tests/integration/azure",
"azure:up":   "docker compose -f packages/azure-sdk/docker-compose.yml up -d",
"azure:down": "docker compose -f packages/azure-sdk/docker-compose.yml down"
```

`pnpm test:local` 从此**不含任何 Azure 集成测试**。`packages/azure-sdk/tests/` 的端口契约测试仍在 `pnpm test` 里,不动。

- [ ] **Step 5: 写 `azure/README.md`**

至少要写清三件事:

1. **目录约定**:`packages/azure-*` 是代码,`azure/` 是运维与工具。删掉 `azure/` 则失去部署与本地栈能力,代码不受影响。
2. **`.dockerignore` 为什么在仓库根、为什么不能搬**:Docker 只读构建上下文根目录的那一份,而 `azure/deploy/Dockerfile` 与 `tests/treespec/Dockerfile` 的上下文都是仓库根。搬走**不会报错**,只会让排除规则静默失效 —— `node_modules`、`dist`、`.git` 会全部进入构建上下文,表现为"构建突然变慢",没人会联想到原因。
3. **`docker-compose.yml` 为什么在 `packages/azure-sdk/` 而不在 `azure/local/`**:它的第一消费者是该包的端口契约测试,而那套测试在强制门禁里;放进 `azure/` 会让"删掉 `azure/` 后 `pnpm test` 仍全绿"不成立。本地栈是借用者。

- [ ] **Step 6: 验证**

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm test:local
pnpm test:azure
az bicep build --file azure/deploy/main.bicep --stdout > /dev/null && echo "bicep ok"
```

前三条必须全绿。`pnpm test:azure` 需要 Docker 在跑(它会起 Postgres 与 Azurite)。

再确认根目录已清空:

```bash
ls infra Dockerfile docker-compose.azure.yml scripts/azure-*.mjs scripts/replica-proxy.mjs 2>&1 | grep -v "No such file" || echo "根目录已清空 ✓"
ls .dockerignore && echo ".dockerignore 仍在根目录 ✓"
```

- [ ] **Step 7: 验证 treespec 的路径改对了**

**这是 grep 级检查,不等于 e2e 真的能跑** —— 跑完整 treespec 要 Docker 构建镜像,很慢,不在本任务范围。但残留检查能抓住绝大多数搬迁遗漏(路径写错会让 spec 里的 `nohup node -e "import(...)"` 静默失败,表现为超时而非报错):

```bash
grep -rn "scripts/azure-runtime\|scripts/replica-proxy\|scripts/azure-ports" tests/ && echo "↑ 仍有残留" || echo "treespec 路径已全部更新 ✓"
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(azure): 部署与本地栈资产收进 azure/,集成测试移出默认门禁"
```

---

### Task 2: Postgres 注册表

实现设计 §4。**这一步只写注册表本身,不接线** —— 接线在 Task 4。这样拆是因为注册表可以独立测试,而接线要等 Bicep 拆分(Task 3)提供 `SELF_WORKER_URL`。

**Files:**
- Create: `packages/azure-sdk/migrations/0002_doc_types.sql`
- Create: `packages/azure-sdk/src/registry-pg.ts`
- Modify: `packages/azure-sdk/src/index.ts`(导出)
- Test: `packages/azure-sdk/tests/registry.test.ts`

**Interfaces:**
- Consumes:`Queryable`(`packages/azure-sdk/src/ports-pg.ts:30`,形状是 `query(text, values?) => Promise<{rows, rowCount}>`)
- Produces:`PgDocTypeRegistry`,构造签名 `new PgDocTypeRegistry(q: Queryable, options?: { ttlMs?: number; now?: () => number })`,方法 `register(docType: string, workerUrl: string): Promise<void>` 与 `resolve(docType: string): Promise<string | null>`。Task 4 用这两个方法接线。

- [ ] **Step 1: 写迁移 SQL**

`packages/azure-sdk/migrations/0002_doc_types.sql`:

```sql
-- doc type 服务启动时把自己的内部 FQDN upsert 进来,网关查它做路由。
-- 取代原先「网关靠 {TYPE}_WORKER_URL 环境变量找服务」的做法 —— 那个做法
-- 使得新增一个 doc type 必须改网关的环境变量,即必须重新部署网关。
--
-- 只 upsert,永不删除:一个 doc type 的 N 个副本共用同一个 ingress FQDN,
-- 写的是同一行同一值。关停时注销是错的 —— 一次滚动更新会在中间时刻把整个
-- doc type 抹掉,而此时其它副本仍在服务。
CREATE TABLE doc_types (
  doc_type   TEXT PRIMARY KEY,
  worker_url TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
```

`runMigrations()` 按文件名排序执行(`packages/azure-sdk/src/migrate.ts:52-54`),`0002_` 前缀保证它排在 `0001_init.sql` 之后。

- [ ] **Step 2: 写失败的测试**

`packages/azure-sdk/tests/registry.test.ts`。本包的 `vitest.config.ts` 有 `globalSetup` 会起 Postgres 容器,直接用即可。

```ts
/**
 * `PgDocTypeRegistry` 的契约。三条不变量:
 *   1. upsert 幂等 —— N 个副本写同一行同一值,不能报错也不能产生多行
 *   2. TTL 内不打库 —— 网关每个请求都要 resolve,不能每次往返
 *   3. 查库失败时用过期旧值 —— 地址极少变,Postgres 抖动不该让网关停摆
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createPool } from "../src/pool.js";
import { runMigrations } from "../src/migrate.js";
import { PgDocTypeRegistry } from "../src/registry-pg.js";
import { DATABASE_URL } from "./containers.js";

const pool = createPool({ databaseUrl: DATABASE_URL });

beforeEach(async () => {
  await runMigrations(pool);
  await pool.query("DELETE FROM doc_types");
});

afterEach(async () => {
  await pool.query("DELETE FROM doc_types");
});

describe("PgDocTypeRegistry", () => {
  test("register 之后 resolve 拿得到", async () => {
    const r = new PgDocTypeRegistry(pool);
    await r.register("markdown", "https://md.internal.example");
    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
  });

  test("未注册的 doc type 返回 null", async () => {
    const r = new PgDocTypeRegistry(pool);
    expect(await r.resolve("nope")).toBeNull();
  });

  // N 个副本共用同一 FQDN,会重复写同一行同一值。
  test("重复 register 同一值:幂等,只有一行", async () => {
    const r = new PgDocTypeRegistry(pool);
    await r.register("markdown", "https://md.internal.example");
    await r.register("markdown", "https://md.internal.example");
    await r.register("markdown", "https://md.internal.example");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM doc_types WHERE doc_type = $1", ["markdown"]);
    expect(rows[0].n).toBe(1);
  });

  test("register 新值:覆盖旧值", async () => {
    const r = new PgDocTypeRegistry(pool);
    await r.register("markdown", "https://old.internal.example");
    await r.register("markdown", "https://new.internal.example");
    expect(await r.resolve("markdown")).toBe("https://new.internal.example");
  });

  // 网关每个请求都 resolve,不能每次往返数据库。
  test("TTL 内不再打库", async () => {
    let queries = 0;
    const counting = {
      query: (text: string, values?: unknown[]) => { queries++; return pool.query(text, values); },
    };
    await pool.query(
      "INSERT INTO doc_types (doc_type, worker_url, updated_at) VALUES ($1, $2, $3)",
      ["markdown", "https://md.internal.example", Date.now()],
    );
    let clock = 1_000;
    const r = new PgDocTypeRegistry(counting, { ttlMs: 30_000, now: () => clock });

    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
    expect(queries).toBe(1);
    clock += 29_000;
    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
    expect(queries).toBe(1);          // 仍在 TTL 内,没有第二次查询
    clock += 2_000;
    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
    expect(queries).toBe(2);          // 过期了,重新查
  });

  // 地址极少变,Postgres 短暂不可用时网关仍应能转发。
  test("查库失败时返回过期的旧值", async () => {
    let failing = false;
    const flaky = {
      query: (text: string, values?: unknown[]) => {
        if (failing) return Promise.reject(new Error("connection terminated"));
        return pool.query(text, values);
      },
    };
    await pool.query(
      "INSERT INTO doc_types (doc_type, worker_url, updated_at) VALUES ($1, $2, $3)",
      ["markdown", "https://md.internal.example", Date.now()],
    );
    let clock = 1_000;
    const r = new PgDocTypeRegistry(flaky, { ttlMs: 30_000, now: () => clock });

    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
    failing = true;
    clock += 60_000;                  // 缓存已过期
    expect(await r.resolve("markdown")).toBe("https://md.internal.example");  // 仍拿到旧值
  });

  // 没有旧值可用时不能假装成功,必须把错误抛出去。
  test("查库失败且没有缓存过的值:抛错", async () => {
    const broken = { query: () => Promise.reject(new Error("connection terminated")) };
    const r = new PgDocTypeRegistry(broken);
    await expect(r.resolve("markdown")).rejects.toThrow(/connection terminated/);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/registry.test.ts
```

预期:FAIL,`registry-pg.js` 不存在。

- [ ] **Step 4: 实现**

`packages/azure-sdk/src/registry-pg.ts`:

```ts
import type { Queryable } from "./ports-pg.js";

/**
 * doc type → 内部 worker URL 的注册表,取代网关对 `{TYPE}_WORKER_URL`
 * 环境变量的依赖。写入方是 doc type 服务自己(启动时 upsert),读取方是
 * 网关。这是 Cloudflare 侧 KV 注册表(`cloudflare-gateway/src/worker.ts`
 * 查 `docType:{type}`)在 Azure 上的对应物。
 *
 * 缓存策略是本类的内部实现:调用方只看到 `resolve()`。将来若真需要秒级
 * 一致,可在此加 Postgres 的 LISTEN/NOTIFY —— 但注意 NOTIFY 不持久也不
 * 重放,断连期间的通知永久丢失,所以它只能叠加在 TTL 之上,不能替代 TTL。
 */
export interface PgDocTypeRegistryOptions {
  /** 缓存有效期,默认 30 秒。 */
  ttlMs?: number;
  /** 注入时钟,仅供测试。 */
  now?: () => number;
}

interface CacheEntry {
  url: string | null;
  at: number;
}

const DEFAULT_TTL_MS = 30_000;

export class PgDocTypeRegistry {
  #q: Queryable;
  #ttlMs: number;
  #now: () => number;
  #cache = new Map<string, CacheEntry>();

  constructor(q: Queryable, options: PgDocTypeRegistryOptions = {}) {
    this.#q = q;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 只 upsert,不提供删除。一个 doc type 的 N 个副本共用同一个 ingress
   * FQDN,写的是同一行同一值 —— 天然幂等,不需要协调。
   *
   * 刻意不做 `unregister()`:关停时注销会让一次滚动更新在中间时刻把整个
   * doc type 从表里抹掉,而此时其它副本仍在正常服务。下线一个 doc type
   * 是运维显式删行,不是进程退出的副作用。
   */
  async register(docType: string, workerUrl: string): Promise<void> {
    await this.#q.query(
      `INSERT INTO doc_types (doc_type, worker_url, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (doc_type) DO UPDATE
         SET worker_url = EXCLUDED.worker_url,
             updated_at = EXCLUDED.updated_at`,
      [docType, workerUrl, this.#now()],
    );
    this.#cache.delete(docType);
  }

  /**
   * 查库失败时回退到过期的缓存值(stale-while-error)。worker 地址极少
   * 变化(新增 doc type 或更换 Container Apps 环境时才变),Postgres 的
   * 短暂抖动不该让网关无法转发任何请求。
   *
   * 但没有可回退的值时必须抛错 —— 那种情况下返回 null 会被网关当成
   * 「这个 doc type 不存在」而回 404,把一个可恢复的故障伪装成永久性的
   * 客户端错误。
   */
  async resolve(docType: string): Promise<string | null> {
    const cached = this.#cache.get(docType);
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.url;

    try {
      const { rows } = await this.#q.query(
        "SELECT worker_url FROM doc_types WHERE doc_type = $1",
        [docType],
      );
      const url = rows.length > 0 ? (rows[0].worker_url as string) : null;
      this.#cache.set(docType, { url, at: this.#now() });
      return url;
    } catch (err) {
      if (cached) return cached.url;
      throw err;
    }
  }
}
```

- [ ] **Step 5: 导出**

`packages/azure-sdk/src/index.ts` 末尾加一行:

```ts
export * from "./registry-pg.js";
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm --filter @unidocs/azure-sdk exec vitest run tests/registry.test.ts
```

预期:7 个测试全部 PASS。

- [ ] **Step 7: 全量验证并提交**

```bash
pnpm build && pnpm typecheck && pnpm test
git add packages/azure-sdk
git commit -m "feat(azure-sdk): doc type 注册表(Postgres),带 TTL 缓存与失败时回退旧值"
```

---

### Task 3: 拆 Bicep

实现设计 §3.1–§3.3。**这一步只拆模板、不接注册表** —— 网关的 `resolveWorkerUrl` 在 Task 4 才改。为了让这一步可独立验证,`gateway.bicep` 暂时保留 `{TYPE}_WORKER_URL`,Task 4 再删。

**Files:**
- Create: `azure/deploy/platform.bicep`
- Create: `azure/deploy/service.bicep`
- Create: `azure/deploy/gateway.bicep`
- Delete: `azure/deploy/main.bicep`(内容分流进上面三个)
- Keep: `azure/deploy/bootstrap.bicep`、`container-app.bicep`、`migrate-job.bicep`(不改)

**Interfaces:**
- Consumes:`bootstrap.bicep` 建的 `unidocs-identity` / `unidocsacr` / `unidocsblob` / `unidocs-logs`(按名 `existing` 引用)
- Produces:`platform.bicep` 输出 `postgresFqdn`、`migrateJobName`;`service.bicep` 参数 `docType` / `targetPort` / `minReplicas` / `maxReplicas` / `imageTag` / `casBaseUrl` / `@secure() pgAdminPassword` / `@secure() internalToken`;`gateway.bicep` 输出 `gatewayFqdn`。Task 5 的部署脚本按这些名字调用。

- [ ] **Step 1: 读懂现有 `main.bicep` 的三段**

```bash
grep -n "^resource\|^module\|^output\|^var databaseUrl" azure/deploy/main.bicep
```

它由三段构成:Postgres + 防火墙 + 库 + ACA 环境(→ platform)、三个 App module(→ service ×2 + gateway)、migrateJob module(→ platform)。`var databaseUrl` 由 `@secure() pgAdminPassword` 拼成,**三段都要用**,所以每个新模板各自拼一次,不能从 output 传(那会把明文暴露在部署历史里)。

- [ ] **Step 2: 写 `platform.bicep`**

从 `main.bicep` 搬:`pg`、`pgDatabase`、`pgFirewall`、`containerEnv`、`migrateJob` module 调用、`var databaseUrl`。参数保留 `location` / `imageTag` / `pgAdminUser` / `@secure() pgAdminPassword`(迁移 Job 要用)。

输出:

```bicep
output postgresFqdn string = pg.properties.fullyQualifiedDomainName
output migrateJobName string = migrateJob.name
```

**不要输出 `databaseUrl`** —— 那会把密码写进部署历史。

- [ ] **Step 3: 写 `service.bicep`**

参数:

```bicep
@description('doc type 名,同时决定 Container App 名 unidocs-{docType} 与镜像 unidocs/azure-{docType}。')
param docType string
param location string = resourceGroup().location
param imageTag string
param targetPort int
param minReplicas int
param maxReplicas int
param casBaseUrl string = ''
param pgAdminUser string = 'unidocs'
@secure()
param pgAdminPassword string
@secure()
param internalToken string
```

`existing` 引用 `unidocs-identity` / `unidocsacr` / `unidocsblob` / `unidocs-env` / `unidocs-pg`,自己拼 `databaseUrl`,然后调 `container-app.bicep`。

关键的一段 —— 服务自知地址,这是解开耦合的核心:

```bicep
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: 'unidocs-env'
}

// Container Apps 的内部 FQDN 是 `<app名>.internal.<环境默认域>`,由 app 名
// 与环境确定性推出,不需要该 App 已存在 —— 所以这里没有先有鸡还是先有蛋的
// 问题。服务拿到它之后在启动时把自己 upsert 进 doc_types 表,网关查表路由。
// 这取代了原先「网关读 markdownApp.outputs.fqdn」的做法,那正是三个 App
// 必须在同一次部署里的根因。
var selfWorkerUrl = 'https://unidocs-${docType}.internal.${containerEnv.properties.defaultDomain}'
```

`extraEnv` 里给出 `BLOB_ACCOUNT_URL`、`AZURE_CLIENT_ID`、`SELF_WORKER_URL`,以及 `casBaseUrl` 非空时的 `CAS_BASE_URL`。**不要给 `PORT`** —— `container-app.bicep` 从 `targetPort` 派生。

输出 `output fqdn string = app.outputs.fqdn`。

- [ ] **Step 4: 写 `gateway.bicep`**

同样 `existing` 引用 + 自拼 `databaseUrl` + 调 `container-app.bicep`,`external: true`。

**本步暂时保留** `MARKDOWN_WORKER_URL` / `DOCX_WORKER_URL`,但值改为确定性推导(不能再读别的 module 的 output):

```bicep
// 过渡:Task 4 把网关改成查注册表之后,这两个变量整体删除。保留到那时是
// 为了让本任务可以独立部署验证,不制造一个「网关找不到任何服务」的中间态。
{ name: 'MARKDOWN_WORKER_URL', value: 'https://unidocs-markdown.internal.${containerEnv.properties.defaultDomain}' }
{ name: 'DOCX_WORKER_URL', value: 'https://unidocs-docx.internal.${containerEnv.properties.defaultDomain}' }
```

输出 `output gatewayFqdn string = app.outputs.fqdn`。

- [ ] **Step 5: 删掉 `main.bicep`**

```bash
git rm azure/deploy/main.bicep
```

- [ ] **Step 6: 编译校验 + 密钥回归检查**

```bash
for f in azure/deploy/*.bicep; do
  echo -n "$f: "
  az bicep build --file "$f" --stdout > /dev/null 2>&1 && echo ok || echo FAILED
done
```

六个都要 ok 且无 warning。

然后做上一轮 I1 的回归检查 —— 确认含密码的表达式**只**出现在嵌套部署的参数里:

```bash
az bicep build --file azure/deploy/platform.bicep --stdout | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
bad=[]
for r in d.get('resources',[]):
    if r.get('type')=='Microsoft.Resources/deployments': continue
    if 'pgAdminPassword' in json.dumps(r.get('properties',{})): bad.append(r.get('name'))
print('FAIL 明文落在资源属性上:', bad) if bad else print('ok:密码只出现在嵌套部署参数里')
"
```

预期:`ok`。

- [ ] **Step 7: 提交**

```bash
git add azure/deploy
git commit -m "refactor(azure): main.bicep 拆成 platform / service / gateway 三个独立部署单元"
```

---

### Task 4: 服务参数下放 + 网关改查注册表

实现设计 §3.4、§4.4、§4.5。这一步把 Task 2 的注册表接上,并完成解耦。

**Files:**
- Create: `packages/azure-markdown/azure.service.json`
- Create: `packages/azure-docx/azure.service.json`
- Create: `packages/azure-gateway/azure.service.json`
- Modify: `packages/azure-sdk/src/doc-type-service.ts`(启动时注册)
- Modify: `packages/azure-gateway/src/main.ts`(`resolveWorkerUrl` 改查注册表)
- Modify: `azure/deploy/gateway.bicep`(删掉 `{TYPE}_WORKER_URL`)

**Interfaces:**
- Consumes:Task 2 的 `PgDocTypeRegistry`;Task 3 的 `service.bicep` 注入的 `SELF_WORKER_URL`
- Produces:三个 `azure.service.json`,Task 5 的部署脚本读它们

- [ ] **Step 1: 写三个参数文件**

```jsonc
// packages/azure-markdown/azure.service.json
{ "docType": "markdown", "targetPort": 8788, "minReplicas": 2, "maxReplicas": 5 }
```

```jsonc
// packages/azure-docx/azure.service.json
{ "docType": "docx", "targetPort": 8789, "minReplicas": 2, "maxReplicas": 5 }
```

```jsonc
// packages/azure-gateway/azure.service.json
{ "external": true, "targetPort": 8787, "minReplicas": 1, "maxReplicas": 3 }
```

doc type 的 `minReplicas: 2` 是刻意的:阶段 3 证明的是多副本拓扑下的并发正确性,生产上跑单副本等于把那份保证退回未验证。

- [ ] **Step 2: doc type 服务启动时注册**

改 `packages/azure-sdk/src/doc-type-service.ts` 的 `runDocTypeService()`,在 `console.log(\`azure-${docType} listening on ...\`)` 之后加:

```ts
  // 注册发生在服务真的 listen 之后:注册表反映的是「谁真的起来了」,不是
  // 「谁被部署过」。部署成功但进程起不来时,不该在表里留一行指向死地址。
  //
  // SELF_WORKER_URL 由 service.bicep 注入(Container Apps 的内部 FQDN)。
  // 本地栈没有 Container Apps,拿不到这个值 —— 此时跳过注册,本地继续走
  // {TYPE}_WORKER_URL 环境变量的兜底路径,行为完全不变。
  const selfWorkerUrl = process.env.SELF_WORKER_URL;
  if (selfWorkerUrl) {
    const registry = new PgDocTypeRegistry(pool);
    await registry.register(docType, selfWorkerUrl);
    console.log(`azure-${docType} registered at ${selfWorkerUrl}`);
  } else {
    console.log(`azure-${docType} SELF_WORKER_URL not set — skipping registry (local mode)`);
  }
```

`pool` 需要从 `startDocTypeService` 返回或在此另建。**读 `startDocTypeService` 的现有实现决定用哪种** —— 若它已经把 pool 暴露在 handle 上就复用,否则在 `runDocTypeService` 里单独建一个只用于注册的连接并在注册后 `end()`。不要为此改 `startDocTypeService` 的签名,那会波及 `local-editor.ts`。

- [ ] **Step 3: 网关改查注册表**

`packages/azure-gateway/src/main.ts`,把:

```ts
function resolveWorkerUrl(docType: string): Promise<string | null> {
  const envKey = `${docType.toUpperCase()}_WORKER_URL`;
  return Promise.resolve(process.env[envKey] ?? null);
}
```

改为(注意它现在需要 `pool`,所以要挪进 `main()` 里或接受 registry 参数):

```ts
/**
 * 两级解析,与 Cloudflare 侧同形(`cloudflare-gateway/src/worker.ts` 先查
 * KV 的 `docType:{type}`、未命中再读环境变量)。
 *
 * 环境变量兜底保留给本地开发与临时调试:本地栈没有 Container Apps,服务
 * 不会注册,只能靠它。云上 `gateway.bicep` 不再设置这些变量 —— 若它去算
 * 那些地址,就得知道有哪些 doc type,耦合又回来了。
 */
function makeResolveWorkerUrl(registry: PgDocTypeRegistry) {
  return async (docType: string): Promise<string | null> => {
    const fromRegistry = await registry.resolve(docType);
    if (fromRegistry) return fromRegistry;
    return process.env[`${docType.toUpperCase()}_WORKER_URL`] ?? null;
  };
}
```

在 `main()` 里 `const registry = new PgDocTypeRegistry(pool);`,把 `makeResolveWorkerUrl(registry)` 传给 `createGatewayHandler`。

- [ ] **Step 4: 删掉 `gateway.bicep` 里的 `{TYPE}_WORKER_URL`**

Task 3 Step 4 留的那两行注释和变量整体删除。删掉之后 `gateway.bicep` 不再包含任何 doc type 名 —— 这是"加新 doc type 不用改中心文件"的判据。

- [ ] **Step 5: 验证本地栈行为未变**

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm test:azure
```

`pnpm test:azure` 必须仍然全绿。本地栈不设 `SELF_WORKER_URL`,所以会走"跳过注册 + 环境变量兜底"的路径 —— **这一条正是在验证本地行为不变**。

若 `test:azure` 出现新失败,先确认是不是因为注册被误执行(检查日志里有没有 `registered at`),而不是急着改测试。

- [ ] **Step 6: 提交**

```bash
git add packages/azure-markdown packages/azure-docx packages/azure-gateway packages/azure-sdk azure/deploy/gateway.bicep
git commit -m "feat(azure): 服务参数下放到各包,网关改查注册表"
```

---

### Task 5: 部署脚本的选择器与并发

实现设计 §5。

**Files:**
- Modify: `azure/deploy/deploy.mjs`
- Modify: `azure/deploy/smoke.mjs`(冒烟按服务过滤)
- Modify: `tests/unit/scripts/azure-deploy.test.mjs`

**Interfaces:**
- Consumes:Task 3 的四个模板与它们的参数名;Task 4 的三个 `azure.service.json`
- Produces:`node azure/deploy/deploy.mjs [--bootstrap|--platform|--service <a,b>|--gateway] [--build-concurrency N]`

- [ ] **Step 1: 写失败的测试**

在 `tests/unit/scripts/azure-deploy.test.mjs` 加:

```js
describe("parseArgs 选择器", () => {
  test("无参数:全量部署", () => {
    const a = parseArgs([]);
    expect(a.targets).toEqual(["bootstrap", "platform", "services", "gateway"]);
  });

  test("--service docx:只部一个", () => {
    const a = parseArgs(["--service", "docx"]);
    expect(a.targets).toEqual(["services"]);
    expect(a.services).toEqual(["docx"]);
  });

  test("--service 多选用逗号分隔", () => {
    expect(parseArgs(["--service", "docx,markdown"]).services).toEqual(["docx", "markdown"]);
  });

  test("--service 的取值必须存在对应的 azure.service.json", () => {
    expect(() => parseArgs(["--service", "nosuch"])).toThrow(/nosuch/);
  });

  test("--build-concurrency 默认 2,可覆盖", () => {
    expect(parseArgs([]).buildConcurrency).toBe(2);
    expect(parseArgs(["--build-concurrency", "1"]).buildConcurrency).toBe(1);
  });

  test("--build-concurrency 非正整数要响亮失败", () => {
    expect(() => parseArgs(["--build-concurrency", "0"])).toThrow(/build-concurrency/);
  });
});

describe("readServiceParams", () => {
  test("读 packages/azure-docx/azure.service.json", () => {
    const p = readServiceParams("docx");
    expect(p).toMatchObject({ docType: "docx", targetPort: 8789, minReplicas: 2 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm exec vitest run tests/unit/scripts/azure-deploy.test.mjs
```

预期:FAIL,`targets` / `services` / `buildConcurrency` / `readServiceParams` 都不存在。

- [ ] **Step 3: 实现选择器与参数读取**

`azure/deploy/deploy.mjs` 导出 `readServiceParams(name)`(读 `packages/azure-${name}/azure.service.json`,文件不存在时抛错并点名),`parseArgs` 增加 `targets` / `services` / `buildConcurrency`。

四个 target 用**各自独立的 deployment 名**:

```js
const DEPLOYMENT_NAMES = {
  bootstrap: "bootstrap",
  platform: "platform",
  gateway: "gateway",
  service: (docType) => `service-${docType}`,
};
```

独立的 deployment 名既让 `az deployment operation group list` 能分辨是谁改的,**也是并发部署安全的必要条件** —— 两个 `--service` 进程同时跑时,它们写的是不同的 deployment 记录。

- [ ] **Step 3b: 把 `-f` 从 `main.bicep` 换成三个新模板**

Task 3 删掉了 `azure/deploy/main.bicep`,但 `deploy.mjs` 里仍有两处 `"-f", "azure/deploy/main.bicep"`(what-if 与 create 各一处)。**不改这两处,部署脚本是坏的** —— 而 `az bicep build` 和单元测试都发现不了,只有真部署时才报"文件不存在"。

按 target 分派模板:

| target | `-f` | deployment 名 |
|---|---|---|
| bootstrap | `azure/deploy/bootstrap.bicep` | `bootstrap` |
| platform | `azure/deploy/platform.bicep` | `platform` |
| service | `azure/deploy/service.bicep` | `service-{docType}` |
| gateway | `azure/deploy/gateway.bicep` | `gateway` |

每个 target 的参数也不同:`platform` 要 `imageTag` / `pgAdminUser` / `@secure() pgAdminPassword`;`service` 额外要 `docType` / `targetPort` / `minReplicas` / `maxReplicas` / `casBaseUrl` / `internalToken`;`gateway` 要 `imageTag` / `casBaseUrl` / 两个 `@secure()`。**去读那三个模板的 `param` 声明确认**,不要照抄本表 —— 模板是真相。

改完后自查:

```bash
grep -n 'main\.bicep' azure/deploy/deploy.mjs && echo "↑ 仍有残留" || echo "无残留 ✓"
```

- [ ] **Step 4: 镜像构建改为有界并发**

把现在顺序 `for` 循环的 `az acr build` 改成有界并发(默认 2)。**不要用无界 `Promise.all`** —— ACR Tasks 的并发构建数受 SKU 限制,我们用 Basic,超限的构建会排队。

在构建开始时打印一行提示,说明这个数字未经实测:

```js
console.log(`[4/7] building ${images.length} linux/amd64 images in ACR (concurrency ${args.buildConcurrency})`);
```

- [ ] **Step 5: 冒烟按服务过滤**

`--service docx` 时冒烟只测 docx。`smoke.mjs` 增加 `--only <docType>` 参数;不给时测全部。

**冒烟必须重试** —— 新 revision 接管流量要几十秒,注册表 TTL 还有 30 秒:

```js
// 这条重试本来就该有:与注册表无关,新 revision 尚未就绪时冒烟同样会失败。
await retryUntil(() => smoke(gatewayUrl, only), { timeoutMs: 120_000, intervalMs: 5_000 });
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm exec vitest run tests/unit/scripts/azure-deploy.test.mjs
pnpm build && pnpm typecheck && pnpm test
```

- [ ] **Step 7: 更新 `azure/README.md`**

补两段:选择器的用法;以及"多个独立进程并行也安全"的前提(各自独立 deployment 名、不同镜像仓库、不同 Container App、注册表按 `doc_type` 主键分行),并注明这是"可以这么用"而非"脚本保证"。

- [ ] **Step 8: 提交**

```bash
git add azure/deploy tests/unit/scripts/azure-deploy.test.mjs
git commit -m "feat(azure): 部署脚本支持按服务选择与镜像并发构建"
```

---

### Task 6: 对现有环境完成过渡

实现设计 §8、§9。**这是唯一在云上产生副作用的任务。**

**背景**:线上那套由旧的 `main.bicep` 一次部出,网关靠环境变量找服务。切换后网关查注册表,而表初始为空(现有进程是旧镜像,不会注册)。**顺序错了会有 404 窗口。**

**Files:** 无代码改动,仅执行与记录。

- [ ] **Step 1: 记录当前状态,便于出问题时对照**

```bash
az resource list -g Unidocs --query "[].{name:name,type:type}" -o table
az containerapp show -g Unidocs -n unidocs-gateway --query "properties.template.containers[0].env[].name" -o tsv
```

- [ ] **Step 2: 部署 platform(建 `doc_types` 表)**

```bash
node azure/deploy/deploy.mjs --platform 2>&1 | tee /tmp/azure-transition-1.log
```

确认迁移 Job 成功、表已创建。

- [ ] **Step 3: 部署两个 doc type 服务(它们会自注册)**

```bash
node azure/deploy/deploy.mjs --service markdown,docx 2>&1 | tee /tmp/azure-transition-2.log
```

验证注册表真的有数据了 —— 这一步是整轮的关键证据:

```bash
az containerapp logs show -g Unidocs -n unidocs-markdown --tail 50 | grep "registered at"
```

- [ ] **Step 4: 最后部署网关**

```bash
node azure/deploy/deploy.mjs --gateway 2>&1 | tee /tmp/azure-transition-3.log
```

- [ ] **Step 5: 验收 —— 单服务独立部署真的成立**

这是设计 §9 第 7 条,本轮的核心验收:

```bash
node azure/deploy/deploy.mjs --service markdown 2>&1 | tee /tmp/azure-verify.log
```

然后确认 docx 与 gateway **未被触碰**:

```bash
az deployment group list -g Unidocs --query "[].{name:name,timestamp:properties.timestamp}" -o table | head -10
```

预期:只有 `service-markdown` 有新的时间戳,`service-docx` 与 `gateway` 的时间戳不变。

- [ ] **Step 6: 验收 —— 网关未重启也能解析**

```bash
az containerapp revision list -g Unidocs -n unidocs-gateway --query "[].{name:name,created:properties.createdTime}" -o table
```

预期:网关的 revision **没有新增**(Step 5 没碰它),而冒烟仍然通过 —— 证明它是通过注册表而非环境变量找到 markdown 的。

- [ ] **Step 7: 实测 ACR 并发数,回写设计**

设计 §5.3 记着"Basic SKU 的并发构建上限未知,待首次部署实测"。现在有数据了:

```bash
az acr task list-runs -r unidocsacr --top 10 -o table
```

看同一时刻有几个 `Running`、几个 `Queued`。把结论写进设计 §10 的风险表(替换掉"待首次部署实测"那条),若实际只允许 1 个并发,把 `deploy.mjs` 的默认 `buildConcurrency` 改成 1。

- [ ] **Step 8: 验收 —— 隔离性**

```bash
mv azure /tmp/azure-moved && pnpm build && pnpm typecheck && pnpm test; mv /tmp/azure-moved azure
```

三条必须全绿 —— 证明代码不依赖运维资产。**记得移回来。**

- [ ] **Step 9: 提交实测结论**

```bash
git add docs/superpowers/specs/2026-08-25-azure-deploy-isolation-design.md azure/deploy/deploy.mjs
git commit -m "docs(azure): 回写 ACR 并发实测结论"
```
