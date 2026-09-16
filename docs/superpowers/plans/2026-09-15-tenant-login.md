# 租户登录全覆盖 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让租户面每个 API 都要求真实身份：Google 登录签发会话、成员表决定租户与 principal、本地免登录改为显式开关，并用两条随契约与生产路由表增长的守门测试证明覆盖。

**Architecture:** 新增 D1 成员表，会话查找每次 JOIN 成员状态；登录端点复用 admin 的 `createGoogleLogin`（先解耦两处写死 admin 的地方），挂在 `serveTenant` 同一出口；admin API 新增 `tenant-members` 管理成员；WebUI 加登录/退出并按身份隔离草稿；最后开生产路由并补 T1（契约遍历，走 `worker.fetch`）与 T2（生产路由遍历，用生产 vars）。

**Tech Stack:** Cloudflare Workers + D1（Miniflare 真库测试）、oRPC 契约（`@orpc/contract` / `@orpc/openapi`）、`oauth4webapi`、Vitest、React 19 + Testing Library、`jsonc-parser`。

**Spec:** `docs/superpowers/specs/2026-09-15-tenant-login-coverage-design.md`（执行者必须同时读它；本计划不重复设计理由）。

## Global Constraints

- 迁移文件：`packages/cloudflare-portal/migrations/0015_tenant_members.sql`。
- Cookie：会话 `__Host-unidocs_tenant`，CSRF `__Host-unidocs_tenant_csrf`，登录事务 `__Host-unidocs_tenant_login`。
- 会话有效期保持 `TENANT_SESSION_TTL_SECONDS = 28_800`；每成员至多 **10** 条会话。
- 登录端点：`GET /portal/auth/login?returnTo=`、`GET /portal/auth/callback`；默认 returnTo `/portal/`。
- 失败回跳：`303 /portal/?login=denied|failed|unavailable&requestId=<id>`。
- `principal_id` 形如 `user:<uuid>`；开发成员固定为 `member-local-dev` / `t-local` / `user-local` / `dev@unidocs.local` / issuer `local-dev` / subject `user-local` / added_by `dev-session`。
- 本地免登录开关：binding `PORTAL_TENANT_DEV_SESSION === "true"`，默认关闭，生产配置不声明。
- 日志事件名：`tenant_google_login_failed`、`tenant_login_not_configured`、`tenant_dev_session_ignored`、`tenant_operation_failed`；**绝不**记录 stack、error 对象、token、client secret。
- 租户认证审计 action：`member.bound`、`session.created`、`session.revoked`。admin 审计 action：`tenant_member.added`、`tenant_member.removed`、`tenant_member.sessions_revoked`；resource type `tenant_member`。
- 成员行永不删除，停用只置 `active = 0`。
- email 入库前必须经 `normalizeGoogleEmail`（trim + 小写 + schema 校验）。
- T2 解析 jsonc 只能用 `jsonc-parser`，禁止正则去注释。
- 每个任务结束时该任务涉及包的 `vitest run` 与 `typecheck` 必须通过再提交。提交信息结尾附：
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## 命令速查

| 目的 | 命令（仓库根目录执行） |
|---|---|
| portal 单测 | `pnpm --filter @unidocs/cloudflare-portal exec vitest run <file>` |
| portal 类型检查 | `pnpm --filter @unidocs/cloudflare-portal typecheck` |
| portal 生成 env 类型 | `pnpm --filter @unidocs/cloudflare-portal types:generate` |
| portal-service 单测 / 类型 | `pnpm --filter @unidocs/portal-service test` / `typecheck` |
| admin 契约单测 / 生成 OpenAPI | `pnpm --filter @unidocs/protocol-admin-portal test` / `docs:generate` |
| 租户 WebUI 单测 / 类型 | `pnpm --filter @unidocs/tenant-portal-webui test` / `typecheck` |
| admin WebUI 类型 | `pnpm --filter @unidocs/admin-portal-webui typecheck` |
| 重建内嵌 UI 资源 | `pnpm --filter @unidocs/cloudflare-portal build:webui` |
| 集成测试（单文件） | `pnpm exec vitest run --fileParallelism=false tests/integration/cloudflare/<file>` |
| 根单元测试 | `pnpm exec vitest run tests/unit/scripts/portal-auth-deploy.test.mjs` |

## 文件地图

| 文件 | 职责 | 任务 |
|---|---|---|
| `packages/cloudflare-portal/migrations/0015_tenant_members.sql` | 成员、登录事务、租户认证审计表 | 1 |
| `packages/cloudflare-portal/tests/tenant/tenant-members-migration.test.ts` | 迁移约束测试 | 1 |
| `packages/cloudflare-portal/tests/tenant/members.ts` | 测试助手：插入成员 | 2 |
| `packages/cloudflare-portal/src/tenant/session.ts` | 会话查找 JOIN 成员、`prepareIssue`、开发会话、退出审计 | 2 |
| `packages/cloudflare-portal/src/tenant/session-http.ts` | 自动签发改为开关；导出 cookie 构造函数 | 2 |
| `packages/cloudflare-portal/src/google-config.ts`、`src/google-login.ts` | 解耦 admin；租户 surface 与 `tenantReturnPath` | 3 |
| `packages/cloudflare-portal/src/tenant/login-repository.ts` | 登录事务存取、`completeLogin` 原子批次 | 4 |
| `packages/cloudflare-portal/src/tenant/login-http.ts` | 两个登录端点、失败回跳、日志 | 5 |
| `packages/cloudflare-portal/src/worker.ts` | 路由接入、开关 binding、tenant-members 分发、注释 | 2、5、8、13 |
| `packages/protocol-admin-portal/src/{schemas,contract,index}.ts` | `tenantMembers` 契约 | 6 |
| `packages/admin-portal-webui/src/app.tsx` | 审计 action/resource 标签 | 6 |
| `packages/portal-service/src/admin/tenant-members.ts` | 成员服务 | 7 |
| `packages/cloudflare-portal/src/admin-authority.ts` | 管理员权威校验 SQL（与 administrators 共用） | 8 |
| `packages/cloudflare-portal/src/tenant-members-{repository,http}.ts` | 成员 D1 仓储与 HTTP | 8 |
| `stacks/unidocs-cloudflare/local/{runtime,portal-seed}.mjs` | 开关选项；seed 加成员 | 2、9 |
| `packages/tenant-portal-webui/src/session/{sign-in.ts,signed-out-notice.tsx,bootstrap.ts}` | 登录入口、回跳提示、退出 | 10 |
| `packages/tenant-portal-webui/src/drafts/*`、`client-context.tsx` | 草稿按身份隔离 | 11 |
| `packages/cloudflare-portal/tests/tenant/auth-coverage-walk.test.ts` | T1 | 12 |
| `packages/cloudflare-portal/tests/production-routes-auth.test.ts` | T2 | 13 |
| `packages/cloudflare-portal/wrangler.production.jsonc`、`packages/cloudflare-markdown/wrangler.toml` | 生产路由与数据面配置 | 13、14 |

---

### Task 1: 迁移 0015

**Files:**
- Create: `packages/cloudflare-portal/migrations/0015_tenant_members.sql`
- Test: `packages/cloudflare-portal/tests/tenant/tenant-members-migration.test.ts`

**Interfaces:**
- Produces: 表 `portal_tenant_members`、`portal_tenant_login_transactions`、`portal_tenant_auth_audit`，索引 `portal_tenant_session_principal`。后续任务直接写 SQL 使用这些列名（见 SQL）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/cloudflare-portal/tests/tenant/tenant-members-migration.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRealD1, type RealD1 } from "./real-d1.js";

let real: RealD1;
beforeEach(async () => { real = await startRealD1(); });
afterEach(async () => { await real.dispose(); });

const insert = (values: { id: string; tenant?: string; principal: string; email: string; active?: number; issuer?: string | null; subject?: string | null }) =>
  real.db.prepare(`INSERT INTO portal_tenant_members
    (member_id, tenant_id, principal_id, email, issuer, subject, active, added_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'test', 1, 1)`)
    .bind(values.id, values.tenant ?? "t1", values.principal, values.email, values.issuer ?? null, values.subject ?? null, values.active ?? 1)
    .run();

describe("0015_tenant_members (real D1)", () => {
  it("allows one active membership per email, and reuse after deactivation", async () => {
    await insert({ id: "m1", principal: "user:1", email: "a@example.com" });
    await expect(insert({ id: "m2", tenant: "t2", principal: "user:2", email: "a@example.com" })).rejects.toThrow();
    await real.db.prepare("UPDATE portal_tenant_members SET active = 0 WHERE member_id = 'm1'").run();
    await expect(insert({ id: "m2", tenant: "t2", principal: "user:2", email: "a@example.com" })).resolves.toBeDefined();
  });

  it("allows one active membership per Google identity", async () => {
    await insert({ id: "m1", principal: "user:1", email: "a@example.com", issuer: "https://accounts.google.com", subject: "s" });
    await expect(insert({ id: "m2", tenant: "t2", principal: "user:2", email: "b@example.com", issuer: "https://accounts.google.com", subject: "s" })).rejects.toThrow();
  });

  it("requires issuer and subject together, and a boolean active flag", async () => {
    await expect(insert({ id: "m1", principal: "user:1", email: "a@example.com", issuer: "https://accounts.google.com" })).rejects.toThrow();
    await expect(insert({ id: "m1", principal: "user:1", email: "a@example.com", active: 2 })).rejects.toThrow();
  });

  it("never reuses a principal inside a tenant, even for an inactive row", async () => {
    await insert({ id: "m1", principal: "user:1", email: "a@example.com", active: 0 });
    await expect(insert({ id: "m2", principal: "user:1", email: "b@example.com" })).rejects.toThrow();
  });

  it("bounds a login transaction to ten minutes", async () => {
    const put = (expires: number) => real.db.prepare(
      "INSERT INTO portal_tenant_login_transactions VALUES ('s', 'b', 'v', 'n', '/portal/', 1000, ?)",
    ).bind(expires).run();
    await expect(put(1601)).rejects.toThrow();
    await expect(put(1600)).resolves.toBeDefined();
  });

  it("only accepts known auth audit actions for an existing member", async () => {
    await insert({ id: "m1", principal: "user:1", email: "a@example.com" });
    const audit = (member: string, action: string) => real.db.prepare(
      "INSERT INTO portal_tenant_auth_audit VALUES (?, ?, ?, 1, 'req')",
    ).bind(crypto.randomUUID(), member, action).run();
    await expect(audit("m1", "session.created")).resolves.toBeDefined();
    await expect(audit("m1", "session.stolen")).rejects.toThrow();
    await expect(audit("missing", "session.created")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/tenant-members-migration.test.ts`
Expected: FAIL，`no such table: portal_tenant_members`。

- [ ] **Step 3: 写迁移**

```sql
-- packages/cloudflare-portal/migrations/0015_tenant_members.sql
-- Tenant members: who may hold a tenant session, and as which principal.
-- Rows are never deleted; removal only clears `active`, so principal history
-- stays resolvable. One person, one tenant: both active indexes are global.
CREATE TABLE portal_tenant_members (
  member_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  email TEXT NOT NULL,
  issuer TEXT,
  subject TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((issuer IS NULL) = (subject IS NULL))
);
CREATE UNIQUE INDEX portal_tenant_member_active_email ON portal_tenant_members(email) WHERE active = 1;
CREATE UNIQUE INDEX portal_tenant_member_active_identity ON portal_tenant_members(issuer, subject) WHERE active = 1 AND subject IS NOT NULL;
CREATE UNIQUE INDEX portal_tenant_member_principal ON portal_tenant_members(tenant_id, principal_id);

CREATE TABLE portal_tenant_login_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 600)
);
CREATE INDEX portal_tenant_login_expiry ON portal_tenant_login_transactions(expires_at);

CREATE TABLE portal_tenant_auth_audit (
  event_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES portal_tenant_members(member_id),
  action TEXT NOT NULL CHECK (action IN ('member.bound', 'session.created', 'session.revoked')),
  occurred_at INTEGER NOT NULL,
  request_id TEXT NOT NULL
);

CREATE INDEX portal_tenant_session_principal ON portal_tenant_sessions(tenant_id, principal_id, created_at);
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/tenant-members-migration.test.ts tests/tenant/migration.test.ts tests/tenant/real-d1.test.ts`
Expected: PASS。若外键断言失败，说明该 D1 连接未开启外键：在测试开头执行 `PRAGMA foreign_keys = ON` 前先确认 `tests/integration/cloudflare/portal-auth-repository.test.mjs` 里同类外键断言是否通过，二者须一致，**不要**删断言。

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/migrations/0015_tenant_members.sql packages/cloudflare-portal/tests/tenant/tenant-members-migration.test.ts
git commit -m "feat(portal): add tenant members, login transactions and auth audit tables"
```

---
### Task 2: 会话必须属于活跃成员；本地免登录改为开关

**Files:**
- Create: `packages/cloudflare-portal/tests/tenant/members.ts`
- Modify: `packages/cloudflare-portal/src/tenant/session.ts`
- Modify: `packages/cloudflare-portal/src/tenant/session-http.ts`
- Modify: `packages/cloudflare-portal/src/worker.ts:124`（传开关）
- Modify: `packages/cloudflare-portal/wrangler.jsonc`（vars 加 `PORTAL_TENANT_DEV_SESSION: ""`），重新生成 `src/env.generated.d.ts`
- Modify: `packages/cloudflare-portal/.dev.vars.example`
- Modify: `stacks/unidocs-cloudflare/local/runtime.mjs`（`tenantDevSession` 选项）
- Test: `packages/cloudflare-portal/tests/tenant/session.test.ts`、`tests/tenant/session-http.test.ts`、`tests/worker.test.ts`
- Test: `tests/integration/cloudflare/portal-tenant-api.test.mjs`、`portal-operator-loop.test.mjs`、`portal-local-runtime.test.mjs`、`portal-seed.test.mjs`

**Interfaces:**
- Consumes: Task 1 的表。
- Produces:
  - `D1TenantSessionStore.prepareIssue(tenantId: string, principalId: string, now: number): Promise<{ token: string; csrfToken: string; statement: D1PreparedStatement }>`
  - `D1TenantSessionStore.issue(tenantId, principalId, now): Promise<{ token; csrfToken }>`（行为不变）
  - `D1TenantSessionStore.issueDevSession(now: number): Promise<{ token; csrfToken }>`
  - `D1TenantSessionStore.revoke(sessionHash: string, requestId: string, now: number): Promise<void>`（**签名变化**）
  - `find` 只返回活跃且已绑定成员的会话。
  - `session-http.ts` 导出 `sessionCookie(token: string): string`、`csrfCookie(token: string): string`。
  - `createTenantSessionHttp` 新增必填选项 `devSession: boolean`。
  - 测试助手 `insertMember(db, input): Promise<string>`（返回 member_id）。
  - 常量 `DEV_TENANT_ID = "t-local"`、`DEV_PRINCIPAL_ID = "user-local"`（从 `session.ts` 导出）。

- [ ] **Step 1: 写测试助手**

```ts
// packages/cloudflare-portal/tests/tenant/members.ts
import type { D1Database } from "@cloudflare/workers-types";

/**
 * Inserts a tenant member row straight into D1. A session only authenticates
 * while its (tenant, principal) belongs to an active, bound member, so every
 * test that issues a session needs one of these first.
 */
export async function insertMember(db: D1Database, input: {
  readonly tenantId: string;
  readonly principalId: string;
  readonly email?: string;
  readonly memberId?: string;
  readonly active?: boolean;
  readonly bound?: boolean;
  readonly createdAt?: number;
}): Promise<string> {
  const memberId = input.memberId ?? `member-${crypto.randomUUID()}`;
  const bound = input.bound ?? true;
  const createdAt = input.createdAt ?? 1;
  await db.prepare(`INSERT INTO portal_tenant_members
    (member_id, tenant_id, principal_id, email, issuer, subject, active, added_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`)
    .bind(
      memberId, input.tenantId, input.principalId,
      input.email ?? `${memberId}@example.test`,
      bound ? "https://accounts.google.com" : null,
      bound ? `subject-${memberId}` : null,
      input.active === false ? 0 : 1,
      createdAt, createdAt,
    )
    .run();
  return memberId;
}
```

- [ ] **Step 2: 给现有会话测试补成员行，并写新的失败测试**

`tests/tenant/session.test.ts`：在 import 区加 `import { insertMember } from "./members.js";`，把 `beforeEach` 改为：

```ts
beforeEach(async () => {
  real = await startRealD1();
  store = new D1TenantSessionStore(real.db);
  await insertMember(real.db, { tenantId: "t-local", principalId: "user-local", memberId: "member-user-local" });
});
```

把第 59 行附近的 `await store.revoke(hash);` 改为 `await store.revoke(hash, "req-revoke", NOW);`。在 `describe("D1TenantSessionStore", ...)` 内追加：

```ts
  it("finds no session once its member is deactivated", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const hash = await hashSessionSecret(token);
    expect(await store.find(hash, NOW)).not.toBeNull();
    await real.db.prepare("UPDATE portal_tenant_members SET active = 0 WHERE member_id = 'member-user-local'").run();
    expect(await store.find(hash, NOW)).toBeNull();
  });

  it("finds no session for a member who never bound a Google identity", async () => {
    await insertMember(real.db, { tenantId: "t-local", principalId: "user:invited", bound: false });
    const { token } = await store.issue("t-local", "user:invited", NOW);
    expect(await store.find(await hashSessionSecret(token), NOW)).toBeNull();
  });

  it("finds no session for a principal with no member row", async () => {
    const { token } = await store.issue("t-local", "user:stranger", NOW);
    expect(await store.find(await hashSessionSecret(token), NOW)).toBeNull();
  });

  it("audits a revocation against the member and deletes the row", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const hash = await hashSessionSecret(token);
    await store.revoke(hash, "req-logout", NOW);
    expect(await store.find(hash, NOW)).toBeNull();
    const audit = await real.db.prepare("SELECT member_id, action, occurred_at, request_id FROM portal_tenant_auth_audit").all();
    expect(audit.results).toEqual([{ member_id: "member-user-local", action: "session.revoked", occurred_at: NOW, request_id: "req-logout" }]);
  });

  it("issues a dev session that brings its own member row, and is idempotent about it", async () => {
    await real.db.prepare("DELETE FROM portal_tenant_members").run();
    const first = await store.issueDevSession(NOW);
    const second = await store.issueDevSession(NOW + 1);
    expect(await store.find(await hashSessionSecret(first.token), NOW + 1)).toMatchObject({ tenantId: "t-local", principalId: "user-local" });
    expect(await store.find(await hashSessionSecret(second.token), NOW + 1)).not.toBeNull();
    const members = await real.db.prepare("SELECT member_id, email, issuer, subject, active, added_by FROM portal_tenant_members").all();
    expect(members.results).toEqual([{ member_id: "member-local-dev", email: "dev@unidocs.local", issuer: "local-dev", subject: "user-local", active: 1, added_by: "dev-session" }]);
    expect((await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_auth_audit").first<{ n: number }>())?.n).toBe(0);
  });
```

若 `hashSessionSecret` 尚未在该文件 import，加 `import { hashSessionSecret } from "../../src/auth.js";`。

`tests/tenant/session-http.test.ts`：同样 import `insertMember`，`beforeEach` 末尾加
`await insertMember(real.db, { tenantId: "t-local", principalId: "user-local", memberId: "member-user-local" });`。
把文件中**所有** `createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW` 改为 `createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW, devSession: true`；`origin: PRODUCTION` 的同样加 `devSession: true`（证明生产 origin 即使开关打开也不签发）。然后在 `describe("GET /portal/auth/session", ...)` 内追加：

```ts
  it("never issues on loopback while the switch is off", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW, devSession: false });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`), "req-1");
    expect(response?.status).toBe(401);
    expect(response!.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows()).toBe(0);
  });

  it("does not replace a present but invalid session cookie with a dev session", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW, devSession: true });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`, {
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${"x".repeat(43)}` },
    }), "req-1");
    expect(response?.status).toBe(401);
    expect(await sessionRows()).toBe(0);
  });

  it("does not downgrade a deactivated member's session to a dev session", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await real.db.prepare("UPDATE portal_tenant_members SET active = 0").run();
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW, devSession: true });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`, {
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${token}` },
    }), "req-1");
    expect(response?.status).toBe(401);
    expect(response!.headers.getSetCookie()).toEqual([]);
  });

  it("warns and refuses when the switch is on for a non-loopback origin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handle = createTenantSessionHttp({ origin: PRODUCTION, store, now: () => NOW, devSession: true });
      const response = await handle(new Request(`${PRODUCTION}/portal/auth/session`), "req-9");
      expect(response?.status).toBe(401);
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: "tenant_dev_session_ignored", requestId: "req-9" }]);
    } finally {
      warn.mockRestore();
    }
  });
```

把文件顶部 vitest import 补上 `vi`。把原有的 “never issues a session on a non-loopback origin” 用例保留（它现在带 `devSession: true`，但不应产生 warn 断言之外的行为——若它因 warn 输出噪音失败，用 `vi.spyOn(console, "warn").mockImplementation(() => {})` 包住）。

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/session.test.ts tests/tenant/session-http.test.ts`
Expected: FAIL（`issueDevSession is not a function`、未停用成员的断言不成立、`devSession` 类型错误等）。

- [ ] **Step 4: 改 `session.ts`**

在文件顶部 import 改为：

```ts
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
```

在常量区追加：

```ts
export const DEV_TENANT_ID = "t-local";
export const DEV_PRINCIPAL_ID = "user-local";
```

用下面的实现替换 `D1TenantSessionStore` 的 `issue`、`find`、`revoke`，并新增 `prepareIssue`、`issueDevSession`：

```ts
  /**
   * Mints the secrets and the INSERT without running it, so a caller can put
   * the session in the same batch as the writes that justify it.
   */
  async prepareIssue(tenantId: string, principalId: string, now: number): Promise<{ token: string; csrfToken: string; statement: D1PreparedStatement }> {
    requireClock(now);
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const csrfToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const statement = this.db
      .prepare(
        "INSERT INTO portal_tenant_sessions (session_hash, tenant_id, principal_id, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(await hashSessionSecret(token), tenantId, principalId, await hashSessionSecret(csrfToken), now, now + TENANT_SESSION_TTL_SECONDS);
    return { token, csrfToken, statement };
  }

  async issue(tenantId: string, principalId: string, now: number): Promise<{ token: string; csrfToken: string }> {
    const { token, csrfToken, statement } = await this.prepareIssue(tenantId, principalId, now);
    await statement.run();
    return { token, csrfToken };
  }

  /**
   * The local dev session. It goes through the same member check as any other
   * session, so it brings its own member row, (re)activated in the same batch.
   * Not audited: it is not a sign-in.
   */
  async issueDevSession(now: number): Promise<{ token: string; csrfToken: string }> {
    const { token, csrfToken, statement } = await this.prepareIssue(DEV_TENANT_ID, DEV_PRINCIPAL_ID, now);
    await this.db.batch([
      this.db.prepare(`INSERT INTO portal_tenant_members
          (member_id, tenant_id, principal_id, email, issuer, subject, active, added_by, created_at, updated_at)
        VALUES ('member-local-dev', ?, ?, 'dev@unidocs.local', 'local-dev', ?, 1, 'dev-session', ?, ?)
        ON CONFLICT (member_id) DO UPDATE SET active = 1, updated_at = excluded.updated_at`)
        .bind(DEV_TENANT_ID, DEV_PRINCIPAL_ID, DEV_PRINCIPAL_ID, now, now),
      statement,
    ]);
    return { token, csrfToken };
  }

  /** Only a session whose member is active and bound authenticates: removal takes effect on the next request. */
  async find(sessionHash: string, now: number): Promise<TenantSessionRecord | null> {
    const row = await this.db
      .prepare(`SELECT session.* FROM portal_tenant_sessions AS session
        JOIN portal_tenant_members AS member
          ON member.tenant_id = session.tenant_id AND member.principal_id = session.principal_id
        WHERE session.session_hash = ? AND session.created_at <= ? AND session.expires_at > ?
          AND member.active = 1 AND member.subject IS NOT NULL`)
      .bind(sessionHash, now, now)
      .first<TenantSessionRow>();
    if (!row) return null;
    return {
      sessionHash: row.session_hash,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      csrfHash: row.csrf_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async revoke(sessionHash: string, requestId: string, now: number): Promise<void> {
    requireClock(now);
    await this.db.batch([
      this.db.prepare(`INSERT INTO portal_tenant_auth_audit (event_id, member_id, action, occurred_at, request_id)
        SELECT ?, member.member_id, 'session.revoked', ?, ? FROM portal_tenant_sessions AS session
        JOIN portal_tenant_members AS member
          ON member.tenant_id = session.tenant_id AND member.principal_id = session.principal_id
        WHERE session.session_hash = ?`)
        .bind(crypto.randomUUID(), now, requestId, sessionHash),
      this.db.prepare("DELETE FROM portal_tenant_sessions WHERE session_hash = ?").bind(sessionHash),
    ]);
  }
```

