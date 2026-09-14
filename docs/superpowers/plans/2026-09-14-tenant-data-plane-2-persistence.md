# Tenant 数据面 Plan 2：D1 迁移与四个 repository

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `portal-service` 里已经写好、却没有任何持久化实现的四个 tenant repository 接口补上 D1 实现，让 tenant 业务逻辑第一次能真正读写数据。

**Architecture:** `packages/portal-service/src/tenant/*` 定义了 `TenantDocumentRepository`、`TenantVersionRepository`、`TenantThreadRepository`、`TenantCatalogRepository` 四个接口，至今零实现——全仓引用它们的只有测试。本 plan 在 `packages/cloudflare-portal` 建立 D1 实现，外加一张迁移和一个游标编解码器。快照字节不落 D1：版本仓储持有 Plan 1 交付的 `SnapshotStore`，D1 只存 `CasBlobRef`。

**Tech Stack:** Cloudflare D1（SQLite）、TypeScript 5.9、Vitest 3、`@unidocs/protocol-tenant-portal` 的 Zod schema、Plan 1 的 `SnapshotStore`。

**Spec:** `docs/superpowers/specs/2026-09-12-tenant-data-plane-design.md`（§5 数据模型、§6 前半、§14 第 3 步）

## Global Constraints

- **迁移编号是 `0012`。** main 已占用到 `0011`（view bundles、operator validations、operators、四个 MCP 表）。落地前用 `ls packages/cloudflare-portal/migrations/` 再确认一次最大编号；如果已有人占了 0012，顺延并在报告里说明。
- 迁移由本地 runtime 自动应用（`services.mjs` 的 `migrations` 字段），经 `stacks/unidocs-cloudflare/local/sql-statements.mjs` 的 `splitSqlStatements` 逐条执行。**该切分器按分号切分并理解字符串/注释/触发器体**，所以多行 `CREATE TABLE` 是安全的，但不要写它无法解析的构造。
- 迁移风格照 `migrations/0001_admin_auth.sql`：`CHECK` 约束写进表定义、JSON 列一律 `CHECK (json_valid(...))`、时间戳存 INTEGER（epoch 秒）、索引紧跟其表。
- D1 repository 风格照 `packages/cloudflare-portal/src/document-types-repository.ts`：`database.batch([...])` 保证原子性、幂等重放走 `replay()` 模式、写操作前先 `authorize()`。
- **每张表带 `tenant_id` 列，但 v0 只跑一个 tenant（`t-local`）。** 不做租户注册，也不埋事后改主键的坑。
- **`open` 状态不落库。** 契约明示它是派生的（`latestCommentIdx > acknowledgedCommentIdx`），`listThreads` 的 `open` 过滤必须用 SQL 算，不得加布尔列。
- **不能复用 `portal_idempotency_receipts`**：它的 `actor_id` 带外键 `REFERENCES portal_administrators(member_id)`，tenant principal 不是管理员。
- `CLAUDE.md` 是 local-only（在 `.git/info/exclude` 里，从未被跟踪）。**绝不编辑、绝不 `git add`、绝不 `git add -A`。** 按路径显式暂存。
- Commit message 用英文祈使句并说明原因。**不要 push，不要开 PR。**
- 门禁用 `pnpm --filter @unidocs/cloudflare-portal test` 与 `typecheck`。**不要**用 `pnpm -r typecheck`：`packages/portal-service` 在 main 上就是红的（测试替身缺 `replayRemove` / `replayUpdate`），`tests/unit/scripts/stack-layout.test.mjs` 同样（硬编码的 stack 列表漏了已跟踪的 `stacks/docs`）。两者都不归你。

---

## 语义的可执行参照

`packages/tenant-portal-client/src/memory/store.ts` 已经完整实现了同一套契约的行为——版本追加、`parentVersionIdx` 取提交时的当前指针、幂等重放、`isOpen` 派生。**它是这些 repository 的语义对照物，两者行为不一致即为缺陷。** 实现每个方法前先读它对应的部分。

一处例外：它的分页是假的（`nextCursor` 恒为 `null`），不能作为游标实现的参考。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `packages/cloudflare-portal/migrations/0012_tenant.sql` | **新建。** 八张 tenant 表 |
| `packages/cloudflare-portal/src/tenant/cursor.ts` | **新建。** 不透明游标的编解码 |
| `packages/cloudflare-portal/src/tenant/catalog-repository.ts` | **新建。** `TenantCatalogRepository` |
| `packages/cloudflare-portal/src/tenant/document-repository.ts` | **新建。** `TenantDocumentRepository` |
| `packages/cloudflare-portal/src/tenant/version-repository.ts` | **新建。** `TenantVersionRepository`，持有 `SnapshotStore` |
| `packages/cloudflare-portal/src/tenant/thread-repository.ts` | **新建。** `TenantThreadRepository` |
| `packages/cloudflare-portal/tests/tenant/*.test.ts` | **新建。** 每个 repository 一个测试文件 |

---

### Task 1: tenant 表迁移

