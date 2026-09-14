# Tenant 数据面 Plan 3：HTTP 适配层、tenant session 与前端切换

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `http://127.0.0.1:8795/portal/` 上的 webui 读写真实数据库：给四个已有的 tenant repository 接上 HTTP 入口和 tenant session，并把 webui 从内存夹具切到 `createHttpTransport`。

**Architecture:** Plan 2 交付了四个 D1 repository，但它们仍然没有任何 HTTP 入口。本 plan 用 `implement(tenantApiContract)` + `OpenAPIHandler` 建 tenant HTTP 适配层（照 admin 的 `*-http.ts`），在 worker 里把 `/api/v1/tenants/*` 与 `/portal/auth/*` 路由到它，前面挂一层 tenant session 认证（照 `auth.ts` 的双 cookie + CSRF 哈希）。本地 dev 在 loopback origin 上自动签发 session。最后 webui 通过 `/portal/auth/session` 拿到 tenantId，改用 HTTP transport。

**Tech Stack:** TypeScript 5.9、oRPC 1.15（`@orpc/server`、`@orpc/openapi`、`@orpc/zod`）、Cloudflare D1 / Miniflare、`@cfworker/json-schema` 4.1.1、React 19 + Vite 7、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-09-12-tenant-data-plane-design.md`（§3.4 tenant session、§6 HTTP 适配层、§7 worker 路由、§12 前端接线、§14 第 4–5 步与第 8 步的前端部分）

## 范围

**做：** location 校验器、tenant session 持久化与认证、session 端点与本地自动签发、tenant HTTP 适配层（读 + 写）、worker 路由、前端切换。

**不做（Plan 4）：** Agent Bearer 认证与 `POST .../submissions`、Operator webhook 派发、dev 种子。**所以本 plan 结束时文档能建、能列，但打开时显示「等待 Operator 初始化」**——没有 Operator 就不会有首个版本，这是链路决定的，不是缺陷。

## Global Constraints

- **测试保真度必须按 task 里写的来。** 本仓库的 D1 测试替身 `tests/tenant/d1-double.ts` 不执行 SQL：它能证明「查询请求了什么」，证明不了「查询回答什么」。Plan 2 的终审就是用真 D1 探针抓到了替身漏掉的真缺陷（被拒绝的指针移动写下了幻影审计行）。凡 task 标注「真 D1」或「真 worker」的，用替身写的测试不算完成。
- **每个 task 报告前必须跑 mutation check**：把测试所命名的行为改坏，确认该测试（且最好只有该测试）变红，再改回。报告里写明改了什么、哪条红了。
- **不得让一个可选能力拖垮整个 worker。** worker 在每个请求上构造服务，任何一个构造函数抛异常都会 503 全站——这个仓库已经因此出过三次事故（`BUNDLE_ORIGIN`、view bundles、operator validation）。CAS 相关的构造必须惰性化，只在真正需要它的路由里发生。
- **仓储会抛裸 `Error`**（Plan 2 终审确认 `document.create`、`thread.create` 仍然可能）。HTTP 层的错误映射必须有兜底分支，并且**绝不能把裸 `Error` 的 message 回传给客户端**——里面可能含 SQL 片段与表名。服务端日志只记 name 与 message，照 `bff.ts` 的 `portal_operation_failed` 写法。
- **Bearer 在本 plan 里一律 401。** 契约规定带 `Authorization` 头的请求只用 token 认证、被拒绝时**不回退到 cookie**。Agent 凭据体系是 Plan 4 的事；在那之前，出现 `Authorization` 头就返回 401，即使同时带着有效 cookie。
- **本地自动签发只在 loopback origin 上发生。** 用 `@unidocs/portal-service` 已导出的 `isLocalDevOrigin(env.PORTAL_ORIGIN)` 判定，不要自己写正则。非 loopback 的 origin 上缺 session 就是 401，没有例外。
- 固定的本地身份：`tenantId = "t-local"`，`principalId = "user-local"`。
- **不要修改 `packages/portal-service/src/tenant/*`**——那是本 plan 实现所依据的接口。
- `packages/cloudflare-portal/wrangler.jsonc` 的 `compatibility_date` 不要动；本地验证用 `pnpm dev portal`，`wrangler dev` 在包内跑不起来。
- `CLAUDE.md` 是 local-only（在 `.git/info/exclude` 里，从未被跟踪）。**绝不编辑、绝不 `git add`、绝不 `git add -A`。** 按路径显式暂存。
- Commit message 用英文祈使句并说明原因。**不要 push，不要开 PR。**
- 门禁：`pnpm --filter <改动的包> test` 与 `typecheck`。**不要**用 `pnpm -r typecheck` 当门禁：`packages/portal-service` 在 main 上就是红的（测试替身缺 `replayRemove` / `replayUpdate`），`tests/unit/scripts/stack-layout.test.mjs` 同样（硬编码的 stack 列表漏了已跟踪的 `stacks/docs`）。两者都不归你。

## 从 Plan 2 终审继承、本 plan 必须遵守的事实

- 四个列表共用一套游标编码、没有 kind 标记：把一个列表的游标喂给另一个列表会被静默误读。HTTP 层不修这个，但**不要**在任何地方假设游标是列表专属的。
- `createDocument` 返回的 `createdAt` 是毫秒精度，随后 `get` 回来的是秒截断值。HTTP 层原样透传，不要试图抹平。
- `version_conflict` 由 `VersionConflictError`（`packages/cloudflare-portal/src/tenant/document-repository.ts`）抛出，携带 `currentVersionIdx`。契约要求这个 409 在 error details 里带出当前值，`TenantErrorDataSchema.details` 就是放它的地方。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `packages/cloudflare-portal/tests/tenant/real-d1.ts` | **新建。** 共享的真 D1 测试脚手架，用运行时真正使用的 SQL 切分器应用全部迁移 |
| `packages/cloudflare-portal/src/tenant/location-validator.ts` | **新建。** `DocumentLocationValidator` 的实现 |
| `packages/cloudflare-portal/src/tenant/session.ts` | **新建。** tenant session 的 D1 存储与请求认证 |
| `packages/cloudflare-portal/src/tenant/session-http.ts` | **新建。** `/portal/auth/session`、`/portal/auth/logout` 与本地自动签发 |
| `packages/cloudflare-portal/src/tenant/thread-repository.ts` | 修改：createThread 的幂等收据按文档隔离 |
| `packages/cloudflare-portal/src/tenant/tenant-http.ts` | **新建。** tenant API 的 oRPC 适配层与错误映射 |
| `packages/cloudflare-portal/src/worker.ts` | 修改：tenant 路由接入，CAS 惰性构造 |
| `tests/integration/cloudflare/portal-tenant-api.test.mjs` | **新建。** 真 worker 上的端到端 |
| `packages/tenant-portal-client/src/http-transport.ts` | 修改：写请求带 CSRF 头 |
| `packages/tenant-portal-webui/src/session/bootstrap.ts` | **新建。** 取 session，决定 tenantId |
| `packages/tenant-portal-webui/src/main.tsx` | 修改：切到 HTTP transport，内存夹具留作开关 |
| `packages/tenant-portal-webui/src/pages/document.tsx` | 修改：`currentVersionIdx === null` 的等待态 |

---

### Task 1: 共享的真 D1 测试脚手架

**Files:**
- Create: `packages/cloudflare-portal/tests/tenant/real-d1.ts`
- Create: `packages/cloudflare-portal/tests/tenant/real-d1.test.ts`
- Modify: `packages/cloudflare-portal/tests/tenant/thread-repository.test.ts`、`document-repository.test.ts`、`catalog-repository.test.ts`（换用共享脚手架）

**Interfaces:**
- Produces: `startRealD1(): Promise<RealD1>`，`RealD1 = { db: D1Database; dispose(): Promise<void> }`。Task 3–7 的真 D1 测试全部用它。

**Background：** Miniflare 启动样板和一个 `collapseToOneStatementPerLine` 函数现在在三个测试文件里复制了六份。更要紧的是那个函数按 `;` 天真切分 SQL，而本地运行时实际用的是 `stacks/unidocs-cloudflare/local/sql-statements.mjs` 的 `splitSqlStatements`——它理解字符串字面量、注释与触发器体。Plan 2 的修复轮里已经有人为了迁就测试专用的天真切分器，把 `0012_tenant.sql` 里的一条 `--` 注释挪走了。测试和运行时用两套切分器，迟早会出现「测试能应用、运行时不能」或反过来的迁移。

**测试保真度：** 真 D1（这个 task 本身就是在造真 D1 设施）。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/real-d1.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startRealD1, type RealD1 } from "./real-d1.js";

describe("startRealD1", () => {
  let real: RealD1 | undefined;

  afterEach(async () => {
    await real?.dispose();
    real = undefined;
  });

  it("applies every migration, admin and tenant alike", async () => {
    real = await startRealD1();
    const { results } = await real.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all<{ name: string }>();
    const names = results.map(row => row.name);
    // 0002 (admin catalog), 0012 (tenant) and 0012's late index must all be present.
    expect(names).toContain("portal_document_types");
    expect(names).toContain("portal_documents");
    expect(names).toContain("portal_tenant_sessions");
    expect(names).toContain("portal_comment_version");
  });

  it("gives each call an isolated database", async () => {
    const first = await startRealD1();
    const second = await startRealD1();
    try {
      await first.db.prepare(
        "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t', 'd', 'n', 'markdown', NULL, 1)",
      ).run();
      const row = await second.db.prepare("SELECT COUNT(*) AS n FROM portal_documents").first<{ n: number }>();
      expect(row?.n).toBe(0);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/real-d1
```

Expected: FAIL，`./real-d1.js` 不存在。

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/tests/tenant/real-d1.ts`：

```ts
/**
 * A real D1 database under Miniflare, with every migration applied through the
 * SAME statement splitter the local runtime uses.
 *
 * The test double in d1-double.ts never evaluates SQL, so it can prove what a
 * query asked for but not what SQLite answers. Anything whose correctness lives
 * in a WHERE clause, a join, a guard subquery or a constraint must be tested
 * here instead - that is how a phantom audit row slipped past the double.
 *
 * Migrations are split with stacks/unidocs-cloudflare/local/sql-statements.mjs
 * rather than a naive split on ";", so a migration that applies in tests is one
 * that applies in `pnpm dev portal`, and vice versa.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { splitSqlStatements } from "../../../../stacks/unidocs-cloudflare/local/sql-statements.mjs";

export interface RealD1 {
  readonly db: D1Database;
  dispose(): Promise<void>;
}

const WORKER = "tenant-real-d1";
const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function startRealD1(): Promise<RealD1> {
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: WORKER,
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: `tenant-real-d1-${crypto.randomUUID()}` },
    }],
  }));
  try {
    await miniflare.ready;
    const db = await miniflare.getD1Database("DB", WORKER) as unknown as D1Database;
    const files = (await readdir(MIGRATIONS)).filter(file => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(`${MIGRATIONS}${file}`, "utf8");
      for (const statement of splitSqlStatements(sql, file)) {
        await db.prepare(statement).run();
      }
    }
    return { db, dispose: () => miniflare.dispose() };
  } catch (error) {
    await miniflare.dispose();
    throw error;
  }
}
```

`sql-statements.mjs` 是无类型的 `.mjs`。若 `tsc -p tsconfig.test.json` 拒绝这个 import，在 `packages/cloudflare-portal/tests/tenant/` 下加一个 `sql-statements.d.ts`：

```ts
declare module "*/sql-statements.mjs" {
  export function splitSqlStatements(sql: string, file?: string): string[];
}
```

**不要**用 `@ts-expect-error` 或 `@ts-ignore` 绕过。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/real-d1
```