- [ ] **Step 5: 改 `session-http.ts`**

1. `sessionCookie` 与 `csrfCookie` 前加 `export`。
2. import 行改为：
   `import { authenticateTenant, D1TenantSessionStore, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE, TENANT_SESSION_TTL_SECONDS } from "./session.js";`（不变），并在 options 类型里加 `readonly devSession: boolean;`，解构加 `devSession`。
3. 在 `accessErrorResponse` 之后加：

```ts
function carriesSessionCookie(request: Request): boolean {
  return (request.headers.get("cookie") ?? "").split(";").some(part => part.trim().split("=", 1)[0] === TENANT_SESSION_COOKIE);
}
```

4. 把 `SESSION_PATH` 分支 catch 里整段自动签发（注释 + if）替换为：

```ts
        // The local dev session is opt-in (PORTAL_TENANT_DEV_SESSION) and only
        // for a request that carries no session cookie at all: a present but
        // invalid one (expired, revoked, member removed) stays 401 instead of
        // silently becoming someone else. The Authorization check is the
        // load-bearing one of the rest: authenticateTenant throws
        // "unauthorized" both for a rejected bearer and for a missing session,
        // and a rejected bearer must never be upgraded to a session. The origin
        // and cross-site checks repeat what authenticateTenant already enforced
        // before it could throw "unauthorized"; they guard against the two
        // drifting apart.
        if (
          error.code === "unauthorized"
          && devSession
          && request.headers.get("authorization") === null
          && !carriesSessionCookie(request)
          && new URL(request.url).origin === origin
          && request.headers.get("sec-fetch-site") !== "cross-site"
        ) {
          if (!isLocalDevOrigin(origin)) {
            console.warn(JSON.stringify({ event: "tenant_dev_session_ignored", requestId }));
            return accessErrorResponse(error, requestId);
          }
          const { token, csrfToken } = await store.issueDevSession(now());
          const headers = new Headers();
          headers.append("Set-Cookie", sessionCookie(token));
          headers.append("Set-Cookie", csrfCookie(csrfToken));
          return Response.json({ tenantId: DEV_TENANT_ID, principalId: DEV_PRINCIPAL_ID }, { headers });
        }
```

   并把 import 补上 `DEV_PRINCIPAL_ID, DEV_TENANT_ID`。
5. `LOGOUT_PATH` 分支里 `if (context.sessionHash) await store.revoke(context.sessionHash);` 改为
   `if (context.sessionHash) await store.revoke(context.sessionHash, requestId, now());`

- [ ] **Step 6: 运行会话测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/session.test.ts tests/tenant/session-http.test.ts`
Expected: PASS。

- [ ] **Step 7: 接入 worker 与 env 类型**

`wrangler.jsonc` 的 `vars` 在 `"AGENT_TENANT_ID": ""` 之前插入 `"PORTAL_TENANT_DEV_SESSION": "",`。
Run: `pnpm --filter @unidocs/cloudflare-portal types:generate`，确认 `src/env.generated.d.ts` 出现 `PORTAL_TENANT_DEV_SESSION: string;`。

`worker.ts` 的 `serveTenant` 里：

```ts
    const session = await createTenantSessionHttp({
      origin: env.PORTAL_ORIGIN, store, now, ...agent,
      // Unset in production config: `undefined === "true"` keeps it off.
      devSession: env.PORTAL_TENANT_DEV_SESSION === "true",
    })(request, requestId);
```

`tests/worker.test.ts` 的 `tenantEnv(db)` 里 `Object.getOwnPropertyDescriptors({ DB: db, ...` 对象加一项 `PORTAL_TENANT_DEV_SESSION: "true",`。在该 describe 内追加：

```ts
  it("refuses a loopback session probe while the dev session switch is off", async () => {
    const env = Object.defineProperties(tenantEnv(real.db), { PORTAL_TENANT_DEV_SESSION: { value: "" } });
    const response = await worker.fetch(new Request(`${ORIGIN}/portal/auth/session`), env);
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
```

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/worker.test.ts`
Expected: PASS。

- [ ] **Step 8: 本地运行时选项与集成测试**

`stacks/unidocs-cloudflare/local/runtime.mjs` 的 `startLocalRuntime` 参数解构里，在 `bundleEntryOverrides = {},` 之后加：

```js
  // 打开 portal 的本地免登录（PORTAL_TENANT_DEV_SESSION）。默认关闭：`pnpm dev
  // portal` 走真实 Google 登录，要免登录就在 packages/cloudflare-portal/.dev.vars
  // 里打开；集成测试需要现成的 t-local 会话时显式传 true。.dev.vars 里的值优先。
  tenantDevSession = false,
```

在 `serviceDevVars[component.name] = {` 对象里，把 `...devVars,` 改为：

```js
      ...(component.name === "portal" && tenantDevSession ? { PORTAL_TENANT_DEV_SESSION: "true" } : {}),
      ...devVars,
```

四个集成测试文件里所有 `startLocalRuntime({` 调用加 `tenantDevSession: true,`：
- `tests/integration/cloudflare/portal-tenant-api.test.mjs:62`
- `tests/integration/cloudflare/portal-operator-loop.test.mjs:129`
- `tests/integration/cloudflare/portal-local-runtime.test.mjs:76`、`:182`、`:217`
- `tests/integration/cloudflare/portal-seed.test.mjs:33`

`packages/cloudflare-portal/.dev.vars.example` 在 `PORTAL_BOOTSTRAP_EMAIL=` 段之后追加：

```
# Local sign-in shortcut for the tenant console. Off by default: `pnpm dev
# portal` then signs in with real Google (the seed adds PORTAL_BOOTSTRAP_EMAIL
# as a member of t-local). Set to "true" to get a t-local / user-local session
# without signing in; it only works on a loopback PORTAL_ORIGIN. While it is on,
# "sign out" only ends the current session: the console's next session probe
# carries no cookie and is handed a fresh dev session. Turn it off to test real
# sign-in and sign-out.
#
# PORTAL_TENANT_DEV_SESSION=true
```

Run: `pnpm exec vitest run --fileParallelism=false tests/integration/cloudflare/portal-tenant-api.test.mjs tests/integration/cloudflare/portal-local-runtime.test.mjs`
Expected: PASS。`portal-operator-loop` 与 `portal-seed` 较慢，在本任务末尾各跑一次确认 PASS。

- [ ] **Step 9: 全包回归并提交**

Run: `pnpm --filter @unidocs/cloudflare-portal test && pnpm --filter @unidocs/cloudflare-portal typecheck`
Expected: PASS。

```bash
git add packages/cloudflare-portal stacks/unidocs-cloudflare/local/runtime.mjs tests/integration/cloudflare
git commit -m "feat(portal): require an active member for tenant sessions and gate the dev session behind a switch"
```

---
### Task 3: 解耦 Google 登录，加租户 surface

**Files:**
- Modify: `packages/cloudflare-portal/src/google-config.ts:12-33`
- Modify: `packages/cloudflare-portal/src/google-login.ts`
- Modify: `packages/cloudflare-portal/src/index.ts`（导出新符号）
- Test: `packages/cloudflare-portal/tests/google-config.test.ts`、`tests/google-login.test.ts`、`tests/integration/cloudflare/portal-auth.test.mjs`

**Interfaces:**
- Produces（均从 `src/google-login.ts` 导出，并经 `src/index.ts` 再导出）：
  - `TENANT_LOGIN_COOKIE = "__Host-unidocs_tenant_login"`
  - `tenantReturnPath(value: string): string`（非法抛 `AdminAccessError("unauthorized")`）
  - `createTenantGoogleLogin(config: PortalGoogleConfig, ports: PortalLoginPorts)`：返回值与 `createPortalGoogleLogin` 同形（`begin(request)`、`complete(request)`）
  - `PortalGoogleConfig` 不再有 `redirectUri`。

- [ ] **Step 1: 更新现有测试去掉 `redirectUri`，写新失败测试**

`tests/google-config.test.ts`：三处 `redirectUri: "…/admin/auth/callback",` 删除（`toEqual` 那处删除后对象恰为四个字段）。在文件末尾追加：

```ts
test("no longer carries a redirect URI: each login surface derives its own callback", () => {
  expect(portalGoogleConfigFromGateway(settings, "https://portal.example")).not.toHaveProperty("redirectUri");
});
```

`tests/google-login.test.ts`：
- 第 32 行 `expect(body.get("redirect_uri")).toBe(loginConfig.redirectUri);` 改为 ``toBe(`${origin}/admin/auth/callback`)``
- 第 54 行 ``new Request(`${loginConfig.redirectUri}?state=`` 改为 ``new Request(`${origin}/admin/auth/callback?state=``
- 第 79 行 `toBe(config.redirectUri)` 改为 ``toBe(`${origin}/admin/auth/callback`)``
- 第 214 行 `rawConfig` 去掉 `redirectUri` 字段。
- import 增加 `createTenantGoogleLogin, TENANT_LOGIN_COOKIE, tenantReturnPath`。

在文件末尾追加：

```ts
describe("Tenant Google login surface", () => {
  const ports = (put: (transaction: PortalLoginTransaction) => void) => ({
    now: () => Math.floor(Date.now() / 1000),
    put: async (transaction: PortalLoginTransaction) => put(transaction),
    take: async () => null,
    fetch: vi.fn<typeof fetch>(async input => {
      if (String(input).endsWith("openid-configuration")) return Response.json(discovery);
      throw new Error("Unexpected endpoint");
    }),
  });

  test("begins on /portal/auth/login with its own callback and cookie", async () => {
    let stored: PortalLoginTransaction | undefined;
    const login = createTenantGoogleLogin(config, ports(transaction => { stored = transaction; }));
    const start = await login.begin(new Request(`${origin}/portal/auth/login?returnTo=${encodeURIComponent("/portal/#/d/doc-1")}`));
    const target = new URL(start.headers.get("location")!);
    expect(start.status).toBe(303);
    expect(target.searchParams.get("redirect_uri")).toBe(`${origin}/portal/auth/callback`);
    expect(start.headers.get("set-cookie")).toMatch(new RegExp(`^${TENANT_LOGIN_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$`));
    expect(stored?.returnTo).toBe("/portal/#/d/doc-1");
  });

  test("defaults the return path to /portal/", async () => {
    let stored: PortalLoginTransaction | undefined;
    const login = createTenantGoogleLogin(config, ports(transaction => { stored = transaction; }));
    await login.begin(new Request(`${origin}/portal/auth/login`));
    expect(stored?.returnTo).toBe("/portal/");
  });

  test("refuses the admin begin path", async () => {
    const login = createTenantGoogleLogin(config, ports(() => {}));
    await expect(login.begin(new Request(`${origin}/admin/auth/login`))).rejects.toThrow();
  });

  test("accepts a loopback origin, which the admin cookie name used to gate", () => {
    const local = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: "c", GATEWAY_OIDC_CLIENT_SECRET: "s" }, "http://127.0.0.1:8795");
    expect(() => createTenantGoogleLogin(local, ports(() => {}))).not.toThrow();
  });

  test.each(["/portal/", "/portal/?tab=1", "/portal/#/d/doc-1/th-1/0", "/portal/index.html"])("accepts tenant return path %j", path => {
    expect(tenantReturnPath(path)).toBe(path);
  });

  test.each([
    "/portal", "/admin/", "https://attacker.example", "//attacker.example", "/portal/auth/login", "/portal/auth/callback",
    "/portal/auth", "/portal/../admin/", "/portal/\\evil", "/portal/%2e%2e/admin", "/portal/%61uth/login", "/portal/ space",
    "/portal/\nunsafe", `/portal/${"a".repeat(2050)}`,
  ])("rejects tenant return path %j", path => {
    expect(() => tenantReturnPath(path)).toThrow();
  });
});
```

`tests/integration/cloudflare/portal-auth.test.mjs`：第 105、115 行的 `config.redirectUri` 改为 `(config.origin + '/admin/auth/callback')`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/google-config.test.ts tests/google-login.test.ts`
Expected: FAIL（`createTenantGoogleLogin` 未导出、`redirectUri` 仍存在）。

- [ ] **Step 3: 改 `google-config.ts`**

删除接口里的 `readonly redirectUri: string;`，返回值改为
`return { issuer: GOOGLE_ISSUER, clientId, clientSecret, origin: portalOrigin };`

- [ ] **Step 4: 改 `google-login.ts`**

1. 在 `LOGIN_COOKIE` 下加 `export const TENANT_LOGIN_COOKIE = "__Host-unidocs_tenant_login";`
2. 用下面三个函数替换现有 `portalReturnPath`（正则与原实现逐字一致，只是参数化了前缀）：

```ts
/**
 * A same-origin path under `prefix`, never under `${prefix}auth`. Shared by
 * both login surfaces so their return-path rules cannot drift apart.
 */
function scopedReturnPath(value: string, prefix: "/admin/" | "/portal/"): string {
  const authPath = `${prefix}auth`;
  if (value.length > 2048 || !value.startsWith(prefix) || /[\\\u0000-\u0020\u007f]/.test(value)) throw new AdminAccessError("unauthorized");
  const url = new URL(value, "https://portal.invalid");
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new AdminAccessError("unauthorized"); }
  if (url.origin !== "https://portal.invalid" || !pathname.startsWith(prefix) || pathname === authPath || pathname.startsWith(`${authPath}/`) || /[%\\\u0000-\u0020\u007f]/.test(pathname) || pathname.split("/").some(segment => segment === "." || segment === "..")) throw new AdminAccessError("unauthorized");
  return url.pathname + url.search + url.hash;
}

export function portalReturnPath(value: string): string {
  if (/^\/oauth\/admin-mcp\/authorize\?resume=[A-Za-z0-9_-]{43}$/.test(value)) return value;
  return scopedReturnPath(value, "/admin/");
}

export function tenantReturnPath(value: string): string {
  return scopedReturnPath(value, "/portal/");
}
```

3. 在 `createPortalGoogleLogin` 之后加：

```ts
export function createTenantGoogleLogin(config: PortalGoogleConfig, ports: PortalLoginPorts) {
  return createGoogleLogin(config, ports, {
    beginPath: "/portal/auth/login", callbackPath: "/portal/auth/callback", cookieName: TENANT_LOGIN_COOKIE,
    returnParameter: "returnTo", defaultReturn: "/portal/", validateReturn: tenantReturnPath,
  });
}
```

4. `createGoogleLogin` 开头两行（`const localWebUi = …` 与配置校验）替换为：

```ts
  const redirectUri = `${config.origin}${surface.callbackPath}`;
  const localWebUi = isLocalDevOrigin(config.origin);
  if (config.issuer !== GOOGLE_ISSUER || new URL(config.origin).origin !== config.origin || (!config.origin.startsWith("https://") && !localWebUi) || !config.clientId.trim() || !config.clientSecret.trim()) throw new TypeError("Invalid Portal Google configuration");
```

5. `begin` 里 `redirect_uri: config.redirectUri,` 改为 `redirect_uri: redirectUri,`；`complete` 里 `authorizationCodeGrantRequest(…, parameters, config.redirectUri, …)` 的 `config.redirectUri` 改为 `redirectUri`。

`src/index.ts`：找到导出 `createPortalGoogleLogin` 的那一行，同一 export 列表追加 `createTenantGoogleLogin, TENANT_LOGIN_COOKIE, tenantReturnPath`。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/google-config.test.ts tests/google-login.test.ts && pnpm --filter @unidocs/cloudflare-portal typecheck`
Expected: PASS。再跑 `pnpm exec vitest run --fileParallelism=false tests/integration/cloudflare/portal-auth.test.mjs`，Expected: PASS（admin 登录不回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/cloudflare-portal/src packages/cloudflare-portal/tests tests/integration/cloudflare/portal-auth.test.mjs
git commit -m "refactor(portal): derive the Google callback per login surface and add the tenant surface"
```

---

### Task 4: 租户登录仓储（原子绑定与签发）

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/login-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/login-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 表；Task 2 `D1TenantSessionStore.prepareIssue`；`@unidocs/portal-service` 的 `AdminAccessError`、`adminConfirmationTime`、`requireRecentAuthentication`、`validateAdminIdentity`、`type AdminIdentity`；`src/google-login.ts` 的 `type PortalLoginTransaction`。
- Produces:
  - `TENANT_MEMBER_SESSION_LIMIT = 10`
  - `class D1TenantLoginRepository { constructor(db: D1Database, now?: () => number) }`
    - `put(transaction: PortalLoginTransaction): Promise<void>`（顺带清理至多 100 条过期事务）
    - `take(stateHash: string, browserHash: string, now: number): Promise<PortalLoginTransaction | null>`
    - `completeLogin(identity: AdminIdentity, requestId: string): Promise<{ memberId: string; tenantId: string; principalId: string; token: string; csrfToken: string }>`
      - 不在名单 / 邀请晚于确认时间 → 抛 `AdminAccessError("forbidden")`
      - 身份无效 → 抛 `AdminAccessError("unauthorized")`（来自 `validateAdminIdentity`）
      - 并发导致 guard 失败 → 抛 D1 错误（非 `AdminAccessError`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/cloudflare-portal/tests/tenant/login-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { AdminAccessError, googleIdentityFromConfirmedLogin } from "@unidocs/portal-service";
import { hashSessionSecret } from "../../src/auth.js";
import { D1TenantLoginRepository, TENANT_MEMBER_SESSION_LIMIT } from "../../src/tenant/login-repository.js";
import { D1TenantSessionStore } from "../../src/tenant/session.js";
import { insertMember } from "./members.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const NOW = 1_800_000_000;
let real: RealD1;
let repository: D1TenantLoginRepository;

beforeEach(async () => {
  real = await startRealD1();
  repository = new D1TenantLoginRepository(real.db, () => NOW);
});
afterEach(async () => { await real.dispose(); });

function identity(subject = "google-subject", email = "Member@Example.com") {
  return googleIdentityFromConfirmedLogin({ iss: "https://accounts.google.com", sub: subject, email, email_verified: true }, NOW);
}

async function invite(email = "member@example.com", createdAt = NOW - 60) {
  return insertMember(real.db, { tenantId: "t1", principalId: "user:invited", email, bound: false, createdAt, memberId: "member-invited" });
}

/** Runs `before` right ahead of the repository's batch: a deterministic interleaving. */
function interleaved(db: D1Database, before: () => Promise<void>): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { await before(); return target.batch(statements); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const rows = async (sql: string) => (await real.db.prepare(sql).all()).results;

describe("D1TenantLoginRepository.completeLogin", () => {
  it("binds an invitation by normalized email and issues a working session", async () => {
    await invite();
    const result = await repository.completeLogin(identity(), "req-1");
    expect(result).toMatchObject({ memberId: "member-invited", tenantId: "t1", principalId: "user:invited" });
    expect(await rows("SELECT issuer, subject, revision FROM portal_tenant_members")).toEqual([
      { issuer: "https://accounts.google.com", subject: "google-subject", revision: 1 },
    ]);
    const session = await new D1TenantSessionStore(real.db).find(await hashSessionSecret(result.token), NOW);
    expect(session).toMatchObject({ tenantId: "t1", principalId: "user:invited" });
    expect(await rows("SELECT action, request_id FROM portal_tenant_auth_audit ORDER BY action")).toEqual([
      { action: "member.bound", request_id: "req-1" },
      { action: "session.created", request_id: "req-1" },
    ]);
  });

  it("finds an already bound member by Google identity, not by email", async () => {
    await invite();
    await repository.completeLogin(identity(), "req-1");
    const again = await repository.completeLogin(identity("google-subject", "renamed@example.com"), "req-2");
    expect(again.memberId).toBe("member-invited");
    expect(await rows("SELECT action FROM portal_tenant_auth_audit WHERE request_id = 'req-2'")).toEqual([{ action: "session.created" }]);
  });

  it("denies an identity with no membership", async () => {
    await expect(repository.completeLogin(identity(), "req-1")).rejects.toEqual(new AdminAccessError("forbidden"));
    expect(await rows("SELECT * FROM portal_tenant_sessions")).toEqual([]);
  });

  it("denies a confirmation older than the invitation", async () => {
    await invite("member@example.com", NOW + 1);
    const late = new D1TenantLoginRepository(real.db, () => NOW + 1);
    await expect(late.completeLogin(identity(), "req-1")).rejects.toEqual(new AdminAccessError("forbidden"));
  });

  it("denies a removed member", async () => {
    await invite();
    await real.db.prepare("UPDATE portal_tenant_members SET active = 0").run();
    await expect(repository.completeLogin(identity(), "req-1")).rejects.toEqual(new AdminAccessError("forbidden"));
  });

  it("writes nothing when the member is removed between the read and the batch", async () => {
    await invite();
    const racing = new D1TenantLoginRepository(interleaved(real.db, async () => {
      await real.db.prepare("UPDATE portal_tenant_members SET active = 0").run();
    }), () => NOW);
    await expect(racing.completeLogin(identity(), "req-1")).rejects.not.toBeInstanceOf(AdminAccessError);
    expect(await rows("SELECT * FROM portal_tenant_sessions")).toEqual([]);
    expect(await rows("SELECT * FROM portal_tenant_auth_audit")).toEqual([]);
    expect(await rows("SELECT subject FROM portal_tenant_members")).toEqual([{ subject: null }]);
  });

  it("lets only one of two racing sign-ins claim the same invitation", async () => {
    await invite();
    const other = new D1TenantLoginRepository(real.db, () => NOW);
    const racing = new D1TenantLoginRepository(interleaved(real.db, async () => {
      await other.completeLogin(identity(), "req-winner");
    }), () => NOW);
    await expect(racing.completeLogin(identity(), "req-loser")).rejects.toBeDefined();
    expect(await rows("SELECT request_id FROM portal_tenant_auth_audit WHERE action = 'session.created'")).toEqual([{ request_id: "req-winner" }]);
  });

  it("keeps at most ten sessions per member, dropping the oldest and every expired one", async () => {
    await insertMember(real.db, { tenantId: "t1", principalId: "user:bound", memberId: "member-bound" });
    await real.db.prepare("UPDATE portal_tenant_members SET issuer = 'https://accounts.google.com', subject = 'google-subject', email = 'member@example.com'").run();
    const store = new D1TenantSessionStore(real.db);
    await store.issue("t1", "user:bound", NOW - 28_800); // expires exactly at NOW
    for (let index = 0; index < TENANT_MEMBER_SESSION_LIMIT; index += 1) await store.issue("t1", "user:bound", NOW - 100 + index);
    await repository.completeLogin(identity(), "req-11");
    expect(await rows("SELECT created_at FROM portal_tenant_sessions ORDER BY created_at")).toEqual(
      [...Array.from({ length: TENANT_MEMBER_SESSION_LIMIT - 1 }, (_, index) => ({ created_at: NOW - 99 + index })), { created_at: NOW }],
    );
  });
});

describe("D1TenantLoginRepository transactions", () => {
  const transaction = (state: string, createdAt: number) => ({
    stateHash: state, browserHash: "browser", verifier: "v".repeat(43), nonce: "n".repeat(43),
    returnTo: "/portal/", createdAt, expiresAt: createdAt + 600,
  });

  it("takes a transaction once, bound to its browser", async () => {
    await repository.put(transaction("s1", NOW));
    expect(await repository.take("s1", "other-browser", NOW)).toBeNull();
    expect(await repository.take("s1", "browser", NOW)).toMatchObject({ stateHash: "s1", returnTo: "/portal/" });
    expect(await repository.take("s1", "browser", NOW)).toBeNull();
  });

  it("sweeps at most one hundred expired transactions on each put", async () => {
    for (let index = 0; index < 150; index += 1) await repository.put(transaction(`old-${index}`, NOW - 10_000));
    await repository.put(transaction("fresh", NOW));
    const left = await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_login_transactions").first<{ n: number }>();
    expect(left?.n).toBe(51);
  });
});
```

注意 sweep 用例：前 150 次 `put` 的 `createdAt` 同为 `NOW - 10_000`，彼此不过期，不会被自己的 sweep 清掉；第 151 次以 `NOW` 为时钟清掉 100 条，剩 50 条旧的加 1 条新的。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/login-repository.test.ts`
Expected: FAIL，找不到模块 `login-repository.js`。

- [ ] **Step 3: 实现**

```ts
// packages/cloudflare-portal/src/tenant/login-repository.ts
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  AdminAccessError, adminConfirmationTime, requireRecentAuthentication, validateAdminIdentity, type AdminIdentity,
} from "@unidocs/portal-service";
import type { PortalLoginTransaction } from "../google-login.js";
import { D1TenantSessionStore } from "./session.js";

/** A member keeps at most this many sessions; signing in once more drops the oldest. */
export const TENANT_MEMBER_SESSION_LIMIT = 10;
/** Bounded so a burst of abandoned sign-ins cannot make one `put` slow. */
const EXPIRED_TRANSACTION_SWEEP = 100;

interface MemberRow {
  readonly member_id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly email: string;
  readonly revision: number;
  readonly created_at: number;
}

export class D1TenantLoginRepository {
  private readonly sessions: D1TenantSessionStore;

  constructor(private readonly db: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.sessions = new D1TenantSessionStore(db);
  }

  async put(transaction: PortalLoginTransaction): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM portal_tenant_login_transactions WHERE rowid IN
        (SELECT rowid FROM portal_tenant_login_transactions WHERE expires_at <= ? LIMIT ${EXPIRED_TRANSACTION_SWEEP})`)
        .bind(transaction.createdAt),
      this.db.prepare(`INSERT INTO portal_tenant_login_transactions
        (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(transaction.stateHash, transaction.browserHash, transaction.verifier, transaction.nonce, transaction.returnTo, transaction.createdAt, transaction.expiresAt),
    ]);
  }

  async take(stateHash: string, browserHash: string, now: number): Promise<PortalLoginTransaction | null> {
    return this.db.prepare(`DELETE FROM portal_tenant_login_transactions WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
      RETURNING state_hash AS stateHash, browser_hash AS browserHash, verifier, nonce, return_to AS returnTo, created_at AS createdAt, expires_at AS expiresAt`)
      .bind(stateHash, browserHash, now).first<PortalLoginTransaction>();
  }

  /**
   * Reads, then commits binding and session in one batch. Every write the
   * batch depends on is followed by a guard row (`portal_mutation_guard`
   * only accepts 1), so a member removed or an invitation claimed between the
   * read and the batch fails the whole batch instead of leaving a session
   * behind for someone who is no longer a member.
   */
  async completeLogin(identity: AdminIdentity, requestId: string) {
    const now = this.now();
    const verified = validateAdminIdentity(identity, now);
    requireRecentAuthentication(verified, now);
    const confirmedAt = adminConfirmationTime(verified);
    if (confirmedAt === null) throw new AdminAccessError("forbidden");

    const bound = await this.db.prepare("SELECT * FROM portal_tenant_members WHERE issuer = ? AND subject = ? AND active = 1")
      .bind(verified.issuer, verified.subject).first<MemberRow>();
    const invited = bound ? null : await this.db.prepare("SELECT * FROM portal_tenant_members WHERE email = ? AND active = 1 AND subject IS NULL")
      .bind(verified.email).first<MemberRow>();
    const member = bound ?? invited;
    // An identity confirmed before the invitation existed may not claim it.
    if (!member || (invited && confirmedAt < invited.created_at)) throw new AdminAccessError("forbidden");

    const clearGuard = this.db.prepare("DELETE FROM portal_mutation_guard");
    const issued = await this.sessions.prepareIssue(member.tenant_id, member.principal_id, now);
    const audit = (action: "member.bound" | "session.created") => this.db.prepare(
      "INSERT INTO portal_tenant_auth_audit (event_id, member_id, action, occurred_at, request_id) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), member.member_id, action, now, requestId);

    const statements: D1PreparedStatement[] = [];
    if (invited) {
      statements.push(
        this.db.prepare(`UPDATE portal_tenant_members SET issuer = ?, subject = ?, revision = revision + 1, updated_at = ?
          WHERE member_id = ? AND email = ? AND active = 1 AND subject IS NULL AND revision = ? AND created_at <= ?`)
          .bind(verified.issuer, verified.subject, now, invited.member_id, verified.email, invited.revision, confirmedAt),
        this.db.prepare("INSERT INTO portal_mutation_guard SELECT changes()"),
        clearGuard,
        audit("member.bound"),
      );
    }
    statements.push(
      this.db.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
        (SELECT 1 FROM portal_tenant_members WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1) THEN 1 ELSE 0 END`)
        .bind(member.member_id, verified.issuer, verified.subject),
      clearGuard,
      this.db.prepare("DELETE FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ? AND expires_at <= ?")
        .bind(member.tenant_id, member.principal_id, now),
      this.db.prepare(`DELETE FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ? AND session_hash NOT IN
        (SELECT session_hash FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ?
          ORDER BY created_at DESC, session_hash DESC LIMIT ?)`)
        .bind(member.tenant_id, member.principal_id, member.tenant_id, member.principal_id, TENANT_MEMBER_SESSION_LIMIT - 1),
      issued.statement,
      audit("session.created"),
    );
    await this.db.batch(statements);
    return { memberId: member.member_id, tenantId: member.tenant_id, principalId: member.principal_id, token: issued.token, csrfToken: issued.csrfToken };
  }
}
```

同一个 `clearGuard` 预编译语句在 batch 里出现两次是允许的（D1 按顺序执行每个元素）。若 Miniflare 报重复语句错误，改为每处各 `prepare` 一次，不要改变顺序。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/login-repository.test.ts && pnpm --filter @unidocs/cloudflare-portal typecheck`
Expected: PASS。若“ten sessions”用例的期望数组不符，先打印实际 `created_at` 列表核对：被删的必须是过期那条和最旧的一条（`NOW - 100`），**不要**放宽断言。

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/src/tenant/login-repository.ts packages/cloudflare-portal/tests/tenant/login-repository.test.ts
git commit -m "feat(portal): bind tenant invitations and issue sessions in one guarded batch"
```

---

### Task 5: 登录端点接入 `serveTenant`

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/login-http.ts`
- Modify: `packages/cloudflare-portal/src/worker.ts:48-50`（`isTenantPath`）、`:115-192`（`serveTenant`）
- Test: `packages/cloudflare-portal/tests/tenant/login-http.test.ts`、`tests/worker.test.ts`

**Interfaces:**
- Consumes: Task 2 `sessionCookie`、`csrfCookie`；Task 3 `createTenantGoogleLogin`、`TENANT_LOGIN_COOKIE`、`GoogleLoginError`；Task 4 `D1TenantLoginRepository`；`portalGoogleConfigFromGateway`。
- Produces:
  - `TENANT_LOGIN_PATH = "/portal/auth/login"`、`TENANT_CALLBACK_PATH = "/portal/auth/callback"`
  - `createTenantLoginHttp(options: { origin: string; googleConfig: () => PortalGoogleConfig; repository: D1TenantLoginRepository; now: () => number; googleFetch?: typeof fetch }): (request: Request, requestId: string) => Promise<Response | null>`，非这两个路径返回 `null`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/cloudflare-portal/tests/tenant/login-http.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { hashSessionSecret } from "../../src/auth.js";
import { portalGoogleConfigFromGateway } from "../../src/google-config.js";
import { TENANT_LOGIN_COOKIE } from "../../src/google-login.js";
import { D1TenantLoginRepository } from "../../src/tenant/login-repository.js";
import { createTenantLoginHttp } from "../../src/tenant/login-http.js";
import { D1TenantSessionStore, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE } from "../../src/tenant/session.js";
import { insertMember } from "./members.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const config = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: "tenant-client", GATEWAY_OIDC_CLIENT_SECRET: "fixture-secret" }, ORIGIN);
const discovery = {
  issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"], authorization_response_iss_parameter_supported: true,
};

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: object[] };
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "google-test", alg: "RS256", use: "sig" }] };
});

