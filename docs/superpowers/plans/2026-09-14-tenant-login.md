# Tenant Portal 登录实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给租户面（`/portal/`）加上 Google 登录、会话与认证门，并接通只读的文档类型目录 API，让登录后的 WebUI 能看到真实数据。

**Architecture:** 复用 `cloudflare-portal` 里已经参数化的 `createGoogleLogin`，为租户开一套独立的 surface（独立路径、独立 cookie、独立 D1 表）。业务核放在 cloud-neutral 的 `portal-service`，HTTP 与 D1 放在 `cloudflare-portal`，WebUI 分阶段从内存 transport 切到真后端。

**Tech Stack:** TypeScript、Cloudflare Workers、D1（SQLite）、`oauth4webapi`、`jose`、Zod 4、React 19、Vitest。

## Global Constraints

- `packages/core`、`packages/doctype-*`、`packages/portal-service` 是 cloud-neutral 的：**不得**引入 Cloudflare 类型或做 I/O。Cloudflare 相关代码只能落在 `packages/cloudflare-*`。
- 租户表与 admin 表**不共用**。管理员与租户用户是两套主体，混表等于让「管理员自动成为租户用户」成为默认行为。
- 日志**绝不**记录 stack、error 对象、token 或 client secret，只记 `stage` / `reason` / `requestId`（照 `bff.ts` 现有写法）。
- 每个响应都要带 `X-Request-ID`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。
- 本轮租户 id 固定 `"t1"`（与 WebUI 现有 mock 一致）。
- 单测位置 `packages/*/tests/*.test.ts`，由裸 `vitest run` 跑，没有 vitest 配置文件。
- 本轮**不做**：documents / versions / threads / cas-capabilities 端点、Bearer（Agent）通道、租户名单后台 UI、域名到租户的映射。
- 目录投影采用**临时规则**「该文档类型最新上传的 bundle = 当前选中的 bundle」。存储里没有选中概念（`portal_type_card_bundles` / `portal_view_bundles` 只是候选列表）。每一处用到这条规则的代码都要写注释说明它是临时的，等 admin 侧有了选择能力就替换。

---

### Task 1: 解耦 `createGoogleLogin` 里写死的 admin 假设

`createGoogleLogin` 已经按 surface 参数化，但两处仍假定调用方是 admin，租户 surface 会直接撞上：

1. `const localWebUi = surface.cookieName === LOGIN_COOKIE && isLocalDevOrigin(config.origin)` —— 用 admin 的 cookie 名判断是否放行 loopback origin。租户换了 cookie 名，本地 dev 会抛 `Invalid Portal Google configuration`。
2. `portalGoogleConfigFromGateway` 把 `redirectUri` 硬编码成 `${portalOrigin}/admin/auth/callback`，`createGoogleLogin` 又反过来断言它等于 `${config.origin}${surface.callbackPath}`。租户的 callbackPath 不同，断言必失败。