Expected: PASS。

- [ ] **Step 5: 迁移六份副本**

把 `thread-repository.test.ts`（三处）、`document-repository.test.ts`（两处）、`catalog-repository.test.ts`（一处）里的 Miniflare 启动样板与 `collapseToOneStatementPerLine` 全部换成 `startRealD1()`。每个 `describe` 的 `beforeEach` 变成 `real = await startRealD1(); db = real.db;`，`afterEach` 变成 `await real.dispose();`。删掉所有 `collapseToOneStatementPerLine` 与不再使用的 import。

原本只应用了 `0012_tenant.sql` 的块，现在会应用全部迁移。如果某个测试因此失败（例如依赖某张表**不存在**），在报告里写明是哪条、为什么，然后修测试而不是修脚手架。

- [ ] **Step 6: 跑全包确认没有回归**

```bash
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
grep -rn "collapseToOneStatementPerLine\|new Miniflare" packages/cloudflare-portal/tests/tenant/ | grep -v real-d1.ts
```

Expected: 测试全过、typecheck 干净、最后一条 grep **无输出**。

- [ ] **Step 7: Mutation check**

把 `real-d1.ts` 里的 `.sort()` 删掉，确认 `applies every migration` 仍然通过或失败——在报告里写明结果与原因（迁移顺序若影响外键，这一步会暴露它）。再临时把 `splitSqlStatements` 换回 `sql.split(";")`，确认至少有一个测试变红，并写明是哪个。改回。

- [ ] **Step 8: Commit**

```bash
git add packages/cloudflare-portal/tests/tenant/real-d1.ts packages/cloudflare-portal/tests/tenant/real-d1.test.ts packages/cloudflare-portal/tests/tenant/thread-repository.test.ts packages/cloudflare-portal/tests/tenant/document-repository.test.ts packages/cloudflare-portal/tests/tenant/catalog-repository.test.ts
git commit -m "test(portal): share one real-D1 harness that splits SQL like the runtime

The Miniflare boilerplate had been copied six times, and each copy applied
migrations with a naive split on semicolons while the local runtime uses
splitSqlStatements. One migration comment had already been moved to appease
the test-only splitter. A migration that applies in tests should be exactly
one that applies in pnpm dev portal."
```

（若加了 `sql-statements.d.ts`，一并暂存。）

---

### Task 2: location 校验器

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/location-validator.ts`
- Test: `packages/cloudflare-portal/tests/tenant/location-validator.test.ts`
- Modify: `packages/cloudflare-portal/package.json`

**Interfaces:**
- Consumes: `DocumentLocationValidator` 类型（`@unidocs/portal-service`），`SValueSchemaDialect`（`@unidocs/protocol`）。
- Produces: `createLocationValidator(): DocumentLocationValidator`，供 Task 7 构造线程服务。

**Background：** `createTenantThreadService(repository, { validateLocation })` 要求调用方提供一个校验器，`threads.ts` 的注释明确说「刻意没有默认值，这样它不可能被静默跳过」。**全仓目前没有任何实现。** 没有它，线程服务根本构造不出来。

Document Contract 的 `location.schema` 是 SValue schema：JSON Schema 2020-12 的扩展方言，`$schema` 固定为 `https://schemas.unidocs.dev/svalue/v1`，额外关键字 `x-unidocs-sblob: true` 表示「这个节点匹配一个 SBlob 原子」。它校验的是 `{ locationType, payload }` 这个投影。

location 是纯 JSON——`DocumentLocationSchema.payload` 是 `JsonValue`，里面不可能出现 SBlob。所以**一个声明了 `x-unidocs-sblob` 的 location schema 本身就是错的**，应当拒绝。

用 `@cfworker/json-schema`：它在 Workers 里可用（不用 `new Function`，而 ajv 的代码生成在 Workers 里被禁止），且支持 `"2020-12"` 草案。它目前只是 `agents` 包的传递依赖，必须显式声明。

**测试保真度：** 纯单元测试，**用真实校验器**，不得 mock `@cfworker/json-schema`。

- [ ] **Step 1: 声明依赖**

在 `packages/cloudflare-portal/package.json` 的 `dependencies` 里加入 `"@cfworker/json-schema": "4.1.1"`；若尚无 `@unidocs/protocol`，加入 `"@unidocs/protocol": "workspace:*"`。然后 `pnpm install`。

- [ ] **Step 2: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/location-validator.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { SValueSchema } from "@unidocs/protocol";
import { createLocationValidator } from "../../src/tenant/location-validator.js";

const DIALECT = "https://schemas.unidocs.dev/svalue/v1";

const markdownRange = {
  $schema: DIALECT,
  type: "object",
  required: ["locationType", "payload"],
  additionalProperties: false,
  properties: {
    locationType: { const: "unidocs.markdown.text-range/v1" },
    payload: {
      type: "object",
      required: ["start", "end", "quote"],
      additionalProperties: false,
      properties: {
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 0 },
        quote: { type: "string" },
      },
    },
  },
} as unknown as SValueSchema;

const location = (payload: unknown, locationType = "unidocs.markdown.text-range/v1") => ({
  documentContractIdx: 0,
  locationType,
  payload: payload as never,
});