let real: RealD1;
beforeEach(async () => { real = await startRealD1(); });
afterEach(async () => { await real.dispose(); vi.restoreAllMocks(); });

const now = () => Math.floor(Date.now() / 1000);

/** A Google double: discovery, JWKS, and a token endpoint that signs for whatever nonce the begin step stored. */
function google(claims: JWTPayload = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json(discovery);
    if (url === discovery.jwks_uri) return Response.json(jwks);
    if (url === discovery.token_endpoint) {
      const row = await real.db.prepare("SELECT nonce FROM portal_tenant_login_transactions").first<{ nonce: string }>();
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("redirect_uri")).toBe(`${ORIGIN}/portal/auth/callback`);
      const issuedAt = now();
      const idToken = await new SignJWT({
        iss: discovery.issuer, aud: config.clientId, sub: "google-subject", email: "member@example.com", email_verified: true,
        iat: issuedAt, exp: issuedAt + 3600, auth_time: issuedAt, nonce: row!.nonce, ...claims,
      }).setProtectedHeader({ alg: "RS256", kid: "google-test" }).sign(keys.privateKey);
      return Response.json({ access_token: "discarded", token_type: "Bearer", id_token: idToken });
    }
    throw new Error(`Unexpected endpoint ${url}`);
  });
}

function handler(googleFetch: typeof fetch, googleConfig = () => config) {
  return createTenantLoginHttp({ origin: ORIGIN, googleConfig, repository: new D1TenantLoginRepository(real.db, now), now, googleFetch });
}

async function signIn(handle: ReturnType<typeof handler>, returnTo = "/portal/#/d/doc-1") {
  const start = (await handle(new Request(`${ORIGIN}/portal/auth/login?returnTo=${encodeURIComponent(returnTo)}`), "req-begin"))!;
  expect(start.status).toBe(303);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const loginCookie = start.headers.get("set-cookie")!.split(";")[0];
  return (await handle(new Request(
    `${ORIGIN}/portal/auth/callback?state=${state}&code=test-code&iss=${encodeURIComponent(discovery.issuer)}`,
    { headers: { cookie: loginCookie, "sec-fetch-site": "cross-site" } },
  ), "req-callback"))!;
}

function setCookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
}

describe("tenant login endpoints", () => {
  it("ignores other paths", async () => {
    expect(await handler(google())(new Request(`${ORIGIN}/portal/auth/session`), "req")).toBeNull();
  });

  it("answers 405 for a non-GET method", async () => {
    const response = await handler(google())(new Request(`${ORIGIN}/portal/auth/login`, { method: "POST" }), "req");
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET");
  });

  it("signs an invited member in, even though the callback is a cross-site navigation", async () => {
    await insertMember(real.db, { tenantId: "t1", principalId: "user:m", email: "member@example.com", bound: false, createdAt: now() - 60 });
    const callback = await signIn(handler(google()));
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/portal/#/d/doc-1`);
    expect(setCookie(callback, TENANT_LOGIN_COOKIE)).toContain("Max-Age=0");
    expect(setCookie(callback, TENANT_CSRF_COOKIE)).toMatch(/SameSite=Strict/);
    const token = setCookie(callback, TENANT_SESSION_COOKIE)!.split(";")[0].split("=")[1];
    const session = await new D1TenantSessionStore(real.db).find(await hashSessionSecret(token), now());
    expect(session).toMatchObject({ tenantId: "t1", principalId: "user:m" });
  });

  it("sends an account with no membership back with login=denied", async () => {
    const callback = await signIn(handler(google()));
    const location = new URL(callback.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}/portal/`);
    expect(location.searchParams.get("login")).toBe("denied");
    expect(location.searchParams.get("requestId")).toBe("req-callback");
    expect(setCookie(callback, TENANT_SESSION_COOKIE)).toBeUndefined();
    expect(setCookie(callback, TENANT_LOGIN_COOKIE)).toContain("Max-Age=0");
  });

  it("sends a failed Google round trip back with login=failed and logs only stage and reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callback = await signIn(handler(google({ email_verified: false })));
    expect(new URL(callback.headers.get("location")!).searchParams.get("login")).toBe("failed");
    const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events).toEqual([expect.objectContaining({ event: "tenant_google_login_failed", requestId: "req-callback" })]);
    expect(Object.keys(events[0]).sort()).toEqual(["event", "reason", "requestId", "stage"]);
  });

  it("sends an invalid returnTo on begin back with login=failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = (await handler(google())(new Request(`${ORIGIN}/portal/auth/login?returnTo=${encodeURIComponent("https://attacker.example")}`), "req-bad"))!;
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.get("login")).toBe("failed");
  });

  it("answers login=unavailable when Google is not configured, on both endpoints", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = handler(google(), () => { throw new TypeError("Gateway Google OIDC client ID and secret are required"); });
    for (const path of ["/portal/auth/login", "/portal/auth/callback"]) {
      const response = (await handle(new Request(`${ORIGIN}${path}`), "req-u"))!;
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).searchParams.get("login")).toBe("unavailable");
    }
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(["tenant_login_not_configured", "tenant_login_not_configured"]);
  });

  it("logs an unexpected failure by name and message only", async () => {
    await insertMember(real.db, { tenantId: "t1", principalId: "user:m", email: "member@example.com", bound: false, createdAt: now() - 60 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const repository = new D1TenantLoginRepository(real.db, now);
    vi.spyOn(repository, "completeLogin").mockRejectedValue(new Error("D1_ERROR: constraint failed"));
    const handle = createTenantLoginHttp({ origin: ORIGIN, googleConfig: () => config, repository, now, googleFetch: google() });
    const callback = await signIn(handle);
    expect(new URL(callback.headers.get("location")!).searchParams.get("login")).toBe("failed");
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{
      event: "tenant_operation_failed", requestId: "req-callback", path: "/portal/auth/callback", name: "Error", message: "D1_ERROR: constraint failed",
    }]);
  });
});
```

在 `tests/worker.test.ts` 的 `describe("Worker tenant routes without Google or CAS configuration", …)` 内追加（该 env 的 Google client 为空）：

```ts
  it("routes the tenant login endpoints through serveTenant and answers login=unavailable without Google", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    try {
      const response = await worker.fetch(new Request(`${ORIGIN}/portal/auth/login`), tenantEnv(real.db));
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).searchParams.get("login")).toBe("unavailable");
      expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get("X-Request-ID")).toBe(new URL(response.headers.get("location")!).searchParams.get("requestId"));
    } finally {
      warn.mockRestore();
    }
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/login-http.test.ts tests/worker.test.ts`
Expected: FAIL，找不到 `login-http.js`；worker 用例得到 404。

- [ ] **Step 3: 实现 `login-http.ts`**

```ts
// packages/cloudflare-portal/src/tenant/login-http.ts
import { AdminAccessError } from "@unidocs/portal-service";
import type { PortalGoogleConfig } from "../google-config.js";
import { createTenantGoogleLogin, GoogleLoginError, TENANT_LOGIN_COOKIE } from "../google-login.js";
import type { D1TenantLoginRepository } from "./login-repository.js";
import { csrfCookie, sessionCookie } from "./session-http.js";

export const TENANT_LOGIN_PATH = "/portal/auth/login";
export const TENANT_CALLBACK_PATH = "/portal/auth/callback";

type LoginOutcome = "denied" | "failed" | "unavailable";

/**
 * `GET /portal/auth/login` and `GET /portal/auth/callback`. Both are top-level
 * browser navigations, so every failure is a 303 back to the console with a
 * `login=` outcome, never a JSON body. The callback arrives from Google as a
 * cross-site navigation and must never call authenticateTenant, which refuses
 * cross-site requests.
 */
export function createTenantLoginHttp(options: {
  readonly origin: string;
  /** Throws when Google is not configured; read only on these two paths. */
  readonly googleConfig: () => PortalGoogleConfig;
  readonly repository: D1TenantLoginRepository;
  readonly now: () => number;
  readonly googleFetch?: typeof fetch;
}): (request: Request, requestId: string) => Promise<Response | null> {
  const { origin, repository, now } = options;

  function backToConsole(outcome: LoginOutcome, requestId: string, clearLoginCookie: boolean): Response {
    const target = new URL("/portal/", origin);
    target.searchParams.set("login", outcome);
    target.searchParams.set("requestId", requestId);
    const headers = new Headers({ Location: target.href });
    if (clearLoginCookie) headers.append("Set-Cookie", `${TENANT_LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    return new Response(null, { status: 303, headers });
  }

  return async function handle(request: Request, requestId: string): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    if (pathname !== TENANT_LOGIN_PATH && pathname !== TENANT_CALLBACK_PATH) return null;
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const callback = pathname === TENANT_CALLBACK_PATH;

    let login: ReturnType<typeof createTenantGoogleLogin>;
    try {
      login = createTenantGoogleLogin(options.googleConfig(), {
        now,
        fetch: options.googleFetch,
        put: transaction => repository.put(transaction),
        take: (stateHash, browserHash, time) => repository.take(stateHash, browserHash, time),
      });
    } catch {
      console.warn(JSON.stringify({ event: "tenant_login_not_configured", requestId }));
      return backToConsole("unavailable", requestId, callback);
    }

    try {
      if (!callback) return await login.begin(request);
      const completed = await login.complete(request);
      const issued = await repository.completeLogin(completed.identity, requestId);
      const headers = new Headers({ Location: new URL(completed.returnTo, origin).href });
      headers.append("Set-Cookie", completed.clearLoginCookie);
      headers.append("Set-Cookie", sessionCookie(issued.token));
      headers.append("Set-Cookie", csrfCookie(issued.csrfToken));
      return new Response(null, { status: 303, headers });
    } catch (error) {
      if (error instanceof GoogleLoginError) {
        console.warn(JSON.stringify({ event: "tenant_google_login_failed", requestId, stage: error.stage, reason: error.reason }));
        return backToConsole("failed", requestId, callback);
      }
      if (error instanceof AdminAccessError) {
        // begin refuses a bad returnTo or an unexpected discovery document; the
        // callback's forbidden is "not on the member list".
        if (!callback) console.warn(JSON.stringify({ event: "tenant_google_login_failed", requestId, stage: "begin", reason: "validation_failed" }));
        return backToConsole(callback && error.code === "forbidden" ? "denied" : "failed", requestId, callback);
      }
      // Name and message only, as bff.ts: never the stack or the error object.
      console.error(JSON.stringify({
        event: "tenant_operation_failed", requestId, path: pathname,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      }));
      return backToConsole("failed", requestId, callback);
    }
  };
}
```

- [ ] **Step 4: 接入 `worker.ts`**

1. import 增加：
   `import { D1TenantLoginRepository } from "./tenant/login-repository.js";`
   `import { createTenantLoginHttp, TENANT_CALLBACK_PATH, TENANT_LOGIN_PATH } from "./tenant/login-http.js";`
2. `isTenantPath` 改为：

```ts
function isTenantPath(path: string): boolean {
  return path === "/portal/auth/session" || path === "/portal/auth/logout"
    || path === TENANT_LOGIN_PATH || path === TENANT_CALLBACK_PATH
    || path.startsWith("/api/v1/tenants/");
}
```

3. `serveTenant` 的 `try {` 内，在 `const store = …` 之前插入，并把原来的 `const session = …; if (session) { … } else { … }` 整体包进 `else`：

```ts
    // Google settings are read only here, on the two login paths, so a missing
    // client leaves the rest of the tenant plane serving.
    const login = await createTenantLoginHttp({
      origin: env.PORTAL_ORIGIN,
      now,
      repository: new D1TenantLoginRepository(env.DB, now),
      googleConfig: () => portalGoogleConfigFromGateway({
        GATEWAY_OIDC_CLIENT_ID: env.GATEWAY_OIDC_CLIENT_ID,
        GATEWAY_OIDC_CLIENT_SECRET: env.GATEWAY_OIDC_CLIENT_SECRET,
        GATEWAY_OIDC_ISSUER: env.GATEWAY_OIDC_ISSUER,
      }, env.PORTAL_ORIGIN),
    })(request, requestId);
    if (login) {
      response = login;
    } else {
      // …原有 store / agent / session / authenticateTenant 代码原样移入这里…
    }
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/login-http.test.ts tests/worker.test.ts && pnpm --filter @unidocs/cloudflare-portal test && pnpm --filter @unidocs/cloudflare-portal typecheck`
Expected: PASS。“failed Google round trip”用例若 `stage` 不是 `identity`，只核对 `event`/`requestId` 与键集合，保持断言不含 token/secret。

- [ ] **Step 6: 提交**

```bash
git add packages/cloudflare-portal/src packages/cloudflare-portal/tests
git commit -m "feat(portal): add tenant Google sign-in endpoints behind serveTenant"
```

---

### Task 6: admin 契约 `tenantMembers`

**Files:**
- Modify: `packages/protocol-admin-portal/src/schemas.ts`（审计枚举、成员 schema）
- Modify: `packages/protocol-admin-portal/src/contract.ts`（错误表、四个 procedure、`adminApiContract.tenantMembers`）
- Modify: `packages/protocol-admin-portal/src/index.ts`（导出）
- Modify: `packages/protocol-admin-portal/openapi/admin-v1.openapi.json`（生成）
- Modify: `packages/admin-portal-webui/src/app.tsx:6-45`（标签）
- Test: `packages/protocol-admin-portal/tests/contract.test.ts`

**Interfaces:**
- Produces（从 `@unidocs/protocol-admin-portal` 导出）：
  - `TenantMemberAuditActions = ["tenant_member.added", "tenant_member.removed", "tenant_member.sessions_revoked"] as const`、`type TenantMemberAuditAction`
  - `TenantMemberRecordSchema` / `type TenantMemberRecord = { memberId; tenantId; principalId; email; bound: boolean; addedBy; addedAt; etag }`
  - `AddTenantMemberRequestSchema = { tenantId, email }`、`TenantMemberMutationResultSchema = { memberId, principalId, etag }`
  - `ListTenantMembersQuerySchema = { cursor?, limit?, tenantId? }`、`ListTenantMembersResponseSchema` / `type ListTenantMembersResponse`
  - `AdminApiErrorMap.TENANT_MEMBER_EXISTS`（409）
  - `adminApiContract.tenantMembers.{list, add, remove, revokeSessions}`，operationId 依次为 `listTenantMembers`、`addTenantMember`、`removeTenantMember`、`revokeTenantMemberSessions`
  - `AdminAuditResourceTypeSchema` 增加 `"tenant_member"`

- [ ] **Step 1: 写失败测试**

`tests/contract.test.ts`：把第 222–224 行改为 `toHaveLength(18)`、`toHaveLength(30)`、`.size).toBe(30)`。在文件末尾追加：

```ts
describe("tenant member operations", () => {
  it("exposes list, add, remove and session revocation under /tenant-members", async () => {
    const document = await generateAdminOpenApiDocument();
    const collection = document.paths?.["/admin/api/v1/tenant-members"];
    const member = document.paths?.["/admin/api/v1/tenant-members/{memberId}"];
    const revocations = document.paths?.["/admin/api/v1/tenant-members/{memberId}/session-revocations"];
    expect(collection?.get?.operationId).toBe("listTenantMembers");
    expect(collection?.post?.operationId).toBe("addTenantMember");
    expect(member?.delete?.operationId).toBe("removeTenantMember");
    expect(revocations?.post?.operationId).toBe("revokeTenantMemberSessions");
    expect(parameterNames(member?.delete ?? {})).toEqual(expect.arrayContaining(["memberId", "idempotency-key", "if-match"]));
    expect(Object.keys(collection?.post?.responses ?? {})).toContain("409");
  });

  it("accepts tenant member audit events", () => {
    expect(AdminAuditActionSchema.options).toEqual(expect.arrayContaining([...TenantMemberAuditActions]));
    expect(AdminAuditResourceTypeSchema.options).toContain("tenant_member");
  });

  it("requires a tenant and an email to add a member", () => {
    expect(AddTenantMemberRequestSchema.safeParse({ tenantId: "t1", email: "a@example.com" }).success).toBe(true);
    expect(AddTenantMemberRequestSchema.safeParse({ email: "a@example.com" }).success).toBe(false);
    expect(AddTenantMemberRequestSchema.safeParse({ tenantId: "t1", email: "not-an-email" }).success).toBe(false);
  });
});
```

文件顶部 import 从 `../src/index.js` 追加 `AddTenantMemberRequestSchema, AdminAuditActionSchema, AdminAuditResourceTypeSchema, TenantMemberAuditActions`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/protocol-admin-portal test`
Expected: FAIL（导出不存在、operation 数为 26）。

- [ ] **Step 3: 改 `schemas.ts`**

在 `AdministratorMemberAuditActions` 之后加：

```ts
export const TenantMemberAuditActions = [
  "tenant_member.added",
  "tenant_member.removed",
  "tenant_member.sessions_revoked",
] as const;
```

`AdminAuditActionSchema` 的数组追加 `...TenantMemberAuditActions,`；在类型导出区加
`export type TenantMemberAuditAction = typeof TenantMemberAuditActions[number];`
`AdminAuditResourceTypeSchema` 的数组追加 `"tenant_member",`。

在 `AdministratorMemberListItemSchema` 定义之后加：

```ts
export const TenantMemberRecordSchema = z.object({
  memberId: IdSchema.describe("Stable tenant membership identity."),
  tenantId: IdSchema.describe("Tenant this membership grants access to."),
  principalId: IdSchema.describe("Tenant principal the member acts as; never reused, even after removal."),
  email: z.email().describe("Normalized Google account email allowed to sign in to the tenant console."),
  bound: z.boolean().describe("Whether the member has bound a verified Google identity by signing in."),
  addedBy: NonEmptyStringSchema.describe("Administrator identity that added this member."),
  addedAt: IsoDateTimeSchema.describe("Time at which the membership was created."),
  etag: EtagSchema.describe("Optimistic-concurrency token required to remove this member."),
}).readonly().meta({ id: "TenantMemberRecord" });

export type TenantMemberRecord = z.infer<typeof TenantMemberRecordSchema>;
```

在 `ListAdminAuditEventsResponseSchema` 之后加：

```ts
export const ListTenantMembersResponseSchema = pageSchema(TenantMemberRecordSchema)
  .meta({ id: "ListTenantMembersResponse" });
export type ListTenantMembersResponse = z.infer<typeof ListTenantMembersResponseSchema>;
```

在 `ListBundlesQuerySchema` 定义之后加：

```ts
export const ListTenantMembersQuerySchema = PaginationQuerySchema.unwrap().extend({
  tenantId: IdSchema.optional().describe("Only memberships of this tenant."),
}).readonly();
```

在 `AddAdministratorMemberRequestSchema` 之后加：

```ts
export const AddTenantMemberRequestSchema = z.object({
  tenantId: IdSchema.describe("Tenant to add the member to."),
  email: z.email().describe("Google account email to add to the tenant."),
}).readonly().meta({ id: "AddTenantMemberRequest" });

export type AddTenantMemberRequest = z.infer<typeof AddTenantMemberRequestSchema>;

export const TenantMemberMutationResultSchema = z.object({
  memberId: IdSchema.describe("Created tenant membership identity."),
  principalId: IdSchema.describe("Principal generated for the membership."),
  etag: EtagSchema.describe("Current membership ETag."),
}).readonly().meta({ id: "TenantMemberMutationResult" });
```

（`IdSchema`、`EtagSchema`、`IsoDateTimeSchema`、`NonEmptyStringSchema`、`PaginationQuerySchema`、`pageSchema` 在该文件已存在；若某个定义位于使用点之后导致 TDZ，就把新增定义挪到其依赖之后。）

- [ ] **Step 4: 改 `contract.ts`**

1. 从 `./schemas.js` 的 import 追加 `AddTenantMemberRequestSchema, ListTenantMembersQuerySchema, ListTenantMembersResponseSchema, TenantMemberAuditActions, TenantMemberMutationResultSchema`。
2. `AdminApiErrorMap` 里 `ADMINISTRATOR_EXISTS` 之后加：

```ts
  TENANT_MEMBER_EXISTS: {
    status: 409,
    message: "An active tenant membership already exists for this email",
    data: AdminErrorDataSchema,
  },
```

3. 在 `administratorMemberParams` 之后加：

```ts
const tenantMemberParams = z.object({
  memberId: IdSchema.describe("Tenant membership to address."),
}).readonly();
```

（若 `IdSchema` 未在 contract.ts import，从 `./schemas.js` 或 `@unidocs/protocol` 按 `administratorMemberParams` 使用的同一来源导入。）

4. 在 `removeAdministratorMemberContract` 之后加：

```ts
export const listTenantMembersContract = adminProcedure
  .route({
    method: "GET",
    path: `${AdminApiV1BasePath}/tenant-members`,
    operationId: "listTenantMembers",
    summary: "List tenant members",
    description: "Returns active tenant memberships, optionally for one tenant, with identity-binding status and current ETag.",
    inputStructure: "detailed",
    tags: ["Members"],
  })
  .input(z.object({ query: ListTenantMembersQuerySchema.optional() }).readonly())
  .output(ListTenantMembersResponseSchema);

export const addTenantMemberContract = idempotentMutationProcedure.errors({
  TENANT_MEMBER_EXISTS: AdminApiErrorMap.TENANT_MEMBER_EXISTS,
})
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/tenant-members`,
    operationId: "addTenantMember",
    summary: "Add a tenant member",
    description: "Adds a normalized Google account email to one tenant and generates its principal. The identity stays unbound until that account signs in to the tenant console. An email can be an active member of only one tenant.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Members"],
  })
  .input(z.object({
    headers: MutationHeadersSchema,
    body: AddTenantMemberRequestSchema,
  }).readonly())
  .output(TenantMemberMutationResultSchema);