**Files:**
- Create: `packages/cloudflare-portal/migrations/0012_tenant.sql`
- Test: `packages/cloudflare-portal/tests/tenant/migration.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: 八张表，供 Task 3–8 的 repository 使用。

- [ ] **Step 1: 确认编号未被占用**

```bash
ls packages/cloudflare-portal/migrations/
```

最大编号应为 `0011`。若已有 `0012`，顺延到下一个可用编号，并在报告中说明你用了哪个。

- [ ] **Step 2: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/migration.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = fileURLToPath(new URL("../../migrations/0012_tenant.sql", import.meta.url));

describe("tenant migration", () => {
  it("creates every table the repositories need", async () => {
    const sql = await readFile(migration, "utf8");
    for (const table of [
      "portal_documents",
      "portal_versions",
      "portal_threads",
      "portal_comments",
      "portal_replies",
      "portal_document_audit",
      "portal_tenant_idempotency_receipts",
      "portal_tenant_sessions",
    ]) {
      expect(sql, table).toContain(`CREATE TABLE ${table} (`);
    }
  });

  it("does not store a thread's open state", async () => {
    const sql = await readFile(migration, "utf8");
    // open is derived from the two watermarks; a stored flag would be a second
    // source of truth the contract explicitly refuses.
    expect(sql).not.toMatch(/\bopen\b\s+INTEGER/i);
    expect(sql).not.toMatch(/\bresolved\b/i);
  });

  it("keeps tenant idempotency receipts off the administrator foreign key", async () => {
    const sql = await readFile(migration, "utf8");
    const receipts = sql.slice(sql.indexOf("CREATE TABLE portal_tenant_idempotency_receipts"));
    const table = receipts.slice(0, receipts.indexOf(");"));
    expect(table).not.toContain("portal_administrators");
  });

  it("validates every JSON column", async () => {
    const sql = await readFile(migration, "utf8");
    const jsonColumns = sql.match(/^\s*\w+_json TEXT NOT NULL(?! CHECK \(json_valid)/gm);
    expect(jsonColumns).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/migration
```

Expected: FAIL，迁移文件不存在。

- [ ] **Step 4: 写迁移**

创建 `packages/cloudflare-portal/migrations/0012_tenant.sql`：

```sql
CREATE TABLE portal_documents (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  document_type TEXT NOT NULL,
  current_version_idx INTEGER CHECK (current_version_idx IS NULL OR current_version_idx >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id)
);
CREATE INDEX portal_document_page ON portal_documents(tenant_id, created_at DESC, document_id DESC);
CREATE INDEX portal_document_type_page ON portal_documents(tenant_id, document_type, created_at DESC, document_id DESC);

CREATE TABLE portal_versions (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version_idx INTEGER NOT NULL CHECK (version_idx >= 0),
  parent_version_idx INTEGER CHECK (parent_version_idx IS NULL OR parent_version_idx >= 0),
  document_contract_idx INTEGER NOT NULL CHECK (document_contract_idx >= 0),
  author_agent_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  addressed_comments_json TEXT NOT NULL CHECK (json_valid(addressed_comments_json)),
  snapshot_blob_hash TEXT NOT NULL,
  snapshot_size INTEGER NOT NULL CHECK (snapshot_size >= 0),
  snapshot_content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, version_idx),
  FOREIGN KEY (tenant_id, document_id) REFERENCES portal_documents(tenant_id, document_id)
);

CREATE TABLE portal_threads (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, thread_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES portal_documents(tenant_id, document_id)
);
CREATE INDEX portal_thread_page ON portal_threads(tenant_id, document_id, created_at DESC, thread_id DESC);

CREATE TABLE portal_comments (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  comment_idx INTEGER NOT NULL CHECK (comment_idx >= 0),
  base_version_idx INTEGER NOT NULL CHECK (base_version_idx >= 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, thread_id, comment_idx),
  FOREIGN KEY (tenant_id, document_id, thread_id) REFERENCES portal_threads(tenant_id, document_id, thread_id)
);

CREATE TABLE portal_replies (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  reply_idx INTEGER NOT NULL CHECK (reply_idx >= 0),
  respond_through_comment_idx INTEGER NOT NULL CHECK (respond_through_comment_idx >= 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  result_locations_json TEXT NOT NULL CHECK (json_valid(result_locations_json)),
  author_agent_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, thread_id, reply_idx),
  FOREIGN KEY (tenant_id, document_id, thread_id) REFERENCES portal_threads(tenant_id, document_id, thread_id)
);

CREATE TABLE portal_document_audit (
  audit_event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_version_idx INTEGER CHECK (before_version_idx IS NULL OR before_version_idx >= 0),
  after_version_idx INTEGER CHECK (after_version_idx IS NULL OR after_version_idx >= 0),
  reason TEXT,
  request_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX portal_document_audit_page ON portal_document_audit(tenant_id, document_id, occurred_at DESC, audit_event_id DESC);

CREATE TABLE portal_tenant_idempotency_receipts (
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, operation, key)
);

CREATE TABLE portal_tenant_sessions (
  session_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 28800)
);
CREATE INDEX portal_tenant_session_expiry ON portal_tenant_sessions(expires_at);
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/migration
```

Expected: PASS。

- [ ] **Step 6: 确认本地 runtime 能应用它**

```bash
pnpm exec vitest run tests/integration/cloudflare/portal-local-runtime.test.mjs --fileParallelism=false
```

Expected: 9/9 仍然通过。该测试会启动运行时并应用全部迁移——**如果新迁移有语法错误或切分器无法解析的构造，这里会失败**，而单测的字符串断言发现不了。

- [ ] **Step 7: Commit**

```bash
git add packages/cloudflare-portal/migrations/0012_tenant.sql packages/cloudflare-portal/tests/tenant/migration.test.ts
git commit -m "feat(portal): add the tenant data-plane tables

Every table carries tenant_id even though v0 runs a single tenant, so the
eventual multi-tenant change is not a primary-key rewrite.

A thread's open state is absent on purpose: the contract derives it from the
two watermarks, and a stored flag would be a second source of truth that can
disagree. Tenant idempotency receipts get their own table because the admin
one's actor_id is a foreign key into portal_administrators."
```

---

### Task 2: 不透明游标

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/cursor.ts`
- Test: `packages/cloudflare-portal/tests/tenant/cursor.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `encodeCursor(key): string`、`decodeCursor(cursor): CursorKey | null`，供 Task 3–8 的分页使用。

**Background：** `memory/store.ts` 的分页是假的（`nextCursor` 恒为 `null`），所以没有可抄的实现。契约把游标定义为**不透明**字符串（`CursorSchema`），且 `requirePagination` 限制其长度不超过 1024。列表一律按 `(created_at DESC, id DESC)` 排序，游标就是上一页最后一行的这两个值。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/cursor.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/tenant/cursor.js";

describe("cursor", () => {
  it("round-trips a key", () => {
    const key = { at: 1_757_000_000, id: "doc-1" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it("survives an id containing the delimiter", () => {
    const key = { at: 1, id: "doc:with:colons" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it("is url-safe and carries no padding", () => {
    expect(encodeCursor({ at: 1, id: "doc-1" })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses malformed input rather than throwing", () => {
    expect(decodeCursor("not-base64!!")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ at: "no", id: 1 })))).toBeNull();
  });

  it("refuses a cursor past the contract's length bound", () => {
    expect(decodeCursor("A".repeat(1_025))).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/cursor
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant/cursor.ts`：

```ts
/**
 * Opaque list cursors.
 *
 * The contract says a cursor is opaque and bounded (TENANT_LIMITS.cursor is
 * 1024), so callers must never parse one. Every tenant list orders by
 * (created_at DESC, id DESC); the cursor is simply the last row's pair, which
 * makes paging a keyset comparison rather than an OFFSET scan.
 *
 * Decoding returns null instead of throwing: a malformed cursor is a client
 * mistake the service layer reports as invalid_request, not an exception.
 */
export interface CursorKey {
  /** Epoch seconds, matching the INTEGER timestamps in the tenant tables. */
  readonly at: number;
  readonly id: string;
}

const MAX_CURSOR_LENGTH = 1_024;

export function encodeCursor(key: CursorKey): string {
  const json = JSON.stringify([key.at, key.id]);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string): CursorKey | null {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let parsed: unknown;
  try {
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [at, id] = parsed;
  if (!Number.isSafeInteger(at) || (at as number) < 0 || typeof id !== "string" || !id) return null;
  return { at: at as number, id };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/cursor
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/cursor.ts packages/cloudflare-portal/tests/tenant/cursor.test.ts
git commit -m "feat(portal): encode tenant list cursors as an opaque keyset pair

The in-memory fixture pages by always returning nextCursor null, so there was
no implementation to follow. Every tenant list orders by (created_at, id), so
the cursor carries that pair and paging stays a keyset comparison instead of
an OFFSET scan that degrades as a document accumulates versions.

Decoding returns null rather than throwing: a malformed cursor is a client
error the service layer turns into invalid_request."
```

---

### Task 3: 目录仓储

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/catalog-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/catalog-repository.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `encodeCursor` / `decodeCursor`。
- Produces: `D1TenantCatalogRepository implements TenantCatalogRepository`，供 Plan 3 的 HTTP 层使用。

**Background（实施者必读）：** 这一层**没有自己的表**，它是对 admin 侧已有数据的投影。关键事实是 `portal_document_types.registration_json` 存的是完整的 `DocumentTypeRegistration`，其中 `typeCardBundle`、`viewBundle`、`builtinOperator` 都是**整条记录而非 ID**，所以不需要任何 JOIN。

`PublicDocumentType` 各字段的来源：

| 字段 | 来源 |
| --- | --- |
| `documentType` | `portal_document_types.document_type`，`WHERE enabled = 1` |
| `typeCardBundleId` | `registration.typeCardBundle.typeCardBundleId` |
| `typeCard` | 由 `registration.typeCardBundle.manifest` 投影，资源路径用 `bundleUrl` 拼成绝对 URL |
| `viewBundleId` | `registration.viewBundle.viewBundleId` |
| `availableDocumentContractIdxs` | `viewBundle.manifest.supportedDocumentContractIdxs` ∩ `builtinOperator.descriptor.supportedDocumentContracts[documentType]` |

三者任一为 `null` 的类型**不得出现在目录里**——`PublicDocumentTypeSchema` 要求 `availableDocumentContractIdxs` 至少一项，交集为空的同样跳过。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/catalog-repository.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { PublicDocumentTypeSchema } from "@unidocs/protocol-tenant-portal";
import { D1TenantCatalogRepository } from "../../src/tenant/catalog-repository.js";

const context = { tenantId: "t-local", principalId: "user-1", transport: "session" as const };

function registration(over: Record<string, unknown> = {}) {
  return {
    documentType: "markdown",
    internalName: "Markdown",
    enabled: true,
    latestDocumentContract: null,
    typeCardBundle: {
      typeCardBundleId: "tcb-1",
      bundleUrl: "https://bundles.example/type-card-bundles/tcb-1/",
      manifest: {
        protocol: "unidocs-type-card-bundle/v1",
        documentType: "markdown",
        locales: { en: { name: "Markdown", description: "Plain text", sampleThumbnailAlt: "A document" } },
        icon: { kind: "svg", path: "icon.svg" },
        sampleThumbnail: "sample.png",
      },
    },
    viewBundle: {
      viewBundleId: "vb-1",
      manifest: { supportedDocumentContractIdxs: [0, 1] },
    },
    builtinOperator: {
      operatorId: "op-1",
      descriptor: { supportedDocumentContracts: { markdown: [1, 2] } },
    },
    ...over,
  };
}

function databaseDouble(rows: readonly { document_type: string; registration_json: string }[]) {
  return {
    prepare(_sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          all: async () => ({ results: rows }),
          first: async () => rows[0] ?? null,
        }),
      };
    },
  } as never;
}

describe("D1TenantCatalogRepository.listDocumentTypes", () => {
  it("projects a public document type from the registration alone", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
      "https://bundles.example",
    );
    const page = await repository.listDocumentTypes(context, {});
    expect(page.items).toHaveLength(1);
    expect(PublicDocumentTypeSchema.safeParse(page.items[0]).success).toBe(true);
  });

  it("intersects the View's and the Operator's supported revisions", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
      "https://bundles.example",
    );
    const page = await repository.listDocumentTypes(context, {});
    // View supports [0, 1], Operator supports [1, 2] - only 1 is usable.
    expect(page.items[0].availableDocumentContractIdxs).toEqual([1]);
  });

  it("omits a type whose View and Operator share no revision", async () => {
    const noOverlap = registration({
      builtinOperator: { operatorId: "op-1", descriptor: { supportedDocumentContracts: { markdown: [7] } } },
    });
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(noOverlap) }]),
      "https://bundles.example",
    );
    expect((await repository.listDocumentTypes(context, {})).items).toEqual([]);
  });

  it("omits a type that is missing any of the three current selections", async () => {
    for (const missing of ["typeCardBundle", "viewBundle", "builtinOperator"]) {
      const repository = new D1TenantCatalogRepository(
        databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration({ [missing]: null })) }]),
        "https://bundles.example",
      );
      expect((await repository.listDocumentTypes(context, {})).items, missing).toEqual([]);
    }
  });

  it("resolves type card asset paths against the bundle url", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
      "https://bundles.example",
    );
    const [item] = (await repository.listDocumentTypes(context, {})).items;
    expect(item.typeCard.sampleThumbnailUrl).toBe("https://bundles.example/type-card-bundles/tcb-1/sample.png");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/catalog-repository
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant/catalog-repository.ts`。要点：

- 构造参数 `(database: D1Database, bundleOrigin: string)`。
- `listDocumentTypes`：
  ```sql
  SELECT document_type, registration_json FROM portal_document_types
  WHERE enabled = 1 AND (?1 IS NULL OR document_type < ?1)
  ORDER BY document_type DESC LIMIT ?2
  ```
  目录按 `document_type` 排序（它是主键，天然唯一且稳定），游标用 `{ at: 0, id: document_type }`。
- 逐行 `JSON.parse(registration_json)`，三项当前选择任一为 `null` 则跳过该行。
- 交集：`view.manifest.supportedDocumentContractIdxs.filter(idx => operatorIdxs.includes(idx))`，升序，空则跳过。
- `typeCard` 投影：`locales` 与 `icon` 原样带出（icon 若是 png 集合，逐尺寸把 path 拼成绝对 URL）；`sampleThumbnailUrl = new URL(manifest.sampleThumbnail, typeCardBundle.bundleUrl).toString()`。
- 每个投影结果用 `PublicDocumentTypeSchema.parse()` 收口——**投影出不合规的记录必须当场失败，而不是流给调用方**。
- `getDocumentContract(context, documentType, idx)`：
  ```sql
  SELECT record_json FROM portal_document_contracts
  WHERE document_type = ? AND document_contract_idx = ?
  ```
  命中则 `DocumentContractRecordSchema.parse(JSON.parse(record_json))`，未命中返回 `null`（服务层会转成 `not_found`）。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/catalog-repository
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/catalog-repository.ts packages/cloudflare-portal/tests/tenant/catalog-repository.test.ts
git commit -m "feat(portal): project the public document type catalog from admin data

The tenant catalog owns no tables. A document type's registration already
embeds the current Type Card bundle, View bundle and Operator as whole records
rather than ids, so the projection needs no join.

availableDocumentContractIdxs is the intersection of what the View and the
Operator each declare, which is why a type with no overlap is omitted rather
than published with an empty list the schema would reject."
```

---

### Task 4: 文档仓储的读路径与创建

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/document-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/document-repository.test.ts`

**Interfaces:**
- Consumes: Task 2 的游标。
- Produces: `D1TenantDocumentRepository` 的 `create` / `get` / `list`；Task 5 在同一个类上补 `moveCurrentVersion` / `listAuditEvents`。

**Background：** 语义对照物是 `memory/store.ts` 的 `createDocument`（`currentVersionIdx` 初始为 `null`）与 `listDocuments`（可按 `documentType` 过滤）。幂等重放照 `document-types-repository.ts` 的 `replay()` 模式，但写进 `portal_tenant_idempotency_receipts`。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/document-repository.test.ts`。

**这个文件建立后续四个 task 复用的 D1 替身写法**，所以完整写出来：

```ts
import { describe, expect, it, vi } from "vitest";
import { TenantOperationError } from "@unidocs/portal-service";
import { D1TenantDocumentRepository } from "../../src/tenant/document-repository.js";

const context = { tenantId: "t-local", principalId: "user-1", transport: "session" as const };

const document = {
  documentId: "doc-1",
  name: "Notes",
  documentType: "markdown",
  currentVersionIdx: null,
  createdAt: "2026-09-14T00:00:00.000Z",
};

const audit = {
  auditEventId: "evt-1",
  actorId: "user-1",
  action: "document.created",
  beforeVersionIdx: null,
  afterVersionIdx: null,
  reason: null,
  requestId: "req-1",
  occurredAt: "2026-09-14T00:00:00.000Z",
};

const row = (over = {}) => ({
  tenant_id: "t-local",
  document_id: "doc-1",
  name: "Notes",
  document_type: "markdown",
  current_version_idx: null,
  created_at: 1_757_808_000,
  ...over,
});

/**
 * Records every statement and its bindings, and answers reads from a queue the
 * test primes. Matching on SQL shape rather than exact text keeps the double
 * from re-asserting the query string, which the repository is free to reword.
 */
function databaseDouble(options: { first?: unknown[]; all?: unknown[][]; batchThrows?: Error } = {}) {
  const statements: { sql: string; bindings: unknown[] }[] = [];
  const firsts = [...(options.first ?? [])];
  const alls = [...(options.all ?? [])];
  const batch = vi.fn(async (prepared: unknown[]) => {
    if (options.batchThrows) throw options.batchThrows;
    return prepared.map(() => ({ meta: { changes: 1 } }));
  });
  const database = {
    prepare(sql: string) {
      const record = { sql, bindings: [] as unknown[] };
      statements.push(record);
      const bound = {
        bind: (...bindings: unknown[]) => { record.bindings = bindings; return bound; },
        first: async () => (firsts.length ? firsts.shift() : null),
        all: async () => ({ results: alls.length ? alls.shift() : [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return bound;
    },
    batch,
  };
  return { database: database as never, statements, batch };
}

describe("D1TenantDocumentRepository.create", () => {
  it("writes the document, its audit event and the receipt in one batch", async () => {
    const { database, batch } = databaseDouble({ first: [null] });
    const repository = new D1TenantDocumentRepository(database);
    const created = await repository.create({
      context, key: "idem-1", fingerprint: "fp-1", document, audit,
    });
    expect(created).toEqual(document);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(3);
  });

  it("replays an identical key without creating a second document", async () => {
    const { database, batch } = databaseDouble({
      first: [{ fingerprint: "fp-1", response_json: JSON.stringify(document) }],
    });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }))
      .resolves.toEqual(document);
    expect(batch).not.toHaveBeenCalled();
  });

  it("refuses the same key with a different body", async () => {
    const { database } = databaseDouble({
      first: [{ fingerprint: "other", response_json: JSON.stringify(document) }],
    });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }))
      .rejects.toThrow(TenantOperationError);
  });

  it("absorbs a concurrent duplicate by re-reading the receipt after a failed batch", async () => {
    const { database } = databaseDouble({
      first: [null, { fingerprint: "fp-1", response_json: JSON.stringify(document) }],
      batchThrows: new Error("UNIQUE constraint failed"),
    });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.create({ context, key: "idem-1", fingerprint: "fp-1", document, audit }))
      .resolves.toEqual(document);
  });
});

describe("D1TenantDocumentRepository.get", () => {
  it("returns the record when it exists", async () => {
    const { database } = databaseDouble({ first: [row()] });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.get(context, "doc-1")).resolves.toEqual(document);
  });

  it("returns null when it does not", async () => {
    const { database } = databaseDouble({ first: [null] });
    const repository = new D1TenantDocumentRepository(database);
    await expect(repository.get(context, "missing")).resolves.toBeNull();
  });

  it("scopes the lookup by tenant", async () => {
    const { database, statements } = databaseDouble({ first: [null] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.get(context, "doc-1");
    expect(statements[0].sql).toContain("tenant_id");
    expect(statements[0].bindings).toContain("t-local");
  });
});

describe("D1TenantDocumentRepository.list", () => {
  it("returns a null cursor when the page is not full", async () => {
    const { database } = databaseDouble({ all: [[row()]] });
    const repository = new D1TenantDocumentRepository(database);
    const page = await repository.list(context, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("returns a cursor and drops the probe row when a further page exists", async () => {
    const { database } = databaseDouble({
      all: [[row({ document_id: "doc-2", created_at: 2 }), row({ document_id: "doc-1", created_at: 1 })]],
    });
    const repository = new D1TenantDocumentRepository(database);
    const page = await repository.list(context, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it("filters by document type when asked", async () => {
    const { database, statements } = databaseDouble({ all: [[]] });
    const repository = new D1TenantDocumentRepository(database);
    await repository.list(context, { documentType: "markdown" });
    expect(statements[0].sql).toContain("document_type");
    expect(statements[0].bindings).toContain("markdown");
  });
});
```

第 3 个 `get` 用例是**跨租户隔离**，单租户 v0 下最容易漏，而它正是 `tenant_id` 进主键的理由。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/document-repository
```

Expected: FAIL。

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant/document-repository.ts`：

- `create(command)`：先 `replay()` 查收据；命中且 fingerprint 相同则返回原响应，fingerprint 不同则抛 `TenantOperationError("idempotency_conflict")`。未命中则 `database.batch([...])` 原子写入收据行、文档行、审计行，返回 `command.document`。`batch` 抛错后再 `replay()` 一次以吸收并发重复。
- `get(context, documentId)`：`WHERE tenant_id = ? AND document_id = ?`，未命中返回 `null`。
- `list(context, query)`：`WHERE tenant_id = ?`，可选 `AND document_type = ?`，游标用 `(created_at, document_id) <` 比较，`ORDER BY created_at DESC, document_id DESC LIMIT ?`。取 `limit + 1` 行判断是否还有下一页，多取的那行丢弃并用最后一行生成 `nextCursor`。
- 所有出参用对应的 Zod schema `parse()` 收口。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/document-repository
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/document-repository.ts packages/cloudflare-portal/tests/tenant/document-repository.test.ts
git commit -m "feat(portal): persist tenant documents with idempotent creation

Creation writes the document, its audit event and the idempotency receipt in
one batch, so a replayed key returns the original record instead of creating a
second document. A batch failure re-reads the receipt before surfacing, which
is how a concurrent duplicate is absorbed rather than reported as an error.

Listing pages by keyset over (created_at, document_id) and fetches limit + 1
rows to decide whether a next cursor exists, so no count query is needed."
```

---
### Task 5: 当前指针移动与文档审计

**Files:**
- Modify: `packages/cloudflare-portal/src/tenant/document-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/document-repository.test.ts`

**Interfaces:**
- Consumes: Task 4 建立的类与游标。
- Produces: 同一个类上的 `moveCurrentVersion` / `listAuditEvents`，补齐 `TenantDocumentRepository`。

**Background：** `CurrentVersionMoveCommand` 把等值锁随命令带下来，接口注释说得很直接：仓储**必须**在提交时拒绝 `observedCurrentVersionIdx` 与当前指针不符的移动，并在**同一事务**里写审计事件。

设计文档 §7.2 强调这里比较的是**相等**而非新旧：所有者把 current 回退到旧版本时，基于较新版本的提交同样要失败，因为指针移动本身表达了意图。核心不变量 #9 要求 current pointer 的移动必须可审计。

- [ ] **Step 1: 写失败的测试**

追加到 `packages/cloudflare-portal/tests/tenant/document-repository.test.ts`：

```ts
// 1. 观测值等于当前指针时，移动成功并返回更新后的 DocumentRecord
// 2. 观测值不符时抛 TenantOperationError("version_conflict")，且文档行未被修改
// 3. 从 null 移动到 0（首个版本就位后的第一次移动）成立
// 4. 目标版本不存在时失败，不会把指针指向不存在的版本
// 5. 移动成功时审计事件与文档更新在同一个 batch 里（断言 batch 收到两条语句）
// 6. 移动失败时不写审计事件
// 7. listAuditEvents 按 occurred_at DESC 分页，跨租户不可见
```

第 2 条和第 6 条是这个 task 的要害：**一次被拒绝的移动不得留下任何痕迹**。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/document-repository
```

Expected: FAIL，方法未实现。

- [ ] **Step 3: 实现**

等值锁写进 UPDATE 的 WHERE 子句，靠受影响行数判断成败——不要先 SELECT 再 UPDATE，那之间有竞态：

```sql
UPDATE portal_documents SET current_version_idx = ?
WHERE tenant_id = ? AND document_id = ?
  AND current_version_idx IS ?            -- IS 而非 =，因为观测值可能是 NULL
  AND EXISTS (SELECT 1 FROM portal_versions
              WHERE tenant_id = ? AND document_id = ? AND version_idx = ?)
```

`IS` 是关键：SQLite 里 `NULL = NULL` 为 NULL（假），而 `NULL IS NULL` 为真，首次移动的观测值正是 `null`。

`batch([update, auditInsert])` 提交后检查 update 的 `meta.changes`：为 `0` 则说明等值锁或目标版本校验失败——此时**审计行也必须不存在**。D1 的 batch 是单事务，但一条 UPDATE 影响 0 行不会让事务回滚，所以审计 INSERT 要用同样的条件保护：

```sql
INSERT INTO portal_document_audit (...)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM portal_documents
              WHERE tenant_id = ? AND document_id = ? AND current_version_idx = ?)
```

即「只有当指针确实已是目标值时才记审计」。这样两条语句共享同一个成立条件，不会出现「移动失败却留下审计」。

`meta.changes === 0` 时抛 `TenantOperationError("version_conflict")`。

`listAuditEvents` 按 `(occurred_at, audit_event_id)` 倒序分页，与 Task 4 的 keyset 写法一致。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/document-repository
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/document-repository.ts packages/cloudflare-portal/tests/tenant/document-repository.test.ts
git commit -m "feat(portal): move the current pointer under an equality lock

The lock lives in the UPDATE's WHERE clause rather than in a preceding SELECT,
so there is no window between checking the pointer and moving it. It compares
with IS, not =, because the observed value is null before the first version
and NULL = NULL is false in SQLite.

The audit insert carries the same condition, so a refused move leaves no trace:
a batch is one transaction, but an UPDATE matching zero rows does not roll it
back, and an audit row for a move that never happened would be worse than none."
```

---

### Task 6: 版本仓储

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/version-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/version-repository.test.ts`

**Interfaces:**
- Consumes: Task 2 的游标；Plan 1 交付的 `SnapshotStore`（`packages/cloudflare-portal/src/snapshot-store.ts`，方法 `read(ref, signal?)` / `retain(ref, requestId)` / `release(ref, requestId)`）。
- Produces: `D1TenantVersionRepository implements TenantVersionRepository`。

**Background：** 这是 Plan 1 的 CAS 工作第一次被真正消费。接口要求：

```ts
export interface VersionSnapshot {
  readonly documentType: string;
  readonly body: ReadableStream<Uint8Array>;
}
readSnapshot(context, documentId, versionIdx): Promise<VersionSnapshot | null>;
```

注意它返回的是 `documentType` 而**不是** media type——服务层用 `documentSnapshotContentType(documentType)` 自己派生，所以线上的 content type 永远是算出来的，不会是存下来的自由字符串。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/version-repository.test.ts`，。**复用 Task 4 建立的 `databaseDouble` 替身写法**（把它提取到 `tests/tenant/d1-double.ts` 供各文件共用），覆盖：

```ts
// 1. list 按 version_idx 升序（出生顺序）分页，addressed_comments_json 正确还原
// 2. get 命中返回 VersionRecord（含 parentVersionIdx 可为 null），未命中返回 null
// 3. readSnapshot 用行里的 CasBlobRef 调 SnapshotStore.read，并带上文档的 documentType
// 4. readSnapshot 在版本不存在时返回 null，且不调用 SnapshotStore
// 5. 跨租户不可见
```

第 4 条要断言 store **没有被调用**——一个不存在的版本不该产生 CAS 流量。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/version-repository
```

Expected: FAIL。

- [ ] **Step 3: 实现**

构造参数 `(database: D1Database, snapshots: SnapshotStore)`。

`list` 与契约一致按**出生顺序**（`version_idx ASC`）返回——这与其它列表的倒序不同，因为版本历史面板要按顺序画 base parent forest。游标用 `{ at: 0, id: String(version_idx).padStart(...) }` 会很别扭，改用 `version_idx > ?` 的简单 keyset 即可，但仍经 `encodeCursor` 保持不透明。

`readSnapshot`：一条语句同时取版本行与文档类型——

```sql
SELECT v.snapshot_blob_hash, v.snapshot_size, v.snapshot_content_type, d.document_type
FROM portal_versions v
JOIN portal_documents d ON d.tenant_id = v.tenant_id AND d.document_id = v.document_id
WHERE v.tenant_id = ? AND v.document_id = ? AND v.version_idx = ?
```

未命中直接返回 `null`（不碰 CAS）。命中则

```ts
const body = await this.snapshots.read({
  blobHash: row.snapshot_blob_hash,
  size: row.snapshot_size,
  contentType: row.snapshot_content_type,
});
return { documentType: row.document_type, body };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/version-repository
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/version-repository.ts packages/cloudflare-portal/tests/tenant/version-repository.test.ts
git commit -m "feat(portal): read version metadata from D1 and snapshots from CAS

This is the first consumer of the snapshot store: D1 holds only the CasBlobRef,
and the bytes stream out of content-addressed storage.

The repository hands back the document type rather than a media type, so the
wire content type stays derived by the service layer instead of being a
free-form string someone could store wrong. A version that does not exist
returns null without touching CAS at all."
```

---

### Task 7: 线程列表与 open 的 SQL 派生

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/thread-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/thread-repository.test.ts`

**Interfaces:**
- Consumes: Task 2 的游标。
- Produces: `D1TenantThreadRepository` 的 `loadCommentAnchor` / `list`；Task 8 在同一个类上补其余方法。

**Background：** 这是全 plan 最该看清契约的一处。线程的 open 状态**是派生的**：

```
open := latestCommentIdx > acknowledgedCommentIdx
```

`memory/store.ts` 的 `isOpen` 就是这条规则的可执行版本（两个水位各取 `MAX`，无记录时取 `-1`）。SQL 实现必须与它逐条对应——**不得新增布尔列，不得把状态缓存在 threads 表上**。

`loadCommentAnchor(context, documentId, baseVersionIdx)` 返回 `{ documentContractIdx, locationSchema }`：版本行给出 `document_contract_idx`，该 revision 的 location schema 来自 `portal_document_contracts.record_json` 的 `location.schema`。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/tenant/thread-repository.test.ts`，。**复用 Task 4 建立的 `databaseDouble` 替身写法**（把它提取到 `tests/tenant/d1-double.ts` 供各文件共用），覆盖：

```ts
// loadCommentAnchor
// 1. 命中返回该版本的 documentContractIdx 与对应 revision 的 location schema
// 2. 版本不存在返回 null（服务层据此报 not_found）
//
// list
// 3. 只返回 ThreadRef（仅 threadId），不泄漏评论内容
// 4. open=true 只返回「最新评论水位 > 回复确认水位」的线程
// 5. open=false 只返回其余线程
// 6. 一个有评论、无回复的线程算 open（确认水位为 -1）
// 7. 一个 reply 的 respond_through 等于最新 comment_idx 的线程算已回复
// 8. 追加一条更新的评论后，同一线程重新变回 open
// 9. versionIdx 过滤只返回「有评论锚定在该版本」的线程
// 10. 跨租户不可见
```

第 6–8 条把派生规则的三种边界钉死，它们正是「把 open 存下来」会出错的地方。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/thread-repository
```

Expected: FAIL。

- [ ] **Step 3: 实现**

`list` 的核心是把 `isOpen` 翻译成 SQL。两个水位各用一个相关子查询，无记录时 `COALESCE(..., -1)`，与 memory 实现的 `-1` 完全一致：

```sql
SELECT t.thread_id, t.created_at
FROM portal_threads t
WHERE t.tenant_id = ?1 AND t.document_id = ?2
  AND (?3 IS NULL OR EXISTS (
        SELECT 1 FROM portal_comments c
        WHERE c.tenant_id = t.tenant_id AND c.document_id = t.document_id
          AND c.thread_id = t.thread_id AND c.base_version_idx = ?3))
  AND (?4 IS NULL OR ?4 = (
        CASE WHEN (
          SELECT COALESCE(MAX(c.comment_idx), -1) FROM portal_comments c
          WHERE c.tenant_id = t.tenant_id AND c.document_id = t.document_id AND c.thread_id = t.thread_id
        ) > (
          SELECT COALESCE(MAX(r.respond_through_comment_idx), -1) FROM portal_replies r
          WHERE r.tenant_id = t.tenant_id AND r.document_id = t.document_id AND r.thread_id = t.thread_id
        ) THEN 1 ELSE 0 END))
  AND (?5 IS NULL OR (t.created_at, t.thread_id) < (?5, ?6))
ORDER BY t.created_at DESC, t.thread_id DESC
LIMIT ?7
```

`?4` 传 `open ? 1 : 0`，未过滤时传 `NULL`。

**如果 D1 不支持行值比较 `(a, b) < (c, d)`**，改写成等价的 `(t.created_at < ?5 OR (t.created_at = ?5 AND t.thread_id < ?6))`，并在报告里说明你用了哪种——不要保留一个跑不通的写法。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/thread-repository
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/thread-repository.ts packages/cloudflare-portal/tests/tenant/thread-repository.test.ts
git commit -m "feat(portal): derive a thread's open state in SQL

open is latestCommentIdx > acknowledgedCommentIdx, computed from two
correlated MAX subqueries that coalesce to -1 exactly as the in-memory
fixture does. Nothing is stored: the contract has no resolve or reopen
operation, and a cached flag would be a second source of truth that drifts the
moment a comment lands during a reply."
```

---

### Task 8: 线程创建、读取与评论追加

**Files:**
- Modify: `packages/cloudflare-portal/src/tenant/thread-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/thread-repository.test.ts`

**Interfaces:**
- Consumes: Task 7 建立的类。
- Produces: `create` / `get` / `appendComment`，补齐 `TenantThreadRepository`，四个仓储至此全部完成。

**Background：** `comment_idx` 是线程内顺序号，分配它需要先读最大值再写——两条语句之间存在竞态，而 D1 的 batch 虽然是一个事务，语句之间却无法传值。

解决办法是让分配发生在**单条语句内**，并让主键兜底：

```sql
INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
SELECT ?1, ?2, ?3, COALESCE(MAX(comment_idx), -1) + 1, ?4, ?5, ?6, ?7, ?8
FROM portal_comments WHERE tenant_id = ?1 AND document_id = ?2 AND thread_id = ?3
RETURNING comment_idx
```

主键 `(tenant_id, document_id, thread_id, comment_idx)` 让并发的两次追加必有一次违反唯一约束而失败，失败方重试即可拿到下一个序号——**不要用应用层的锁或先 SELECT 后 INSERT 代替它**。

`RETURNING` 需要 SQLite 3.35+。**先确认 D1 支持**：若不支持，退回到在同一 batch 里追加一条 `SELECT MAX(comment_idx) ...` 读回，并在报告里说明。

- [ ] **Step 1: 写失败的测试**

追加到 `packages/cloudflare-portal/tests/tenant/thread-repository.test.ts`：

```ts
// create
// 1. 创建线程与其首条评论（commentIdx 为 0），返回完整 ThreadDetail
// 2. 同 key 同内容重放返回原 ThreadDetail，不产生第二个线程
// 3. 同 key 不同 fingerprint 抛 idempotency_conflict
//
// get
// 4. 返回两条完整的追加序列（comments 与 replies），各自按 idx 升序
// 5. 线程不存在返回 null
// 6. 跨租户不可见
//
// appendComment
// 7. 追加分配的 commentIdx 是当前最大值 +1
// 8. 同 key 同内容重放返回原 CommentRecord，不产生第二条评论
// 9. 向不存在的线程追加失败
// 10. 追加后该线程重新变为 open（与 Task 7 的派生联动）
```

第 10 条跨越两个 task，是整套水位语义真正成立的证明。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- tenant/thread-repository
```

Expected: FAIL。

- [ ] **Step 3: 实现**

- `create`：`replay()` → `batch([收据, 线程行, 首条评论])` → 返回 `{ threadId, comments: [comment], replies: [] }`。`threadId` 由服务层之外生成（命令里带 `request`，线程 id 用 `th-${crypto.randomUUID()}`）。
- `get`：两条查询取 comments 与 replies，各按 idx 升序，组装 `ThreadDetail` 并 `ThreadDetailSchema.parse()`。
- `appendComment`：`replay()` → 上面的 `INSERT ... SELECT ... RETURNING` → 用返回的 `comment_idx` 组装 `CommentRecord`，并把它写进幂等收据。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: 整个包通过。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/tenant/thread-repository.ts packages/cloudflare-portal/tests/tenant/thread-repository.test.ts
git commit -m "feat(portal): append comments with a race-free index

The comment index is allocated inside the INSERT itself rather than by reading
the maximum first, so two concurrent appends cannot compute the same number.
The composite primary key is the backstop: the loser violates it and retries,
which is cheaper and more honest than an application-level lock.

Threads and comments are immutable and append-only, so there is no update path
here at all - a correction is a new comment, which is also what re-opens the
thread."
```

---

## Plan 2 完成标准

- [ ] `pnpm --filter @unidocs/cloudflare-portal test` 通过
- [ ] `pnpm --filter @unidocs/cloudflare-portal typecheck` 通过
- [ ] `pnpm exec vitest run tests/integration/cloudflare/portal-local-runtime.test.mjs --fileParallelism=false` 仍 9/9（证明新迁移能被真实运行时应用）
- [ ] 四个 repository 接口全部有实现，且 `packages/portal-service/src/tenant/*` 一行未改

产出给 Plan 3 的接口：`D1TenantCatalogRepository`、`D1TenantDocumentRepository`、`D1TenantVersionRepository`、`D1TenantThreadRepository`，以及 `portal_tenant_sessions` 表（Plan 3 的 tenant session 用）。

**本 plan 结束时 webui 仍看不到真数据** —— 这些仓储还没有接到任何 HTTP 入口上，那是 Plan 3 的第一件事。