describe("createLocationValidator", () => {
  const validate = createLocationValidator();

  it("accepts a location matching the schema", () => {
    expect(validate(location({ start: 0, end: 5, quote: "hello" }), markdownRange)).toBe(true);
  });

  it("rejects a payload missing a required field", () => {
    expect(validate(location({ start: 0, end: 5 }), markdownRange)).toBe(false);
  });

  it("rejects a payload with an extra field", () => {
    expect(validate(location({ start: 0, end: 5, quote: "x", extra: 1 }), markdownRange)).toBe(false);
  });

  it("rejects a locationType the schema does not allow", () => {
    expect(validate(location({ start: 0, end: 5, quote: "x" }, "unidocs.psd.layer/v1"), markdownRange)).toBe(false);
  });

  it("validates the documentContractIdx-free projection, not the whole envelope", () => {
    // documentContractIdx is not part of the projection; additionalProperties:false
    // at the root would reject it if the validator passed the raw envelope.
    expect(validate(location({ start: 1, end: 2, quote: "a" }), markdownRange)).toBe(true);
  });

  it("refuses a schema that is not in the SValue dialect", () => {
    const foreign = { ...markdownRange, $schema: "https://json-schema.org/draft/2020-12/schema" } as unknown as SValueSchema;
    expect(validate(location({ start: 0, end: 5, quote: "x" }), foreign)).toBe(false);
  });

  it("refuses a location schema that declares an SBlob anywhere", () => {
    const withBlob = {
      ...markdownRange,
      properties: { ...(markdownRange as never as { properties: object }).properties, blob: { "x-unidocs-sblob": true } },
    } as unknown as SValueSchema;
    expect(validate(location({ start: 0, end: 5, quote: "x" }), withBlob)).toBe(false);
  });

  it("returns false rather than throwing on a malformed schema", () => {
    const broken = { $schema: DIALECT, type: 42 } as unknown as SValueSchema;
    expect(() => validate(location({}), broken)).not.toThrow();
    expect(validate(location({}), broken)).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/location-validator
```

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现**

创建 `packages/cloudflare-portal/src/tenant/location-validator.ts`：

```ts
/**
 * Validates a comment location against its Document Contract revision's
 * location schema.
 *
 * createTenantThreadService takes this with no default on purpose, so it
 * cannot be skipped silently. The schema is an SValue schema - JSON Schema
 * 2020-12 plus the x-unidocs-sblob keyword - and it validates the
 * { locationType, payload } projection, not the whole envelope.
 *
 * A location is pure JSON (its payload is a JsonValue), so a location schema
 * that declares an SBlob anywhere is itself malformed and is refused.
 *
 * Never throws: a schema the validator cannot compile is a contract defect the
 * caller reports as location_contract_violation, not an uncoded 500.
 */
import { Validator } from "@cfworker/json-schema";
import type { DocumentLocationValidator } from "@unidocs/portal-service";
import { SValueSchemaDialect } from "@unidocs/protocol";

function declaresSBlob(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(declaresSBlob);
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "x-unidocs-sblob") return true;
      if (declaresSBlob(value)) return true;
    }
  }
  return false;
}

export function createLocationValidator(): DocumentLocationValidator {
  return (location, schema) => {
    try {
      if (schema.$schema !== SValueSchemaDialect || declaresSBlob(schema)) return false;
      const { $schema: _dialect, ...standard } = schema;
      const projection = { locationType: location.locationType, payload: location.payload };
      return new Validator(standard as never, "2020-12", false).validate(projection).valid;
    } catch {
      return false;
    }
  };
}
```

若 `@cfworker/json-schema` 对非法 schema 不抛而是返回 `valid: true`，`returns false rather than throwing on a malformed schema` 会失败——那说明需要在校验前做一次最小的结构检查（至少确认根节点是对象、`type` 若存在是字符串或字符串数组）。按测试的要求补上，并在报告里写明你观察到的行为。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/location-validator
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 6: Mutation check**

逐一：删掉 `declaresSBlob(schema)` 条件、删掉 dialect 比较、把 `projection` 换成 `location` 本身（整个信封）。每次确认对应的那条测试变红，改回。报告写明三次各红了哪条。

- [ ] **Step 7: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/location-validator.ts packages/cloudflare-portal/tests/tenant/location-validator.test.ts packages/cloudflare-portal/package.json pnpm-lock.yaml
git commit -m "feat(portal): validate comment locations against their contract revision

The thread service takes a location validator with no default so it cannot
be skipped, and nothing in the repository implemented one, so the service
could not be constructed at all.

It uses @cfworker/json-schema because ajv's code generation relies on
new Function, which Workers forbid. A location is pure JSON, so a location
schema that declares an SBlob is rejected as malformed rather than trusted."
```

---

### Task 3: tenant session 的存储与认证

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/session.ts`
- Test: `packages/cloudflare-portal/tests/tenant/session.test.ts`

**Interfaces:**
- Consumes: `hashSessionSecret`（`src/auth.ts`，已导出），`TenantAccessError` 与 `TenantContext`（`@unidocs/portal-service`），Task 1 的 `startRealD1`，Plan 2 迁移里的 `portal_tenant_sessions` 表。
- Produces:
  - 常量 `TENANT_SESSION_COOKIE = "__Host-unidocs_tenant"`、`TENANT_CSRF_COOKIE = "__Host-unidocs_tenant_csrf"`、`TENANT_SESSION_TTL_SECONDS = 28_800`
  - `class D1TenantSessionStore`：`issue(tenantId, principalId, now): Promise<{ token: string; csrfToken: string }>`、`find(sessionHash, now): Promise<TenantSessionRecord | null>`、`revoke(sessionHash): Promise<void>`
  - `authenticateTenant(request, options: { origin: string; now: number; store: D1TenantSessionStore }): Promise<TenantContext>`

**Background：** 照 `src/auth.ts` 的会话认证（`createAdminAuthenticator` 的 cookie 分支），但更简单：tenant 没有 Google 身份也没有管理员成员关系要回查。关键规则都来自 `auth.ts:84-110`，逐条对应：

| 规则 | 失败 |
| --- | --- |
| 请求带 `Authorization` 头 | 401——**即使 cookie 有效也不回退**（契约规定；Bearer 在 Plan 4 才支持） |
| 请求 URL 的 origin ≠ 配置的 origin，或 `sec-fetch-site: cross-site` | 403 |
| cookie 里 session token 不是恰好一个、或不匹配 `/^[A-Za-z0-9_-]{43}$/` | 401 |
| session 不存在或已过期 | 401 |
| 非 GET/HEAD/OPTIONS：`origin` 头 ≠ 配置的 origin，或 `x-csrf-token` 缺失/格式不对/哈希不等（用 `timingSafeEqual`） | 403 |

服务端只存 `session_hash` 与 `csrf_hash`，从不存明文 token。

**测试保真度：** 存储层**真 D1**（过期、撤销的判定在 SQL 里）；认证逻辑用**真 D1 上的真存储**，不得替身化存储。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/session.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenantAccessError } from "@unidocs/portal-service";
import {
  authenticateTenant,
  D1TenantSessionStore,
  TENANT_CSRF_COOKIE,
  TENANT_SESSION_COOKIE,
  TENANT_SESSION_TTL_SECONDS,
} from "../../src/tenant/session.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const NOW = 1_757_808_000;

let real: RealD1;
let store: D1TenantSessionStore;

beforeEach(async () => {
  real = await startRealD1();
  store = new D1TenantSessionStore(real.db);
});

afterEach(async () => {
  await real.dispose();
});

function request(options: { method?: string; token?: string; csrf?: string; origin?: string; authorization?: string; site?: string; url?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("cookie", `${TENANT_SESSION_COOKIE}=${options.token}`);
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  if (options.origin) headers.set("origin", options.origin);
  if (options.authorization) headers.set("authorization", options.authorization);
  if (options.site) headers.set("sec-fetch-site", options.site);
  return new Request(options.url ?? `${ORIGIN}/api/v1/tenants/t-local/documents`, { method: options.method ?? "GET", headers });
}

describe("D1TenantSessionStore", () => {
  it("never stores the plaintext token", async () => {
    const { token, csrfToken } = await store.issue("t-local", "user-local", NOW);
    const { results } = await real.db.prepare("SELECT * FROM portal_tenant_sessions").all<Record<string, unknown>>();
    const stored = JSON.stringify(results);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(csrfToken);
  });

  it("does not find a session past its expiry", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const { hashSessionSecret } = await import("../../src/auth.js");
    const hash = await hashSessionSecret(token);
    expect(await store.find(hash, NOW + TENANT_SESSION_TTL_SECONDS - 1)).not.toBeNull();
    expect(await store.find(hash, NOW + TENANT_SESSION_TTL_SECONDS)).toBeNull();
  });

  it("does not find a revoked session", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const { hashSessionSecret } = await import("../../src/auth.js");
    const hash = await hashSessionSecret(token);
    await store.revoke(hash);
    expect(await store.find(hash, NOW)).toBeNull();
  });
});

describe("authenticateTenant", () => {
  const auth = (req: Request) => authenticateTenant(req, { origin: ORIGIN, now: NOW, store });

  it("resolves a valid session on a read", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ token }))).resolves.toMatchObject({
      tenantId: "t-local", principalId: "user-local", transport: "session",
    });
  });

  it("is unauthorized without a session cookie", async () => {
    await expect(auth(request())).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not fall back to a valid cookie when an Authorization header is present", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ token, authorization: "Bearer abc.def.ghi" }))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("refuses a cross-site request even with a valid session", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ token, site: "cross-site" }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a mutation without a CSRF token", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ method: "POST", token, origin: ORIGIN }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a mutation whose CSRF token does not match", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const { csrfToken: other } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ method: "POST", token, csrf: other, origin: ORIGIN }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a mutation from another origin even with a matching CSRF token", async () => {
    const { token, csrfToken } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ method: "POST", token, csrf: csrfToken, origin: "http://evil.test" }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("accepts a mutation with a matching CSRF token and origin", async () => {
    const { token, csrfToken } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ method: "POST", token, csrf: csrfToken, origin: ORIGIN }))).resolves.toMatchObject({ tenantId: "t-local" });
  });

  it("throws TenantAccessError, so the HTTP layer can map it", async () => {
    await expect(auth(request())).rejects.toBeInstanceOf(TenantAccessError);
  });
});
```

注意 `TENANT_CSRF_COOKIE` 在这个文件里暂时没被引用；它是 Task 4 设置 cookie 时用的。若 lint 或 typecheck 因未使用而报错，删掉这个 import。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/session
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant/session.ts`。要点：

- token 与 csrfToken 用 `crypto.getRandomValues(new Uint8Array(32))` 生成并 base64url 编码（去填充后恰为 43 字符，与 `auth.ts` 的 `opaqueTokenPattern` 一致）。`auth.ts` 的 `base64url` 未导出——在本文件写一个同样的局部函数，**不要**为此改 `auth.ts` 的导出面。
- `issue` 写入 `(session_hash, tenant_id, principal_id, csrf_hash, created_at, expires_at)`，`expires_at = now + TENANT_SESSION_TTL_SECONDS`。迁移里的 `CHECK (expires_at > created_at AND expires_at - created_at <= 28800)` 会拒绝越界值——这正是我们要的。
- `find` 的 SQL 把过期判定放在 WHERE 里：`WHERE session_hash = ? AND expires_at > ?`。**不要**先取出再在 JS 里比较——那样测试只能测到 JS，而过期正是 SQL 该保证的。
- `revoke` 直接 `DELETE`。
- `authenticateTenant` 按上面的规则表逐条实现；CSRF 比较用 `node:crypto` 的 `timingSafeEqual`，比较前先确认两边长度相等（长度不等直接 forbidden，否则 `timingSafeEqual` 会抛）。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/session
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Mutation check**

逐一：去掉 `find` 的 `expires_at > ?`；去掉 `Authorization` 头的检查；去掉 CSRF 的 origin 比较；把 `timingSafeEqual` 换成永远返回 true。每次确认对应测试变红，改回。报告写明各红了哪条。

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/session.ts packages/cloudflare-portal/tests/tenant/session.test.ts
git commit -m "feat(portal): authenticate tenant requests with a hashed session and CSRF

Mirrors the administrator session: an HttpOnly session cookie, a readable
CSRF cookie, and only the hashes of either stored. Expiry is decided in the
query rather than in JavaScript, so the check that matters is the one the
real-D1 tests exercise.

An Authorization header is refused outright even beside a valid cookie. The
contract says a rejected bearer never falls back to the cookie, and agent
bearer tokens do not exist yet."
```

---

### Task 4: session 端点与本地自动签发

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/session-http.ts`
- Test: `packages/cloudflare-portal/tests/tenant/session-http.test.ts`

**Interfaces:**
- Consumes: Task 3 的全部导出；`isLocalDevOrigin`（`@unidocs/portal-service`）。
- Produces: `createTenantSessionHttp(options: { origin: string; store: D1TenantSessionStore; now: () => number }): (request: Request, requestId: string) => Promise<Response | null>`。路径不属于它时返回 `null`。

**Background：** 两个端点：

| 路径 | 行为 |
| --- | --- |
| `GET /portal/auth/session` | 有效 session → `200 { tenantId, principalId }`。无有效 session 且 `isLocalDevOrigin(origin)` → 签发 `t-local` / `user-local` 的 session，`200` 并 `Set-Cookie` 两个 cookie。无有效 session 且非 loopback → `401`，**不签发、不写库**。跨站（`forbidden`）→ `403`，同样不签发。 |
| `POST /portal/auth/logout` | 认证（会走 CSRF 检查）→ 撤销 → `204` 并清空两个 cookie |

cookie 形状照 `auth.ts:48` 与 `bff.ts:30`：

```
__Host-unidocs_tenant=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800
__Host-unidocs_tenant_csrf=<csrfToken>; Path=/; Secure; SameSite=Strict; Max-Age=28800
```

浏览器把 `http://127.0.0.1` 视为安全上下文，所以 `Secure` 与 `__Host-` 前缀在本地可用——admin 已经在本地这样工作。

错误响应体形状：`{ error: { code, message, requestId } }`，与 `TenantApiErrorSchema` 一致。

**测试保真度：** **真 D1**。「非 loopback 不签发」这条必须断言**库里没有新行**，不能只断言状态码。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/session-http.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1TenantSessionStore, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE } from "../../src/tenant/session.js";
import { createTenantSessionHttp } from "../../src/tenant/session-http.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const LOCAL = "http://127.0.0.1:8795";
const PRODUCTION = "https://unidocs.shazhou.work";
const NOW = 1_757_808_000;