export const removeTenantMemberContract = conditionalMutationProcedure
  .route({
    method: "DELETE",
    path: `${AdminApiV1BasePath}/tenant-members/{memberId}`,
    operationId: "removeTenantMember",
    summary: "Remove a tenant member",
    description: "Deactivates one tenant membership under its current ETag and ends all of its sessions. The row is kept; adding the email again creates a new principal.",
    inputStructure: "detailed",
    successStatus: 204,
    tags: ["Members"],
  })
  .input(z.object({
    params: tenantMemberParams,
    headers: ConditionalMutationHeadersSchema,
  }).readonly())
  .output(z.undefined());

export const revokeTenantMemberSessionsContract = resourceMutationProcedure
  .route({
    method: "POST",
    path: `${AdminApiV1BasePath}/tenant-members/{memberId}/session-revocations`,
    operationId: "revokeTenantMemberSessions",
    summary: "End every session of a tenant member",
    description: "Signs the member out on every device without removing the membership, for example when an account may be compromised.",
    inputStructure: "detailed",
    successStatus: 204,
    tags: ["Members"],
  })
  .input(z.object({
    params: tenantMemberParams,
    headers: MutationHeadersSchema,
  }).readonly())
  .output(z.undefined());
```

5. `adminApiContract` 在 `members: {…},` 之后加：

```ts
  tenantMembers: {
    list: listTenantMembersContract,
    add: addTenantMemberContract,
    remove: removeTenantMemberContract,
    revokeSessions: revokeTenantMemberSessionsContract,
  },
```

6. 文件末尾 `export { AdministratorMemberAuditActions, DocumentTypeAuditActions };` 改为追加 `TenantMemberAuditActions`，类型导出追加 `TenantMemberAuditAction`。

- [ ] **Step 5: 改 `index.ts`**

`./contract.js` 的值导出追加 `TenantMemberAuditActions`，类型导出追加 `TenantMemberAuditAction`；`./schemas.js` 的值导出追加 `AddTenantMemberRequestSchema, ListTenantMembersQuerySchema, ListTenantMembersResponseSchema, TenantMemberMutationResultSchema, TenantMemberRecordSchema`；类型导出追加 `AddTenantMemberRequest, ListTenantMembersResponse, TenantMemberRecord`（与同文件已有 `AdministratorMemberRecord` 等类型导出放在一起）。

- [ ] **Step 6: 运行契约测试并生成 OpenAPI**

Run: `pnpm --filter @unidocs/protocol-admin-portal test && pnpm --filter @unidocs/protocol-admin-portal typecheck && pnpm --filter @unidocs/protocol-admin-portal docs:generate`
Expected: 测试 PASS；`openapi/admin-v1.openapi.json` 出现四个新 operationId。若 `mcp.test.ts` 快照变化，先确认变化只来自新增 schema，再 `vitest run -u` 更新。

- [ ] **Step 7: admin WebUI 标签**

`packages/admin-portal-webui/src/app.tsx`：
- import 追加 `TenantMemberAuditActions`。
- `auditActionLabels` 追加：

```ts
  "tenant_member.added": "添加租户成员",
  "tenant_member.removed": "移除租户成员",
  "tenant_member.sessions_revoked": "强制租户成员下线",
```

- `resourceLabels` 追加 `tenant_member: "租户成员",`
- `const auditActions = [...AdministratorMemberAuditActions, ...DocumentTypeAuditActions];` 改为 `[...AdministratorMemberAuditActions, ...TenantMemberAuditActions, ...DocumentTypeAuditActions]`

Run: `pnpm --filter @unidocs/admin-portal-webui typecheck && pnpm --filter @unidocs/admin-portal-webui test`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/protocol-admin-portal packages/admin-portal-webui/src/app.tsx
git commit -m "feat(protocol-admin-portal): add the tenant members contract"
```

---

### Task 7: 成员服务（portal-service）

**Files:**
- Modify: `packages/portal-service/src/auth/administrator.ts:40-43`（抽出 `normalizeGoogleEmail`）
- Create: `packages/portal-service/src/admin/tenant-members.ts`
- Modify: `packages/portal-service/src/index.ts`
- Test: `packages/portal-service/tests/tenant-members.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `TenantMemberRecordSchema`、`AddTenantMemberRequestSchema`、`ListTenantMembersQuerySchema`、`type TenantMemberRecord`、`type ListTenantMembersResponse`、`type AdminAuditEvent`。
- Produces（经 `@unidocs/portal-service` 导出）：
  - `normalizeGoogleEmail(email: string): string`（`normalizeAdministratorEmail` 变为它的别名）
  - `class TenantMemberOperationError extends Error { code: "invalid_request" | "not_found" | "idempotency_conflict" | "tenant_member_exists" | "precondition_failed" | "forbidden" }`
  - `interface TenantMemberAddCommand { context; key; fingerprint; member: TenantMemberRecord; audit: AdminAuditEvent }`
  - `interface TenantMemberRemoveCommand { context; memberId; key; fingerprint; expectedEtag; audit }`
  - `interface TenantMemberRevokeSessionsCommand { context; memberId; key; fingerprint; audit }`
  - `interface TenantMemberRepository { add(c): Promise<{ memberId: string; principalId: string; etag: string }>; remove(c): Promise<void>; revokeSessions(c): Promise<void>; list(context, query: { cursor?: string; limit?: number; tenantId?: string }): Promise<ListTenantMembersResponse> }`
  - `createTenantMemberService(repository, options?: { now?: () => Date; id?: () => string })` → `{ add(context, body, key, requestId), remove(context, memberId, key, expectedEtag, requestId), revokeSessions(context, memberId, key, requestId), list(context, query) }`
  - fingerprint 的 operation 名：`addTenantMember`、`removeTenantMember`、`revokeTenantMemberSessions`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/portal-service/tests/tenant-members.test.ts
import { expect, test, vi } from "vitest";
import {
  createTenantMemberService, normalizeAdministratorEmail, normalizeGoogleEmail, resourceEtag, schemaHash,
  type AdminContext, type TenantMemberRepository,
} from "../src/index.js";

const context: AdminContext = {
  memberId: "admin-1", transport: "session",
  identity: { issuer: "https://accounts.google.com", subject: "subject", email: "owner@example.com", authenticatedAt: null, loginConfirmedAt: 1000, loginConfirmation: "authorization-code-v1" },
};
const ETAG = `"sha256-${"a".repeat(43)}"`;

function setup() {
  const repository: TenantMemberRepository = {
    add: vi.fn(async command => ({ memberId: command.member.memberId, principalId: command.member.principalId, etag: command.member.etag })),
    remove: vi.fn(async () => undefined),
    revokeSessions: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const ids = ["member-1", "principal-1", "audit-1"];
  return { repository, service: createTenantMemberService(repository, { now: () => new Date("2026-09-15T00:00:00.400Z"), id: () => ids.shift()! }) };
}

test("normalizeGoogleEmail is the rule administrators already use", () => {
  expect(normalizeGoogleEmail("  Member@Example.COM ")).toBe("member@example.com");
  expect(normalizeAdministratorEmail("  Member@Example.COM ")).toBe(normalizeGoogleEmail("  Member@Example.COM "));
});

test("adds a normalized, unbound member with a fresh user principal, canonical ETag and audit", async () => {
  const { repository, service } = setup();
  const result = await service.add(context, { tenantId: "t1", email: " Member@Example.com" }, "add-key", "request-1");
  const [command] = vi.mocked(repository.add).mock.calls[0];
  const representation = { memberId: "member-1", tenantId: "t1", principalId: "user:principal-1", email: "member@example.com", bound: false, addedBy: "admin-1", addedAt: "2026-09-15T00:00:00.000Z" };
  expect(command.member).toEqual({ ...representation, etag: await resourceEtag(representation) });
  expect(result).toEqual({ memberId: "member-1", principalId: "user:principal-1", etag: command.member.etag });
  expect(command.fingerprint).toBe(await schemaHash({ operation: "addTenantMember", body: { tenantId: "t1", email: "member@example.com" } }));
  expect(command.audit).toMatchObject({ auditEventId: "audit-1", action: "tenant_member.added", resourceType: "tenant_member", resourceId: "member-1", requestId: "request-1", documentType: null, reason: null });
  expect(JSON.stringify(command.audit)).not.toContain("member@example.com");
});

test.each([
  {}, { email: "a@example.com" }, { tenantId: "t1" }, { tenantId: "t1", email: "invalid" }, { tenantId: "", email: "a@example.com" },
  { tenantId: "t 1", email: "a@example.com" }, { tenantId: "t1", email: "a@example.com", extra: true }, [], null,
])("rejects invalid add input %#", async body => {
  const { repository, service } = setup();
  await expect(service.add(context, body, "key", "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.add).not.toHaveBeenCalled();
});

test("rejects a malformed idempotency key before touching the repository", async () => {
  const { repository, service } = setup();
  await expect(service.add(context, { tenantId: "t1", email: "a@example.com" }, "", "request")).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.revokeSessions(context, "member-1", "k".repeat(129), "request")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.add).not.toHaveBeenCalled();
  expect(repository.revokeSessions).not.toHaveBeenCalled();
});

test("removes under an ETag with a fingerprint over the member and ETag", async () => {
  const { repository, service } = setup();
  await service.remove(context, "member-1", "remove-key", ETAG, "request-2");
  const [command] = vi.mocked(repository.remove).mock.calls[0];
  expect(command).toMatchObject({ memberId: "member-1", key: "remove-key", expectedEtag: ETAG });
  expect(command.fingerprint).toBe(await schemaHash({ operation: "removeTenantMember", memberId: "member-1", expectedEtag: ETAG }));
  expect(command.audit).toMatchObject({ action: "tenant_member.removed", resourceType: "tenant_member", resourceId: "member-1" });
  await expect(service.remove(context, "member-1", "remove-key", "W/\"weak\"", "request-3")).rejects.toMatchObject({ code: "invalid_request" });
});

test("revokes sessions with its own fingerprint and audit action", async () => {
  const { repository, service } = setup();
  await service.revokeSessions(context, "member-1", "revoke-key", "request-4");
  const [command] = vi.mocked(repository.revokeSessions).mock.calls[0];
  expect(command.fingerprint).toBe(await schemaHash({ operation: "revokeTenantMemberSessions", memberId: "member-1" }));
  expect(command.audit).toMatchObject({ action: "tenant_member.sessions_revoked", resourceType: "tenant_member", resourceId: "member-1" });
});

test("validates the list query, including the tenant filter", async () => {
  const { repository, service } = setup();
  await service.list(context, { tenantId: "t1", limit: 10 });
  expect(repository.list).toHaveBeenCalledWith(context, { tenantId: "t1", limit: 10 });
  await expect(service.list(context, { limit: 0 })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.list(context, { tenantId: "" })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.list(context, { unknown: 1 })).rejects.toMatchObject({ code: "invalid_request" });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-members.test.ts`
Expected: FAIL，导出不存在。

- [ ] **Step 3: 抽出 `normalizeGoogleEmail`**

`src/auth/administrator.ts` 第 40–43 行替换为：

```ts
/** Google account emails are matched after trimming and lower-casing, for administrators and tenant members alike. */
export function normalizeGoogleEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return AddAdministratorMemberRequestSchema.parse({ email: normalized }).email;
}

export const normalizeAdministratorEmail = normalizeGoogleEmail;
```

`readGoogleIdentity` 里的 `normalizeAdministratorEmail(claims.email)` 改为 `normalizeGoogleEmail(claims.email)`。

- [ ] **Step 4: 实现服务**

```ts
// packages/portal-service/src/admin/tenant-members.ts
import {
  AddTenantMemberRequestSchema,
  ListTenantMembersQuerySchema,
  TenantMemberRecordSchema,
  type AdminAuditEvent,
  type ListTenantMembersResponse,
  type TenantMemberRecord,
} from "@unidocs/protocol-admin-portal";
import { normalizeGoogleEmail, type AdminContext } from "../auth/administrator.js";
import { resourceEtag, schemaHash } from "../identity.js";

export type TenantMemberOperationCode =
  "invalid_request" | "not_found" | "idempotency_conflict" | "tenant_member_exists" | "precondition_failed" | "forbidden";

export class TenantMemberOperationError extends Error {
  constructor(readonly code: TenantMemberOperationCode) {
    super({
      invalid_request: "The request is invalid",
      not_found: "Tenant member not found",
      idempotency_conflict: "The idempotency key was used with a different request",
      tenant_member_exists: "An active tenant membership already exists for this email",
      precondition_failed: "The If-Match precondition failed",
      forbidden: "Administrator access is denied",
    }[code]);
    this.name = "TenantMemberOperationError";
  }
}

export interface TenantMemberAddCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly member: TenantMemberRecord;
  readonly audit: AdminAuditEvent;
}

export interface TenantMemberRemoveCommand {
  readonly context: AdminContext;
  readonly memberId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly expectedEtag: string;
  readonly audit: AdminAuditEvent;
}

export interface TenantMemberRevokeSessionsCommand {
  readonly context: AdminContext;
  readonly memberId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly audit: AdminAuditEvent;
}

export interface TenantMemberRepository {
  add(command: TenantMemberAddCommand): Promise<{ readonly memberId: string; readonly principalId: string; readonly etag: string }>;
  remove(command: TenantMemberRemoveCommand): Promise<void>;
  revokeSessions(command: TenantMemberRevokeSessionsCommand): Promise<void>;
  list(context: AdminContext, query: { readonly cursor?: string; readonly limit?: number; readonly tenantId?: string }): Promise<ListTenantMembersResponse>;
}

const KEY = /^[\x20-\x7e]{1,128}$/;
const TENANT_ID = /^[\x21-\x7e]{1,128}$/;
const ETAG = /^"sha256-[A-Za-z0-9_-]{43}"$/;

function requireMemberId(memberId: unknown): string {
  if (typeof memberId !== "string" || !memberId || memberId.length > 256) throw new TenantMemberOperationError("invalid_request");
  return memberId;
}

export function createTenantMemberService(repository: TenantMemberRepository, options: {
  readonly now?: () => Date;
  readonly id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  const timestamp = () => new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
  const audit = (context: AdminContext, action: AdminAuditEvent["action"], memberId: string, requestId: string, occurredAt: string): AdminAuditEvent => ({
    auditEventId: id(), actorId: context.memberId, action, resourceType: "tenant_member",
    resourceId: memberId, documentType: null, occurredAt, requestId, reason: null,
  });

  return {
    async add(context: AdminContext, body: unknown, key: string, requestId: string) {
      if (typeof body !== "object" || body === null || Array.isArray(body)
        || Object.keys(body).some(field => field !== "tenantId" && field !== "email") || !KEY.test(key)) {
        throw new TenantMemberOperationError("invalid_request");
      }
      const { tenantId, email: rawEmail } = body as { readonly tenantId?: unknown; readonly email?: unknown };
      let email: string;
      try {
        if (typeof tenantId !== "string" || !TENANT_ID.test(tenantId) || typeof rawEmail !== "string") throw new Error();
        email = normalizeGoogleEmail(rawEmail);
        AddTenantMemberRequestSchema.parse({ tenantId, email });
      } catch {
        throw new TenantMemberOperationError("invalid_request");
      }
      const addedAt = timestamp();
      const memberId = id();
      const principalId = `user:${id()}`;
      const representation = { memberId, tenantId, principalId, email, bound: false, addedBy: context.memberId, addedAt };
      const member = TenantMemberRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
      return repository.add({
        context, key, member,
        fingerprint: await schemaHash({ operation: "addTenantMember", body: { tenantId, email } }),
        audit: audit(context, "tenant_member.added", memberId, requestId, addedAt),
      });
    },

    async remove(context: AdminContext, memberId: string, key: string, expectedEtag: string, requestId: string) {
      requireMemberId(memberId);
      if (!KEY.test(key) || !ETAG.test(expectedEtag)) throw new TenantMemberOperationError("invalid_request");
      return repository.remove({
        context, memberId, key, expectedEtag,
        fingerprint: await schemaHash({ operation: "removeTenantMember", memberId, expectedEtag }),
        audit: audit(context, "tenant_member.removed", memberId, requestId, timestamp()),
      });
    },

    async revokeSessions(context: AdminContext, memberId: string, key: string, requestId: string) {
      requireMemberId(memberId);
      if (!KEY.test(key)) throw new TenantMemberOperationError("invalid_request");
      return repository.revokeSessions({
        context, memberId, key,
        fingerprint: await schemaHash({ operation: "revokeTenantMemberSessions", memberId }),
        audit: audit(context, "tenant_member.sessions_revoked", memberId, requestId, timestamp()),
      });
    },

    async list(context: AdminContext, query: unknown = {}) {
      const parsed = ListTenantMembersQuerySchema.strict().safeParse(query);
      if (!parsed.success || (parsed.data.cursor?.length ?? 0) > 1024) throw new TenantMemberOperationError("invalid_request");
      return repository.list(context, parsed.data);
    },
  };
}
```