**Files:**
- Modify: `packages/cloudflare-portal/src/google-config.ts`
- Modify: `packages/cloudflare-portal/src/google-login.ts`
- Test: `packages/cloudflare-portal/tests/google-config.test.ts`
- Test: `packages/cloudflare-portal/tests/google-login.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `PortalGoogleConfig` 不再有 `redirectUri` 字段；`createGoogleLogin` 内部用 `${config.origin}${surface.callbackPath}` 作为 redirect_uri。后续任务的租户 surface 依赖这两点。

- [ ] **Step 1: 写失败测试**

加到 `packages/cloudflare-portal/tests/google-login.test.ts` 末尾：

```ts
test("the loopback relaxation does not depend on which surface is logging in", () => {
  const localConfig = portalGoogleConfigFromGateway(
    { GATEWAY_OIDC_CLIENT_ID: "dev-client", GATEWAY_OIDC_CLIENT_SECRET: "dev-secret" },
    "http://localhost:8791",
  );
  expect(localConfig).not.toHaveProperty("redirectUri");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/google-login.test.ts -t "loopback relaxation"`
Expected: FAIL —— `expected { ..., redirectUri: 'http://localhost:8791/admin/auth/callback' } not to have property "redirectUri"`

- [ ] **Step 3: 从 `PortalGoogleConfig` 移除 `redirectUri`**

在 `packages/cloudflare-portal/src/google-config.ts`：

```ts
export interface PortalGoogleConfig {
  readonly issuer: "https://accounts.google.com";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly origin: string;
}
```

并把 `portalGoogleConfigFromGateway` 的 return 改成：

```ts
  return { issuer: GOOGLE_ISSUER, clientId, clientSecret, origin: portalOrigin };
```

- [ ] **Step 4: 让 `createGoogleLogin` 自算 redirect URI 并解绑 cookie 名**

在 `packages/cloudflare-portal/src/google-login.ts` 的 `createGoogleLogin` 开头，把原来的 `localWebUi` 与那条长 `if` 换成：

```ts
  // redirect_uri 由 surface 的 callbackPath 决定，不再由 config 携带：
  // 一个 Google client 同时服务 admin 与 tenant 两个回调地址。
  const redirectUri = `${config.origin}${surface.callbackPath}`;
  // loopback 放行只与 origin 有关，与哪个 surface 在登录无关。
  const localWebUi = isLocalDevOrigin(config.origin);
  if (config.issuer !== GOOGLE_ISSUER || new URL(config.origin).origin !== config.origin
    || (!config.origin.startsWith("https://") && !localWebUi)
    || !config.clientId.trim() || !config.clientSecret.trim()) throw new TypeError("Invalid Portal Google configuration");
```

然后把函数体内所有 `config.redirectUri` 替换为 `redirectUri`（`begin` 里 authorization URL 的 `redirect_uri` 参数、`complete` 里 `authorizationCodeGrantRequest` 的第五个实参）。

Run: `grep -n "config.redirectUri" packages/cloudflare-portal/src/google-login.ts`
Expected: 无输出

- [ ] **Step 5: 修既有测试对 `redirectUri` 的引用**

`packages/cloudflare-portal/tests/google-login.test.ts` 的 `setup()` 里加一个本地常量：

```ts
  const redirectUri = `${origin}/admin/auth/callback`;
```

把 `expect(body.get("redirect_uri")).toBe(loginConfig.redirectUri)` 和 `callback` 里的 `${loginConfig.redirectUri}` 都换成 `redirectUri`。再检查 `packages/cloudflare-portal/tests/google-config.test.ts` 里对 `redirectUri` 的断言，删掉或改为断言该字段不存在。

- [ ] **Step 6: 跑全包测试确认 admin 未回归**

Run: `pnpm --filter @unidocs/cloudflare-portal test`
Expected: 全部 PASS。admin 登录行为必须一字不差地保留。

- [ ] **Step 7: 提交**

```bash
git add packages/cloudflare-portal/src/google-config.ts packages/cloudflare-portal/src/google-login.ts packages/cloudflare-portal/tests/google-config.test.ts packages/cloudflare-portal/tests/google-login.test.ts
git commit -m "refactor(portal): let a login surface decide its own redirect URI"
```

---

### Task 2: 租户成员身份业务核

**Files:**
- Create: `packages/portal-service/src/auth/tenant-member.ts`
- Modify: `packages/portal-service/src/index.ts`
- Test: `packages/portal-service/tests/tenant-member.test.ts`

**Interfaces:**
- Consumes: `AdminIdentity`（`./administrator.js`）；`TenantAccessError`、`TenantContext`（`../tenant/access.js`）
- Produces:
  - `type GoogleLoginIdentity = AdminIdentity`
  - `interface TenantMember { memberId: string; tenantId: string; principalId: string; email: string; issuer: string | null; subject: string | null; active: boolean }`
  - `function requireBoundTenantMember(identity: GoogleLoginIdentity, member: TenantMember | null): TenantMember`
  - `function tenantContextFromSession(member: TenantMember, sessionHash: string): TenantContext`

- [ ] **Step 1: 写失败测试**

创建 `packages/portal-service/tests/tenant-member.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import { requireBoundTenantMember, tenantContextFromSession, TenantAccessError, type GoogleLoginIdentity, type TenantMember } from "../src/index.js";

const identity: GoogleLoginIdentity = {
  issuer: "https://accounts.google.com",
  subject: "google-subject",
  email: "user@example.com",
  authenticatedAt: 1_000,
};

const member: TenantMember = {
  memberId: "m1", tenantId: "t1", principalId: "p1", email: "user@example.com",
  issuer: "https://accounts.google.com", subject: "google-subject", active: true,
};

describe("tenant member binding", () => {
  test("accepts a bound active member", () => {
    expect(requireBoundTenantMember(identity, member)).toBe(member);
  });

  test("rejects someone who is not on the list", () => {
    expect(() => requireBoundTenantMember(identity, null)).toThrow(TenantAccessError);
  });

  test("rejects a deactivated member", () => {
    expect(() => requireBoundTenantMember(identity, { ...member, active: false })).toThrow(TenantAccessError);
  });

  test("rejects a member bound to a different Google subject", () => {
    expect(() => requireBoundTenantMember(identity, { ...member, subject: "other-subject" })).toThrow(TenantAccessError);
  });

  test("accepts an invited member that has never logged in", () => {
    const invited = { ...member, issuer: null, subject: null };
    expect(requireBoundTenantMember(identity, invited)).toBe(invited);
  });

  test("rejects an invited member whose email does not match the identity", () => {
    const invited = { ...member, issuer: null, subject: null, email: "someone@example.com" };
    expect(() => requireBoundTenantMember(identity, invited)).toThrow(TenantAccessError);
  });

  test("projects a session into a tenant context", () => {
    expect(tenantContextFromSession(member, "session-hash")).toEqual({
      tenantId: "t1", principalId: "p1", transport: "session", sessionHash: "session-hash",
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-member.test.ts`
Expected: FAIL —— `requireBoundTenantMember` 未从 `../src/index.js` 导出

- [ ] **Step 3: 实现**

创建 `packages/portal-service/src/auth/tenant-member.ts`：

```ts
import type { AdminIdentity } from "./administrator.js";
import { TenantAccessError, type TenantContext } from "../tenant/access.js";

/**
 * 一次 Google 授权码登录得到的身份。形状与管理员登录完全一致 —— 同一个
 * Google client、同一套 claim 校验 —— 只是这里的主体是租户用户。类型沿用
 * AdminIdentity，以免出现两套会各自漂移的校验规则。
 */
export type GoogleLoginIdentity = AdminIdentity;

/**
 * 名单上的一行。issuer/subject 为 null 表示「已邀请、尚未首次登录」，
 * 首次登录时由仓储在同一个事务里绑定（见 D1TenantAuthRepository.completeLogin）。
 */
export interface TenantMember {
  readonly memberId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly email: string;
  readonly issuer: string | null;
  readonly subject: string | null;
  readonly active: boolean;
}

export function requireBoundTenantMember(identity: GoogleLoginIdentity, member: TenantMember | null): TenantMember {
  if (!member?.active) throw new TenantAccessError("forbidden");
  if (member.issuer === null || member.subject === null) {
    // 尚未绑定：只认邮箱，绑定这一步由仓储完成。
    if (member.email !== identity.email) throw new TenantAccessError("forbidden");
    return member;
  }
  if (member.issuer !== identity.issuer || member.subject !== identity.subject) throw new TenantAccessError("forbidden");
  return member;
}

export function tenantContextFromSession(member: TenantMember, sessionHash: string): TenantContext {
  return { tenantId: member.tenantId, principalId: member.principalId, transport: "session", sessionHash };
}
```

- [ ] **Step 4: 导出**

在 `packages/portal-service/src/index.ts` 里 `export { ... } from "./tenant/access.js";` 那一行之后加：

```ts
export { requireBoundTenantMember, tenantContextFromSession } from "./auth/tenant-member.js";
export type { GoogleLoginIdentity, TenantMember } from "./auth/tenant-member.js";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-member.test.ts`
Expected: 7 passed

- [ ] **Step 6: 提交**

```bash
git add packages/portal-service/src/auth/tenant-member.ts packages/portal-service/src/index.ts packages/portal-service/tests/tenant-member.test.ts
git commit -m "feat(portal-service): decide whether a Google identity is a tenant member"
```

---

### Task 3: 租户认证的 D1 表

**Files:**
- Create: `packages/cloudflare-portal/migrations/0012_tenant_auth.sql`
- Test: `tests/unit/scripts/sql-statements.test.mjs`（已存在，确认新迁移被覆盖）

**Interfaces:**
- Consumes: Task 2 的 `TenantMember` 字段名
- Produces: 表 `portal_tenant_members`、`portal_tenant_login_transactions`、`portal_tenant_sessions`、`portal_tenant_auth_audit`

- [ ] **Step 1: 读现有迁移测试，确认它怎么发现迁移文件**

Run: `cat tests/unit/scripts/sql-statements.test.mjs`
如果它按目录枚举，新迁移会自动纳入；如果是硬编码列表，把 `0012_tenant_auth.sql` 加进去。

- [ ] **Step 2: 写迁移**

创建 `packages/cloudflare-portal/migrations/0012_tenant_auth.sql`：

```sql
CREATE TABLE portal_tenant_members (
  member_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  email TEXT NOT NULL,
  issuer TEXT,
  subject TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((issuer IS NULL) = (subject IS NULL))
);
CREATE UNIQUE INDEX portal_tenant_member_active_email ON portal_tenant_members(tenant_id, email) WHERE active = 1;
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
CREATE TABLE portal_tenant_sessions (
  session_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES portal_tenant_members(member_id),
  csrf_hash TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 28800)
);
CREATE INDEX portal_tenant_session_member ON portal_tenant_sessions(member_id);
CREATE INDEX portal_tenant_session_expiry ON portal_tenant_sessions(expires_at);
CREATE TABLE portal_tenant_auth_audit (
  event_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES portal_tenant_members(member_id),
  action TEXT NOT NULL CHECK (action IN ('session.created', 'session.revoked', 'member.bound')),
  occurred_at INTEGER NOT NULL,
  request_id TEXT NOT NULL
);
```

与 admin 有意的两处差异：租户没有 session family（admin 的 family 是为 MCP 授权链路服务的，租户面没有那条链路），撤销直接删 session 行；`portal_tenant_member_active_email` 带上 `tenant_id`，为将来同一邮箱在不同租户各有一行留出空间。

- [ ] **Step 3: 本地应用迁移验证语法**

Run: `pnpm --filter @unidocs/cloudflare-portal exec wrangler d1 migrations apply unidocs-portal-local --local`
Expected: `0012_tenant_auth.sql` 报告 applied，无 SQL 错误

- [ ] **Step 4: 跑迁移相关单测**

Run: `npx vitest run tests/unit/scripts/sql-statements.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/migrations/0012_tenant_auth.sql
git commit -m "feat(portal): add tenant member and session tables"
```

---

### Task 4: 租户会话与认证器

**Files:**
- Create: `packages/cloudflare-portal/src/tenant-auth.ts`
- Test: `packages/cloudflare-portal/tests/tenant-auth.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `requireBoundTenantMember` / `tenantContextFromSession` / `TenantMember` / `GoogleLoginIdentity`
- Produces:
  - 常量 `TENANT_COOKIE = "__Host-unidocs_tenant"`、`TENANT_CSRF_COOKIE = "__Host-unidocs_tenant_csrf"`、`TENANT_SESSION_TTL_SECONDS = 8 * 60 * 60`
  - `interface TenantSession { sessionHash: string; csrfHash: string; memberId: string; identity: GoogleLoginIdentity; createdAt: number; expiresAt: number }`
  - `hashTenantSecret(secret: string): Promise<string>`
  - `createTenantSession(member, identity, now)` 返回 `{ token, csrfToken, session, cookie }`
  - `clearedTenantCookie(): string`、`tenantTokenFromCookie(cookie: string | null): string`
  - `createTenantAuthenticator(config: { origin: string }, deps: TenantAuthDependencies)` 返回 `(request: Request) => Promise<TenantContext>`

- [ ] **Step 1: 写失败测试**

创建 `packages/cloudflare-portal/tests/tenant-auth.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import { TenantAccessError, type TenantMember } from "@unidocs/portal-service";
import { createTenantAuthenticator, createTenantSession, hashTenantSecret, TENANT_COOKIE, type TenantSession } from "../src/tenant-auth.js";

const origin = "https://portal.example";
const now = 1_700_000_000;
const identity = { issuer: "https://accounts.google.com", subject: "s1", email: "user@example.com", authenticatedAt: now, loginConfirmedAt: now, loginConfirmation: "authorization-code-v1" as const };
const member: TenantMember = { memberId: "m1", tenantId: "t1", principalId: "p1", email: "user@example.com", issuer: "https://accounts.google.com", subject: "s1", active: true };

function authenticatorFor(session: TenantSession | null) {
  return createTenantAuthenticator({ origin }, {
    now: () => now,
    findSession: async hash => (session && session.sessionHash === hash ? session : null),
    findMemberById: async id => (id === member.memberId ? member : null),
  });
}

async function issued() {
  return createTenantSession(member, identity, now);
}

describe("tenant session authentication", () => {
  test("accepts a valid session cookie on a GET", async () => {
    const { token, session } = await issued();
    const context = await authenticatorFor(session)(new Request(`${origin}/api/v1/tenants/t1/document-types`, { headers: { cookie: `${TENANT_COOKIE}=${token}` } }));
    expect(context).toEqual({ tenantId: "t1", principalId: "p1", transport: "session", sessionHash: session.sessionHash });
  });

  test("rejects a request with no cookie", async () => {
    await expect(authenticatorFor(null)(new Request(`${origin}/api/v1/tenants/t1/document-types`))).rejects.toThrow(TenantAccessError);
  });

  test("rejects a malformed token", async () => {
    const { session } = await issued();
    await expect(authenticatorFor(session)(new Request(`${origin}/api/v1/tenants/t1/document-types`, { headers: { cookie: `${TENANT_COOKIE}=not-a-token` } }))).rejects.toThrow(TenantAccessError);
  });

  test("rejects two cookies of the same name", async () => {
    const { token, session } = await issued();
    await expect(authenticatorFor(session)(new Request(`${origin}/api/v1/tenants/t1/document-types`, { headers: { cookie: `${TENANT_COOKIE}=${token}; ${TENANT_COOKIE}=${token}` } }))).rejects.toThrow(TenantAccessError);
  });

  test("rejects an expired session", async () => {
    const { token, session } = await issued();
    const authenticate = createTenantAuthenticator({ origin }, {
      now: () => session.expiresAt,
      findSession: async () => session,
      findMemberById: async () => member,
    });
    await expect(authenticate(new Request(`${origin}/api/v1/tenants/t1/document-types`, { headers: { cookie: `${TENANT_COOKIE}=${token}` } }))).rejects.toThrow(TenantAccessError);
  });

  test("rejects a cross-site request", async () => {
    const { token, session } = await issued();
    await expect(authenticatorFor(session)(new Request(`${origin}/api/v1/tenants/t1/document-types`, { headers: { cookie: `${TENANT_COOKIE}=${token}`, "sec-fetch-site": "cross-site" } }))).rejects.toThrow(TenantAccessError);
  });

  test("requires a matching CSRF token on a POST", async () => {
    const { token, csrfToken, session } = await issued();
    const authenticate = authenticatorFor(session);
    const post = (headers: Record<string, string>) => new Request(`${origin}/portal/auth/logout`, { method: "POST", headers: { cookie: `${TENANT_COOKIE}=${token}`, origin, ...headers } });
    await expect(authenticate(post({}))).rejects.toThrow(TenantAccessError);
    await expect(authenticate(post({ "x-csrf-token": await hashTenantSecret("wrong") }))).rejects.toThrow(TenantAccessError);
    await expect(authenticate(post({ "x-csrf-token": csrfToken }))).resolves.toMatchObject({ principalId: "p1" });
  });

  test("rejects a member deactivated since the session was issued", async () => {
    const { token, session } = await issued();
    const authenticate = createTenantAuthenticator({ origin }, {
      now: () => now, findSession: async () => session, findMemberById: async () => null,
    });
    await expect(authenticate(new Request(`${origin}/api/v1/tenants/t1/document-types`, { headers: { cookie: `${TENANT_COOKIE}=${token}` } }))).rejects.toThrow(TenantAccessError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-auth.test.ts`
Expected: FAIL —— 找不到模块 `../src/tenant-auth.js`

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant-auth.ts`：

```ts
import { timingSafeEqual } from "node:crypto";
import { requireBoundTenantMember, requireRecentAuthentication, TenantAccessError, tenantContextFromSession, type GoogleLoginIdentity, type TenantContext, type TenantMember } from "@unidocs/portal-service";

export const TENANT_COOKIE = "__Host-unidocs_tenant";
export const TENANT_CSRF_COOKIE = "__Host-unidocs_tenant_csrf";
export const TENANT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface TenantSession {
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly memberId: string;
  readonly identity: GoogleLoginIdentity;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface TenantAuthDependencies {
  readonly now: () => number;
  readonly findSession: (hash: string) => Promise<TenantSession | null>;
  readonly findMemberById: (memberId: string) => Promise<TenantMember | null>;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function hashTenantSecret(secret: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))));
}

export async function createTenantSession(member: TenantMember, identity: GoogleLoginIdentity, now: number) {
  requireBoundTenantMember(identity, member);
  requireRecentAuthentication(identity, now);
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const csrfToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const session: TenantSession = {
    sessionHash: await hashTenantSecret(token),
    csrfHash: await hashTenantSecret(csrfToken),
    memberId: member.memberId,
    identity,
    createdAt: now,
    expiresAt: now + TENANT_SESSION_TTL_SECONDS,
  };
  return { token, csrfToken, session, cookie: `${TENANT_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TENANT_SESSION_TTL_SECONDS}` };
}

export function clearedTenantCookie(): string {
  return `${TENANT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function tenantTokenFromCookie(cookie: string | null): string {
  const tokens = (cookie ?? "").split(";").map(part => part.trim()).filter(part => part.split("=", 1)[0] === TENANT_COOKIE);
  if (tokens.length !== 1) throw new TenantAccessError("unauthorized");
  const token = tokens[0].slice(TENANT_COOKIE.length + 1);
  if (!opaqueTokenPattern.test(token)) throw new TenantAccessError("unauthorized");
  return token;
}

export function createTenantAuthenticator(config: { readonly origin: string }, dependencies: TenantAuthDependencies) {
  return async function authenticate(request: Request): Promise<TenantContext> {
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid auth clock");
    // 本轮只有浏览器会话一种通道。Agent 的 Bearer 通道还没有发证方，
    // 与其留一条走不到的分支，不如等它真的落地时再加。
    if (new URL(request.url).origin !== config.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new TenantAccessError("forbidden");
    const token = tenantTokenFromCookie(request.headers.get("cookie"));
    const hash = await hashTenantSecret(token);
    const session = await dependencies.findSession(hash);
    if (!session || session.sessionHash !== hash || !Number.isSafeInteger(session.createdAt) || !Number.isSafeInteger(session.expiresAt)
      || session.createdAt > now || session.expiresAt <= now || session.expiresAt <= session.createdAt
      || session.expiresAt - session.createdAt > TENANT_SESSION_TTL_SECONDS) throw new TenantAccessError("unauthorized");
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      const csrf = request.headers.get("x-csrf-token");
      if (request.headers.get("origin") !== config.origin || !csrf || !opaqueTokenPattern.test(csrf) || !opaqueTokenPattern.test(session.csrfHash)) throw new TenantAccessError("forbidden");
      const provided = new TextEncoder().encode(await hashTenantSecret(csrf));
      const expected = new TextEncoder().encode(session.csrfHash);
      if (!timingSafeEqual(provided, expected)) throw new TenantAccessError("forbidden");
    }
    const member = requireBoundTenantMember(session.identity, await dependencies.findMemberById(session.memberId));
    if (member.memberId !== session.memberId) throw new TenantAccessError("forbidden");
    return tenantContextFromSession(member, hash);
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-auth.test.ts`
Expected: 8 passed

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/src/tenant-auth.ts packages/cloudflare-portal/tests/tenant-auth.test.ts
git commit -m "feat(portal): authenticate a tenant browser session"
```

---

### Task 5: 租户登录 surface 与 D1 仓储

**Files:**
- Create: `packages/cloudflare-portal/src/tenant-login.ts`
- Create: `packages/cloudflare-portal/src/tenant-auth-repository.ts`
- Modify: `packages/cloudflare-portal/src/google-login.ts`（导出 `createGoogleLogin`）
- Test: `packages/cloudflare-portal/tests/tenant-login.test.ts`

**Interfaces:**
- Consumes: Task 1 的无 `redirectUri` 配置、Task 4 的 `createTenantSession` / `TenantSession`
- Produces:
  - `TENANT_LOGIN_COOKIE = "__Host-unidocs_tenant_login"`
  - `tenantReturnPath(value: string): string`
  - `createTenantGoogleLogin(config: PortalGoogleConfig, ports: PortalLoginPorts)` 返回 `{ begin, complete }`
  - `class D1TenantAuthRepository`，方法 `put` / `take` / `findSession` / `findMemberById` / `completeLogin` / `revokeSession`

- [ ] **Step 1: 写失败测试**

创建 `packages/cloudflare-portal/tests/tenant-login.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import { TenantAccessError } from "@unidocs/portal-service";
import { tenantReturnPath } from "../src/tenant-login.js";

describe("tenant login return target", () => {
  test("keeps an in-app portal path", () => {
    expect(tenantReturnPath("/portal/#/d/doc-1")).toBe("/portal/#/d/doc-1");
  });

  test("keeps the workbench root", () => {
    expect(tenantReturnPath("/portal/")).toBe("/portal/");
  });

  test("refuses the auth paths themselves", () => {
    expect(() => tenantReturnPath("/portal/auth/login")).toThrow(TenantAccessError);
    expect(() => tenantReturnPath("/portal/auth/callback")).toThrow(TenantAccessError);
  });

  test("refuses anything outside /portal/", () => {
    expect(() => tenantReturnPath("/admin/")).toThrow(TenantAccessError);
    expect(() => tenantReturnPath("https://evil.example/portal/")).toThrow(TenantAccessError);
    expect(() => tenantReturnPath("//evil.example/portal/")).toThrow(TenantAccessError);
  });

  test("refuses encoded traversal, whitespace and overlong values", () => {
    expect(() => tenantReturnPath("/portal/%2e%2e/admin/")).toThrow(TenantAccessError);
    expect(() => tenantReturnPath("/portal/ ")).toThrow(TenantAccessError);
    expect(() => tenantReturnPath(`/portal/${"a".repeat(2048)}`)).toThrow(TenantAccessError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-login.test.ts`
Expected: FAIL —— 找不到 `../src/tenant-login.js`

- [ ] **Step 3: 让 `createGoogleLogin` 可被复用**

在 `packages/cloudflare-portal/src/google-login.ts` 里把 `function createGoogleLogin(` 改成 `export function createGoogleLogin(`。`PortalLoginTransaction` / `PortalLoginPorts` 已经是 `export interface`，无需改动。

- [ ] **Step 4: 实现租户 surface**

创建 `packages/cloudflare-portal/src/tenant-login.ts`：

```ts
import { TenantAccessError } from "@unidocs/portal-service";
import { createGoogleLogin, type PortalLoginPorts } from "./google-login.js";
import type { PortalGoogleConfig } from "./google-config.js";

export const TENANT_LOGIN_COOKIE = "__Host-unidocs_tenant_login";

// 控制字符、空白与反斜杠一律拒绝，和 admin 侧 portalReturnPath 用的是同一条规则。
const UNSAFE = /[\\ - ]/;

/**
 * 登录后能回到的地方只有租户 WebUI 自己。auth 路径本身被排除，否则一次登录
 * 可以把浏览器送回登录起点，绕成一个无限跳转。
 */
export function tenantReturnPath(value: string): string {
  if (value.length > 2048 || !value.startsWith("/portal/") || UNSAFE.test(value)) throw new TenantAccessError("unauthorized");
  const url = new URL(value, "https://portal.invalid");
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new TenantAccessError("unauthorized"); }
  if (url.origin !== "https://portal.invalid" || !pathname.startsWith("/portal/") || pathname.startsWith("/portal/auth/")
    || /[%]/.test(pathname) || UNSAFE.test(pathname)
    || pathname.split("/").some(segment => segment === "." || segment === "..")) throw new TenantAccessError("unauthorized");
  return url.pathname + url.search + url.hash;
}

export function createTenantGoogleLogin(config: PortalGoogleConfig, ports: PortalLoginPorts) {
  return createGoogleLogin(config, ports, {
    beginPath: "/portal/auth/login", callbackPath: "/portal/auth/callback", cookieName: TENANT_LOGIN_COOKIE,
    returnParameter: "returnTo", defaultReturn: "/portal/", validateReturn: tenantReturnPath,
  });
}
```

`createGoogleLogin` 内部抛 `AdminAccessError`，`validateReturn` 抛 `TenantAccessError`；`complete` 的 catch 把两者都包成 `GoogleLoginError`，对调用方一致。`begin` 里 `validateReturn` 的抛出会直接冒出来，由 Task 6 的 BFF 统一处理。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-login.test.ts`
Expected: 5 passed

- [ ] **Step 6: 实现 D1 仓储**

创建 `packages/cloudflare-portal/src/tenant-auth-repository.ts`：

```ts
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { adminConfirmationTime, TenantAccessError, validateAdminIdentity, type GoogleLoginIdentity, type TenantMember } from "@unidocs/portal-service";
import { createTenantSession, type TenantSession } from "./tenant-auth.js";
import type { PortalLoginTransaction } from "./google-login.js";

interface TenantMemberRow {
  member_id: string;
  tenant_id: string;
  principal_id: string;
  email: string;
  issuer: string | null;
  subject: string | null;
  active: number;
  revision: number;
  created_at: number;
}

function memberFromRow(row: TenantMemberRow | null): TenantMember | null {
  if (!row || row.active !== 1) return null;
  return { memberId: row.member_id, tenantId: row.tenant_id, principalId: row.principal_id, email: row.email, issuer: row.issuer, subject: row.subject, active: true };
}

export class D1TenantAuthRepository {
  constructor(private readonly database: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async put(transaction: PortalLoginTransaction): Promise<void> {
    await this.database.prepare(`INSERT INTO portal_tenant_login_transactions
      (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(transaction.stateHash, transaction.browserHash, transaction.verifier, transaction.nonce, transaction.returnTo, transaction.createdAt, transaction.expiresAt).run();
  }

  async take(stateHash: string, browserHash: string, now: number): Promise<PortalLoginTransaction | null> {
    return this.database.prepare(`DELETE FROM portal_tenant_login_transactions WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
      RETURNING state_hash AS stateHash, browser_hash AS browserHash, verifier, nonce, return_to AS returnTo, created_at AS createdAt, expires_at AS expiresAt`)
      .bind(stateHash, browserHash, now).first<PortalLoginTransaction>();
  }

  async findMemberById(memberId: string): Promise<TenantMember | null> {
    return memberFromRow(await this.database.prepare("SELECT * FROM portal_tenant_members WHERE member_id = ? AND active = 1").bind(memberId).first<TenantMemberRow>());
  }

  async findSession(sessionHash: string): Promise<TenantSession | null> {
    const row = await this.database.prepare(`SELECT session.session_hash, session.csrf_hash, session.identity_json, session.created_at, session.expires_at, session.member_id
      FROM portal_tenant_sessions AS session JOIN portal_tenant_members AS member ON session.member_id = member.member_id
      WHERE session.session_hash = ? AND member.active = 1 AND session.expires_at > ?`)
      .bind(sessionHash, this.now()).first<{ session_hash: string; csrf_hash: string; identity_json: string; created_at: number; expires_at: number; member_id: string }>();
    if (!row) return null;
    const identity = validateAdminIdentity(JSON.parse(row.identity_json), this.now());
    return { sessionHash: row.session_hash, csrfHash: row.csrf_hash, identity, memberId: row.member_id, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  /**
   * 首次登录时把名单行绑定到这个 Google 身份，并签发会话。绑定与签发在同一个
   * batch 里完成：绑定失败（并发、名单行已被改）不会留下一个指向未绑定成员的会话。
   */
  async completeLogin(identity: GoogleLoginIdentity, requestId: string) {
    const now = this.now();
    const verified = validateAdminIdentity(identity, now);
    const confirmationTime = adminConfirmationTime(verified);
    if (confirmationTime === null) throw new TenantAccessError("forbidden");
    const bound = await this.database.prepare("SELECT * FROM portal_tenant_members WHERE issuer = ? AND subject = ? AND active = 1").bind(verified.issuer, verified.subject).first<TenantMemberRow>();
    const invited = bound ? null : await this.database.prepare("SELECT * FROM portal_tenant_members WHERE email = ? AND active = 1 AND subject IS NULL").bind(verified.email).first<TenantMemberRow>();
    const row = bound ?? invited;
    // 不在名单上就是 403。租户面没有 bootstrap 自助开户那条路径。
    if (!row) throw new TenantAccessError("forbidden");
    if (invited && confirmationTime < invited.created_at) throw new TenantAccessError("forbidden");
    const member = memberFromRow(row)!;
    const issued = await createTenantSession({ ...member, issuer: verified.issuer, subject: verified.subject }, verified, now);
    const statements: D1PreparedStatement[] = [];
    if (invited) {
      statements.push(
        this.database.prepare(`UPDATE portal_tenant_members SET issuer = ?, subject = ?, revision = revision + 1, updated_at = ?
          WHERE member_id = ? AND email = ? AND active = 1 AND subject IS NULL AND revision = ? AND created_at <= ?`)
          .bind(verified.issuer, verified.subject, now, member.memberId, verified.email, invited.revision, confirmationTime),
        this.database.prepare("INSERT INTO portal_tenant_auth_audit VALUES (?, ?, 'member.bound', ?, ?)").bind(crypto.randomUUID(), member.memberId, now, requestId),
      );
    }
    statements.push(
      this.database.prepare("DELETE FROM portal_tenant_sessions WHERE member_id = ?").bind(member.memberId),
      this.database.prepare("INSERT INTO portal_tenant_sessions VALUES (?, ?, ?, ?, ?, ?)")
        .bind(issued.session.sessionHash, member.memberId, issued.session.csrfHash, JSON.stringify(verified), now, issued.session.expiresAt),
      this.database.prepare("INSERT INTO portal_tenant_auth_audit VALUES (?, ?, 'session.created', ?, ?)").bind(crypto.randomUUID(), member.memberId, now, requestId),
    );
    await this.database.batch(statements);
    return { ...issued, member };
  }

  /**
   * 只按 session_hash 撤销：它是主键，且调用方已经通过认证器证明了这个
   * session 属于当前调用者。审计行的 member_id 从 session 行本身取，所以
   * 调用方不需要（也拿不到）memberId —— TenantContext 里只有 principalId。
   */
  async revokeSession(sessionHash: string, requestId: string): Promise<void> {
    await this.database.batch([
      this.database.prepare(`INSERT INTO portal_tenant_auth_audit
        SELECT ?, member_id, 'session.revoked', ?, ? FROM portal_tenant_sessions WHERE session_hash = ?`)
        .bind(crypto.randomUUID(), this.now(), requestId, sessionHash),
      this.database.prepare("DELETE FROM portal_tenant_sessions WHERE session_hash = ?").bind(sessionHash),
    ]);
  }
}
```

- [ ] **Step 7: 跑全包测试**

Run: `pnpm --filter @unidocs/cloudflare-portal test`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add packages/cloudflare-portal/src/tenant-login.ts packages/cloudflare-portal/src/tenant-auth-repository.ts packages/cloudflare-portal/src/google-login.ts packages/cloudflare-portal/tests/tenant-login.test.ts
git commit -m "feat(portal): give the tenant plane its own Google login surface"
```

---

### Task 6: 租户 BFF —— 登录往返与会话端点

**Files:**
- Create: `packages/cloudflare-portal/src/tenant-bff.ts`
- Test: `packages/cloudflare-portal/tests/tenant-bff.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `createTenantAuthenticator` / `clearedTenantCookie` / `tenantTokenFromCookie` / `hashTenantSecret` / `TENANT_CSRF_COOKIE` / `TENANT_SESSION_TTL_SECONDS`；Task 5 的 `createTenantGoogleLogin` / `D1TenantAuthRepository` / `TENANT_LOGIN_COOKIE`
- Produces: `createTenantBff(config, repository, options)` 返回 `(request: Request) => Promise<Response | null>`。返回 `null` 表示「这个路径不归租户 auth 面管」，由 worker 继续往下分发。

- [ ] **Step 1: 写失败测试**

创建 `packages/cloudflare-portal/tests/tenant-bff.test.ts`：

```ts
import { describe, expect, test, vi } from "vitest";
import { portalGoogleConfigFromGateway } from "../src/google-config.js";
import { createTenantBff } from "../src/tenant-bff.js";

const origin = "https://portal.example";
const config = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: "client", GATEWAY_OIDC_CLIENT_SECRET: "secret" }, origin);

function repositoryStub() {
  return {
    put: vi.fn(async () => {}),
    take: vi.fn(async () => null),
    findSession: vi.fn(async () => null),
    findMemberById: vi.fn(async () => null),
    completeLogin: vi.fn(),
    revokeSession: vi.fn(async () => {}),
  };
}

describe("tenant BFF routing", () => {
  test("hands non-tenant paths back to the worker", async () => {
    const handle = createTenantBff(config, repositoryStub() as never, {});
    expect(await handle(new Request(`${origin}/admin/`))).toBeNull();
  });

  test("answers an anonymous session probe with 401", async () => {
    const handle = createTenantBff(config, repositoryStub() as never, {});
    const response = await handle(new Request(`${origin}/portal/auth/session`));
    expect(response!.status).toBe(401);
    expect(response!.headers.get("Cache-Control")).toBe("no-store");
    expect(response!.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("begins login with a redirect carrying the tenant callback", async () => {
    const handle = createTenantBff(config, repositoryStub() as never, {
      googleFetch: (async (input: RequestInfo | URL) => {
        expect(String(input)).toContain("openid-configuration");
        return Response.json({
          issuer: config.issuer, authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
          code_challenge_methods_supported: ["S256"], response_types_supported: ["code"],
        });
      }) as typeof fetch,
    });
    const response = await handle(new Request(`${origin}/portal/auth/login`));
    expect(response!.status).toBe(303);
    expect(new URL(response!.headers.get("location")!).searchParams.get("redirect_uri")).toBe(`${origin}/portal/auth/callback`);
    expect(response!.headers.get("set-cookie")).toContain("__Host-unidocs_tenant_login=");
  });

  test("rejects the wrong method with an Allow header", async () => {
    const handle = createTenantBff(config, repositoryStub() as never, {});
    const response = await handle(new Request(`${origin}/portal/auth/logout`, { method: "GET" }));
    expect(response!.status).toBe(405);
    expect(response!.headers.get("Allow")).toBe("POST");
  });

  test("authenticates a tenant API path before dispatching it", async () => {
    const handle = createTenantBff(config, repositoryStub() as never, {});
    const response = await handle(new Request(`${origin}/api/v1/tenants/t1/document-types`));
    expect(response!.status).toBe(401);
  });
});
```

最后一条期望 401 而不是 404：没有会话的请求先被认证器拦下，`tenantApi` 根本不会被调用——认证先于分发，这正是要锁住的行为。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-bff.test.ts`
Expected: FAIL —— 找不到 `../src/tenant-bff.js`

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant-bff.ts`：

```ts
import { TenantAccessError, TenantOperationError, type TenantContext } from "@unidocs/portal-service";
import { clearedTenantCookie, createTenantAuthenticator, hashTenantSecret, TENANT_CSRF_COOKIE, TENANT_SESSION_TTL_SECONDS, tenantTokenFromCookie } from "./tenant-auth.js";
import type { D1TenantAuthRepository } from "./tenant-auth-repository.js";
import { createTenantGoogleLogin, TENANT_LOGIN_COOKIE } from "./tenant-login.js";
import { GoogleLoginError } from "./google-login.js";
import type { PortalGoogleConfig } from "./google-config.js";

const AUTH_METHODS: Readonly<Record<string, string>> = {
  "/portal/auth/login": "GET",
  "/portal/auth/callback": "GET",
  "/portal/auth/session": "GET",
  "/portal/auth/logout": "POST",
};

export function createTenantBff(config: PortalGoogleConfig, repository: D1TenantAuthRepository, options: {
  readonly now?: () => number;
  readonly googleFetch?: typeof fetch;
  /** 已接通的租户 API；未提供时这些路径在通过认证后 404。 */
  readonly tenantApi?: (request: Request, context: TenantContext, requestId: string) => Promise<Response>;
}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const login = createTenantGoogleLogin(config, {
    now, put: transaction => repository.put(transaction), take: (state, browser, time) => repository.take(state, browser, time), fetch: options.googleFetch,
  });
  const authenticate = createTenantAuthenticator({ origin: config.origin }, {
    now, findSession: hash => repository.findSession(hash), findMemberById: memberId => repository.findMemberById(memberId),
  });
  function csrfCookie(token: string, maxAge: number) {
    return `${TENANT_CSRF_COOKIE}=${token}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}`;
  }

  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/v1/tenants/");
    const method = AUTH_METHODS[url.pathname];
    if (!method && !isApi) return null;

    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      if (url.origin !== config.origin) throw new TenantAccessError("forbidden");
      if (isApi) {
        const context = await authenticate(request);
        response = options.tenantApi ? await options.tenantApi(request, context, requestId) : new Response(null, { status: 404 });
      } else if (request.method !== method) {
        // 走到这里必然 isApi 为 false，因此 method 已确定存在（见上面的 return null）。
        response = new Response(null, { status: 405, headers: { Allow: method! } });
      } else if (url.pathname === "/portal/auth/login") {
        response = await login.begin(request);
      } else if (url.pathname === "/portal/auth/callback") {
        const completed = await login.complete(request);
        const issued = await repository.completeLogin(completed.identity, requestId);
        const headers = new Headers({ Location: new URL(completed.returnTo, config.origin).href });
        headers.append("Set-Cookie", completed.clearLoginCookie);
        headers.append("Set-Cookie", issued.cookie);
        headers.append("Set-Cookie", csrfCookie(issued.csrfToken, TENANT_SESSION_TTL_SECONDS));
        response = new Response(null, { status: 303, headers });
      } else if (url.pathname === "/portal/auth/session") {
        const context = await authenticate(request);
        response = Response.json({ tenantId: context.tenantId, principalId: context.principalId, transport: context.transport });
      } else {
        // 认证成功即证明这个 session 属于调用者；撤销只需要 session hash。
        await authenticate(request);
        const hash = await hashTenantSecret(tenantTokenFromCookie(request.headers.get("cookie")));
        await repository.revokeSession(hash, requestId);
        const headers = new Headers();
        headers.append("Set-Cookie", clearedTenantCookie());
        headers.append("Set-Cookie", csrfCookie("", 0));
        response = new Response(null, { status: 204, headers });
      }
    } catch (error) {
      const known = error instanceof TenantAccessError || error instanceof TenantOperationError;
      const code = known ? error.code : "internal_error";
      const details = error instanceof GoogleLoginError ? { stage: error.stage, reason: error.reason } : undefined;
      // 与 admin 一侧同样的纪律：只记 name 与 message，绝不记 stack 或 error
      // 对象本身 —— 登录往返深处抛出的异常不能把 client secret 或 token 带进日志。
      if (details) console.warn(JSON.stringify({ event: "tenant_google_login_failed", requestId, ...details }));
      else if (!known) console.error(JSON.stringify({ event: "tenant_operation_failed", requestId, path: url.pathname, name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) }));
      const status = code === "unauthorized" ? 401 : code === "forbidden" ? 403 : code === "not_found" ? 404 : code === "internal_error" ? 500 : 400;
      response = Response.json({ error: { code, message: known ? error.message : "Tenant operation failed", requestId, ...(details ? { details } : {}) } }, { status });
      // 登录回调失败时把浏览器送到拒绝页，而不是丢给用户一段 JSON。
      if (url.pathname === "/portal/auth/callback" && request.method === "GET") {
        const target = new URL("/portal/access-denied", config.origin);
        target.searchParams.set("code", code);
        target.searchParams.set("requestId", requestId);
        response = new Response(null, { status: 303, headers: { Location: target.href } });
        response.headers.append("Set-Cookie", `${TENANT_LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
      }
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Request-ID", requestId);
    return response;
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-bff.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/src/tenant-bff.ts packages/cloudflare-portal/tests/tenant-bff.test.ts
git commit -m "feat(portal): route the tenant login round trip"
```

---

### Task 7: 认证门与两个路径路由

`serveTenantWebUi` 当前的注释明确写着「**No SPA fallback list.** The tenant UI is hash-routed... inventing path routes here would serve the shell on URLs the app itself never produces」以及「**No authentication gate.** The tenant plane has no login yet」。这两条本任务都要推翻——登录必须落在路径上，因为 Google 回跳和 303 都落不到 hash 上。**注释要一并改写**，否则会误导下一个人。

**Files:**
- Modify: `packages/cloudflare-portal/src/static-assets.ts`
- Test: `packages/cloudflare-portal/tests/static-assets.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `isTenantWebUiPath(pathname)` 额外接受 `/portal/login`、`/portal/access-denied`
  - `isGatedTenantWebUiPath(pathname): boolean` —— 需要有效会话才能拿到 shell 的路径
  - `serveTenantWebUi(request)` 行为不变（只发资源），门由 worker 在它之前判定

- [ ] **Step 1: 写失败测试**

追加到 `packages/cloudflare-portal/tests/static-assets.test.ts`（import 行按该文件已有写法合并）：

```ts
describe("tenant WebUI path routes", () => {
  test("serves the shell on the two login-related path routes", () => {
    for (const path of ["/portal/login", "/portal/access-denied"]) {
      const response = serveTenantWebUi(new Request(`https://portal.example${path}`));
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    }
  });

  test("gates the workbench but not the login pages or assets", () => {
    expect(isGatedTenantWebUiPath("/portal/")).toBe(true);
    expect(isGatedTenantWebUiPath("/portal")).toBe(true);
    expect(isGatedTenantWebUiPath("/portal/index.html")).toBe(true);
    expect(isGatedTenantWebUiPath("/portal/login")).toBe(false);
    expect(isGatedTenantWebUiPath("/portal/access-denied")).toBe(false);
    expect(isGatedTenantWebUiPath("/portal/assets/index.css")).toBe(false);
  });

  test("still refuses invented path routes", () => {
    expect(isTenantWebUiPath("/portal/documents")).toBe(false);
    expect(serveTenantWebUi(new Request("https://portal.example/portal/documents"))).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/static-assets.test.ts`
Expected: FAIL —— `isGatedTenantWebUiPath` 未导出

- [ ] **Step 3: 实现**

在 `packages/cloudflare-portal/src/static-assets.ts` 里，把 `isTenantWebUiPath` 及其上方注释与 `serveTenantWebUi` 一并替换为：

```ts
const TENANT_SHELL_PATHS = new Set(["/portal", "/portal/", "/portal/index.html", "/portal/login", "/portal/access-denied"]);

export function isTenantWebUiPath(pathname: string): boolean {
  return TENANT_SHELL_PATHS.has(pathname) || pathname.startsWith("/portal/assets/");
}

/** 需要有效租户会话才能拿到 shell 的路径。登录页与静态资源必须不设门。 */
export function isGatedTenantWebUiPath(pathname: string): boolean {
  return pathname === "/portal" || pathname === "/portal/" || pathname === "/portal/index.html";
}

/**
 * 租户 WebUI，和 admin 一样嵌在 portal 自己的 origin 上。
 *
 * 与 `serveAdminWebUi` 的两点差异：
 *
 * - **只有两个路径路由。** 租户 UI 是 hash 路由的（见其 `src/router.ts`），
 *   应用内每个位置都是 `#/d/...`。唯二的例外是 `/portal/login` 与
 *   `/portal/access-denied`：Google 回跳和 303 重定向只能落在路径上，落不到
 *   hash 上。除这两个之外不做通配 fallback —— 那会把 shell 发到应用自己
 *   从不产生的 URL 上。
 * - **认证门在调用方。** `/portal/` 需要有效会话（见 `isGatedTenantWebUiPath`），
 *   但判定要读 D1，所以由 `worker.ts` 在调用本函数之前完成，无会话时 303 到
 *   `/portal/login`。本函数只负责发资源和设安全响应头。
 */
export function serveTenantWebUi(request: Request): Response | null {
  const url = new URL(request.url);
  if (!isTenantWebUiPath(url.pathname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const path = url.pathname.startsWith("/portal/assets/") ? url.pathname : "/portal/index.html";
  const response = assetResponse(TENANT_UI_ASSETS, path, request, "Tenant WebUI asset not found");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  return response;
}
```

**保留原注释里关于 CSP 两处放宽的那段说明**（`'unsafe-inline'` 样式是因为 thread marker 写 `element.style`；两个 Google Fonts origin 是因为 `src/mock-base.css` 的 `@import`），原样搬到 `response.headers.set("Content-Security-Policy", ...)` 之前。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/static-assets.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/src/static-assets.ts packages/cloudflare-portal/tests/static-assets.test.ts
git commit -m "feat(portal): add the two path routes tenant login needs"
```

---

### Task 8: 目录仓储与投影

把 `portal_document_types` 加上最新的 type-card / view bundle 与 contract 索引，投影成契约要求的 `PublicDocumentType`。

**Files:**
- Create: `packages/cloudflare-portal/src/tenant-catalog-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant-catalog-repository.test.ts`

**Interfaces:**
- Consumes: `TenantCatalogRepository`、`TenantContext`（`@unidocs/portal-service`）；`PublicDocumentTypeSchema`、`PublicDocumentType`、`DocumentContractRecord`、`ListPublicDocumentTypesResponse`、`PaginationQuery`（`@unidocs/protocol-tenant-portal`）；`TypeCardBundleManifestV1Schema`、`ViewBundleManifestV1Schema`（`@unidocs/protocol-admin-portal`）
- Produces:
  - `interface CatalogProjectionInput { documentType: string; lastContractIdx: number; typeCardBundleId: string; typeCardBundleUrl: string; typeCardManifest: unknown; viewBundleId: string; viewManifest: unknown }`
  - `projectPublicDocumentType(input: CatalogProjectionInput): PublicDocumentType | null`
  - `class D1TenantCatalogRepository implements TenantCatalogRepository`

- [ ] **Step 1: 写失败测试**

创建 `packages/cloudflare-portal/tests/tenant-catalog-repository.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import { PublicDocumentTypeSchema } from "@unidocs/protocol-tenant-portal";
import { projectPublicDocumentType } from "../src/tenant-catalog-repository.js";

const typeCardManifest = {
  protocol: "unidocs-type-card/v1",
  documentType: "text/markdown",
  locales: { en: { name: "Markdown", description: "Plain text", sampleThumbnailAlt: "A markdown sample" } },
  icon: { kind: "svg", path: "icon.svg" },
  sampleThumbnail: "sample.png",
};

const viewManifest = {
  protocol: "unidocs-view-bundle/v1",
  documentType: "text/markdown",
  entrypoints: { interactive: "index.html", thumbnail: "thumb.html" },
  supportedDocumentContractIdxs: [0, 1, 7],
};

const input = {
  documentType: "text/markdown",
  lastContractIdx: 2,
  typeCardBundleId: "tb_1",
  typeCardBundleUrl: "https://bundles.example/type-card-bundles/tb_1/",
  typeCardManifest,
  viewBundleId: "vb_1",
  viewManifest,
};

describe("public document type projection", () => {
  test("resolves every asset path against the bundle root", () => {
    const projected = projectPublicDocumentType(input)!;
    expect(PublicDocumentTypeSchema.parse(projected)).toBeTruthy();
    expect(projected.typeCard.icon).toEqual({ kind: "svg", url: "https://bundles.example/type-card-bundles/tb_1/icon.svg" });
    expect(projected.typeCard.sampleThumbnailUrl).toBe("https://bundles.example/type-card-bundles/tb_1/sample.png");
    expect(projected.typeCard.locales.en.name).toBe("Markdown");
  });

  test("intersects the View's supported revisions with the ones that exist", () => {
    expect(projectPublicDocumentType(input)!.availableDocumentContractIdxs).toEqual([0, 1]);
  });

  test("drops a type whose View supports no existing revision", () => {
    expect(projectPublicDocumentType({ ...input, lastContractIdx: -1 })).toBeNull();
  });

  test("drops a type whose manifests do not parse", () => {
    expect(projectPublicDocumentType({ ...input, typeCardManifest: { protocol: "wrong" } })).toBeNull();
    expect(projectPublicDocumentType({ ...input, viewManifest: {} })).toBeNull();
  });

  test("resolves a PNG icon set", () => {
    const png = { ...typeCardManifest, icon: { kind: "png", images: { 16: "i16.png", 32: "i32.png", 64: "i64.png", 128: "i128.png", 256: "i256.png" } } };
    const projected = projectPublicDocumentType({ ...input, typeCardManifest: png })!;
    expect(projected.typeCard.icon).toEqual({
      kind: "png",
      imageUrls: {
        16: "https://bundles.example/type-card-bundles/tb_1/i16.png",
        32: "https://bundles.example/type-card-bundles/tb_1/i32.png",
        64: "https://bundles.example/type-card-bundles/tb_1/i64.png",
        128: "https://bundles.example/type-card-bundles/tb_1/i128.png",
        256: "https://bundles.example/type-card-bundles/tb_1/i256.png",
      },
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-catalog-repository.test.ts`
Expected: FAIL —— 找不到 `../src/tenant-catalog-repository.js`

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant-catalog-repository.ts`：

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { TypeCardBundleManifestV1Schema, ViewBundleManifestV1Schema } from "@unidocs/protocol-admin-portal";
import { PublicDocumentTypeSchema, type DocumentContractRecord, type ListPublicDocumentTypesResponse, type PaginationQuery, type PublicDocumentType } from "@unidocs/protocol-tenant-portal";
import type { TenantCatalogRepository, TenantContext } from "@unidocs/portal-service";

export interface CatalogProjectionInput {
  readonly documentType: string;
  readonly lastContractIdx: number;
  readonly typeCardBundleId: string;
  readonly typeCardBundleUrl: string;
  readonly typeCardManifest: unknown;
  readonly viewBundleId: string;
  readonly viewManifest: unknown;
}

function resolve(bundleUrl: string, path: string): string {
  return new URL(path, bundleUrl).href;
}

/**
 * 把一个文档类型投影成契约要求的 PublicDocumentType；投影不出来就返回 null，
 * 目录里直接不出现这个类型，而不是发一条残缺记录。
 */
export function projectPublicDocumentType(input: CatalogProjectionInput): PublicDocumentType | null {
  const typeCard = TypeCardBundleManifestV1Schema.safeParse(input.typeCardManifest);
  const view = ViewBundleManifestV1Schema.safeParse(input.viewManifest);
  if (!typeCard.success || !view.success) return null;
  // 契约说这里是「当前 View 与内置 Operator 都支持的版本」。Operator 那一侧
  // 还没有数据来源，本轮先取「View 支持的」与「确实存在的」的交集。
  const available = view.data.supportedDocumentContractIdxs.filter(idx => idx <= input.lastContractIdx);
  if (available.length === 0) return null;
  const icon = typeCard.data.icon.kind === "svg"
    ? { kind: "svg", url: resolve(input.typeCardBundleUrl, typeCard.data.icon.path) }
    : { kind: "png", imageUrls: Object.fromEntries(Object.entries(typeCard.data.icon.images).map(([size, path]) => [size, resolve(input.typeCardBundleUrl, path)])) };
  const parsed = PublicDocumentTypeSchema.safeParse({
    documentType: input.documentType,
    typeCardBundleId: input.typeCardBundleId,
    typeCard: { locales: typeCard.data.locales, icon, sampleThumbnailUrl: resolve(input.typeCardBundleUrl, typeCard.data.sampleThumbnail) },
    viewBundleId: input.viewBundleId,
    availableDocumentContractIdxs: available,
  });
  return parsed.success ? parsed.data : null;
}

interface CatalogRow {
  document_type: string;
  last_contract_idx: number;
  type_card_bundle_id: string;
  type_card_record_json: string;
  view_bundle_id: string;
  view_record_json: string;
}

export class D1TenantCatalogRepository implements TenantCatalogRepository {
  constructor(private readonly database: D1Database) {}

  async listDocumentTypes(_context: TenantContext, query: PaginationQuery): Promise<ListPublicDocumentTypesResponse> {
    const limit = query.limit ?? 50;
    const cursor = query.cursor ?? "";
    // 临时规则：每个类型「当前」的 bundle = 最新上传的那个。存储里还没有
    // 「选中」这个概念（portal_type_card_bundles / portal_view_bundles 都只是
    // 候选列表）。admin 侧加上选择能力后，这两个子查询要换成读选中列。
    const rows = await this.database.prepare(`
      SELECT types.document_type, types.last_contract_idx,
        card.type_card_bundle_id, card.record_json AS type_card_record_json,
        views.view_bundle_id, views.record_json AS view_record_json
      FROM portal_document_types AS types
      JOIN portal_type_card_bundles AS card ON card.type_card_bundle_id = (
        SELECT type_card_bundle_id FROM portal_type_card_bundles
        WHERE document_type = types.document_type ORDER BY uploaded_at DESC, type_card_bundle_id DESC LIMIT 1)
      JOIN portal_view_bundles AS views ON views.view_bundle_id = (
        SELECT view_bundle_id FROM portal_view_bundles
        WHERE document_type = types.document_type ORDER BY uploaded_at DESC, view_bundle_id DESC LIMIT 1)
      WHERE types.enabled = 1 AND types.document_type > ?
      ORDER BY types.document_type LIMIT ?`)
      .bind(cursor, limit + 1).all<CatalogRow>();
    const page = rows.results.slice(0, limit);
    const items: PublicDocumentType[] = [];
    for (const row of page) {
      const card = JSON.parse(row.type_card_record_json) as { manifest: unknown; bundleUrl: string };
      const view = JSON.parse(row.view_record_json) as { manifest: unknown };
      const projected = projectPublicDocumentType({
        documentType: row.document_type, lastContractIdx: row.last_contract_idx,
        typeCardBundleId: row.type_card_bundle_id, typeCardBundleUrl: card.bundleUrl, typeCardManifest: card.manifest,
        viewBundleId: row.view_bundle_id, viewManifest: view.manifest,
      });
      if (projected) items.push(projected);
    }
    return { items, nextCursor: rows.results.length > limit ? page[page.length - 1].document_type : null };
  }

  async getDocumentContract(_context: TenantContext, documentType: string, documentContractIdx: number): Promise<DocumentContractRecord | null> {
    const row = await this.database.prepare("SELECT record_json FROM portal_document_contracts WHERE document_type = ? AND document_contract_idx = ?")
      .bind(documentType, documentContractIdx).first<{ record_json: string }>();
    return row ? JSON.parse(row.record_json) as DocumentContractRecord : null;
  }
}
```

`view` 在 SQL 里是保留字，所以表别名用 `views`。若 `ListPublicDocumentTypesResponse` 的 `nextCursor` 字段名或可空性与上面不符，以 `packages/protocol-tenant-portal/src/schemas.ts` 为准修正实现，**不要改契约**。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-catalog-repository.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/src/tenant-catalog-repository.ts packages/cloudflare-portal/tests/tenant-catalog-repository.test.ts
git commit -m "feat(portal): project the document type catalog for tenants"
```

---

### Task 9: 目录 HTTP 处理器

**Files:**
- Create: `packages/cloudflare-portal/src/tenant-catalog-http.ts`
- Test: `packages/cloudflare-portal/tests/tenant-catalog-http.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `D1TenantCatalogRepository`；`createTenantCatalogService`（`@unidocs/portal-service`）
- Produces: `createTenantCatalogHttp(repository: TenantCatalogRepository)` 返回 `(request: Request, context: TenantContext, requestId: string) => Promise<Response>`

`createTenantCatalogService` 的真实签名（见 `packages/portal-service/src/tenant/catalog.ts`）是：

```ts
listDocumentTypes(context: TenantContext, tenantId: string, query?: unknown)
getDocumentContract(context: TenantContext, tenantId: string, documentType: string, documentContractIdx: number)
```

实现时按这个顺序传参。

- [ ] **Step 1: 写失败测试**

创建 `packages/cloudflare-portal/tests/tenant-catalog-http.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import type { TenantContext } from "@unidocs/portal-service";
import { createTenantCatalogHttp } from "../src/tenant-catalog-http.js";

const context: TenantContext = { tenantId: "t1", principalId: "p1", transport: "session", sessionHash: "h" };
const origin = "https://portal.example";
const repository = {
  listDocumentTypes: async () => ({ items: [], nextCursor: null }),
  getDocumentContract: async (_c: TenantContext, type: string, idx: number) =>
    (type === "text/markdown" && idx === 0 ? ({ documentType: "text/markdown" } as never) : null),
};

describe("tenant catalog HTTP", () => {
  test("lists document types for the caller's own tenant", async () => {
    const response = await createTenantCatalogHttp(repository)(new Request(`${origin}/api/v1/tenants/t1/document-types`), context, "req-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
  });

  test("refuses another tenant's path with 403", async () => {
    const response = await createTenantCatalogHttp(repository)(new Request(`${origin}/api/v1/tenants/t2/document-types`), context, "req-2");
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  test("reads one document contract revision", async () => {
    const response = await createTenantCatalogHttp(repository)(new Request(`${origin}/api/v1/tenants/t1/document-types/text%2Fmarkdown/document-contracts/0`), context, "req-3");
    expect(response.status).toBe(200);
  });

  test("returns 404 for a revision that does not exist", async () => {
    const response = await createTenantCatalogHttp(repository)(new Request(`${origin}/api/v1/tenants/t1/document-types/text%2Fmarkdown/document-contracts/9`), context, "req-4");
    expect(response.status).toBe(404);
  });

  test("returns 404 for a path the catalog does not serve", async () => {
    const response = await createTenantCatalogHttp(repository)(new Request(`${origin}/api/v1/tenants/t1/documents`), context, "req-5");
    expect(response.status).toBe(404);
  });

  test("rejects a write method", async () => {
    const response = await createTenantCatalogHttp(repository)(new Request(`${origin}/api/v1/tenants/t1/document-types`, { method: "POST" }), context, "req-6");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-catalog-http.test.ts`
Expected: FAIL —— 找不到 `../src/tenant-catalog-http.js`

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/tenant-catalog-http.ts`：

```ts
import { createTenantCatalogService, TenantOperationError, type TenantCatalogRepository, type TenantContext } from "@unidocs/portal-service";

const LIST = /^\/api\/v1\/tenants\/([^/]+)\/document-types$/;
const CONTRACT = /^\/api\/v1\/tenants\/([^/]+)\/document-types\/([^/]+)\/document-contracts\/([^/]+)$/;

const STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400, forbidden: 403, not_found: 404, limit_exceeded: 413,
  location_contract_violation: 422, document_type_disabled: 409, version_conflict: 409,
  idempotency_conflict: 409, content_unavailable: 409, unavailable: 503,
};

export function createTenantCatalogHttp(repository: TenantCatalogRepository) {
  const service = createTenantCatalogService(repository);

  return async function handle(request: Request, context: TenantContext, requestId: string): Promise<Response> {
    const url = new URL(request.url);
    try {
      const list = LIST.exec(url.pathname);
      const contract = CONTRACT.exec(url.pathname);
      if (!list && !contract) return new Response(null, { status: 404 });
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      if (list) {
        const limit = url.searchParams.get("limit");
        const cursor = url.searchParams.get("cursor");
        return Response.json(await service.listDocumentTypes(context, decodeURIComponent(list[1]), {
          ...(cursor === null ? {} : { cursor }),
          ...(limit === null ? {} : { limit: Number(limit) }),
        }));
      }
      return Response.json(await service.getDocumentContract(
        context, decodeURIComponent(contract![1]), decodeURIComponent(contract![2]), Number(contract![3]),
      ));
    } catch (error) {
      if (!(error instanceof TenantOperationError)) throw error;
      return Response.json({ error: { code: error.code, message: error.message, requestId } }, { status: STATUS[error.code] ?? 500 });
    }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/tenant-catalog-http.test.ts`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add packages/cloudflare-portal/src/tenant-catalog-http.ts packages/cloudflare-portal/tests/tenant-catalog-http.test.ts
git commit -m "feat(portal): serve the tenant document type catalog"
```

---

### Task 10: worker 接线与生产路由

**Files:**
- Modify: `packages/cloudflare-portal/src/worker.ts`（`serveTenantWebUi` 那一段，约 80-95 行）
- Modify: `packages/cloudflare-portal/src/index.ts`
- Modify: `packages/cloudflare-portal/wrangler.production.jsonc`
- Test: `packages/cloudflare-portal/tests/worker.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `createTenantBff`、Task 7 的 `isGatedTenantWebUiPath` / `serveTenantWebUi`、Task 8/9 的目录仓储与处理器、Task 5 的 `D1TenantAuthRepository`、Task 4 的 `hashTenantSecret` / `tenantTokenFromCookie`
- Produces: 无（终端接线）

- [ ] **Step 1: 写失败测试**

追加到 `packages/cloudflare-portal/tests/worker.test.ts`，沿用该文件已有的 env / context 构造方式：

```ts
test("sends an anonymous visitor from the workbench to the login page", async () => {
  const response = await worker.fetch(new Request("https://portal.example/portal/"), env, context);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("https://portal.example/portal/login");
});

test("serves the login page without a session", async () => {
  const response = await worker.fetch(new Request("https://portal.example/portal/login"), env, context);
  expect(response.status).toBe(200);
});

test("serves tenant assets without a session", async () => {
  const response = await worker.fetch(new Request("https://portal.example/portal/assets/does-not-exist.css"), env, context);
  expect(response.status).toBe(404);
  expect(response.headers.get("location")).toBeNull();
});

test("rejects an anonymous catalog read with 401", async () => {
  const response = await worker.fetch(new Request("https://portal.example/api/v1/tenants/t1/document-types"), env, context);
  expect(response.status).toBe(401);
});

test("still serves the tenant WebUI when no Google client is configured", async () => {
  const response = await worker.fetch(new Request("https://portal.example/portal/login"), { ...env, GATEWAY_OIDC_CLIENT_ID: "" }, context);
  expect(response.status).toBe(200);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/cloudflare-portal exec vitest run tests/worker.test.ts`
Expected: FAIL —— `/portal/` 目前 200，`/api/v1/...` 目前不是 401

- [ ] **Step 3: 接线**

把 `packages/cloudflare-portal/src/worker.ts` 里从 `// Ahead of the BFF...` 注释到 `return tenantUi;` 那整段替换为：

```ts
      // 租户面在 admin BFF 之前分发：auth 端点 -> 目录 API -> WebUI（带认证门）。
      // admin BFF 是 admin 形状的，会把匿名访客送到 /admin/login。
      const tenantPath = new URL(request.url).pathname;
      const tenantRepository = new D1TenantAuthRepository(env.DB);
      // 没有配置 Google client 的环境仍然要能发 WebUI（原来这段代码就在读
      // Google 设置之前，保留这个性质）：配置缺失时跳过租户 auth 面，
      // /portal/ 照常 303 到登录页，登录页会显示服务未配置。
      let tenantConfig: PortalGoogleConfig | null = null;
      try {
        tenantConfig = portalGoogleConfigFromGateway({
          GATEWAY_OIDC_CLIENT_ID: env.GATEWAY_OIDC_CLIENT_ID,
          GATEWAY_OIDC_CLIENT_SECRET: env.GATEWAY_OIDC_CLIENT_SECRET,
          GATEWAY_OIDC_ISSUER: env.GATEWAY_OIDC_ISSUER,
        }, env.PORTAL_ORIGIN);
      } catch {
        tenantConfig = null;
      }
      if (tenantConfig) {
        const tenantResponse = await createTenantBff(tenantConfig, tenantRepository, {
          tenantApi: createTenantCatalogHttp(new D1TenantCatalogRepository(env.DB)),
        })(request);
        if (tenantResponse) {
          console.log(JSON.stringify({ event: "portal_request", requestId: tenantResponse.headers.get("X-Request-ID"), path: tenantPath, status: tenantResponse.status }));
          return tenantResponse;
        }
      }
      if (isGatedTenantWebUiPath(tenantPath)) {
        // tenantTokenFromCookie 在无 cookie 时抛 TenantAccessError；降级成
        // 「查不到会话」，这样匿名访问走 303 而不是 500。
        const session = await (async () => {
          try {
            return await tenantRepository.findSession(await hashTenantSecret(tenantTokenFromCookie(request.headers.get("cookie"))));
          } catch {
            return null;
          }
        })();
        if (!session) return new Response(null, { status: 303, headers: { Location: `${env.PORTAL_ORIGIN}/portal/login`, "Cache-Control": "no-store" } });
      }
      const tenantUi = serveTenantWebUi(request);
      if (tenantUi) {
        const requestId = crypto.randomUUID();
        tenantUi.headers.set("X-Request-ID", requestId);
        console.log(JSON.stringify({ event: "portal_request", requestId, path: tenantPath, status: tenantUi.status }));
        return tenantUi;
      }
```

把 `createTenantBff`、`D1TenantAuthRepository`、`createTenantCatalogHttp`、`D1TenantCatalogRepository`、`isGatedTenantWebUiPath`、`hashTenantSecret`、`tenantTokenFromCookie`、`type PortalGoogleConfig` 加进文件顶部的 import。

- [ ] **Step 4: 导出新符号**

在 `packages/cloudflare-portal/src/index.ts` 里补：

```ts
export { createTenantBff } from "./tenant-bff.js";
export { createTenantGoogleLogin, tenantReturnPath, TENANT_LOGIN_COOKIE } from "./tenant-login.js";
export { clearedTenantCookie, createTenantAuthenticator, createTenantSession, hashTenantSecret, tenantTokenFromCookie, TENANT_COOKIE, TENANT_CSRF_COOKIE, TENANT_SESSION_TTL_SECONDS } from "./tenant-auth.js";
export type { TenantSession } from "./tenant-auth.js";
export { D1TenantAuthRepository } from "./tenant-auth-repository.js";
export { createTenantCatalogHttp } from "./tenant-catalog-http.js";
export { D1TenantCatalogRepository, projectPublicDocumentType } from "./tenant-catalog-repository.js";
export { isGatedTenantWebUiPath } from "./static-assets.js";
```

- [ ] **Step 5: 加生产路由**

在 `packages/cloudflare-portal/wrangler.production.jsonc` 的 `routes` 数组里，`bundles.shazhou.work` 那条之前插入：

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

这三条把路径从 gateway 的 `unidocs.shazhou.work/*` catch-all 划到 portal（Cloudflare 里更具体的路由优先）。已核实 gateway 实际使用的是 `/admin/api/v1`、`/ui/*`、`/tenants/*`，与这三条不重叠。

- [ ] **Step 6: 跑全包测试与类型检查**

Run: `pnpm --filter @unidocs/cloudflare-portal test && pnpm --filter @unidocs/cloudflare-portal typecheck`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add packages/cloudflare-portal/src/worker.ts packages/cloudflare-portal/src/index.ts packages/cloudflare-portal/wrangler.production.jsonc packages/cloudflare-portal/tests/worker.test.ts
git commit -m "feat(portal): gate the tenant WebUI and route its API"
```

---

### Task 11: WebUI 会话探测、登录页与退出

**Files:**
- Create: `packages/tenant-portal-webui/src/session.ts`
- Create: `packages/tenant-portal-webui/src/pages/login.tsx`
- Modify: `packages/tenant-portal-webui/src/main.tsx`
- Modify: `packages/tenant-portal-webui/src/shell/app-shell.tsx`
- Modify: `packages/tenant-portal-webui/src/styles.css`
- Test: `packages/tenant-portal-webui/tests/session.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `/portal/auth/session`（200 返回 `{tenantId, principalId, transport}`，401 表示未登录）
- Produces:
  - `type SessionProbe = { kind: "signed-in"; tenantId: string; principalId: string } | { kind: "anonymous" } | { kind: "unavailable" }`
  - `probeSession(fetchImpl?: typeof fetch): Promise<SessionProbe>`
  - `<LoginPage reason={string | null} requestId={string | null} />`

- [ ] **Step 1: 写失败测试**

创建 `packages/tenant-portal-webui/tests/session.test.ts`：

```ts
import { describe, expect, test, vi } from "vitest";
import { probeSession } from "../src/session.js";

describe("session probe", () => {
  test("reports a signed-in tenant", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ tenantId: "t1", principalId: "p1", transport: "session" }));
    await expect(probeSession(fetchImpl as never)).resolves.toEqual({ kind: "signed-in", tenantId: "t1", principalId: "p1" });
  });

  test("reports anonymous on 401", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(probeSession(fetchImpl as never)).resolves.toEqual({ kind: "anonymous" });
  });

  test("reports unavailable on a network failure", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await expect(probeSession(fetchImpl as never)).resolves.toEqual({ kind: "unavailable" });
  });

  test("reports unavailable on a malformed body", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ tenantId: 1 }));
    await expect(probeSession(fetchImpl as never)).resolves.toEqual({ kind: "unavailable" });
  });

  test("sends the request same-origin without caching", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await probeSession(fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledWith("/portal/auth/session", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui exec vitest run tests/session.test.ts`
Expected: FAIL —— 找不到 `../src/session.js`

- [ ] **Step 3: 实现探测**

创建 `packages/tenant-portal-webui/src/session.ts`：

```ts
export type SessionProbe =
  | { readonly kind: "signed-in"; readonly tenantId: string; readonly principalId: string }
  | { readonly kind: "anonymous" }
  | { readonly kind: "unavailable" };

export async function probeSession(fetchImpl: typeof fetch = globalThis.fetch): Promise<SessionProbe> {
  let response: Response;
  try {
    response = await fetchImpl("/portal/auth/session", { credentials: "same-origin", cache: "no-store", redirect: "error" });
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 401) return { kind: "anonymous" };
  if (!response.ok) return { kind: "unavailable" };
  let body: unknown;
  try { body = await response.json(); } catch { return { kind: "unavailable" }; }
  const shape = body as { tenantId?: unknown; principalId?: unknown };
  if (typeof shape.tenantId !== "string" || typeof shape.principalId !== "string") return { kind: "unavailable" };
  return { kind: "signed-in", tenantId: shape.tenantId, principalId: shape.principalId };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/tenant-portal-webui exec vitest run tests/session.test.ts`
Expected: 5 passed

- [ ] **Step 5: 写登录页**

创建 `packages/tenant-portal-webui/src/pages/login.tsx`：

```tsx
const REASONS: Readonly<Record<string, string>> = {
  forbidden: "这个账号还没有被加入本工作区。",
  unauthorized: "登录没有完成，请重试。",
  internal_error: "服务暂时不可用，请稍后重试。",
};

export function LoginPage(props: { reason: string | null; requestId: string | null }) {
  return (
    <main className="tenant-login-screen">
      <h1>UniDocs</h1>
      {props.reason ? <p role="alert">{REASONS[props.reason] ?? "无法进入工作区。"}</p> : null}
      {props.requestId ? <p><small>请求编号 {props.requestId}</small></p> : null}
      <a className="tenant-login-button" href="/portal/auth/login">使用 Google 账号进入</a>
    </main>
  );
}
```

在 `packages/tenant-portal-webui/src/styles.css` 末尾补 `.tenant-login-screen` 与 `.tenant-login-button` 的样式，沿用文件里已有的颜色变量，不要引入新的颜色常量。

- [ ] **Step 6: 改 `main.tsx` 按路径与会话分流**

把 `packages/tenant-portal-webui/src/main.tsx` 整个换成：

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { App } from "./app.js";
import { LoginPage } from "./pages/login.js";
import { probeSession } from "./session.js";

const root = createRoot(document.getElementById("root")!);
const search = new URLSearchParams(window.location.search);

async function start() {
  if (window.location.pathname === "/portal/login" || window.location.pathname === "/portal/access-denied") {
    root.render(<StrictMode><LoginPage reason={search.get("code")} requestId={search.get("requestId")} /></StrictMode>);
    return;
  }
  const session = await probeSession();
  if (session.kind !== "signed-in") {
    window.location.assign("/portal/login");
    return;
  }
  // Task 12 会把目录换成真后端；在那之前全部端点仍是假数据。
  const client = createTenantPortalClient({
    tenantId: session.tenantId,
    transport: createMemoryTransport({ seed: sampleSeed(), agent: { autoRun: true } }),
  });
  root.render(<StrictMode><App client={client} /></StrictMode>);
}

void start();
```

- [ ] **Step 7: 侧边栏加退出**

在 `packages/tenant-portal-webui/src/shell/app-shell.tsx` 里加：

```tsx
async function signOut() {
  const prefix = "__Host-unidocs_tenant_csrf=";
  const csrf = document.cookie.split(";").map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length) ?? "";
  await fetch("/portal/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } });
  window.location.assign("/portal/login");
}
```

并在 `Sidebar` 的渲染里加一个按钮：`<button type="button" onClick={() => { void signOut(); }}>退出</button>`。

- [ ] **Step 8: 构建 WebUI 并重新生成内嵌资源**

Run: `ls scripts/ | grep ui-assets`
确认生成脚本名，然后：
Run: `pnpm --filter @unidocs/tenant-portal-webui build && node scripts/build-ui-assets.mjs`
Expected: `packages/cloudflare-portal/src/tenant-ui-assets.generated.ts` 被更新

- [ ] **Step 9: 跑测试**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: 全部 PASS

- [ ] **Step 10: 提交**

```bash
git add packages/tenant-portal-webui/src packages/tenant-portal-webui/tests packages/cloudflare-portal/src/tenant-ui-assets.generated.ts
git commit -m "feat(tenant-portal-webui): require a session before the workbench"
```

---

### Task 12: 把目录切到真后端

**Files:**
- Create: `packages/tenant-portal-client/src/split-transport.ts`
- Modify: `packages/tenant-portal-client/src/index.ts`
- Modify: `packages/tenant-portal-webui/src/main.tsx`
- Test: `packages/tenant-portal-client/tests/split-transport.test.ts`

**Interfaces:**
- Consumes: `PlatformRequest` / `PlatformResponse` / `PlatformTransport`（`./transport.js`）、`createHttpTransport`、`createMemoryTransport`
- Produces: `createSplitTransport(options: { http: PlatformTransport; fallback: PlatformTransport; httpPathSegments: readonly string[] }): PlatformTransport`

- [ ] **Step 1: 写失败测试**

创建 `packages/tenant-portal-client/tests/split-transport.test.ts`：

```ts
import { describe, expect, test, vi } from "vitest";
import { createSplitTransport } from "../src/split-transport.js";

describe("split transport", () => {
  const http = vi.fn(async () => ({ ok: true as const, data: "from http" }));
  const fallback = vi.fn(async () => ({ ok: true as const, data: "from memory" }));
  const transport = createSplitTransport({ http, fallback, httpPathSegments: ["document-types", "document-contracts"] });

  test("routes a listed segment to the real backend", async () => {
    await expect(transport({ method: "GET", path: "/api/v1/tenants/t1/document-types" })).resolves.toEqual({ ok: true, data: "from http" });
  });

  test("routes a nested listed segment to the real backend", async () => {
    await expect(transport({ method: "GET", path: "/api/v1/tenants/t1/document-types/text%2Fmarkdown/document-contracts/0" })).resolves.toEqual({ ok: true, data: "from http" });
  });

  test("routes everything else to the fallback", async () => {
    await expect(transport({ method: "GET", path: "/api/v1/tenants/t1/documents" })).resolves.toEqual({ ok: true, data: "from memory" });
  });

  test("does not match a segment that merely shares a prefix", async () => {
    await expect(transport({ method: "GET", path: "/api/v1/tenants/t1/document-types-archive" })).resolves.toEqual({ ok: true, data: "from memory" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-client exec vitest run tests/split-transport.test.ts`
Expected: FAIL —— 找不到 `../src/split-transport.js`

- [ ] **Step 3: 实现**

创建 `packages/tenant-portal-client/src/split-transport.ts`：

```ts
import type { PlatformRequest, PlatformResponse, PlatformTransport } from "./transport.js";

/**
 * 过渡态：租户 API 正在一段一段接上真后端，接上的走 http，没接上的继续走
 * 假后端。`httpPathSegments` 是「已经有真后端」的显式清单 —— 每接通一个端点
 * 就往里加一条；全部接通后删掉这个文件，直接用 createHttpTransport。
 */
export function createSplitTransport(options: {
  readonly http: PlatformTransport;
  readonly fallback: PlatformTransport;
  readonly httpPathSegments: readonly string[];
}): PlatformTransport {
  const segments = new Set(options.httpPathSegments);
  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    const isReal = request.path.split("/").some(segment => segments.has(segment));
    return (isReal ? options.http : options.fallback)(request);
  };
}
```

- [ ] **Step 4: 导出**

在 `packages/tenant-portal-client/src/index.ts` 的 `export { createHttpTransport } from "./http-transport.js";` 之后加：

```ts
export { createSplitTransport } from "./split-transport.js";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/tenant-portal-client exec vitest run tests/split-transport.test.ts`
Expected: 4 passed

- [ ] **Step 6: 在 WebUI 里接上**

把 `packages/tenant-portal-webui/src/main.tsx` 里建 client 的那几行换成：

```tsx
  const client = createTenantPortalClient({
    tenantId: session.tenantId,
    // 过渡态：目录已接真后端，其余端点仍是假数据。端点接通后从
    // httpPathSegments 逐条搬走，全部搬完即可删掉 split transport。
    transport: createSplitTransport({
      http: createHttpTransport({ baseUrl: window.location.origin }),
      fallback: createMemoryTransport({ seed: sampleSeed(), agent: { autoRun: true } }),
      httpPathSegments: ["document-types", "document-contracts"],
    }),
  });
```

import 改成：

```tsx
import { createHttpTransport, createMemoryTransport, createSplitTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
```

- [ ] **Step 7: 重新构建内嵌资源并跑全仓验证**

Run: `pnpm --filter @unidocs/tenant-portal-webui build && node scripts/build-ui-assets.mjs && pnpm typecheck && pnpm test`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add packages/tenant-portal-client/src packages/tenant-portal-client/tests packages/tenant-portal-webui/src/main.tsx packages/cloudflare-portal/src/tenant-ui-assets.generated.ts
git commit -m "feat(tenant-portal-webui): read the document type catalog from the real backend"
```

---

### Task 13: 本地端到端验证与文档

**Files:**
- Create: `docs/design/platform-v0/tenant/login.md`
- Modify: `docs/deployment-and-local-configuration.md`
- Modify: `docs/design/platform-v0/tenant/TODO.md`

**Interfaces:**
- Consumes: 前面全部
- Produces: 无

- [ ] **Step 1: 起本地 dev**

Run: `pnpm dev portal`
Expected: 正常启动。端口被占时杀掉残留的 `workerd` / `node` 进程，不要改端口。

- [ ] **Step 2: 应用迁移并放一行名单**

```bash
pnpm --filter @unidocs/cloudflare-portal exec wrangler d1 migrations apply unidocs-portal-local --local
pnpm --filter @unidocs/cloudflare-portal exec wrangler d1 execute unidocs-portal-local --local --command \
  "INSERT INTO portal_tenant_members (member_id, tenant_id, principal_id, email, active, created_at, updated_at) VALUES ('m-dev', 't1', 'p-dev', '<你的 Google 邮箱>', 1, unixepoch(), unixepoch())"
```

- [ ] **Step 3: 走一遍真实登录**

浏览器打开本地 dev 的 `/portal/`，确认：

1. 匿名访问被 303 到 `/portal/login`
2. 点「使用 Google 账号进入」跳到 Google
3. 回跳后落在 `/portal/`，工作台可见
4. 目录处显示的是 D1 里的真实文档类型（本地库为空时目录为空，这是正确结果）
5. 点「退出」回到登录页，再访问 `/portal/` 仍被拦

**若第 2 步回调失败**：多半是 Google Cloud Console 里没给这个 OAuth client 加本地 dev 的回调地址。这是外部前提，见 Step 5。

- [ ] **Step 4: 用不在名单上的账号验证 403**

换一个 Google 账号登录，确认落到 `/portal/access-denied?code=forbidden&requestId=...`，页面显示「这个账号还没有被加入本工作区」。

- [ ] **Step 5: 写文档**

创建 `docs/design/platform-v0/tenant/login.md`，记下：

- 租户登录的路径、cookie 名与会话时长
- 名单表结构，以及「怎么加一个租户用户」的具体 SQL
- **两条必须人工完成的外部前提**：Google Cloud Console 里给 `GATEWAY_OIDC_CLIENT_ID` 增加 `https://unidocs.shazhou.work/portal/auth/callback` 与本地 dev 回调；部署前 `wrangler d1 migrations apply`
- **目录投影用的是临时规则**「最新上传的 bundle = 当前选中」，替换点在 `tenant-catalog-repository.ts` 的两个子查询
- 本轮仍是假数据的端点清单，以及 split transport 的退役条件

在 `docs/deployment-and-local-configuration.md` 补一段租户登录所需的配置与迁移步骤。

在 `docs/design/platform-v0/tenant/TODO.md` 的「已完成」里加一条租户登录；在 TODO 里加一条「把 documents/versions/threads 接上真后端并从 split transport 移除」。

- [ ] **Step 6: 全仓验证**

Run: `pnpm typecheck && pnpm test && pnpm test:local`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add docs/
git commit -m "docs(portal): record how tenant login works and what it still needs"
```