let real: RealD1;
let store: D1TenantSessionStore;

beforeEach(async () => {
  real = await startRealD1();
  store = new D1TenantSessionStore(real.db);
});

afterEach(async () => {
  await real.dispose();
});

async function sessionRows() {
  const row = await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_sessions").first<{ n: number }>();
  return row?.n ?? 0;
}

function cookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [key, value] = pair.split("=");
    if (key === name) return value;
  }
  return null;
}

describe("GET /portal/auth/session", () => {
  it("issues a local session on a loopback origin when none exists", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`), "req-1");
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ tenantId: "t-local", principalId: "user-local" });
    expect(cookieValue(response!, TENANT_SESSION_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieValue(response!, TENANT_CSRF_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sessionRows()).toBe(1);
  });

  it("marks the session cookie HttpOnly and leaves the CSRF cookie readable", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`), "req-1");
    const headers = response!.headers.getSetCookie();
    const session = headers.find(value => value.startsWith(`${TENANT_SESSION_COOKIE}=`))!;
    const csrf = headers.find(value => value.startsWith(`${TENANT_CSRF_COOKIE}=`))!;
    expect(session).toContain("HttpOnly");
    expect(csrf).not.toContain("HttpOnly");
  });

  it("never issues a session on a non-loopback origin", async () => {
    const handle = createTenantSessionHttp({ origin: PRODUCTION, store, now: () => NOW });
    const response = await handle(new Request(`${PRODUCTION}/portal/auth/session`), "req-1");
    expect(response?.status).toBe(401);
    expect(response!.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows()).toBe(0);
  });

  it("reuses an existing session instead of issuing another", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const first = await handle(new Request(`${LOCAL}/portal/auth/session`), "req-1");
    const token = cookieValue(first!, TENANT_SESSION_COOKIE)!;
    const second = await handle(new Request(`${LOCAL}/portal/auth/session`, {
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${token}` },
    }), "req-2");
    expect(second?.status).toBe(200);
    expect(second!.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows()).toBe(1);
  });

  it("does not issue on a cross-site request", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`, {
      headers: { "sec-fetch-site": "cross-site" },
    }), "req-1");
    expect(response?.status).toBe(403);
    expect(await sessionRows()).toBe(0);
  });

  it("returns null for a path it does not own", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    await expect(handle(new Request(`${LOCAL}/api/v1/tenants/t-local/documents`), "req-1")).resolves.toBeNull();
  });
});

describe("POST /portal/auth/logout", () => {
  it("revokes the session and clears both cookies", async () => {
    const { token, csrfToken } = await store.issue("t-local", "user-local", NOW);
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/logout`, {
      method: "POST",
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${token}`, "x-csrf-token": csrfToken, origin: LOCAL },
    }), "req-1");
    expect(response?.status).toBe(204);
    expect(response!.headers.getSetCookie().every(value => value.includes("Max-Age=0"))).toBe(true);
    expect(await sessionRows()).toBe(0);
  });

  it("refuses a logout without the CSRF token and leaves the session intact", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/logout`, {
      method: "POST",
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${token}`, origin: LOCAL },
    }), "req-1");
    expect(response?.status).toBe(403);
    expect(await sessionRows()).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/session-http
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant/session-http.ts`。其它路径返回 `null`；不匹配的方法返回 `405` 带 `Allow`。`GET /portal/auth/session` 的判定顺序是：

1. `authenticateTenant` 成功 → 200 身份
2. 抛出 `TenantAccessError("unauthorized")` 且 `isLocalDevOrigin(origin)` → 签发并 200
3. 其它 `TenantAccessError` → 按 code 返回 401 / 403
4. 非 `TenantAccessError` → 重新抛出（由 worker 层兜底）

**第 2 步只对 `unauthorized` 签发。** `forbidden`（跨站或 origin 不符）意味着请求本身不可信，签发会把本地 dev 的便利变成一个 CSRF 放大器。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/session-http
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Mutation check**

逐一：去掉 `isLocalDevOrigin` 判定（让任何 origin 都签发）；让 `forbidden` 也签发；logout 不调用 `revoke`。每次确认对应测试变红，改回。报告写明各红了哪条。

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/session-http.ts packages/cloudflare-portal/tests/tenant/session-http.test.ts
git commit -m "feat(portal): issue a local tenant session on loopback origins only

The tenant console has no sign-in yet, so on a loopback origin a missing
session is issued for the fixed local tenant. Anywhere else it is a 401 that
writes nothing, which the tests assert against the table rather than the
status code alone.

Only an unauthorized request is issued a session. A forbidden one - cross-site
or from the wrong origin - is untrusted, and issuing to it would turn a local
convenience into a CSRF amplifier."
```

---

### Task 5: createThread 的幂等收据按文档隔离

**Files:**
- Modify: `packages/cloudflare-portal/src/tenant/thread-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/thread-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `startRealD1`。
- Produces: 行为变更，无新接口。

**Background：** Plan 2 终审记下的一处可达缺陷。线程服务的指纹是 `schemaHash({ operation: "createThread", body })`，**不含 documentId**（`packages/portal-service/src/tenant/threads.ts`，本 plan 不得修改）；而收据主键是 `(tenant_id, actor_id, operation, key)`。所以**同一个幂等键 + 同一个请求体打到两个不同文档，第二次会重放出第一个文档的线程**——调用方以为在文档 B 上开了讨论，拿到的却是文档 A 的线程。

仓储能控制的是写进收据的 `operation`。把它按文档限定即可堵住，而不必动服务层。`appendComment` 没有这个问题：它的指纹含 `threadId`，而线程 id 是随机 UUID，不会跨文档碰撞。`createDocument` 也没有：它不隶属于任何文档。

在 HTTP 层接上之前，这个缺陷只能由直接调用仓储的代码触发；接上之后任何客户端都能触发。所以它必须先于 Task 7。

**测试保真度：** **真 D1**。

- [ ] **Step 1: 写失败的测试**

在 `thread-repository.test.ts` 中使用真 D1 的 `create` 测试块里追加（沿用该块已有的 `createCommand()` 辅助函数与文档种子写法，确保 `doc-a` 与 `doc-b` 两个文档都存在且各有版本 0；下面的对象字面量只示意字段，实际以 `ThreadCreateCommand` 与现有辅助函数为准）：

```ts
it("does not replay one document's thread when the same key and body target another document", async () => {
  const request = { baseVersionIdx: 0, content: { text: "same", richContent: null, attachments: [] }, location: null };
  const onA = await repository.create({ context, documentId: "doc-a", key: "shared-key", fingerprint: "same-fp", request });
  const onB = await repository.create({ context, documentId: "doc-b", key: "shared-key", fingerprint: "same-fp", request });
  expect(onB.threadId).not.toBe(onA.threadId);
  const rows = await db.prepare("SELECT document_id FROM portal_threads ORDER BY document_id").all<{ document_id: string }>();
  expect(rows.results.map(row => row.document_id)).toEqual(["doc-a", "doc-b"]);
});