说明：`ListTenantMembersQuerySchema` 是 `.readonly()` 包装；若 `.strict()` 在 readonly schema 上不可用，改为先 `Object.keys(query).some(k => !["cursor", "limit", "tenantId"].includes(k))` 判定，再 `safeParse`。`IdSchema` 允许空格，但 tenantId 会进入 URL 与 SQL 关联，服务层用 `TENANT_ID` 收紧为可打印无空格字符。

`src/index.ts` 在 administrators 导出两行之后加：

```ts
export { createTenantMemberService, TenantMemberOperationError } from "./admin/tenant-members.js";
export type { TenantMemberAddCommand, TenantMemberOperationCode, TenantMemberRemoveCommand, TenantMemberRepository, TenantMemberRevokeSessionsCommand } from "./admin/tenant-members.js";
```

并把第 15 行的导出列表追加 `normalizeGoogleEmail`。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @unidocs/portal-service test && pnpm --filter @unidocs/portal-service typecheck`
Expected: PASS（含原 `administrators.test.ts`、`administrator.test.ts` 不回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/portal-service
git commit -m "feat(portal-service): add the tenant member service and share Google email normalization"
```

---

### Task 8: 成员 D1 仓储、HTTP 与 worker 分发

**Files:**
- Create: `packages/cloudflare-portal/src/admin-authority.ts`
- Modify: `packages/cloudflare-portal/src/administrators-repository.ts:27-38, 64-68, 110-114`（改用共用权威 SQL）
- Create: `packages/cloudflare-portal/src/tenant-members-repository.ts`
- Create: `packages/cloudflare-portal/src/tenant-members-http.ts`
- Modify: `packages/cloudflare-portal/src/worker.ts:305-315`（`adminApi` 分发）
- Test: `packages/cloudflare-portal/tests/tenant-members.test.ts`

**Interfaces:**
- Consumes: Task 7 服务与类型；Task 6 契约；Task 2 `D1TenantSessionStore`（测试里验证会话被删）；`auditAttribution`。
- Produces:
  - `adminAuthorityQuery(db: D1Database, context: AdminContext, now: number): D1PreparedStatement`（SELECT，`first()` 非空即有权）
  - `adminAuthorityGuard(db: D1Database, context: AdminContext, now: number): D1PreparedStatement`（写 `portal_mutation_guard`，无权时让 batch 失败）
  - `class D1TenantMemberRepository implements TenantMemberRepository { constructor(db: D1Database, now?: () => number) }`
  - `createTenantMembersHttp(repository: TenantMemberRepository): (request: Request, admin: AdminContext, requestId: string) => Promise<Response>`

- [ ] **Step 1: 写失败测试**

```ts
// packages/cloudflare-portal/tests/tenant-members.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { googleIdentityFromConfirmedLogin, type AdminContext } from "@unidocs/portal-service";
import { hashSessionSecret } from "../src/auth.js";
import { D1PortalAuthRepository } from "../src/auth-repository.js";
import { createTenantMembersHttp } from "../src/tenant-members-http.js";
import { D1TenantMemberRepository } from "../src/tenant-members-repository.js";
import { D1TenantSessionStore } from "../src/tenant/session.js";
import { startRealD1, type RealD1 } from "./tenant/real-d1.js";

const ORIGIN = "https://portal.example";
const NOW = Math.floor(Date.now() / 1000);
let real: RealD1;
let admin: AdminContext;
let handle: ReturnType<typeof createTenantMembersHttp>;

beforeEach(async () => {
  real = await startRealD1();
  const identity = googleIdentityFromConfirmedLogin({ iss: "https://accounts.google.com", sub: "admin-sub", email: "admin@example.com", email_verified: true }, NOW);
  const issued = await new D1PortalAuthRepository(real.db, () => NOW).completeLogin(identity, "admin@example.com", "bootstrap");
  admin = { memberId: issued.memberId, identity, transport: "session", sessionHash: issued.session.sessionHash };
  handle = createTenantMembersHttp(new D1TenantMemberRepository(real.db, () => NOW));
});
afterEach(async () => { await real.dispose(); });

let keys = 0;
function call(method: string, path: string, options: { body?: unknown; ifMatch?: string; key?: string } = {}) {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["idempotency-key"] = options.key ?? `key-${keys += 1}`;
  if (options.ifMatch) headers["if-match"] = options.ifMatch;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return handle(new Request(`${ORIGIN}/admin/api/v1${path}`, {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), admin, "req-test");
}

async function add(email = "Member@Example.com", tenantId = "t1") {
  const response = await call("POST", "/tenant-members", { body: { tenantId, email } });
  expect(response.status).toBe(201);
  return await response.json() as { memberId: string; principalId: string; etag: string };
}

async function bindAndSignIn(memberId: string) {
  await real.db.prepare("UPDATE portal_tenant_members SET issuer = 'https://accounts.google.com', subject = ? WHERE member_id = ?").bind(`sub-${memberId}`, memberId).run();
  const row = await real.db.prepare("SELECT tenant_id, principal_id FROM portal_tenant_members WHERE member_id = ?").bind(memberId).first<{ tenant_id: string; principal_id: string }>();
  const store = new D1TenantSessionStore(real.db);
  const { token } = await store.issue(row!.tenant_id, row!.principal_id, NOW);
  return { store, hash: await hashSessionSecret(token) };
}

async function currentEtag(memberId: string) {
  const list = await (await call("GET", "/tenant-members")).json() as { items: { memberId: string; etag: string }[] };
  return list.items.find(item => item.memberId === memberId)!.etag;
}

describe("tenant members admin API (real D1)", () => {
  it("adds a normalized member, lists it, and audits the addition", async () => {
    const created = await add();
    expect(created.principalId).toMatch(/^user:[0-9a-f-]{36}$/);
    const list = await (await call("GET", "/tenant-members?tenantId=t1")).json() as { items: unknown[]; nextCursor: string | null };
    expect(list).toEqual({
      items: [expect.objectContaining({ memberId: created.memberId, tenantId: "t1", email: "member@example.com", bound: false, addedBy: admin.memberId, etag: created.etag })],
      nextCursor: null,
    });
    expect(await real.db.prepare("SELECT action, resource_type, resource_id FROM portal_admin_audit WHERE action LIKE 'tenant_member.%'").all())
      .toMatchObject({ results: [{ action: "tenant_member.added", resource_type: "tenant_member", resource_id: created.memberId }] });
  });

  it("filters the list by tenant and pages through it", async () => {
    await add("a@example.com", "t1");
    await add("b@example.com", "t2");
    await add("c@example.com", "t1");
    const first = await (await call("GET", "/tenant-members?tenantId=t1&limit=1")).json() as { items: { email: string }[]; nextCursor: string };
    const second = await (await call("GET", `/tenant-members?tenantId=t1&limit=1&cursor=${first.nextCursor}`)).json() as { items: { email: string }[]; nextCursor: string | null };
    expect([...first.items, ...second.items].map(item => item.email).sort()).toEqual(["a@example.com", "c@example.com"]);
    expect(second.nextCursor).toBeNull();
    expect((await call("GET", "/tenant-members?color=red")).status).toBe(400);
  });

  it("refuses a second active membership for the same email, in any tenant", async () => {
    await add("member@example.com", "t1");
    const again = await call("POST", "/tenant-members", { body: { tenantId: "t2", email: "MEMBER@example.com" } });
    expect(again.status).toBe(409);
    expect((await again.json() as { error: { code: string } }).error.code).toBe("tenant_member_exists");
  });

  it("replays an add with the same key and refuses the key for a different body", async () => {
    const first = await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "a@example.com" }, key: "same" });
    const replay = await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "a@example.com" }, key: "same" });
    expect(await replay.json()).toEqual(await first.json());
    const conflict = await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "b@example.com" }, key: "same" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe("idempotency_conflict");
  });

  it("removes a member under its ETag, ends its sessions, keeps the row, and allows re-adding with a new principal", async () => {
    const created = await add();
    const { store, hash } = await bindAndSignIn(created.memberId);
    expect(await store.find(hash, NOW)).not.toBeNull();

    expect((await call("DELETE", `/tenant-members/${created.memberId}`)).status).toBe(428);
    expect((await call("DELETE", `/tenant-members/${created.memberId}`, { ifMatch: created.etag })).status).toBe(412);
    const removed = await call("DELETE", `/tenant-members/${created.memberId}`, { ifMatch: await currentEtag(created.memberId) });
    expect(removed.status).toBe(204);

    expect(await store.find(hash, NOW)).toBeNull();
    expect(await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_sessions").first("n")).toBe(0);
    expect(await real.db.prepare("SELECT active FROM portal_tenant_members WHERE member_id = ?").bind(created.memberId).first("active")).toBe(0);
    expect((await (await call("GET", "/tenant-members")).json() as { items: unknown[] }).items).toEqual([]);

    const readded = await add();
    expect(readded.principalId).not.toBe(created.principalId);
  });

  it("revokes every session of a member without removing it", async () => {
    const created = await add();
    const { store, hash } = await bindAndSignIn(created.memberId);
    const response = await call("POST", `/tenant-members/${created.memberId}/session-revocations`);
    expect(response.status).toBe(204);
    expect(await store.find(hash, NOW)).toBeNull();
    expect(await real.db.prepare("SELECT active FROM portal_tenant_members WHERE member_id = ?").bind(created.memberId).first("active")).toBe(1);
    expect(await real.db.prepare("SELECT COUNT(*) AS n FROM portal_admin_audit WHERE action = 'tenant_member.sessions_revoked'").first("n")).toBe(1);
  });

  it("answers 404 for an unknown or already removed member", async () => {
    expect((await call("POST", "/tenant-members/missing/session-revocations")).status).toBe(404);
    expect((await call("DELETE", "/tenant-members/missing", { ifMatch: `"sha256-${"a".repeat(43)}"` })).status).toBe(404);
  });

  it("writes nothing for an administrator whose session was revoked", async () => {
    await real.db.prepare("UPDATE portal_session_families SET revoked_at = ?").bind(NOW).run();
    const response = await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "a@example.com" } });
    expect(response.status).toBe(403);
    expect(await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_members").first("n")).toBe(0);
  });

  it("refuses a body with extra fields or a non-JSON content type", async () => {
    expect((await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "a@example.com", role: "owner" } })).status).toBe(400);
    const text = await handle(new Request(`${ORIGIN}/admin/api/v1/tenant-members`, {
      method: "POST", headers: { "idempotency-key": "k", "content-type": "text/plain" }, body: "{}",
    }), admin, "req");
    expect(text.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-members.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 抽出权威校验 SQL**

```ts
// packages/cloudflare-portal/src/admin-authority.ts
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { AdminContext } from "@unidocs/portal-service";

/**
 * The acting administrator is still an active, bound member and, for a
 * browser, still holds an unrevoked, unexpired session. Checked before a
 * mutation and again inside its batch, so an administrator removed mid-request
 * cannot finish one.
 */
const AUTHORITY = `SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
  AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
    WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))`;

function bindings(context: AdminContext, now: number) {
  return [context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, now] as const;
}

export function adminAuthorityQuery(db: D1Database, context: AdminContext, now: number): D1PreparedStatement {
  return db.prepare(AUTHORITY).bind(...bindings(context, now));
}

export function adminAuthorityGuard(db: D1Database, context: AdminContext, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS (${AUTHORITY}) THEN 1 ELSE 0 END`).bind(...bindings(context, now));
}
```

`administrators-repository.ts`：
- import `adminAuthorityGuard, adminAuthorityQuery` from `./admin-authority.js`。
- `authorityStatement(context)` 的方法体替换为 `return adminAuthorityQuery(this.database, context, this.now());`
- `add` 与 `remove` 的 batch 里第一条 `INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS (… ) THEN 1 ELSE 0 END` 整条语句替换为 `adminAuthorityGuard(this.database, context, this.now()),`。

Run: `pnpm exec vitest run --fileParallelism=false tests/integration/cloudflare/portal-auth-repository.test.mjs`
Expected: PASS（administrators 行为不变）。

- [ ] **Step 4: 实现仓储**

```ts
// packages/cloudflare-portal/src/tenant-members-repository.ts
import type { D1Database } from "@cloudflare/workers-types";
import { TenantMemberRecordSchema, type ListTenantMembersResponse, type TenantMemberRecord } from "@unidocs/protocol-admin-portal";
import {
  resourceEtag, TenantMemberOperationError,
  type AdminContext, type TenantMemberAddCommand, type TenantMemberRemoveCommand, type TenantMemberRepository, type TenantMemberRevokeSessionsCommand,
} from "@unidocs/portal-service";
import { adminAuthorityGuard, adminAuthorityQuery } from "./admin-authority.js";
import { auditAttribution } from "./audit-attribution.js";

interface MemberRow {
  readonly member_id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly email: string;
  readonly issuer: string | null;
  readonly subject: string | null;
  readonly active: number;
  readonly revision: number;
  readonly added_by: string;
  readonly created_at: number;
}

const toSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const encodeCursor = (after: string) => btoa(JSON.stringify({ after })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export class D1TenantMemberRepository implements TenantMemberRepository {
  constructor(private readonly db: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  private async authorize(context: AdminContext): Promise<void> {
    if (!await adminAuthorityQuery(this.db, context, this.now()).first()) throw new TenantMemberOperationError("forbidden");
  }

  private async record(row: MemberRow): Promise<TenantMemberRecord> {
    const representation = {
      memberId: row.member_id, tenantId: row.tenant_id, principalId: row.principal_id, email: row.email,
      bound: row.issuer !== null && row.subject !== null, addedBy: row.added_by,
      addedAt: new Date(row.created_at * 1000).toISOString(),
    };
    return TenantMemberRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
  }

  private activeMember(memberId: string) {
    return this.db.prepare("SELECT * FROM portal_tenant_members WHERE member_id = ? AND active = 1").bind(memberId).first<MemberRow>();
  }

  private async receipt(context: AdminContext, operation: string, key: string, fingerprint: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT fingerprint, response_json FROM portal_idempotency_receipts WHERE actor_id = ? AND operation = ? AND key = ?")
      .bind(context.memberId, operation, key).first<{ fingerprint: string; response_json: string }>();
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new TenantMemberOperationError("idempotency_conflict");
    return row.response_json;
  }

  private auditStatement(context: AdminContext, audit: TenantMemberAddCommand["audit"]) {
    return this.db.prepare(`INSERT INTO portal_admin_audit
      (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json, caller_channel, oauth_client_handle, tool_name)
      VALUES (?, ?, ?, 'tenant_member', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`)
      .bind(audit.auditEventId, context.memberId, audit.action, audit.resourceId, toSeconds(audit.occurredAt), audit.requestId, ...auditAttribution(context));
  }

  async add(command: TenantMemberAddCommand) {
    const { context, key, fingerprint, member, audit } = command;
    await this.authorize(context);
    const replay = async () => {
      const response = await this.receipt(context, "addTenantMember", key, fingerprint);
      return response === null ? null : JSON.parse(response) as { memberId: string; principalId: string; etag: string };
    };
    const previous = await replay();
    if (previous) return previous;
    const response = { memberId: member.memberId, principalId: member.principalId, etag: member.etag };
    const createdAt = toSeconds(member.addedAt);
    try {
      await this.db.batch([
        adminAuthorityGuard(this.db, context, this.now()),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'addTenantMember', ?, ?, ?, ?)")
          .bind(context.memberId, key, fingerprint, JSON.stringify(response), member.addedAt),
        this.db.prepare(`INSERT INTO portal_tenant_members
          (member_id, tenant_id, principal_id, email, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(member.memberId, member.tenantId, member.principalId, member.email, context.memberId, createdAt, createdAt),
        this.auditStatement(context, audit),
      ]);
      return response;
    } catch (error) {
      const concurrent = await replay();
      if (concurrent) return concurrent;
      if (await this.db.prepare("SELECT 1 FROM portal_tenant_members WHERE email = ? AND active = 1").bind(member.email).first()) {
        throw new TenantMemberOperationError("tenant_member_exists");
      }
      if (!await adminAuthorityQuery(this.db, context, this.now()).first()) throw new TenantMemberOperationError("forbidden");
      throw error;
    }
  }

  async remove(command: TenantMemberRemoveCommand): Promise<void> {
    const { context, memberId, key, fingerprint, expectedEtag, audit } = command;
    await this.authorize(context);
    if (await this.receipt(context, "removeTenantMember", key, fingerprint) !== null) return;
    const check = async () => {
      const target = await this.activeMember(memberId);
      if (!target) throw new TenantMemberOperationError("not_found");
      if ((await this.record(target)).etag !== expectedEtag) throw new TenantMemberOperationError("precondition_failed");
      return target;
    };
    const target = await check();
    try {
      await this.db.batch([
        adminAuthorityGuard(this.db, context, this.now()),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'removeTenantMember', ?, ?, 'null', ?)")
          .bind(context.memberId, key, fingerprint, audit.occurredAt),
        this.db.prepare("UPDATE portal_tenant_members SET active = 0, revision = revision + 1, updated_at = ? WHERE member_id = ? AND active = 1 AND revision = ?")
          .bind(toSeconds(audit.occurredAt), memberId, target.revision),
        this.db.prepare("INSERT INTO portal_mutation_guard SELECT changes()"),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("DELETE FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ?").bind(target.tenant_id, target.principal_id),
        this.auditStatement(context, audit),
      ]);
    } catch (error) {
      if (await this.receipt(context, "removeTenantMember", key, fingerprint) !== null) return;
      await check();
      throw error;
    }
  }

  async revokeSessions(command: TenantMemberRevokeSessionsCommand): Promise<void> {
    const { context, memberId, key, fingerprint, audit } = command;
    await this.authorize(context);
    if (await this.receipt(context, "revokeTenantMemberSessions", key, fingerprint) !== null) return;
    const target = await this.activeMember(memberId);
    if (!target) throw new TenantMemberOperationError("not_found");
    try {
      await this.db.batch([
        adminAuthorityGuard(this.db, context, this.now()),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'revokeTenantMemberSessions', ?, ?, 'null', ?)")
          .bind(context.memberId, key, fingerprint, audit.occurredAt),
        this.db.prepare("INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM portal_tenant_members WHERE member_id = ? AND active = 1) THEN 1 ELSE 0 END")
          .bind(memberId),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("DELETE FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ?").bind(target.tenant_id, target.principal_id),
        this.auditStatement(context, audit),
      ]);
    } catch (error) {
      if (await this.receipt(context, "revokeTenantMemberSessions", key, fingerprint) !== null) return;
      if (!await this.activeMember(memberId)) throw new TenantMemberOperationError("not_found");
      throw error;
    }
  }

  async list(context: AdminContext, query: { readonly cursor?: string; readonly limit?: number; readonly tenantId?: string }): Promise<ListTenantMembersResponse> {
    await this.authorize(context);
    const limit = query.limit ?? 25;
    let after = "";
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const cursor = JSON.parse(atob(query.cursor.replaceAll("-", "+").replaceAll("_", "/"))) as { after?: unknown };
        if (typeof cursor.after !== "string" || !cursor.after || cursor.after.length > 256) throw new Error();
        after = cursor.after;
      } catch {
        throw new TenantMemberOperationError("invalid_request");
      }
    }
    const result = await this.db.prepare(`SELECT * FROM portal_tenant_members
      WHERE active = 1 AND member_id > ? AND (? IS NULL OR tenant_id = ?) ORDER BY member_id ASC LIMIT ?`)
      .bind(after, query.tenantId ?? null, query.tenantId ?? null, limit + 1).all<MemberRow>();
    const rows = result.results.slice(0, limit);
    return {
      items: await Promise.all(rows.map(row => this.record(row))),
      nextCursor: result.results.length > limit ? encodeCursor(rows.at(-1)!.member_id) : null,
    };
  }
}
```

注意 `add` 的 catch 顺序：先 replay，再判重复 email，再判权威（管理员被撤销时 batch 因 guard 失败，应答 403 而不是 500）。

- [ ] **Step 5: 实现 HTTP**

```ts
// packages/cloudflare-portal/src/tenant-members-http.ts
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import { adminApiContract } from "@unidocs/protocol-admin-portal";
import {
  boundedBytes, createTenantMemberService, parseStrictJson, TenantMemberOperationError,
  type AdminContext, type TenantMemberRepository,
} from "@unidocs/portal-service";

const STATUS = {
  invalid_request: 400, not_found: 404, idempotency_conflict: 409, tenant_member_exists: 409, precondition_failed: 412, forbidden: 403,
} as const;

/** `/admin/api/v1/tenant-members*`, shaped like administrators-http.ts. */
export function createTenantMembersHttp(repository: TenantMemberRepository) {
  const implementation = implement(adminApiContract.tenantMembers).$context<{ admin: AdminContext; requestId: string }>();
  const service = createTenantMemberService(repository);
  const router = {
    list: implementation.list.handler(({ input, context }) => service.list(context.admin, input.query ?? {})),
    add: implementation.add.handler(({ input, context }) => service.add(context.admin, input.body, input.headers["idempotency-key"], context.requestId)),
    remove: implementation.remove.handler(async ({ input, context }) => {
      await service.remove(context.admin, input.params.memberId, input.headers["idempotency-key"], input.headers["if-match"], context.requestId);
      return undefined;
    }),
    revokeSessions: implementation.revokeSessions.handler(async ({ input, context }) => {
      await service.revokeSessions(context.admin, input.params.memberId, input.headers["idempotency-key"], context.requestId);
      return undefined;
    }),
  };

  return async (request: Request, admin: AdminContext, requestId: string): Promise<Response> => {
    const url = new URL(request.url);
    const invalid = () => Response.json({ error: { code: "invalid_request", message: "The request is invalid", requestId } }, { status: 400 });
    const seen = new Set<string>();
    let invalidQuery = false;
    url.searchParams.forEach((value, name) => {
      if (request.method !== "GET" || seen.has(name) || !["limit", "cursor", "tenantId"].includes(name) || (name === "limit" && !/^[1-9][0-9]*$/.test(value))) invalidQuery = true;
      seen.add(name);
    });
    if (invalidQuery) return invalid();
    if (request.method === "DELETE" && !request.headers.has("if-match")) {
      return Response.json({ error: { code: "precondition_required", message: "The If-Match precondition is required", requestId } }, { status: 428 });
    }

    let boundedRequest = request;
    if (request.method === "POST" && url.pathname === "/admin/api/v1/tenant-members") {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) return invalid();
      try {
        if (!request.body) throw new Error();
        const content = new Uint8Array(16_384);
        let length = 0;
        for await (const chunk of boundedBytes(request.body, content.length)) {
          content.set(chunk, length);
          length += chunk.byteLength;
        }
        const body = parseStrictJson(content.subarray(0, length));
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some(field => field !== "tenantId" && field !== "email")) throw new Error();
        boundedRequest = new Request(request.url, { method: request.method, headers: request.headers, body: content.slice(0, length) });
      } catch {
        return invalid();
      }
    }

    const handler = new OpenAPIHandler(router, {
      plugins: request.method === "GET" ? [new experimental_ZodSmartCoercionPlugin()] : [],
      interceptors: [async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          if (error instanceof TenantMemberOperationError) {
            throw new ORPCError(error.code.toUpperCase(), { status: STATUS[error.code], message: error.message, data: { requestId } });
          }
          throw error;
        }
      }],
      customErrorResponseBodyEncoder: error => {
        const code = error.status >= 500 ? "internal_error" : error.code === "BAD_REQUEST" ? "invalid_request" : error.code.toLowerCase();
        return { error: { code, message: error.status >= 500 ? "Administrator operation failed" : error.status === 400 ? "The request is invalid" : error.message, requestId } };
      },
    });
    const result = await handler.handle(boundedRequest, { context: { admin, requestId } });
    return result.matched ? result.response : new Response(null, { status: 404 });
  };
}
```

- [ ] **Step 6: worker 分发**

`worker.ts`：import `createTenantMembersHttp` 与 `D1TenantMemberRepository`；在 `const operatorsHttp = …` 下一行加
`const tenantMembersHttp = createTenantMembersHttp(new D1TenantMemberRepository(env.DB));`
在 `adminApi` 分发里 `administrators` 那行之后加
`if (path.startsWith("/admin/api/v1/tenant-members")) return tenantMembersHttp(apiRequest, admin, requestId);`

- [ ] **Step 7: 运行确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-members.test.ts && pnpm --filter @unidocs/cloudflare-portal test && pnpm --filter @unidocs/cloudflare-portal typecheck`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/cloudflare-portal/src packages/cloudflare-portal/tests/tenant-members.test.ts
git commit -m "feat(portal): add the tenant members admin API"
```

---

### Task 9: seed 把 bootstrap email 加进 `t-local`；本地配置文档

**Files:**
- Modify: `stacks/unidocs-cloudflare/local/portal-seed.mjs:388-406`（新增 `addBootstrapTenantMember`）及两处调用点
- Modify: `tests/integration/cloudflare/portal-seed.test.mjs`
- Modify: `docs/deployment-and-local-configuration.md`（`## Local UniDocs configuration` 小节内追加）

**Interfaces:**
- Consumes: Task 8 的 `POST /admin/api/v1/tenant-members`（409 `tenant_member_exists` 视为已存在）。
- Produces: 无新代码接口。seed 结束时，若 `PORTAL_BOOTSTRAP_EMAIL` 已绑定，`portal_tenant_members` 恰有一行 `(tenant_id='t-local', email=<规范化 email>, active=1)`。

- [ ] **Step 1: 写失败测试**

`tests/integration/cloudflare/portal-seed.test.mjs`：
- 在 `const SEED_EMAIL = …` 下一行加 `const LOCAL_TENANT_ID = "t-local";`
- 在 “a second run …” 用例末尾 `const catalog = await tenantDocumentTypes(runtime);` 之前插入：

```js
    // The same account can then sign in to the tenant console, as a member of
    // the local tenant, instead of relying on the dev session switch.
    const members = await db.prepare("SELECT tenant_id, email, subject, active FROM portal_tenant_members WHERE added_by != 'dev-session' ORDER BY email").all();
    expect(members.results).toEqual([
      { tenant_id: LOCAL_TENANT_ID, email: BOOTSTRAP_EMAIL, subject: null, active: 1 },
      ...(fileBootstrapEmail ? [{ tenant_id: LOCAL_TENANT_ID, email: fileBootstrapEmail, subject: null, active: 1 }] : []),
    ].sort(byEmail));
```

- 在 “leaves exactly the seed administrator …” 用例末尾追加（首轮没配 bootstrap email 时不加任何成员）：

```js
    const members = await db.prepare("SELECT email FROM portal_tenant_members WHERE added_by != 'dev-session'").all();
    expect(members.results).toEqual(fileBootstrapEmail ? [{ email: fileBootstrapEmail }] : []);
```

`added_by != 'dev-session'` 排除 `tenantDocumentTypes` 触发开发会话时写入的开发成员行。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run --fileParallelism=false tests/integration/cloudflare/portal-seed.test.mjs`
Expected: FAIL，成员查询为空数组。

- [ ] **Step 3: 实现**

`portal-seed.mjs`：在 `inviteBootstrapEmail` 之后加：

```js
/** The local tenant the dev runtime's Agent and dev session both use. */
const LOCAL_TENANT_ID = "t-local";

/**
 * Adds the bound bootstrap email as a member of the local tenant, so that
 * account can sign in to the tenant console with real Google once the dev
 * session switch is off. A membership that already exists is not a failure.
 */
async function addBootstrapTenantMember(runtime, api, log) {
  const bindings = await step("read the portal bootstrap email", () => runtime.mf.getBindings(PORTAL_WORKER));
  const email = typeof bindings.PORTAL_BOOTSTRAP_EMAIL === "string" ? bindings.PORTAL_BOOTSTRAP_EMAIL.trim() : "";
  if (!email) return;
  const added = await api("add the bootstrap email to the local tenant", {
    method: "POST", path: "/tenant-members", json: { tenantId: LOCAL_TENANT_ID, email }, accept: [201, 409],
  });
  if (added.status === 409 && added.body?.error?.code !== "tenant_member_exists") {
    throw new Error(`portal seed: add the bootstrap email to the local tenant failed with HTTP 409: ${JSON.stringify(added.body)}`);
  }
  if (added.status === 201) log(`portal seed: added ${email} to tenant ${LOCAL_TENANT_ID}`);
}
```

在 `seedPortalCatalog` 里，**每一处** `await inviteBootstrapEmail(runtime, api, log);` 的下一行加
`await addBootstrapTenantMember(runtime, api, log);`
（用 `grep -n "inviteBootstrapEmail(runtime" stacks/unidocs-cloudflare/local/portal-seed.mjs` 找全，当前有两处：已注册分支与完整注册之后。）

文件头部说明 seed 做了哪些事的注释块若列举了 “invites PORTAL_BOOTSTRAP_EMAIL”，同句补上 “and adds it to tenant t-local”。

- [ ] **Step 4: 文档**

`docs/deployment-and-local-configuration.md` 的 `## Local UniDocs configuration` 小节末尾（`## Local UniCAS configuration` 之前）追加：

```markdown
### Tenant console sign-in (`pnpm dev portal`)

The tenant console at `/portal/` needs a tenant session. Locally there are two
ways to get one:

- **Real Google sign-in (default).** Set `PORTAL_BOOTSTRAP_EMAIL` and the Google
  client in `packages/cloudflare-portal/.dev.vars`. On every boot the seed adds
  that email as a member of tenant `t-local`, so it can sign in through
  `/portal/auth/login`. The Google client must list the loopback callback
  `http://127.0.0.1:<portal port>/portal/auth/callback`.
- **Dev session switch.** Set `PORTAL_TENANT_DEV_SESSION=true` in the same file.
  Any visit without a session cookie is handed a `t-local` / `user-local`
  session. It only works on a loopback `PORTAL_ORIGIN`, and "sign out" does not
  stick while it is on.

Documents written under the dev session belong to `user-local`; signing in with
Google gives a different principal in the same tenant, which still sees every
document.
```

- [ ] **Step 5: 运行确认通过并提交**

Run: `pnpm exec vitest run --fileParallelism=false tests/integration/cloudflare/portal-seed.test.mjs`
Expected: PASS。

```bash
git add stacks/unidocs-cloudflare/local/portal-seed.mjs tests/integration/cloudflare/portal-seed.test.mjs docs/deployment-and-local-configuration.md
git commit -m "feat(stacks): seed the bootstrap email as a local tenant member"
```

---

### Task 10: WebUI 登录入口、回跳提示与退出

**Files:**
- Create: `packages/tenant-portal-webui/src/session/sign-in.ts`
- Create: `packages/tenant-portal-webui/src/session/signed-out-notice.tsx`
- Modify: `packages/tenant-portal-webui/src/session/bootstrap.ts`（加 `signOut`）
- Modify: `packages/tenant-portal-webui/src/shell/app-shell.tsx`（`Sidebar` 加退出）
- Modify: `packages/tenant-portal-webui/src/app.tsx`（`App` 透传 `onSignOut`）
- Modify: `packages/tenant-portal-webui/src/main.tsx`
- Test: `packages/tenant-portal-webui/tests/sign-in.test.tsx`、`tests/session-bootstrap.test.ts`

**Interfaces:**
- Produces:
  - `type LoginOutcome = { readonly kind: "denied" | "failed" | "unavailable"; readonly requestId: string | null }`
  - `loginHref(location: { readonly pathname: string; readonly hash: string }): string`
  - `readLoginOutcome(search: string): LoginOutcome | null`
  - `withoutLoginOutcome(location: { readonly pathname: string; readonly search: string; readonly hash: string }): string`
  - `SignedOutNotice(props: { readonly outcome: LoginOutcome | null; readonly location: { pathname: string; hash: string } })`
  - `signOut(fetchImpl?: typeof fetch, csrfToken?: string | null): Promise<void>`（204 与 401 都视为已退出；其他状态抛 `TenantSessionError`）
  - `Sidebar` 新增可选 prop `onSignOut?: () => void`；`App` 新增可选 prop `onSignOut?: () => void`。

- [ ] **Step 1: 写失败测试**

```tsx
// packages/tenant-portal-webui/tests/sign-in.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/shell/app-shell.js";
import { loginHref, readLoginOutcome, withoutLoginOutcome } from "../src/session/sign-in.js";
import { SignedOutNotice } from "../src/session/signed-out-notice.js";

describe("loginHref", () => {
  it("keeps the hash route so a deep link survives the round trip", () => {
    expect(loginHref({ pathname: "/portal/", hash: "#/d/doc%201/th-1/0" }))
      .toBe(`/portal/auth/login?returnTo=${encodeURIComponent("/portal/#/d/doc%201/th-1/0")}`);
  });

  it.each(["/portal", "/portal/index.html", "/elsewhere", ""])("normalizes the shell path %j to /portal/", pathname => {
    expect(loginHref({ pathname, hash: "" })).toBe(`/portal/auth/login?returnTo=${encodeURIComponent("/portal/")}`);
  });
});

describe("readLoginOutcome", () => {
  it.each(["denied", "failed", "unavailable"] as const)("reads login=%s with its request id", kind => {
    expect(readLoginOutcome(`?login=${kind}&requestId=req-1`)).toEqual({ kind, requestId: "req-1" });
  });

  it("ignores anything else", () => {
    expect(readLoginOutcome("")).toBeNull();
    expect(readLoginOutcome("?login=granted")).toBeNull();
  });

  it("strips only the login parameters and keeps the hash", () => {
    expect(withoutLoginOutcome({ pathname: "/portal/", search: "?login=denied&requestId=r&tab=1", hash: "#/d/doc-1" })).toBe("/portal/?tab=1#/d/doc-1");
    expect(withoutLoginOutcome({ pathname: "/portal/", search: "?login=failed&requestId=r", hash: "" })).toBe("/portal/");
  });
});

describe("SignedOutNotice", () => {
  const location = { pathname: "/portal/", hash: "#/d/doc-1" };

  it("offers Google sign-in back to the current location", () => {
    render(<SignedOutNotice outcome={null} location={location} />);
    expect(screen.getByRole("heading", { name: "需要登录后才能查看" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "使用 Google 账号登录" })).toHaveAttribute("href", loginHref(location));
  });

  it.each([
    ["denied", "这个账号还没有加入工作区"],
    ["failed", "登录没有完成，请重试"],
    ["unavailable", "登录暂不可用，请稍后再试"],
  ] as const)("explains login=%s and shows the request id", (kind, message) => {
    render(<SignedOutNotice outcome={{ kind, requestId: "req-42" }} location={location} />);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByText(/req-42/)).toBeInTheDocument();
  });
});