it("still replays the same key and body on the same document", async () => {
  const request = { baseVersionIdx: 0, content: { text: "same", richContent: null, attachments: [] }, location: null };
  const first = await repository.create({ context, documentId: "doc-a", key: "k", fingerprint: "fp", request });
  const second = await repository.create({ context, documentId: "doc-a", key: "k", fingerprint: "fp", request });
  expect(second.threadId).toBe(first.threadId);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/thread-repository
```

Expected: 第一条 FAIL（`onB.threadId` 等于 `onA.threadId`），第二条 PASS。

- [ ] **Step 3: 实现**

在 `thread-repository.ts` 中，`create` 读收据与写收据两处使用的 `operation` 值，从固定的 `CREATE_THREAD_OPERATION` 改为按文档限定的值（例如 `` `${CREATE_THREAD_OPERATION}:${command.documentId}` ``），并**在一个函数里集中构造**，读和写都调用它——两处拼接各写一遍，就是这类缺陷下一次的来源。在该函数上写注释说明为什么：服务层指纹不含 documentId，而本仓储不得修改服务层。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/thread-repository
```

Expected: PASS。

- [ ] **Step 5: Mutation check**

只把**写**收据处改回旧的 operation，读处保留新的；确认第二条（同文档重放）变红——这证明读写必须一致。改回。再把两处都改回旧值，确认第一条变红。改回。

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/thread-repository.ts packages/cloudflare-portal/tests/tenant/thread-repository.test.ts
git commit -m "fix(portal): scope createThread's idempotency receipt to its document

The service fingerprints createThread without the document id, and the receipt
key is (tenant, actor, operation, key), so the same key and body sent to two
documents replayed the first document's thread for the second. Once the HTTP
layer lands any client can trigger it.

The repository cannot change the service's fingerprint, but it owns the
operation it records, so the receipt is now scoped by document. appendComment
already fingerprints the thread id, which is a random UUID."
```

---

### Task 6: tenant HTTP 适配层——读路径

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/tenant-http.ts`
- Test: `packages/cloudflare-portal/tests/tenant/tenant-http-read.test.ts`

**Interfaces:**
- Consumes: 四个 service 工厂（`createTenantCatalogService`、`createTenantDocumentService`、`createTenantVersionService`、`createTenantThreadService`，均来自 `@unidocs/portal-service`），`tenantApiContract`（`@unidocs/protocol-tenant-portal`），`VersionConflictError`（Plan 2），Task 2 的 `createLocationValidator`。
- Produces:

```ts
export interface TenantHttpDependencies {
  readonly catalog: TenantCatalogRepository;
  readonly documents: TenantDocumentRepository;
  readonly versions: TenantVersionRepository;
  readonly threads: TenantThreadRepository;
  readonly validateLocation: DocumentLocationValidator;
}
export function createTenantHttp(dependencies: TenantHttpDependencies):
  (request: Request, tenant: TenantContext, requestId: string) => Promise<Response>;
```

Task 7 在同一个 router 上补写操作。

**Background（实施者必读）：**

照 `packages/cloudflare-portal/src/document-types-http.ts` 的写法：`implement(contract).$context<...>()`、`OpenAPIHandler`、GET 请求挂 `experimental_ZodSmartCoercionPlugin`（查询参数的 `limit`、`open`、`versionIdx` 需要从字符串强转）。**handler 只调用 service，不直接调用 repository**——service 做租户作用域校验与输入校验。

本 task 接入的 operation：`documentTypes.list`、`documentTypes.getDocumentContract`、`documents.list`、`documents.get`、`documents.listAudit`、`versions.list`、`versions.get`、`versions.getSnapshot`、`threads.list`、`threads.get`，以及 `cas.issueCapability`（见下）。

**snapshot 的 content type。** 契约的 `.output(SnapshotStreamSchema)` 是 `z.instanceof(ReadableStream)`，没有声明 detailed 输出，所以 handler 没法设置响应头。oRPC 的 fetch 适配器（`@orpc/standard-server-fetch` 的 `toFetchBody`）会把 `ReadableStream` 原样透传，**但不会设置 content-type**。而线上的 content type 必须是 service 派生出来的 `application/vnd.unidocs.{documentType}.snapshot+cbor;version=1`。

做法：每个请求建一个可变的 `response` 对象放进 context，`getSnapshot` 的 handler 把 `snapshot.contentType` 写进去，`handler.handle(...)` 返回后在响应上 `headers.set("content-type", ...)`。

```ts
getSnapshot: implementation.versions.getSnapshot.handler(async ({ input, context }) => {
  const snapshot = await versions.getSnapshot(context.tenant, input.params.tenantId, input.params.documentId, input.params.versionIdx);
  context.response.contentType = snapshot.contentType;
  return snapshot.body;
}),
```

**`cas.issueCapability` 在 v0 不实现**（spec §1.3：浏览器直连 UniCAS 推迟）。handler 抛 `TenantOperationError("unavailable")`，得到 503——**不要**返回一个假 capability，也不要让它落进 404。

**错误映射**（interceptor 内）：

| 捕获 | 响应 |
| --- | --- |
| `TenantAccessError` / `TenantOperationError` | `ORPCError(code.toUpperCase(), { status, message, data: { requestId, details? } })` |
| `VersionConflictError` | 同上，`details = { currentVersionIdx }` |
| 其它任何错误 | 记录 `portal_operation_failed`（仅 name 与 message），向上抛，由 encoder 输出 `internal_error` |

status 表：

```ts
const STATUS = {
  invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, limit_exceeded: 413,
  location_contract_violation: 422, document_type_disabled: 409, version_conflict: 409,
  idempotency_conflict: 409, content_unavailable: 409, unavailable: 503,
} as const;
```

`customErrorResponseBodyEncoder` 输出 `{ error: { code, message, requestId, details? } }`，其中：
- oRPC 自身的输入校验失败（`BAD_REQUEST`）→ `code: "invalid_request"`，message 固定为 `"The request is invalid"`
- status 为 500（未被映射的错误）→ `code: "internal_error"`，message 固定为 `"Tenant operation failed"`，**不回传原始 message**
- 其余 → 小写 code 与映射时给定的 message

**测试保真度：** handler 接**真 D1 上的真 repository**。`SnapshotStore` 用一个返回固定字节的内存实现即可（CAS 往返在 Plan 1 已由真 CAS 覆盖）。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/tenant-http-read.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "@unidocs/portal-service";
import { D1TenantCatalogRepository } from "../../src/tenant/catalog-repository.js";
import { D1TenantDocumentRepository } from "../../src/tenant/document-repository.js";
import { D1TenantVersionRepository } from "../../src/tenant/version-repository.js";
import { D1TenantThreadRepository } from "../../src/tenant/thread-repository.js";
import { createLocationValidator } from "../../src/tenant/location-validator.js";
import { createTenantHttp } from "../../src/tenant/tenant-http.js";
import type { SnapshotStore } from "../../src/snapshot-store.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const tenant: TenantContext = { tenantId: "t-local", principalId: "user-local", transport: "session", sessionHash: "h" };
const SNAPSHOT_BYTES = new Uint8Array([0xa1, 0x61, 0x63, 0x60]);

let real: RealD1;
let handle: ReturnType<typeof createTenantHttp>;

const snapshots: SnapshotStore = {
  read: async () => new ReadableStream({ start(controller) { controller.enqueue(SNAPSHOT_BYTES); controller.close(); } }),
  retain: async () => {},
  release: async () => {},
};

beforeEach(async () => {
  real = await startRealD1();
  handle = createTenantHttp({
    catalog: new D1TenantCatalogRepository(real.db),
    documents: new D1TenantDocumentRepository(real.db),
    versions: new D1TenantVersionRepository(real.db, snapshots),
    threads: new D1TenantThreadRepository(real.db),
    validateLocation: createLocationValidator(),
  });
});

afterEach(async () => {
  await real.dispose();
});

async function seedDocumentWithVersion(documentId: string) {
  await real.db.prepare(
    "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t-local', ?, 'Notes', 'markdown', 0, 1757808000)",
  ).bind(documentId).run();
  await real.db.prepare(
    `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
     VALUES ('t-local', ?, 0, NULL, 0, 'agent:test', 'sub-0', '[]', 'hash', 4, 'application/vnd.unidocs.markdown.snapshot+cbor;version=1', 1757808000)`,
  ).bind(documentId).run();
}

const get = (path: string) => handle(new Request(`${ORIGIN}${path}`), tenant, "req-1");

describe("tenant HTTP reads", () => {
  it("lists documents as a page", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await get("/api/v1/tenants/t-local/documents");
    expect(response.status).toBe(200);
    const body = await response.json() as { items: { documentId: string }[]; nextCursor: string | null };
    expect(body.items.map(item => item.documentId)).toEqual(["doc-1"]);
    expect(body.nextCursor).toBeNull();
  });

  it("coerces a numeric limit from the query string", async () => {
    await seedDocumentWithVersion("doc-1");
    await seedDocumentWithVersion("doc-2");
    const response = await get("/api/v1/tenants/t-local/documents?limit=1");
    expect(response.status).toBe(200);
    const body = await response.json() as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
  });

  it("returns 404 in the contract's error shape for a missing document", async () => {
    const response = await get("/api/v1/tenants/t-local/documents/missing");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: expect.any(String), requestId: "req-1" },
    });
  });

  it("refuses another tenant's path with 403", async () => {
    const response = await get("/api/v1/tenants/t-other/documents");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
  });

  it("streams a snapshot with the derived vendor content type", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await get("/api/v1/tenants/t-local/documents/doc-1/versions/0/snapshot");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.unidocs.markdown.snapshot+cbor;version=1");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(SNAPSHOT_BYTES);
  });

  it("answers 503 unavailable for CAS capabilities, which v0 does not issue", async () => {
    const response = await handle(new Request(`${ORIGIN}/api/v1/tenants/t-local/cas-capabilities`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), tenant, "req-1");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unavailable" } });
  });

  it("does not leak an unexpected error's message", async () => {
    const exploding = createTenantHttp({
      catalog: new D1TenantCatalogRepository(real.db),
      documents: { ...new D1TenantDocumentRepository(real.db), list: async () => { throw new Error("SELECT secret_column FROM portal_documents"); } } as never,
      versions: new D1TenantVersionRepository(real.db, snapshots),
      threads: new D1TenantThreadRepository(real.db),
      validateLocation: createLocationValidator(),
    });
    const response = await exploding(new Request(`${ORIGIN}/api/v1/tenants/t-local/documents`), tenant, "req-1");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret_column");
    expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", message: "Tenant operation failed", requestId: "req-1" } });
  });

  it("lists thread references for a document", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await get("/api/v1/tenants/t-local/documents/doc-1/threads?open=true");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
  });
});
```

`does not leak` 用例里 `{ ...new D1TenantDocumentRepository(real.db), list }` 会丢掉原型上的方法——若因此导致其它方法缺失而类型或运行出错，改为创建一个真实实例后只覆盖 `list` 属性。保留断言不变。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/tenant-http-read
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

按上面的 Background 实现 `tenant-http.ts`。router 必须覆盖契约里的**全部**顶层分组（`implement(tenantApiContract)` 要求完整实现）——写操作（`documents.create`、`documents.moveCurrentVersion`、`threads.create`、`threads.appendComment`）在本 task 暂时抛 `TenantOperationError("unavailable")`，由 Task 7 替换。在这四个 handler 上各留一行注释指向 Task 7。

路由未匹配时返回 404，body 为 `{ error: { code: "not_found", message: "The requested resource was not found", requestId } }`。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/tenant-http-read
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Mutation check**

逐一：去掉 snapshot 的 content-type 补写；去掉 GET 的 coercion plugin；让 encoder 回传原始 message；让 `cas.issueCapability` 返回 404。每次确认对应测试变红，改回。报告写明各红了哪条。

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/tenant-http.ts packages/cloudflare-portal/tests/tenant/tenant-http-read.test.ts
git commit -m "feat(portal): serve the tenant API's read operations over HTTP

Routing, input validation and coercion come from the tenant contract the way
the admin API's do. The snapshot operation returns a stream, which oRPC passes
through without a content type, so the derived vendor media type is set on the
response after the handler runs.

An unexpected error is logged by name and message and answered as a generic
internal_error: repository errors can carry SQL fragments, and none of that
belongs in a response body. CAS capabilities answer 503 because v0 does not
issue them."
```