describe("Sidebar sign-out", () => {
  it("renders a sign-out button only when it can sign out", () => {
    const onSignOut = vi.fn();
    const { rerender } = render(<Sidebar documentCount={null} />);
    expect(screen.queryByRole("button", { name: "退出" })).toBeNull();
    rerender(<Sidebar documentCount={null} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
```

`tests/session-bootstrap.test.ts` 追加（import 加 `signOut`）：

```ts
describe("signOut", () => {
  it("posts to the logout endpoint with the CSRF token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await signOut(fetchImpl, "csrf-token");
    expect(fetchImpl).toHaveBeenCalledWith("/portal/auth/logout", { method: "POST", credentials: "include", headers: { "x-csrf-token": "csrf-token" } });
  });

  it("treats an already ended session as signed out", async () => {
    await expect(signOut(async () => Response.json({ error: { code: "unauthorized" } }, { status: 401 }), "t")).resolves.toBeUndefined();
  });

  it("reports any other failure with its status", async () => {
    const error = await signOut(async () => new Response(null, { status: 403 }), null).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantSessionError);
    expect((error as TenantSessionError).status).toBe(403);
  });
});
```

并把该文件 vitest import 补上 `vi`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui exec vitest run tests/sign-in.test.tsx tests/session-bootstrap.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `sign-in.ts`**

```ts
// packages/tenant-portal-webui/src/session/sign-in.ts
/**
 * 登录入口与登录回跳。登录往返由 portal worker 的 /portal/auth/login 与
 * /portal/auth/callback 完成，这里只负责拼出发链接、读回跳结果。
 */
export type LoginOutcome = {
  readonly kind: "denied" | "failed" | "unavailable";
  readonly requestId: string | null;
};

const LOGIN_PATH = "/portal/auth/login";
const OUTCOMES = new Set(["denied", "failed", "unavailable"]);

/**
 * 服务端只接受以 /portal/ 开头的 returnTo，所以外壳的其它入口（/portal、
 * /portal/index.html）先统一成 /portal/。hash 原样带上：hash 路由的位置服务端
 * 看不到，只能靠这里带过去，登录回来才能回到原来那条评论。
 */
export function loginHref(location: { readonly pathname: string; readonly hash: string }): string {
  const pathname = location.pathname.startsWith("/portal/") && location.pathname !== "/portal/index.html"
    ? location.pathname
    : "/portal/";
  return `${LOGIN_PATH}?returnTo=${encodeURIComponent(pathname + location.hash)}`;
}

export function readLoginOutcome(search: string): LoginOutcome | null {
  const params = new URLSearchParams(search);
  const kind = params.get("login");
  if (kind === null || !OUTCOMES.has(kind)) return null;
  return { kind: kind as LoginOutcome["kind"], requestId: params.get("requestId") };
}

/** 展示过一次就从地址栏去掉，刷新时不再重复提示。 */
export function withoutLoginOutcome(location: { readonly pathname: string; readonly search: string; readonly hash: string }): string {
  const params = new URLSearchParams(location.search);
  params.delete("login");
  params.delete("requestId");
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}
```

- [ ] **Step 4: 实现 `signed-out-notice.tsx`**

```tsx
// packages/tenant-portal-webui/src/session/signed-out-notice.tsx
import { loginHref, type LoginOutcome } from "./sign-in.js";

const MESSAGES: Record<LoginOutcome["kind"], string> = {
  denied: "这个账号还没有加入工作区",
  failed: "登录没有完成，请重试",
  unavailable: "登录暂不可用，请稍后再试",
};

/** 复用 device-notice 的结构：标题、一句说明、登录链接。 */
export function SignedOutNotice(props: {
  readonly outcome: LoginOutcome | null;
  readonly location: { readonly pathname: string; readonly hash: string };
}) {
  return (
    <section className="device-notice" aria-labelledby="device-notice-title">
      <h1 id="device-notice-title">需要登录后才能查看</h1>
      {props.outcome && (
        <p role="status">
          {MESSAGES[props.outcome.kind]}
          {props.outcome.requestId && <small>（请求编号 {props.outcome.requestId}）</small>}
        </p>
      )}
      <a className="button" href={loginHref(props.location)}>使用 Google 账号登录</a>
    </section>
  );
}
```

（若 `styles.css` 没有 `.button`，改用样式表里已有的主按钮 class；用 `grep -n "\.btn\|\.button" packages/tenant-portal-webui/src/styles.css` 确认名字，不新增视觉样式。）

- [ ] **Step 5: `bootstrap.ts` 加 `signOut`**

在 `SESSION_PATH` 下加 `const LOGOUT_PATH = "/portal/auth/logout";`，文件末尾加：

```ts
/**
 * 结束当前会话。401 说明会话本来就没了（过期或被管理员强制下线），同样算已退出。
 * 浏览器对 POST 自动带 Origin，服务端据此和 CSRF token 一起校验。
 */
export async function signOut(fetchImpl: typeof fetch = globalThis.fetch, csrfToken: string | null = readCsrfCookie()): Promise<void> {
  const response = await fetchImpl(LOGOUT_PATH, {
    method: "POST",
    credentials: "include",
    headers: csrfToken ? { "x-csrf-token": csrfToken } : {},
  });
  if (response.status === 204 || response.status === 401) return;
  throw new TenantSessionError(`/portal/auth/logout responded with HTTP ${response.status}`, response.status);
}
```

- [ ] **Step 6: `Sidebar` 与 `App`**

`app-shell.tsx`：import 追加 `LogOut`；签名改为 `export function Sidebar(props: { documentCount: number | null; onSignOut?: () => void })`；在 `sidebar-bottom` 的 `.row` 之后、演示工作空间提示之前插入：

```tsx
        {props.onSignOut && (
          <button type="button" className="nav-item" onClick={props.onSignOut}>
            <LogOut size={14} aria-hidden="true" />
            退出
          </button>
        )}
```

`app.tsx`：`export function App(props: { client: TenantPortalClient; onSignOut?: () => void })`，`<Sidebar documentCount={documentCount} onSignOut={props.onSignOut} />`。

- [ ] **Step 7: `main.tsx`**

1. import 追加：
   `import { readLoginOutcome, withoutLoginOutcome, type LoginOutcome } from "./session/sign-in.js";`
   `import { SignedOutNotice } from "./session/signed-out-notice.js";`
   并从 `./session/bootstrap.js` 追加 `signOut`。
2. `renderSignedOutNotice` 替换为：

```tsx
function renderSignedOutNotice(outcome: LoginOutcome | null = null): void {
  root.render(
    <StrictMode>
      <SignedOutNotice outcome={outcome} location={{ pathname: window.location.pathname, hash: window.location.hash }} />
    </StrictMode>,
  );
}
```

3. `bootstrap()` 里 `try {` 之前加：

```ts
  // 登录回跳带着 ?login=…：读一次、立刻从地址栏去掉，只在确实未登录时展示。
  const outcome = readLoginOutcome(window.location.search);
  if (outcome) window.history.replaceState(null, "", withoutLoginOutcome(window.location));
```

4. `if (session.kind === "signed-out") { renderSignedOutNotice(); return; }` 改为 `renderSignedOutNotice(outcome)`。
5. `withSessionRefresh` 的 `onSignedOut: renderSignedOutNotice` 改为 `onSignedOut: () => renderSignedOutNotice()`。
6. 真实会话分支的 `<App client={client} />` 改为：

```tsx
    const onSignOut = () => {
      signOut()
        .then(() => renderSignedOutNotice())
        .catch(renderConnectionFailureNotice);
    };
    root.render(<StrictMode><App client={client} onSignOut={onSignOut} /></StrictMode>);
```

内存夹具分支保持不传 `onSignOut`（演示环境没有会话可退）。

- [ ] **Step 8: 运行确认通过并提交**

Run: `pnpm --filter @unidocs/tenant-portal-webui test && pnpm --filter @unidocs/tenant-portal-webui typecheck`
Expected: PASS。

```bash
git add packages/tenant-portal-webui
git commit -m "feat(tenant-webui): add Google sign-in, sign-in outcomes and sign-out"
```

---

### Task 11: 草稿按身份隔离；重建内嵌资源

**Files:**
- Modify: `packages/tenant-portal-webui/src/drafts/draft-store.ts`
- Modify: `packages/tenant-portal-webui/src/drafts/use-drafts.ts:24`
- Modify: `packages/tenant-portal-webui/src/pages/workbench.tsx:49`
- Modify: `packages/tenant-portal-webui/src/client-context.tsx`
- Modify: `packages/tenant-portal-webui/src/app.tsx`、`src/main.tsx`
- Create: `packages/tenant-portal-webui/tests/draft-scope.ts`
- Modify（加 prop）: `tests/app.test.tsx`、`tests/comment-flow.test.tsx`、`tests/document-page.test.tsx`、`tests/operator-follow.test.tsx`，以及 `grep` 找到的其它渲染 `ClientProvider` / `App` 的测试
- Test: `packages/tenant-portal-webui/tests/drafts.test.ts`
- Regenerate: `packages/cloudflare-portal/src/tenant-ui-assets.generated.ts`

**Interfaces:**
- Consumes: Task 10 的 `App` props。
- Produces:
  - `interface DraftScope { readonly tenantId: string; readonly principalId: string }`
  - `draftStorageKey(scope: DraftScope): string` → `unidocs.portal.drafts.v2:<tenantId>:<principalId>`
  - `createDraftStore(storage: Storage, scope: DraftScope): DraftStore`（**第二个参数必填**）
  - `ClientProvider` 新增必填 prop `draftScope: DraftScope`；`useDraftScope(): DraftScope`
  - `App` 新增必填 prop `draftScope: DraftScope`

- [ ] **Step 1: 写失败测试**

`tests/draft-scope.ts`：

```ts
import type { DraftScope } from "../src/drafts/draft-store.js";

export const TEST_DRAFT_SCOPE: DraftScope = { tenantId: "t-test", principalId: "user:test" };
```

`tests/drafts.test.ts`：
- import 追加 `draftStorageKey` 与 `import { TEST_DRAFT_SCOPE } from "./draft-scope.js";`
- 文件内所有 `createDraftStore(localStorage)` 改为 `createDraftStore(localStorage, TEST_DRAFT_SCOPE)`；`createDraftStore(throwing)` 改为 `createDraftStore(throwing, TEST_DRAFT_SCOPE)`。
- “存储里是坏数据时当作空” 用例里的 `"unidocs.portal.drafts.v1"` 改为 `draftStorageKey(TEST_DRAFT_SCOPE)`。
- `useDrafts` 的 `renderHook` 调用加 wrapper：`renderHook(() => useDrafts("doc-1"), { wrapper: ({ children }) => <ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}>{children}</ClientProvider> })`。若该文件当前没有 client，就用 `createTenantPortalClient({ tenantId: "t-test", transport: createMemoryTransport({ seed: sampleSeed() }) })`（从 `@unidocs/tenant-portal-client` 导入），并把文件扩展名改为 `.tsx`（`git mv tests/drafts.test.ts tests/drafts.test.tsx`）。

在 `describe("createDraftStore", …)` 内追加：

```ts
  it("keeps each identity's drafts apart on a shared browser", () => {
    createDraftStore(localStorage, { tenantId: "t1", principalId: "user:a" }).save(draft({ text: "A 的草稿" }));
    expect(createDraftStore(localStorage, { tenantId: "t1", principalId: "user:b" }).list()).toEqual([]);
    expect(createDraftStore(localStorage, { tenantId: "t2", principalId: "user:a" }).list()).toEqual([]);
    expect(createDraftStore(localStorage, { tenantId: "t1", principalId: "user:a" }).list()).toHaveLength(1);
  });

  it("moves legacy unscoped drafts to the first identity that loads, once", () => {
    localStorage.setItem("unidocs.portal.drafts.v1", JSON.stringify([draft({ draftId: "legacy" })]));
    const first = createDraftStore(localStorage, { tenantId: "t1", principalId: "user:a" });
    expect(first.list().map(item => item.draftId)).toEqual(["legacy"]);
    expect(localStorage.getItem("unidocs.portal.drafts.v1")).toBeNull();
    expect(createDraftStore(localStorage, { tenantId: "t1", principalId: "user:b" }).list()).toEqual([]);
  });

  it("merges legacy drafts into existing scoped drafts without duplicating ids", () => {
    const scope = { tenantId: "t1", principalId: "user:a" };
    createDraftStore(localStorage, scope).save(draft({ draftId: "kept" }));
    localStorage.setItem("unidocs.portal.drafts.v1", JSON.stringify([draft({ draftId: "kept", text: "old" }), draft({ draftId: "legacy" })]));
    expect(createDraftStore(localStorage, scope).list().map(item => item.draftId).sort()).toEqual(["kept", "legacy"]);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui exec vitest run tests/drafts.test.tsx`
Expected: FAIL（`draftStorageKey` 不存在、草稿未隔离）。

- [ ] **Step 3: 改 `draft-store.ts`**

1. `const STORAGE_KEY = "unidocs.portal.drafts.v1";` 替换为：

```ts
/** v1 不分身份，同一浏览器换人登录会看到前一个人的草稿。只在迁移时读。 */
const LEGACY_STORAGE_KEY = "unidocs.portal.drafts.v1";

export interface DraftScope {
  readonly tenantId: string;
  readonly principalId: string;
}

export function draftStorageKey(scope: DraftScope): string {
  return `unidocs.portal.drafts.v2:${scope.tenantId}:${scope.principalId}`;
}
```

2. `createDraftStore(storage: Storage)` 改为 `createDraftStore(storage: Storage, scope: DraftScope)`，函数体开头改为：

```ts
  const storageKey = draftStorageKey(scope);
  let cache: Draft[] = read(storageKey);
  migrateLegacy();

  function read(key: string): Draft[] {
    try {
      const raw = storage.getItem(key);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Draft[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * 生产此前没有租户面，v1 草稿只可能来自本地开发。第一次以某个身份加载时并入它，
   * 已有同 draftId 的以 v2 为准，然后删掉 v1，别的身份不会再看到。
   */
  function migrateLegacy(): void {
    let legacy: Draft[];
    try {
      if (storage.getItem(LEGACY_STORAGE_KEY) === null) return;
      legacy = read(LEGACY_STORAGE_KEY);
      storage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      return;
    }
    const known = new Set(cache.map(item => item.draftId));
    const moved = legacy.filter(item => !known.has(item.draftId));
    if (moved.length > 0) write([...cache, ...moved]);
  }
```

   删除原来的无参 `read()`；`write` 里的 `storage.setItem(STORAGE_KEY, …)` 改为 `storage.setItem(storageKey, …)`。

- [ ] **Step 4: 身份经 context 下发**

`client-context.tsx` 替换为：

```tsx
import { createContext, useContext } from "react";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import type { DraftScope } from "./drafts/draft-store.js";

const ClientContext = createContext<TenantPortalClient | null>(null);
const DraftScopeContext = createContext<DraftScope | null>(null);

export function ClientProvider(props: { client: TenantPortalClient; draftScope: DraftScope; children: React.ReactNode }) {
  return (
    <ClientContext.Provider value={props.client}>
      <DraftScopeContext.Provider value={props.draftScope}>{props.children}</DraftScopeContext.Provider>
    </ClientContext.Provider>
  );
}

export function useClient(): TenantPortalClient {
  const client = useContext(ClientContext);
  if (client === null) throw new Error("useClient must be used inside ClientProvider");
  return client;
}

/** 草稿按「租户 + principal」存，谁登录就只看到谁的。 */
export function useDraftScope(): DraftScope {
  const scope = useContext(DraftScopeContext);
  if (scope === null) throw new Error("useDraftScope must be used inside ClientProvider");
  return scope;
}
```

`use-drafts.ts`：import `useDraftScope` from `../client-context.js`；
`const store = useMemo(() => createDraftStore(globalThis.localStorage), []);` 改为

```ts
  const scope = useDraftScope();
  const store = useMemo(
    () => createDraftStore(globalThis.localStorage, scope),
    [scope.tenantId, scope.principalId],
  );
```

`workbench.tsx:49` 同样改为先 `const scope = useDraftScope();` 再 `useMemo(() => createDraftStore(globalThis.localStorage, scope), [scope.tenantId, scope.principalId])`，并补 import。

`app.tsx`：`App(props: { client: TenantPortalClient; draftScope: DraftScope; onSignOut?: () => void })`，`<ClientProvider client={props.client} draftScope={props.draftScope}>`。

`main.tsx`：
- 内存夹具分支：`<App client={client} draftScope={{ tenantId: "t1", principalId: "fixture" }} />`
- 真实会话分支：`<App client={client} draftScope={{ tenantId: session.tenantId, principalId: session.principalId }} onSignOut={onSignOut} />`

- [ ] **Step 5: 更新渲染测试**

Run: `grep -rn "<ClientProvider \|<App " packages/tenant-portal-webui/tests`
对每个结果：`<ClientProvider client={X}>` 改为 `<ClientProvider client={X} draftScope={TEST_DRAFT_SCOPE}>`，`<App client={client} />` 改为 `<App client={client} draftScope={TEST_DRAFT_SCOPE} />`，并在该文件 import `TEST_DRAFT_SCOPE` from `./draft-scope.js`。测试里若直接 `localStorage.setItem("unidocs.portal.drafts.v1", …)` 预置草稿，改为 `draftStorageKey(TEST_DRAFT_SCOPE)`（`grep -rn "drafts.v1" packages/tenant-portal-webui/tests` 确认）。

Run: `pnpm --filter @unidocs/tenant-portal-webui typecheck && pnpm --filter @unidocs/tenant-portal-webui test`
Expected: PASS。typecheck 报 `draftScope` 缺失的位置即为漏改的渲染点。

- [ ] **Step 6: 重建内嵌资源并校验**

Run: `pnpm --filter @unidocs/cloudflare-portal build:webui`
然后：`grep -c "user-local\|t-local\|dev@unidocs.local" packages/cloudflare-portal/src/tenant-ui-assets.generated.ts`
Expected: `0`。再跑 `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/static-assets.test.ts tests/worker.test.ts`，Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/tenant-portal-webui packages/cloudflare-portal/src/tenant-ui-assets.generated.ts packages/cloudflare-portal/src/ui-assets.generated.ts
git commit -m "feat(tenant-webui): keep drafts per tenant and principal"
```

（`build:webui` 也会重建 admin 资源；Task 6 改过 admin WebUI，一并提交。）

---

### Task 12: T1 契约遍历守门测试

**Files:**
- Create: `packages/cloudflare-portal/tests/tenant/walk-fixtures.ts`（从 bearer walk 抽出 `contractProcedures`、`seedDocumentWithVersion`）
- Modify: `packages/cloudflare-portal/tests/tenant/tenant-http-bearer-walk.test.ts`（改用抽出的助手）
- Create: `packages/cloudflare-portal/tests/tenant/auth-coverage-walk.test.ts`

**Interfaces:**
- Consumes: Task 2 `insertMember`、`D1TenantSessionStore`；`worker.fetch`；`tenantApiContract`（`@unidocs/protocol-tenant-portal`）、`agentApiContract`（`@unidocs/protocol-platform`）。
- Produces（测试助手）:
  - `interface ContractRoute { readonly method?: string; readonly path?: string }`
  - `contractProcedures(node: unknown, prefix?: string[]): { name: string; route: ContractRoute }[]`
  - `seedDocumentWithVersion(db: D1Database, documentId: string, tenantId?: string): Promise<void>`

- [ ] **Step 1: 抽出助手**

```ts
// packages/cloudflare-portal/tests/tenant/walk-fixtures.ts
import type { D1Database } from "@cloudflare/workers-types";

export interface ContractRoute { readonly method?: string; readonly path?: string }

/** Every contract procedure with its dotted path, found by walking the router object. */
export function contractProcedures(node: unknown, prefix: string[] = []): { name: string; route: ContractRoute }[] {
  if (typeof node !== "object" || node === null) return [];
  const orpc = (node as { "~orpc"?: { route?: ContractRoute } })["~orpc"];
  if (orpc) return [{ name: prefix.join("."), route: orpc.route ?? {} }];
  return Object.entries(node).flatMap(([key, child]) => contractProcedures(child, [...prefix, key]));
}
```

然后把 `tenant-http-bearer-walk.test.ts` 里 `seedDocumentWithVersion` 的函数体原样搬到 `walk-fixtures.ts`，签名改为 `export async function seedDocumentWithVersion(db: D1Database, documentId: string, tenantId = "t-local")`，函数体里的 `real.db` 改为 `db`，两处 `'t-local'` 字面量改为绑定参数 `tenantId`（`INSERT INTO portal_documents … VALUES (?, ?, 'Notes', …)` 与 `portal_versions` 同理，`.bind(tenantId, documentId)`）。

bearer walk 文件：删除本地 `procedures`、`Route`、`seedDocumentWithVersion`，改为 `import { contractProcedures, seedDocumentWithVersion, type ContractRoute } from "./walk-fixtures.js";`；调用处 `procedures(tenantApiContract)` → `contractProcedures(tenantApiContract)`，`seedDocumentWithVersion("doc-1")` → `seedDocumentWithVersion(real.db, "doc-1")`，`Route` → `ContractRoute`。

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/tenant-http-bearer-walk.test.ts`
Expected: PASS（纯重构）。

- [ ] **Step 2: 写 T1**

```ts
// packages/cloudflare-portal/tests/tenant/auth-coverage-walk.test.ts
/**
 * T1: every tenant and Agent API procedure, through worker.fetch, so the
 * requests pass the real gate in serveTenant rather than a handler called
 * directly. The procedure set comes from the contracts: a procedure added to
 * either contract fails the completeness check until it has a fixture here.
 *
 * Checks 1, 3, 4 and 5 are decided in serveTenant before any routing; per
 * procedure they prove that the path reaches serveTenant at all. Check 2 (a
 * session of another tenant) is the one that depends on each handler calling
 * requireTenantScope, and the only one that catches a new handler forgetting
 * it. The control group proves each refusal above is the gate, not an invalid
 * fixture: with seeded data no fixture may answer 400/401/403/404.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentApiContract } from "@unidocs/protocol-platform";
import { tenantApiContract } from "@unidocs/protocol-tenant-portal";
import worker from "../../src/worker.js";
import { D1TenantSessionStore, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE } from "../../src/tenant/session.js";
import { insertMember } from "./members.js";
import { startRealD1, type RealD1 } from "./real-d1.js";
import { contractProcedures, seedDocumentWithVersion } from "./walk-fixtures.js";

const ORIGIN = "http://127.0.0.1:19195";
const AGENT_TOKEN = "agent-walk-token-0123456789";
const message = (text: string) => ({ text, richContent: null, attachments: [] });

interface Fixture { readonly body?: unknown; readonly headers?: Record<string, string> }

/** One valid request per procedure, keyed by dotted contract path. */
const TENANT_FIXTURES: Record<string, Fixture> = {
  "documentTypes.list": {},
  "documentTypes.getDocumentContract": {},
  "documents.list": {},
  "documents.create": { body: { documentType: "markdown", name: "Walk" }, headers: { "idempotency-key": "walk-doc" } },
  "documents.get": {},
  "documents.moveCurrentVersion": { body: { observedCurrentVersionIdx: 0, targetVersionIdx: 0, reason: "walk" } },
  "documents.listAudit": {},
  "versions.list": {},
  "versions.get": {},
  "versions.getSnapshot": {},
  "threads.list": {},
  "threads.create": { body: { baseVersionIdx: 0, content: message("walk thread"), location: null }, headers: { "idempotency-key": "walk-thread" } },
  "threads.get": {},
  "threads.appendComment": { body: { baseVersionIdx: 0, content: message("walk comment"), location: null }, headers: { "idempotency-key": "walk-comment" } },
  "cas.issueCapability": { body: {} },
};

/** Object order matters: the control group creates the receipt that `get` then reads. */
const AGENT_FIXTURES: Record<string, Fixture> = {
  "submissions.create": {
    body: {
      submissionId: "walk-sub",
      threadUpdates: [{ threadId: "th-walk", observedAcknowledgedCommentIdx: null, respondThroughCommentIdx: 0, content: message("walk reply"), resultLocations: [] }],
    },
  },
  "submissions.get": {},
};

const PARAMS: Record<string, string> = {
  tenantId: "t-local", documentId: "doc-walk", threadId: "th-walk", versionIdx: "0",
  documentType: "markdown", documentContractIdx: "0", submissionId: "walk-sub",
};

let real: RealD1;
let env: Env;
const cookies: Record<"member" | "otherTenant" | "removed", { session: string; csrf: string }> = {} as never;

beforeEach(async () => {
  real = await startRealD1();
  const now = Math.floor(Date.now() / 1000);
  await seedDocumentWithVersion(real.db, "doc-walk");
  await real.db.prepare("INSERT INTO portal_threads (tenant_id, document_id, thread_id, created_at) VALUES ('t-local', 'doc-walk', 'th-walk', 0)").run();
  await real.db.prepare(`INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
    VALUES ('t-local', 'doc-walk', 'th-walk', 0, 0, '{"text":"seed","richContent":null,"attachments":[]}', NULL, 'user:walker', 0)`).run();

  const store = new D1TenantSessionStore(real.db);
  const issue = async (tenantId: string, principalId: string, active: boolean) => {
    await insertMember(real.db, { tenantId, principalId, active });
    const { token, csrfToken } = await store.issue(tenantId, principalId, now);
    return { session: token, csrf: csrfToken };
  };
  cookies.member = await issue("t-local", "user:walker", true);
  cookies.otherTenant = await issue("t-other", "user:other", true);
  cookies.removed = await issue("t-local", "user:removed", false);

  env = {
    DB: real.db, BUNDLES: {}, ADMIN_MARKDOWN_SERVICE: {}, MARKDOWN_OPERATOR_HMAC_KEY: "",
    PORTAL_ORIGIN: ORIGIN, BUNDLE_ORIGIN: "http://127.0.0.1:19196",
    GATEWAY_OIDC_ISSUER: "https://accounts.google.com", GATEWAY_OIDC_CLIENT_ID: "", GATEWAY_OIDC_CLIENT_SECRET: "",
    PORTAL_BOOTSTRAP_EMAIL: "", PORTAL_TENANT_DEV_SESSION: "",
    MCP_ENABLED: "false", MCP_PUBLIC_ORIGIN: ORIGIN, MCP_ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
    MCP_CONTENT_MUTATIONS_ENABLED: "false", MCP_PUBLISH_MUTATIONS_ENABLED: "false", MCP_SECURITY_MUTATIONS_ENABLED: "false",
    OAUTH_STATE_ENCRYPTION_KEY: "unused", OAUTH_KV: {},
    CAS_ORIGIN: "", CAS_STACK_ID: "", CAS_ISSUER: "", CAS_AUDIENCE: "", CAS_REF_DOMAIN: "", CAS_SIGNING_KID: "", CAS_SIGNING_KEY: "",
    AGENT_API_TOKEN: AGENT_TOKEN, AGENT_TENANT_ID: "t-local",
  } as unknown as Env;
});

afterEach(async () => { await real.dispose(); });

function pathFor(name: string, template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_match, param: string) => {
    const value = PARAMS[param];
    if (value === undefined) throw new Error(`${name}: no walk value for path parameter {${param}}`);
    return encodeURIComponent(value);
  });
}

type Caller =
  | { readonly kind: "anonymous" }
  | { readonly kind: "session"; readonly who: keyof typeof cookies; readonly csrf: boolean; readonly site?: string }
  | { readonly kind: "bearer" };

let sequence = 0;
async function send(name: string, route: { method?: string; path?: string }, fixture: Fixture, caller: Caller): Promise<number> {
  const method = (route.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = {};
  for (const [header, value] of Object.entries(fixture.headers ?? {})) {
    headers[header] = header === "idempotency-key" ? `${value}-${sequence += 1}` : value;
  }
  if (fixture.body !== undefined) headers["content-type"] = "application/json";
  if (caller.kind === "bearer") headers.authorization = `Bearer ${AGENT_TOKEN}`;
  if (caller.kind === "session") {
    const pair = cookies[caller.who];
    headers.cookie = `${TENANT_SESSION_COOKIE}=${pair.session}; ${TENANT_CSRF_COOKIE}=${pair.csrf}`;
    if (method !== "GET") headers.origin = ORIGIN;
    if (caller.csrf && method !== "GET") headers["x-csrf-token"] = pair.csrf;
    if (caller.site) headers["sec-fetch-site"] = caller.site;
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${pathFor(name, route.path ?? "")}`, {
    method, headers, body: fixture.body === undefined ? undefined : JSON.stringify(fixture.body),
  }), env);
  await response.body?.cancel();
  return response.status;
}

const tenantProcedures = () => contractProcedures(tenantApiContract);
const agentProcedures = () => contractProcedures(agentApiContract);

it("covers every procedure of both contracts, and nothing else", () => {
  expect(tenantProcedures().length).toBeGreaterThan(0);
  expect(agentProcedures().length).toBeGreaterThan(0);
  expect(tenantProcedures().map(({ name }) => name).sort()).toEqual(Object.keys(TENANT_FIXTURES).sort());
  expect(agentProcedures().map(({ name }) => name).sort()).toEqual(Object.keys(AGENT_FIXTURES).sort());
});

it("gates every tenant API procedure in serveTenant", async () => {
  const outcomes: Record<string, Record<string, number>> = {};
  const expected: Record<string, Record<string, number>> = {};
  for (const { name, route } of tenantProcedures()) {
    const fixture = TENANT_FIXTURES[name];
    const write = (route.method ?? "POST").toUpperCase() !== "GET";
    outcomes[name] = {
      anonymous: await send(name, route, fixture, { kind: "anonymous" }),
      otherTenant: await send(name, route, fixture, { kind: "session", who: "otherTenant", csrf: true }),
      removedMember: await send(name, route, fixture, { kind: "session", who: "removed", csrf: true }),
      crossSite: await send(name, route, fixture, { kind: "session", who: "member", csrf: true, site: "cross-site" }),
      ...(write ? { missingCsrf: await send(name, route, fixture, { kind: "session", who: "member", csrf: false }) } : {}),
    };
    expected[name] = { anonymous: 401, otherTenant: 403, removedMember: 401, crossSite: 403, ...(write ? { missingCsrf: 403 } : {}) };
  }
  expect(outcomes).toEqual(expected);
});

it("gates every Agent API procedure: bearer only", async () => {
  const outcomes: Record<string, Record<string, number>> = {};
  for (const { name, route } of agentProcedures()) {
    outcomes[name] = {
      anonymous: await send(name, route, AGENT_FIXTURES[name], { kind: "anonymous" }),
      memberSession: await send(name, route, AGENT_FIXTURES[name], { kind: "session", who: "member", csrf: true }),
    };
  }
  expect(outcomes).toEqual(Object.fromEntries(agentProcedures().map(({ name }) => [name, { anonymous: 401, memberSession: 403 }])));
});

it("control group: every fixture reaches its handler for a legitimate caller", async () => {
  const refused = [400, 401, 403, 404];
  const outcomes: Record<string, number> = {};
  for (const { name, route } of tenantProcedures()) {
    outcomes[name] = await send(name, route, TENANT_FIXTURES[name], { kind: "session", who: "member", csrf: true });
  }
  for (const { name, route } of agentProcedures()) {
    outcomes[`agent:${name}`] = await send(name, route, AGENT_FIXTURES[name], { kind: "bearer" });
  }
  const rejected = Object.fromEntries(Object.entries(outcomes).filter(([, status]) => refused.includes(status)));
  expect(rejected).toEqual({});
});
```

- [ ] **Step 3: 运行并核对**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/auth-coverage-walk.test.ts`
Expected: PASS。

这是守门测试，不能“调到通过”。若失败，按下面判断：
- 完整性用例失败：契约有 fixture 表之外的 procedure → 补 fixture，不删断言。
- 某 procedure 的 `otherTenant` 不是 403：该 handler 漏了 `requireTenantScope` → 这是真 bug，停下来报告，不改期望。
- 对照组出现 404：缺预置数据（例如路径参数指向的资源不存在）→ 在 `beforeEach` 补数据；出现 400：fixture 不符合契约 → 按契约修 fixture。
- `documents.create` 若因 `registration_json = '{}'` 得到 409 属正常（不在拒绝集合里）。

- [ ] **Step 4: 提交**

```bash
git add packages/cloudflare-portal/tests/tenant
git commit -m "test(portal): walk both tenant contracts through the worker's auth gate"
```

---

### Task 13: 开生产路由；T2 生产路由遍历

**Files:**
- Modify: `packages/cloudflare-portal/package.json`（devDependency `jsonc-parser`）
- Modify: `packages/cloudflare-portal/tests/tenant/real-d1.ts`（同一 Miniflare 顺带提供 KV 与 R2）
- Modify: `packages/cloudflare-portal/wrangler.production.jsonc`（三条 route）
- Modify: `tests/unit/scripts/portal-auth-deploy.test.mjs:11-16`（路由清单）
- Modify: `packages/cloudflare-portal/src/worker.ts:243-250`（注释）、`tests/worker.test.ts:125-127`（注释）
- Create: `packages/cloudflare-portal/tests/production-routes-auth.test.ts`

**Interfaces:**
- Consumes: 前面全部任务（T2 覆盖登录端点与 tenant-members）。
- Produces: `RealD1` 增加 `readonly kv: KVNamespace; readonly r2: R2Bucket;`。

- [ ] **Step 1: 依赖与 real-d1 扩展**

Run: `pnpm --filter @unidocs/cloudflare-portal add -D jsonc-parser@3.3.1`

`tests/tenant/real-d1.ts`：
- import 行加 `import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";`（替换原来只导入 `D1Database` 的那行）。
- `RealD1` 接口加：

```ts
  /** An empty KV namespace and R2 bucket from the same Miniflare, for tests that run the whole worker. */
  readonly kv: KVNamespace;
  readonly r2: R2Bucket;
```

- Miniflare worker 选项里 `d1Databases` 之后加 ``kvNamespaces: { OAUTH_KV: `tenant-real-kv-${crypto.randomUUID()}` }, r2Buckets: { BUNDLES: `tenant-real-r2-${crypto.randomUUID()}` },``
- `return { db, applyMigration, dispose }` 改为：

```ts
    const kv = await miniflare.getKVNamespace("OAUTH_KV", WORKER) as unknown as KVNamespace;
    const r2 = await miniflare.getR2Bucket("BUNDLES", WORKER) as unknown as R2Bucket;
    return { db, kv, r2, applyMigration, dispose: () => miniflare.dispose() };
```

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant/real-d1.test.ts`
Expected: PASS。

- [ ] **Step 2: 写 T2（此时生产配置还没有新路由）**

```ts
// packages/cloudflare-portal/tests/production-routes-auth.test.ts
/**
 * T2: every route wrangler.production.jsonc gives this worker, requested
 * anonymously with the PRODUCTION vars. Local vars would prove nothing about
 * production: MCP is off locally, so /mcp answers 404 there and 401 here.
 *
 * Each route pattern must have an entry in SAMPLES, so a route added to the
 * production config without deciding how it is authenticated fails here.
 * Every sample must be refused (401/403, or a 303 to a sign-in page) unless it
 * is listed with an explicit expectation below; changing that list needs review.
 */
import { readFile } from "node:fs/promises";
import { parse, type ParseError } from "jsonc-parser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiContract } from "@unidocs/protocol-platform";
import { tenantApiContract } from "@unidocs/protocol-tenant-portal";
import worker from "../src/worker.js";
import { ADMIN_UI_ASSETS } from "../src/ui-assets.generated.js";
import { TENANT_UI_ASSETS } from "../src/tenant-ui-assets.generated.js";
import { startRealD1, type RealD1 } from "./tenant/real-d1.js";
import { contractProcedures } from "./tenant/walk-fixtures.js";

interface ProductionConfig {
  readonly routes: readonly { readonly pattern: string }[];
  readonly vars: Readonly<Record<string, string>>;
}

type Expectation =
  | { readonly kind: "gate" }
  | { readonly kind: "status"; readonly status: readonly number[]; readonly location?: RegExp }
  | { readonly kind: "clientError" }
  | { readonly kind: "emptyNotFound" };

interface Sample { readonly method: string; readonly url: string; readonly expect: Expectation }

const SITE = "https://unidocs.shazhou.work";
const BUNDLES = "https://bundles.shazhou.work";
const GATE: Expectation = { kind: "gate" };
const SIGN_IN_PATHS = ["/admin/login", "/admin/auth/login", "/portal/auth/login"];
const GOOGLE = /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/;
const probe = () => `__probe_${crypto.randomUUID()}`;
const get = (url: string, expectation: Expectation = GATE): Sample => ({ method: "GET", url, expect: expectation });
const post = (url: string, expectation: Expectation = GATE): Sample => ({ method: "POST", url, expect: expectation });
const ok = (status = 200): Expectation => ({ kind: "status", status: [status] });

const firstAsset = (assets: Readonly<Record<string, string>>, prefix: string) => {
  const path = Object.keys(assets).find(key => key.startsWith(prefix));
  if (!path) throw new Error(`no built asset under ${prefix}`);
  return path;
};

function contractSamples(): Sample[] {
  const values: Record<string, string> = {
    tenantId: "t-probe", documentId: "d", threadId: "th", versionIdx: "0", documentType: "markdown", documentContractIdx: "0", submissionId: "s",
  };
  return [...contractProcedures(tenantApiContract), ...contractProcedures(agentApiContract)].map(({ route }) => ({
    method: (route.method ?? "POST").toUpperCase(),
    url: SITE + (route.path ?? "").replace(/\{([^}]+)\}/g, (_match, name: string) => values[name]),
    expect: GATE,
  }));
}

/** The only place a production route is classified. */
const SAMPLES: Record<string, () => Sample[]> = {
  "unidocs.shazhou.work/admin": () => [get(`${SITE}/admin`)],
  "unidocs.shazhou.work/admin/*": () => [
    get(`${SITE}/admin/`), get(`${SITE}/admin/document-types`), get(`${SITE}/admin/administrators`), get(`${SITE}/admin/audit`),
    get(`${SITE}/admin/login`, ok()), get(`${SITE}/admin/access-denied`, ok()),
    get(SITE + firstAsset(ADMIN_UI_ASSETS, "/admin/assets/"), ok()),
    get(`${SITE}/admin/auth/login`, { kind: "status", status: [303], location: GOOGLE }),
    get(`${SITE}/admin/auth/callback`), get(`${SITE}/admin/auth/session`), post(`${SITE}/admin/auth/logout`),
    get(`${SITE}/admin/api/v1/administrators`), get(`${SITE}/admin/api/v1/tenant-members`),
    get(`${SITE}/admin/api/v1/document-types`), get(`${SITE}/admin/api/v1/audit-events`),
    get(`${SITE}/admin/${probe()}`, { kind: "emptyNotFound" }),
  ],
  "unidocs.shazhou.work/mcp": () => [get(`${SITE}/mcp`), post(`${SITE}/mcp`)],
  "unidocs.shazhou.work/.well-known/oauth-protected-resource/mcp": () => [get(`${SITE}/.well-known/oauth-protected-resource/mcp`, ok())],
  "unidocs.shazhou.work/.well-known/oauth-authorization-server": () => [get(`${SITE}/.well-known/oauth-authorization-server`, ok())],
  "unidocs.shazhou.work/oauth/admin-mcp/*": () => [
    post(`${SITE}/oauth/admin-mcp/register`, { kind: "clientError" }),
    post(`${SITE}/oauth/admin-mcp/token`, { kind: "clientError" }),
    post(`${SITE}/oauth/admin-mcp/revoke`, { kind: "clientError" }),
    get(`${SITE}/oauth/admin-mcp/authorize`, { kind: "status", status: [400] }),
    get(`${SITE}/oauth/admin-mcp/${probe()}`, { kind: "emptyNotFound" }),
  ],
  "bundles.shazhou.work": () => [
    get(`${BUNDLES}/view-bundles/vb_${"0".repeat(64)}/unidocs-view.json`, { kind: "status", status: [404] }),
    get(`${BUNDLES}/${probe()}`, { kind: "status", status: [404] }),
  ],
  "unidocs.shazhou.work/portal": () => [get(`${SITE}/portal`, ok())],
  "unidocs.shazhou.work/portal/*": () => [
    get(`${SITE}/portal/`, ok()), get(`${SITE}/portal/index.html`, ok()), { method: "HEAD", url: `${SITE}/portal/`, expect: ok() },
    get(SITE + firstAsset(TENANT_UI_ASSETS, "/portal/assets/"), ok()),
    get(`${SITE}/portal/auth/login`, { kind: "status", status: [303], location: GOOGLE }),
    get(`${SITE}/portal/auth/callback`, { kind: "status", status: [303], location: /^https:\/\/unidocs\.shazhou\.work\/portal\/\?login=failed&requestId=/ }),
    get(`${SITE}/portal/auth/session`), post(`${SITE}/portal/auth/logout`),
    get(`${SITE}/portal/${probe()}`, { kind: "emptyNotFound" }),
  ],
  "unidocs.shazhou.work/api/v1/tenants/*": () => [
    ...contractSamples(),
    // Authentication runs before routing on this surface: an unknown path is 401, not 404.
    get(`${SITE}/api/v1/tenants/t-probe/${probe()}`),
  ],
};

let config: ProductionConfig;
let real: RealD1;
let env: Env;
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

beforeAll(async () => {
  const text = await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");
  const errors: ParseError[] = [];
  config = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as ProductionConfig;
  expect(errors, "wrangler.production.jsonc must parse").toEqual([]);
});

beforeEach(async () => {
  real = await startRealD1();
  env = {
    ...config.vars,
    DB: real.db, OAUTH_KV: real.kv, BUNDLES: real.r2,
    GATEWAY_OIDC_CLIENT_SECRET: "t2-client-secret",
    OAUTH_STATE_ENCRYPTION_KEY: "A".repeat(43),
    MARKDOWN_OPERATOR_HMAC_KEY: "",
    ADMIN_MARKDOWN_SERVICE: {},
  } as unknown as Env;
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://accounts.google.com/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (/^https:\/\/([a-z0-9-]+\.)*(google|googleapis)\.com\//.test(url)) throw new Error(`T2 must not reach Google: ${url}`);
    return original(input, init);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await real.dispose();
});

function judge(sample: Sample, response: Response, body: string): string | null {
  const location = response.headers.get("location");
  switch (sample.expect.kind) {
    case "gate":
      if ([401, 403].includes(response.status)) return null;
      if (response.status === 303 && location && SIGN_IN_PATHS.includes(new URL(location, SITE).pathname)) return null;
      return `expected 401/403 or a 303 to a sign-in page, got ${response.status} ${location ?? ""}`;
    case "status":
      if (!sample.expect.status.includes(response.status)) return `expected ${sample.expect.status.join("/")}, got ${response.status}`;
      if (sample.expect.location && !sample.expect.location.test(location ?? "")) return `unexpected Location ${location}`;
      return null;
    case "clientError":
      return response.status >= 400 && response.status < 500 ? null : `expected a 4xx, got ${response.status}`;
    case "emptyNotFound":
      return response.status === 404 && body === "" ? null : `expected an empty 404, got ${response.status} with ${body.length} bytes`;
  }
}

describe("production routes (anonymous, production vars)", () => {
  it("classifies every production route, and only production routes", () => {
    expect(config.routes.map(route => route.pattern).sort()).toEqual(Object.keys(SAMPLES).sort());
    for (const [pattern, samples] of Object.entries(SAMPLES)) expect(samples().length, pattern).toBeGreaterThan(0);
  });

  it("refuses every sample that is not explicitly public", async () => {
    const failures: Record<string, string> = {};
    for (const pattern of config.routes.map(route => route.pattern)) {
      for (const sample of SAMPLES[pattern]?.() ?? []) {
        // No Origin, no cookie, no Authorization: an anonymous POST to
        // /admin/auth/logout with a same-origin Origin would get a cookie-clearing
        // 204 (bff.ts), which is not a leak but would make the verdict depend on headers.
        const response = await worker.fetch(new Request(sample.url, { method: sample.method }), env, context);
        const body = sample.method === "HEAD" ? "" : await response.text();
        const failure = judge(sample, response, body);
        if (failure) failures[`${sample.method} ${sample.url}`] = failure;
      }
    }
    expect(failures).toEqual({});
  });

  it("serves a tenant shell that carries no local identity or fixture data", () => {
    for (const [path, content] of Object.entries(TENANT_UI_ASSETS)) {
      for (const forbidden of ["t-local", "user-local", "dev@unidocs.local"]) {
        expect(content.includes(forbidden), `${path} contains ${forbidden}`).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/production-routes-auth.test.ts`
Expected: FAIL，“classifies every production route” 报 `SAMPLES` 多出三条 `/portal`、`/portal/*`、`/api/v1/tenants/*`。

- [ ] **Step 4: 加生产路由**

`wrangler.production.jsonc` 的 `routes` 在 `bundles.shazhou.work` 那项之前插入：

```jsonc
    {
      "pattern": "unidocs.shazhou.work/portal",
      "zone_name": "shazhou.work"
    },
    {
      "pattern": "unidocs.shazhou.work/portal/*",
      "zone_name": "shazhou.work"
    },
    {
      "pattern": "unidocs.shazhou.work/api/v1/tenants/*",
      "zone_name": "shazhou.work"
    },
```

`tests/unit/scripts/portal-auth-deploy.test.mjs` 的路由清单同位置插入
`"unidocs.shazhou.work/portal", "unidocs.shazhou.work/portal/*", "unidocs.shazhou.work/api/v1/tenants/*",`，并把用例名 `"approved production cutover owns only admin routes and a separate database"` 改为 `"approved production cutover owns the admin and tenant routes and a separate database"`。

- [ ] **Step 5: 运行 T2 并核对**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/production-routes-auth.test.ts && pnpm exec vitest run tests/unit/scripts/portal-auth-deploy.test.mjs`
Expected: PASS。

失败时按下面判断，**不要**把失败样例改成白名单：
- 某个应被拒绝的样例得到 2xx：真漏洞，停下报告。
- `/oauth/admin-mcp/revoke` 得到 200：说明匿名吊销被接受。先读 `@cloudflare/workers-oauth-provider` 的 revoke 行为确认不泄漏数据，再把该项改为 `ok()` 并在 SAMPLES 旁写一行注释引用确认依据；无法确认就停下报告。
- `/.well-known/*` 不是 200：检查 env 是否带了生产 `MCP_ENABLED: "true"` 与 `context`。
- `/admin/assets/*` 或 `/portal/assets/*` 取不到：先跑 `pnpm --filter @unidocs/cloudflare-portal build:webui`。

- [ ] **Step 6: 注释**

`worker.ts` 第 243–250 行注释块替换为：

```ts
      // Ahead of the BFF, and ahead of reading the Google settings: the tenant
      // shell is public on purpose (its routes are hash routes the server never
      // sees, so a server-side gate would lose a deep link across sign-in; the
      // gate is on the tenant API), the admin-shaped BFF would send an anonymous
      // visitor to `/admin/login`, and it should still serve on an environment
      // that has no Google client configured at all.
      // The bare origin is what a developer opens first, and it has no page of
      // its own. Production does not route `/` to this worker
      // (wrangler.production.jsonc), so this only ever answers locally.
```

`tests/worker.test.ts` 第 125–127 行注释中 “Production never routes `/` to this worker” 保持，删去其后任何 “only admin” 字样（若有）。

- [ ] **Step 7: 全量回归并提交**

Run: `pnpm --filter @unidocs/cloudflare-portal test && pnpm --filter @unidocs/cloudflare-portal typecheck`
Expected: PASS。

```bash
git add packages/cloudflare-portal tests/unit/scripts/portal-auth-deploy.test.mjs pnpm-lock.yaml
git commit -m "feat(portal): route the tenant console and API in production behind a route-walk test"
```

---

### Task 14: 生产数据面配置与上线手册

> **需要人工输入，执行者不得编造。** 开始本任务前向用户索取下列值；拿不到就停在 Step 1，前 13 个任务的成果不受影响（生产路由已开，但在本任务完成前不要部署）。
>
> | 名称 | 用在 | 性质 |
> |---|---|---|
> | `AGENT_TENANT_ID` | portal vars | 首个上线租户的 id |
> | `CAS_ORIGIN`、`CAS_STACK_ID`、`CAS_ISSUER`、`CAS_AUDIENCE`、`CAS_REF_DOMAIN`、`CAS_SIGNING_KID` | portal vars | 该租户 UniCAS 栈的公开配置 |
> | `PLATFORM_ORIGIN` | markdown vars | 通常为 `https://unidocs.shazhou.work` |
> | `OPERATOR_CAS_ORIGIN`、`OPERATOR_CAS_STACK_ID`、`OPERATOR_CAS_ISSUER`、`OPERATOR_CAS_AUDIENCE`、`OPERATOR_CAS_SIGNING_KID` | markdown vars | Operator 写快照用的 UniCAS 配置 |
> | `CAS_SIGNING_KEY`、`AGENT_API_TOKEN`（portal）；`PLATFORM_AGENT_TOKEN`、`OPERATOR_CAS_SIGNING_KEY`（markdown） | `wrangler secret put` | **只由人执行**，值不进仓库、不进对话 |

**Files:**
- Modify: `packages/cloudflare-portal/wrangler.production.jsonc`（vars、`secrets.required`）
- Modify: `packages/cloudflare-markdown/wrangler.toml`（vars、`PLATFORM_SERVICE` service binding、注释）
- Modify: `tests/unit/scripts/portal-auth-deploy.test.mjs`
- Modify: `stacks/unidocs-cloudflare/deploy/README.md`（上线步骤）

**Interfaces:**
- Consumes: 用户提供的配置值。
- Produces: 生产 portal 与 markdown worker 的 Operator 回路配置完整。

- [ ] **Step 1: 取得输入**

向用户确认上表全部非 secret 值，以及“首个上线租户只有一个”。同时读 `packages/cloudflare-markdown/src/platform-client.ts` 与 `stacks/unidocs-cloudflare/local/runtime.mjs` 中 Operator 侧绑定的构造（`grep -n "PLATFORM_\|OPERATOR_CAS_" stacks/unidocs-cloudflare/local/runtime.mjs`），确认 markdown worker 需要的完整名字集合与上表一致；不一致时以代码为准并告知用户。

- [ ] **Step 2: 写失败测试**

`tests/unit/scripts/portal-auth-deploy.test.mjs` 的第一个用例末尾追加：

```js
    // The tenant data plane in production: CAS for snapshots, one Agent tenant for the Operator loop.
    for (const name of ["AGENT_TENANT_ID", "CAS_ORIGIN", "CAS_STACK_ID", "CAS_ISSUER", "CAS_AUDIENCE", "CAS_REF_DOMAIN", "CAS_SIGNING_KID"]) {
      expect(typeof config.vars[name] === "string" && config.vars[name].trim() !== "", name).toBe(true);
    }
    expect(config.secrets.required).toEqual(expect.arrayContaining(["CAS_SIGNING_KEY", "AGENT_API_TOKEN", "MARKDOWN_OPERATOR_HMAC_KEY"]));
    expect(config.vars).not.toHaveProperty("AGENT_API_TOKEN");
    expect(config.vars).not.toHaveProperty("CAS_SIGNING_KEY");
    expect(config.vars).not.toHaveProperty("PORTAL_TENANT_DEV_SESSION");
```

并新增一个用例校验 markdown 配置（`wrangler.toml` 用仓库已有的 TOML 解析方式；若仓库没有 TOML 解析依赖，用 `readFile` 后逐行断言 `PLATFORM_ORIGIN = "`、`OPERATOR_CAS_ORIGIN = "` 等行存在，以及 `[[services]]` 下有 `binding = "PLATFORM_SERVICE"` 与 `service = "unidocs-portal"`）：

```js
  test("the production markdown worker is wired back to the portal for the Operator loop", async () => {
    const toml = await readFile(new URL("../../../packages/cloudflare-markdown/wrangler.toml", import.meta.url), "utf8");
    for (const name of ["PLATFORM_ORIGIN", "OPERATOR_CAS_ORIGIN", "OPERATOR_CAS_STACK_ID", "OPERATOR_CAS_ISSUER", "OPERATOR_CAS_AUDIENCE", "OPERATOR_CAS_SIGNING_KID"]) {
      expect(toml, name).toMatch(new RegExp(`^${name} = "[^"]+"$`, "m"));
    }
    expect(toml).toMatch(/\[\[services\]\]\s*\nbinding = "PLATFORM_SERVICE"\s*\nservice = "unidocs-portal"/);
    expect(toml).not.toMatch(/^PLATFORM_AGENT_TOKEN\s*=/m);
    expect(toml).not.toMatch(/^OPERATOR_CAS_SIGNING_KEY\s*=/m);
  });
```

Run: `pnpm exec vitest run tests/unit/scripts/portal-auth-deploy.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 改配置**

`wrangler.production.jsonc`：
- `vars` 追加 Step 1 取得的 `AGENT_TENANT_ID` 与六个 `CAS_*` 值。
- `secrets.required` 追加 `"CAS_SIGNING_KEY"`、`"AGENT_API_TOKEN"`。

`packages/cloudflare-markdown/wrangler.toml`：
- `[vars]` 在 `MARKDOWN_OPERATOR_DOCUMENT_TYPE` 之后追加 `PLATFORM_ORIGIN` 与五个 `OPERATOR_CAS_*` 值。
- 删除第 25–29 行 “intentionally not deployed in v0” 注释，改为：

```toml
# Operator webhook loop (tenant data plane). PLATFORM_AGENT_TOKEN must equal the
# portal's AGENT_API_TOKEN and, like OPERATOR_CAS_SIGNING_KEY, is a secret
# (wrangler secret put). The local runtime injects its own values instead.
```

- 在现有 `[[services]]`（`CAS_SERVICE`）之后追加：

```toml
[[services]]
binding = "PLATFORM_SERVICE"
service = "unidocs-portal"
```

- 文件末尾 “Deployment secrets” 注释列表追加两行：

```toml
#   PLATFORM_AGENT_TOKEN         equal to the portal's AGENT_API_TOKEN
#   OPERATOR_CAS_SIGNING_KEY     the Operator's UniCAS signing key
```

Run: `pnpm exec vitest run tests/unit/scripts/portal-auth-deploy.test.mjs && pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/production-routes-auth.test.ts && pnpm --filter @unidocs/cloudflare-markdown test`
Expected: PASS（T2 用新的生产 vars 仍须通过）。

- [ ] **Step 4: 上线手册**

`stacks/unidocs-cloudflare/deploy/README.md` 末尾追加（与 spec §6 一致）：

```markdown
## Tenant console go-live

In order; each step is manual.

1. In Google Cloud Console, add `https://unidocs.shazhou.work/portal/auth/callback`
   (and the loopback callback used locally) to the OAuth client named by
   `GATEWAY_OIDC_CLIENT_ID`. Without it every tenant sign-in fails at the callback.
2. `wrangler secret put CAS_SIGNING_KEY` and `wrangler secret put AGENT_API_TOKEN`
   for `unidocs-portal` (`--config packages/cloudflare-portal/wrangler.production.jsonc`).
3. `wrangler secret put PLATFORM_AGENT_TOKEN` (same value as `AGENT_API_TOKEN`)
   and `wrangler secret put OPERATOR_CAS_SIGNING_KEY` for `unidocs-markdown`.
4. `wrangler d1 migrations apply unidocs-portal --remote --config packages/cloudflare-portal/wrangler.production.jsonc`
   (`wrangler deploy` does not apply migrations).
5. Deploy `unidocs-markdown`, then `unidocs-portal`.
6. As an administrator, `POST /admin/api/v1/tenant-members` with
   `{ "tenantId": "<AGENT_TENANT_ID>", "email": "<first member>" }`.
7. That member signs in at `https://unidocs.shazhou.work/portal/`, creates a
   document, and confirms the Operator produces its first version.
8. Spot-check that `https://unidocs.shazhou.work/ui/` and `/tenants/*` still reach the gateway.
```

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/wrangler.production.jsonc packages/cloudflare-markdown/wrangler.toml tests/unit/scripts/portal-auth-deploy.test.mjs stacks/unidocs-cloudflare/deploy/README.md
git commit -m "feat(stacks): configure the production tenant data plane and document go-live"
```

---

## 收尾检查（全部任务完成后）

- [ ] `pnpm --filter @unidocs/cloudflare-portal test && pnpm --filter @unidocs/cloudflare-portal typecheck`
- [ ] `pnpm --filter @unidocs/portal-service test && pnpm --filter @unidocs/protocol-admin-portal test && pnpm --filter @unidocs/tenant-portal-webui test && pnpm --filter @unidocs/admin-portal-webui test`
- [ ] `pnpm test:local`（集成测试，耗时较长）
- [ ] 对照 spec §4.8 T3 清单逐条确认有对应用例：成员绑定/拒绝/确认时效（Task 4）、并发（Task 4）、会话上限（Task 4）、begin 清理（Task 4）、callback 失败分支与 cross-site（Task 5）、returnTo（Task 3）、开关组合（Task 2）、tenant-members 全部行为（Task 7、8）、WebUI 登录/提示/退出/草稿（Task 10、11）。