---

### Task 7: tenant HTTP 适配层——写路径

**Files:**
- Modify: `packages/cloudflare-portal/src/tenant/tenant-http.ts`
- Test: `packages/cloudflare-portal/tests/tenant/tenant-http-write.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `createTenantHttp`。
- Produces: 同一函数的写操作实现。

**Background：** 替换 Task 6 留下的四个 `unavailable` 占位：`documents.create`、`documents.moveCurrentVersion`、`threads.create`、`threads.appendComment`。

| operation | service 调用 | 关键头 |
| --- | --- | --- |
| `documents.create` | `documents.create(tenant, tenantId, body, headers["idempotency-key"], requestId)` | `idempotency-key` |
| `documents.moveCurrentVersion` | `documents.moveCurrentVersion(tenant, tenantId, documentId, body, requestId)` | 无 |
| `threads.create` | `threads.create(tenant, tenantId, documentId, body, headers["idempotency-key"])` | `idempotency-key` |
| `threads.appendComment` | `threads.appendComment(tenant, tenantId, documentId, threadId, body, headers["idempotency-key"])` | `idempotency-key` |

CSRF 已由 worker 层的 `authenticateTenant` 在进入适配层之前校验，适配层**不重复**校验。

**请求体边界**，照 `document-types-http.ts:49-63`：非 `application/json` 或带 `content-encoding` → 400；用 `boundedBytes` 读取并以 `parseStrictJson`（均来自 `@unidocs/portal-service`）解析——它拒绝重复键；超限或解析失败 → 400。上限取 `131_072` 字节：`TENANT_LIMITS.messageText` 是 16 384 个 UTF-16 码元，UTF-8 下最坏约 65 KB，再加上 8 KB 的 location 与 20 个附件引用。在常量上写注释说明这个数怎么来的。

**测试保真度：** **真 D1**。`createDocument` 需要一个启用的文档类型：直接往 `portal_document_types` 插一行 `enabled = 1`（Plan 2 的 A4 修复只校验这一条件）。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/tenant-http-write.test.ts`，复用 Task 6 测试里的 `createTenantHttp` 构造方式与 `seedDocumentWithVersion`。追加辅助函数：

```ts
async function enableDocumentType(documentType: string) {
  await real.db.prepare(
    "INSERT INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, 1, '{}', '2026-09-14T00:00:00.000Z')",
  ).bind(documentType, documentType).run();
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  handle(new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), tenant, "req-1");
```

用例：

```ts
describe("tenant HTTP writes", () => {
  it("creates a document with 201 and currentVersionIdx null", async () => {
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ name: "Notes", documentType: "markdown", currentVersionIdx: null });
  });

  it("replays the same idempotency key without creating a second document", async () => {
    await enableDocumentType("markdown");
    const first = await (await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" })).json() as { documentId: string };
    const second = await (await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" })).json() as { documentId: string };
    expect(second.documentId).toBe(first.documentId);
    const row = await real.db.prepare("SELECT COUNT(*) AS n FROM portal_documents").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("refuses a disabled document type with 409 document_type_disabled", async () => {
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" }, { "idempotency-key": "k1" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "document_type_disabled" } });
  });

  it("requires an idempotency key on creation", async () => {
    await enableDocumentType("markdown");
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "Notes" });
    expect(response.status).toBe(400);
  });

  it("rejects a non-JSON body", async () => {
    const response = await handle(new Request(`${ORIGIN}/api/v1/tenants/t-local/documents`, {
      method: "POST", headers: { "content-type": "text/plain", "idempotency-key": "k1" }, body: "hello",
    }), tenant, "req-1");
    expect(response.status).toBe(400);
  });

  it("rejects a body with a duplicate key", async () => {
    const response = await post("/api/v1/tenants/t-local/documents", '{"documentType":"markdown","name":"a","name":"b"}', { "idempotency-key": "k1" });
    expect(response.status).toBe(400);
  });

  it("rejects an oversized body", async () => {
    const response = await post("/api/v1/tenants/t-local/documents", { documentType: "markdown", name: "x".repeat(200_000) }, { "idempotency-key": "k1" });
    expect(response.status).toBe(400);
  });

  it("carries the current pointer in details on a version conflict", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await post("/api/v1/tenants/t-local/documents/doc-1/current-version", {
      observedCurrentVersionIdx: 7, targetVersionIdx: 0, reason: "stale",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "version_conflict", message: expect.any(String), requestId: "req-1", details: { currentVersionIdx: 0 } },
    });
  });

  it("answers 404 when moving the pointer of a missing document", async () => {
    const response = await post("/api/v1/tenants/t-local/documents/missing/current-version", {
      observedCurrentVersionIdx: null, targetVersionIdx: 0, reason: "x",
    });
    expect(response.status).toBe(404);
  });

  it("creates a thread against an existing version and appends to it", async () => {
    await seedDocumentWithVersion("doc-1");
    const created = await post("/api/v1/tenants/t-local/documents/doc-1/threads", {
      baseVersionIdx: 0, content: { text: "first", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "t1" });
    expect(created.status).toBe(201);
    const thread = await created.json() as { threadId: string; comments: unknown[] };
    expect(thread.comments).toHaveLength(1);

    const appended = await post(`/api/v1/tenants/t-local/documents/doc-1/threads/${thread.threadId}/comments`, {
      baseVersionIdx: 0, content: { text: "second", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "c1" });
    expect(appended.status).toBe(201);
    await expect(appended.json()).resolves.toMatchObject({ commentIdx: 1 });
  });

  it("refuses a thread on a version that does not exist", async () => {
    await seedDocumentWithVersion("doc-1");
    const response = await post("/api/v1/tenants/t-local/documents/doc-1/threads", {
      baseVersionIdx: 9, content: { text: "x", richContent: null, attachments: [] }, location: null,
    }, { "idempotency-key": "t1" });
    expect(response.status).toBe(404);
  });
});
```

`carries the current pointer in details` 要求 `seedDocumentWithVersion` 种下的 `current_version_idx` 是 0；Task 6 的写法满足。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/tenant-http-write
```

Expected: FAIL——写操作仍是 Task 6 的 `unavailable` 占位。

- [ ] **Step 3: 实现**

替换四个占位；加入请求体边界处理（在 `handler.handle` 之前，对 POST 执行）；确认 `VersionConflictError` 的 `details` 经 encoder 原样到达响应体。删掉 Task 6 留下的指向本 task 的注释。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: 全包 PASS（Task 6 的读路径测试必须仍然通过）。

- [ ] **Step 5: Mutation check**

逐一：去掉 `details` 的附加；去掉 content-type 检查；把体积上限改成 10 MB；让 `threads.create` 不传 idempotency key。每次确认对应测试变红，改回。报告写明各红了哪条。

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/tenant-http.ts packages/cloudflare-portal/tests/tenant/tenant-http-write.test.ts
git commit -m "feat(portal): serve the tenant API's write operations over HTTP

Creation, pointer moves, thread creation and comment appends now reach their
services. Request bodies are bounded and parsed strictly - duplicate keys are
refused - before routing, the same way the admin API does it.

A version conflict carries the current pointer in the error details, which
the contract promises and which a client needs to rebase without a second
round trip."
```

---

### Task 8: worker 路由与真 worker 端到端

**Files:**
- Modify: `packages/cloudflare-portal/src/worker.ts`
- Test: `tests/integration/cloudflare/portal-tenant-api.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `authenticateTenant` 与 `D1TenantSessionStore`，Task 4 的 `createTenantSessionHttp`，Task 6–7 的 `createTenantHttp`，Plan 1 的 `createPortalCasRuntime`，Plan 2 的四个 repository。

**Background（实施者必读）：**

**位置。** tenant 路由必须放在 `serveTenantWebUi` 之后、**读取 Google 配置之前**。`worker.ts` 现有注释解释过为什么 tenant UI 排在 BFF 前面：它不需要 Google 登录，也应当在没有配置 Google client 的环境里照常服务。tenant API 同理——如果它排在 `portalGoogleConfigFromGateway(...)` 之后，一个缺失的 Google 配置就会 503 掉整个 tenant 数据面。

```ts
const tenantPath = requestPath === "/portal/auth/session" || requestPath === "/portal/auth/logout"
  || requestPath.startsWith("/api/v1/tenants/");
```

**CAS 必须惰性。** 本仓库已经因为「每个请求无条件构造一个可能抛异常的服务」而全站 503 过三次。`createPortalCasRuntime` 在 `CAS_*` binding 缺失时会抛——而只有 snapshot 路由需要它。用一个惰性的 `SnapshotStore` 包装，把构造推迟到第一次真正 `read` 时：

```ts
function lazySnapshotStore(build: () => Promise<SnapshotStore>): SnapshotStore {
  let store: Promise<SnapshotStore> | undefined;
  const resolve = () => (store ??= build());
  return {
    read: async (ref, signal) => (await resolve()).read(ref, signal),
    retain: async (ref, requestId) => (await resolve()).retain(ref, requestId),
    release: async (ref, requestId) => (await resolve()).release(ref, requestId),
  };
}
```

构造失败发生在 `read()` 内部，Plan 2 的 A5 修复已经把版本仓储里 `read()` 抛出的未知错误映射为 `unavailable`——所以缺 CAS binding 时 snapshot 路由得到 503，其它所有路由不受影响。

**认证失败的响应。** `authenticateTenant` 抛 `TenantAccessError` 时，worker 直接返回 `401`/`403`，body `{ error: { code, message, requestId } }`。

**响应头。** 所有 tenant 响应设置 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Request-ID`；API 与 session 路由设置 `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`。沿用现有的 `portal_request` 结构化日志。

**测试保真度：** **真 worker**。照 `tests/integration/cloudflare/portal-local-runtime.test.mjs` 的写法启动 `startLocalRuntime`——**先读那个文件**，沿用它的端口覆盖（`ports: PORTS`）与 `runtime.dispose()`，否则会与正在运行的 `pnpm dev portal` 抢端口。请求 origin 必须等于运行时给 worker 的 `PORTAL_ORIGIN`；从那个文件里确认它在端口覆盖下的实际值。

- [ ] **Step 1: 写失败的集成测试**

创建 `tests/integration/cloudflare/portal-tenant-api.test.mjs`。以下是必须覆盖的序列，按顺序在同一个运行时里执行（一个 `describe`，`beforeAll` 启动，`afterAll` dispose）：

```js
// 1. GET  /portal/auth/session              → 200 { tenantId: "t-local", principalId: "user-local" }，两个 Set-Cookie
//    记下 session token 与 csrf token，后续请求用 `cookie: __Host-unidocs_tenant=<token>`
// 2. GET  /api/v1/tenants/t-local/documents （无 cookie）        → 401, error.code "unauthorized"
// 3. GET  /api/v1/tenants/t-local/documents （带 cookie）        → 200 { items: [], nextCursor: null }
// 4. POST /api/v1/tenants/t-local/documents （cookie + origin + idempotency-key，无 x-csrf-token） → 403
// 5. POST 同上加 x-csrf-token，markdown 未启用                   → 409, error.code "document_type_disabled"
// 6. 经 runtime 取得 DB 绑定，插入 portal_document_types(markdown, enabled=1)
//    POST 同上                                                   → 201, currentVersionIdx null
// 7. GET  /api/v1/tenants/t-local/documents （带 cookie）        → items 恰有 1 项
// 8. GET  /api/v1/tenants/t-other/documents （带 cookie）        → 403
// 9. GET  /api/v1/tenants/t-local/documents/<id>/versions/0/snapshot （带 cookie） → 404
//    ——证明 snapshot 路由在没有版本时不会因构造 CAS 而 503
// 10. GET /admin/auth/session                                    → 401（admin 未受影响）
// 11. POST /portal/auth/logout（cookie + csrf + origin）          → 204；随后第 3 步的请求 → 401
```

每一步写成独立的 `expect`，失败信息要能看出是哪一步。取 DB 绑定的方式照 `portal-local-runtime.test.mjs` 或 `portal-cas.test.mjs` 中已有的写法（`runtime.mf.getD1Database("DB", "unidocs-portal")`）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run tests/integration/cloudflare/portal-tenant-api.test.mjs --fileParallelism=false
```

Expected: FAIL，第 1 步返回 404（路由尚未接入）。

- [ ] **Step 3: 实现**

在 `worker.ts` 中按 Background 接入。每个请求构造 repository 与 service（它们构造成本很低且不抛）；CAS 用 `lazySnapshotStore`；`D1TenantSessionStore` 用 `env.DB`；`now` 为 `() => Math.floor(Date.now() / 1000)`。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm exec vitest run tests/integration/cloudflare/portal-tenant-api.test.mjs --fileParallelism=false
pnpm exec vitest run tests/integration/cloudflare/portal-local-runtime.test.mjs tests/integration/cloudflare/portal-cas.test.mjs --fileParallelism=false
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: 全部 PASS。`portal-local-runtime.test.mjs` 必须仍为 9/9——它证明 admin 与 tenant UI 没有被新路由打断。

- [ ] **Step 5: Mutation check**

逐一：把 tenant 路由挪到 `portalGoogleConfigFromGateway` 之后并临时清空 `GATEWAY_OIDC_CLIENT_ID`（确认第 1 步失败，证明位置是承重的）；把 CAS 改为非惰性构造（确认第 9 步或整个序列 503）。改回。报告写明观察。

- [ ] **Step 6: 手工确认**

```bash
pnpm dev portal
```

浏览器打开 `http://127.0.0.1:8795/portal/auth/session`，确认返回 `{"tenantId":"t-local","principalId":"user-local"}`，开发者工具里能看到两个 cookie。然后访问 `/admin/` 确认管理台仍可用。Ctrl-C 退出。在报告里写明结果。

- [ ] **Step 7: Commit**

```bash
git add packages/cloudflare-portal/src/worker.ts tests/integration/cloudflare/portal-tenant-api.test.mjs
git commit -m "feat(portal): route the tenant API and session through the portal worker

Tenant routes sit ahead of the Google configuration for the same reason the
tenant UI already does: nothing in the tenant data plane needs Google, and a
missing client must not take it down.

CAS is built lazily inside the snapshot store, because an unconfigured
capability built on every request has 503'd this worker three times already.
Only the snapshot route needs CAS, so only it can fail for want of one."
```

---

### Task 9: 前端切到真实 API

**Files:**
- Modify: `packages/tenant-portal-client/src/http-transport.ts`
- Test: `packages/tenant-portal-client/tests/http-transport.test.ts`
- Create: `packages/tenant-portal-webui/src/session/bootstrap.ts`
- Test: `packages/tenant-portal-webui/tests/session-bootstrap.test.ts`
- Modify: `packages/tenant-portal-webui/src/main.tsx`
- Modify: `packages/tenant-portal-webui/src/pages/document.tsx`
- Test: `packages/tenant-portal-webui/tests/document-page.test.tsx`
- Modify: `packages/cloudflare-portal/src/tenant-ui-assets.generated.ts`（由构建生成）

**Interfaces:**
- Consumes: Task 4 的 `/portal/auth/session` 响应形状 `{ tenantId, principalId }`；cookie 名 `__Host-unidocs_tenant_csrf`。
- Produces:
  - `createHttpTransport(options: { baseUrl: string; fetchImpl?: typeof fetch; csrfToken?: () => string | null })`
  - `loadTenantSession(fetchImpl?: typeof fetch): Promise<{ kind: "signed-in"; tenantId: string; principalId: string } | { kind: "signed-out" }>`

**Background：**

**CSRF。** `http-transport.ts` 目前一个 CSRF 头都不发。`tenant-portal-client` 是环境无关的包（将来 Agent 也可能用），所以**不要**在里面直接读 `document.cookie`——让调用方注入 `csrfToken`，webui 传一个读 cookie 的函数。只在 POST 上发，GET 不发。读 cookie 的写法照 `packages/admin-portal-client/src/index.ts:91`。

**启动。** `main.tsx` 目前硬编码 `tenantId: "t1"` 与 `createMemoryTransport({ seed: sampleSeed(), ... })`。改为：

- `import.meta.env.VITE_TENANT_FIXTURE === "memory"` 时保留现有内存夹具（离线开发与演示用，**不要删**）
- 否则先 `loadTenantSession()`：`signed-in` → 用返回的 `tenantId` 与 `createHttpTransport({ baseUrl: window.location.origin, csrfToken: readCsrfCookie })` 构造 client；`signed-out` → 渲染一个「需要登录」的提示页，不渲染 `App`

webui 由 portal worker 同源服务（`stacks/README.md`：两个 WebUI 都编译进 worker，不是独立 dev server），所以 `baseUrl` 是当前 origin，cookie 自然随请求携带。

**等待态。** `currentVersionIdx === null` 的文档没有任何可显示的正文，而且设计文档 §5.4 规定「首版本产生前不能创建 thread 或追加 comment」。`use-document.ts` 已经在这种情况下返回 `currentVersion: null` 与 `currentSnapshot: null`；`document.tsx` 需要据此显示「等待 Operator 初始化」，并**禁用评论入口**——前端不应发出注定 404 的请求。

**构建。** worker 服务的是 `src/tenant-ui-assets.generated.ts`，不是 webui 源码。改完必须 `pnpm --filter @unidocs/cloudflare-portal build:webui`，并提交重新生成的文件。

**测试保真度：** transport 与 bootstrap 用注入的 `fetchImpl` 做单元测试；页面用现有的 jsdom + testing-library 基建；最后**手工在真 worker 上确认**。

- [ ] **Step 1: transport 的失败测试**

追加到 `packages/tenant-portal-client/tests/http-transport.test.ts`：

```ts
it("sends the CSRF token on a POST", async () => {
  const calls: Request[] = [];
  const transport = createHttpTransport({
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => { calls.push(new Request(input, init)); return Response.json({}, { status: 201 }); },
    csrfToken: () => "csrf-abc",
  });
  await transport({ method: "POST", path: "/api/v1/tenants/t1/documents", body: {}, idempotencyKey: "k" });
  expect(calls[0].headers.get("x-csrf-token")).toBe("csrf-abc");
});

it("does not send the CSRF token on a GET", async () => {
  const calls: Request[] = [];
  const transport = createHttpTransport({
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => { calls.push(new Request(input, init)); return Response.json({ items: [], nextCursor: null }); },
    csrfToken: () => "csrf-abc",
  });
  await transport({ method: "GET", path: "/api/v1/tenants/t1/documents" });
  expect(calls[0].headers.has("x-csrf-token")).toBe(false);
});

it("omits the header when no token is available", async () => {
  const calls: Request[] = [];
  const transport = createHttpTransport({
    baseUrl: "https://example.test",
    fetchImpl: async (input, init) => { calls.push(new Request(input, init)); return Response.json({}, { status: 201 }); },
    csrfToken: () => null,
  });
  await transport({ method: "POST", path: "/api/v1/tenants/t1/documents", body: {}, idempotencyKey: "k" });
  expect(calls[0].headers.has("x-csrf-token")).toBe(false);
});
```

跑 `pnpm --filter @unidocs/tenant-portal-client test`，确认失败；实现；确认通过。

- [ ] **Step 2: bootstrap 的失败测试**

创建 `packages/tenant-portal-webui/tests/session-bootstrap.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { loadTenantSession } from "../src/session/bootstrap.js";

describe("loadTenantSession", () => {
  it("returns the tenant identity when signed in", async () => {
    const session = await loadTenantSession(async () => Response.json({ tenantId: "t-local", principalId: "user-local" }));
    expect(session).toEqual({ kind: "signed-in", tenantId: "t-local", principalId: "user-local" });
  });

  it("reports signed-out on 401", async () => {
    const session = await loadTenantSession(async () => Response.json({ error: { code: "unauthorized", message: "x", requestId: "r" } }, { status: 401 }));
    expect(session).toEqual({ kind: "signed-out" });
  });

  it("requests the session with credentials", async () => {
    let seen: RequestInit | undefined;
    await loadTenantSession(async (_input, init) => { seen = init; return Response.json({ tenantId: "t", principalId: "p" }); });
    expect(seen?.credentials).toBe("include");
  });

  it("throws on an unexpected response rather than guessing a tenant", async () => {
    await expect(loadTenantSession(async () => Response.json({ tenantId: 42 }))).rejects.toThrow();
  });
});
```

创建 `src/session/bootstrap.ts`，实现 `loadTenantSession`（`fetchImpl` 默认 `globalThis.fetch`，请求 `/portal/auth/session`）。确认测试通过。

- [ ] **Step 3: 等待态的失败测试**

在 `packages/tenant-portal-webui/tests/document-page.test.tsx` 中追加：用内存 transport 种一个 `currentVersionIdx: null` 的文档（`MemorySeed` 的文档 `versions: []` 即可），渲染 `DocumentPage`，断言：

- 页面出现「等待 Operator 初始化」
- 不存在可用的评论入口（按该文件现有测试查找评论入口的方式查询，断言其不存在或为 `disabled`）

先读 `document-page.test.tsx` 与 `pages/document.tsx`，沿用已有的渲染辅助函数与查询方式。确认失败，实现，确认通过。

- [ ] **Step 4: 切换 main.tsx**

按 Background 修改 `main.tsx`。`readCsrfCookie` 写在 `src/session/bootstrap.ts` 里并导出。「需要登录」提示页复用现有的 `device-notice` 样式结构即可，文案：「需要登录后才能查看」。

- [ ] **Step 5: 跑 webui 与 client 全部测试**

```bash
pnpm --filter @unidocs/tenant-portal-client test
pnpm --filter @unidocs/tenant-portal-client typecheck
pnpm --filter @unidocs/tenant-portal-webui test
pnpm --filter @unidocs/tenant-portal-webui typecheck
```

Expected: 全部 PASS。现有 webui 测试使用内存 transport，必须不受影响。

- [ ] **Step 6: 重新生成资源并在真 worker 上确认**

```bash
pnpm --filter @unidocs/cloudflare-portal build:webui
pnpm exec vitest run tests/integration/cloudflare/portal-local-runtime.test.mjs tests/integration/cloudflare/portal-tenant-api.test.mjs --fileParallelism=false
pnpm dev portal
```

浏览器打开 `http://127.0.0.1:8795/portal/`，确认：

- 工作台**不再出现** `sampleSeed()` 里的示例文档，而是空列表（真实数据库为空）
- 开发者工具 Network 里能看到对 `/portal/auth/session` 与 `/api/v1/tenants/t-local/documents` 的真实请求

Ctrl-C 退出。在报告里写明观察到的内容；若工作台仍显示示例文档，说明生成文件未更新或 `VITE_TENANT_FIXTURE` 被意外设置，查明后再报告。

- [ ] **Step 7: Mutation check**

逐一：transport 在 GET 上也发 CSRF；bootstrap 在非 200 时返回 `signed-in`；等待态不禁用评论入口。每次确认对应测试变红，改回。

- [ ] **Step 8: Commit**

```bash
git add packages/tenant-portal-client/src/http-transport.ts packages/tenant-portal-client/tests/http-transport.test.ts packages/tenant-portal-webui/src/session/bootstrap.ts packages/tenant-portal-webui/tests/session-bootstrap.test.ts packages/tenant-portal-webui/src/main.tsx packages/tenant-portal-webui/src/pages/document.tsx packages/tenant-portal-webui/tests/document-page.test.tsx packages/cloudflare-portal/src/tenant-ui-assets.generated.ts
git commit -m "feat(tenant-portal): read and write the real tenant API instead of a fixture

The console now asks /portal/auth/session who it is and talks to the tenant API
over HTTP, sending the CSRF token on writes. The in-memory fixture stays behind
VITE_TENANT_FIXTURE=memory for offline work.

A document with no version yet has nothing to show and, per the design, cannot
take comments, so the page shows it waiting for its Operator and disables the
comment entry rather than sending requests that can only fail."
```

---

## Plan 3 完成标准

- [ ] `pnpm --filter @unidocs/cloudflare-portal test` 与 `typecheck` 通过
- [ ] `pnpm --filter @unidocs/tenant-portal-client test` 与 `typecheck` 通过
- [ ] `pnpm --filter @unidocs/tenant-portal-webui test` 与 `typecheck` 通过
- [ ] `pnpm exec vitest run tests/integration/cloudflare/portal-local-runtime.test.mjs tests/integration/cloudflare/portal-cas.test.mjs tests/integration/cloudflare/portal-tenant-api.test.mjs --fileParallelism=false` 全部通过
- [ ] `pnpm dev portal` 下 `/portal/` 显示真实（空）工作台，`/admin/` 仍可用
- [ ] `packages/portal-service/src/tenant/*` 一行未改

**产出给 Plan 4 的：** 可用的 tenant HTTP 入口与 session；Plan 4 在其上加 Agent Bearer 认证（替换本 plan 的「Bearer 一律 401」）、`POST .../submissions`、Operator webhook 与 dev 种子。届时第一个文档才会拥有版本，webui 才会显示正文。
