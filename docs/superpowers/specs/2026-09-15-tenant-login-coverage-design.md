# 租户登录全覆盖 · 设计

日期：2026-09-15。状态：两轮 review 意见已并入，开放问题已全部定案（§8）。
分支：`feat/tenant-login`（已 rebase 到 `9923dbe`，即 #70 合入后的 main）。

本文替换 2026-09-14 的 `tenant-login-design.md` 及其计划。那一版写于 #67
合入之前，其前提（租户 API 未接入 worker、会话认证不存在）已不成立。

> **2026-09-16 修订。** 产品方决定反转本文的两处定案：租户面从「邀请制」改为
> 「自助开户」（任何 Google 账号均可登录，首次登录即开出一个新租户），
> Agent 承载者的租户改为从请求路径读取，`AGENT_TENANT_ID` 已从代码中整体移除
> （不再固定于单一租户）。受影响的段落在原处保留并标注修订，完整说明见新增
> 的 §9。历史决定本身不被删除——它们是当时的事实与理由，只是不再是现状；本文
> 其余部分提到 `AGENT_TENANT_ID` 之处，按「历史约束，现已解除」阅读。

---

## 1. 现状（main @ 9923dbe）

以下均为核实过的事实，每条附出处。

### 1.1 已经有的

- **租户 API 在分发前统一认证。** `packages/cloudflare-portal/src/worker.ts`
  的 `serveTenant` 先把 `/portal/auth/session`、`/portal/auth/logout`
  交给 `createTenantSessionHttp`；其余 `/api/v1/tenants/*` 请求一律先过
  `authenticateTenant`，通过后才交给 `createAgentHttp`（submissions）或
  `createTenantHttp`（其余）。认证失败不会进入任何 handler。
- **两种凭据。** `tenant/session.ts` 的 `authenticateTenant`：
  - 带 `Authorization` 头 → 走 Agent bearer（`tenant/agent-auth.ts`），
    结论终局，被拒绝的 bearer 不会回退到 cookie；
  - 否则 → 请求 URL origin 必须等于 `PORTAL_ORIGIN` 且非
    `sec-fetch-site: cross-site`（**GET 也检查**），再查 cookie
    `__Host-unidocs_tenant` + D1 `portal_tenant_sessions`；
    非 GET/HEAD/OPTIONS 另要求 `Origin` 同源与 `x-csrf-token`。
- **bearer 不能写。** `tenant/tenant-http.ts` 每个写 procedure 调
  `forbidBearerWrite`；`tests/tenant/tenant-http-bearer-walk.test.ts`
  遍历 `tenantApiContract` 证明这一点。
- **授权粒度是租户。** 路径里的 `tenantId` 与凭据里的必须一致，由每个 handler
  内调用 `requireTenantScope`（`portal-service/src/tenant/access.ts:74`）保证；
  仓储按 `tenant_id` 过滤；`principalId` 只用于作者字段与幂等收据，没有文档级 ACL。
- **admin 与 MCP 已有独立认证**，本设计不触碰其行为。admin 的 Google 登录
  （`auth-repository.ts` 的 `completeLogin`）是本设计的参照实现：
  身份经 `googleIdentityFromConfirmedLogin` 校验（要求 `email_verified`，
  email 经 `normalizeAdministratorEmail` 做 trim + 小写），绑定邀请时用
  `portal_mutation_guard`（`CHECK valid = 1` + `changes()`）让 0 行更新使整个
  batch 失败。

### 1.2 缺的

1. **生产上拿不到租户会话。** 会话唯一的签发点是
   `tenant/session-http.ts` 里的 loopback 自动签发：origin 为 loopback 且
   请求未携带有效会话时，无条件签发固定的 `t-local` / `user-local`。
   不存在登录端点。
2. **生产路由不存在。** `wrangler.production.jsonc` 只把 `/admin`、
   `/admin/*`、`/mcp`、两条 `/.well-known/*`、`/oauth/admin-mcp/*` 和
   `bundles.shazhou.work` 路由到 portal；`/portal*` 与
   `/api/v1/tenants/*` 落在 gateway 的 `unidocs.shazhou.work/*` catch-all 上。
3. **生产缺租户数据面的配置。** `wrangler.production.jsonc` 既没有 `CAS_*`
   （`cas-runtime.ts` 需要的七项），也没有 `AGENT_API_TOKEN` / `AGENT_TENANT_ID`。
   仅开路由的话：快照读取返回 unavailable，Markdown Operator 的提交被拒，
   新建文档永远没有版本。
4. **没有身份到租户的映射。** 所有会话都是 `user-local`；不存在成员表。
5. **没有覆盖保证。** 现有 walk 测的是 `createTenantHttp` 这一层，而认证发生
   在它外面的 `serveTenant` 里。测 handler 证明不了「每条路由都被认证门挡住」。
6. **WebUI 未登录时没有出路。** `tenant-portal-webui/src/main.tsx` 在 401 时
   只渲染「需要登录后才能查看」，没有登录入口，也没有退出入口。
7. **没有过期数据清理。** 过期的 `portal_tenant_sessions` 与未完成的
   `portal_login_transactions` 在代码里都没有删除点，worker 也没有 `scheduled`。
8. **草稿不分身份。** WebUI 草稿存在 `localStorage` 的
   `unidocs.portal.drafts.v1`（`drafts/draft-store.ts:8`），不带租户与 principal。
   同一浏览器换人登录会看到前一个人未发送的草稿。

### 1.3 与本设计相关的其他事实

- 迁移 `0012`、`0013`、`0014`（`0014_operator_loop_repair.sql`）均已占用，
  本设计用 `0015`。
- WebUI 使用 hash 路由（`tenant-portal-webui/src/router.ts`：
  `#/d/<documentId>/<threadId>/<commentIdx>`）。hash 不会发给服务端。
- WebUI 目前**不显示评论作者**（`src` 中没有读取 `authorId` 的地方），
  也不存在 principal → email/名字的查询途径。
- 外壳 `index.html` 以 `Cache-Control: no-store` 返回，带哈希的资源为
  `immutable`（`static-assets.ts` 的 `assetResponse`）。
- bundle 路径必须带 64 位十六进制摘要
  （`bundle-ingress.ts:42`：`(tb|vb)_[0-9a-f]{64}`）。

---

## 2. 目标与非目标

**目标**

- G1 租户面每一个 API 都要求真实身份（用户会话或 Agent bearer）。
- G2 生产上用户能用 Google 登录获得会话，并能看到、编辑真实数据。
- G3 身份映射到租户与 principal；被移出名单或被强制下线的人，**下一个 Platform
  API 请求**即失去访问。注意：v0 的 `POST …/cas-capabilities` 固定返回 503
  （`tenant-http.ts` 的 `cas.issueCapability`），当前不存在可残留的直连 UniCAS
  凭据；将来开放签发时，已签发 JWT 在其有效期内仍可用，届时须在该功能的设计里
  声明这段残留窗口。
- G4 守门测试随**契约**与**生产路由表**自动增长：
  - 契约新增 procedure 而未补 fixture → T1 变红；
  - 生产配置新增 route 而未归类 → T2 变红。
  G4 **不**承诺发现「已有通配 route 下新增的路径」；这一类由 T2 的兜底样例
  （未知路径必须 404 无体，认证先于路由的面为 401）与代码评审共同覆盖。

**非目标**

- ~~Agent 凭据改造（仍为共享 token；本轮只在生产配置它，见 §6）。~~
  **2026-09-16 修订：不再是非目标。** 自助开户使「唯一一个
  `AGENT_TENANT_ID`」的前提不再成立——新开的租户事先并不存在于任何配置里。
  本轮把 Agent 承载者的租户改为从请求路径读取，`AGENT_TENANT_ID`
  整体删除；token 本身仍是共享密钥，未做成按租户短期签发。取舍与后续窄化
  路径见新增的 §9。
- gateway 主站（`/ui/*`、`/tenants/*`）的登录体系。
- 成员管理的后台页面。
- 文档级 ACL；租户内全可见保持不变。
- 一人多租户与租户切换。
- 评论作者的显示名。
- 登录端点的限流（见 §7 风险）。

---

## 3. 覆盖清单

「需要覆盖」的集合**从契约推导**，不手写。本表是推导结果的快照，供 review；
测试以契约为准。

| 面 | 路由 | 凭据 | 本设计的变化 |
|---|---|---|---|
| 租户 API | `tenantApiContract` 全部 15 个 procedure | 会话（读写）/ bearer（只读） | 会话来源变为真实登录；每请求校验成员状态 |
| Agent API | `agentApiContract.submissions` 2 个 procedure | bearer | 不变，纳入遍历测试 |
| 会话端点 | `GET /portal/auth/session`、`POST /portal/auth/logout` | 会话 | loopback 自动签发改为显式开关 |
| 登录端点 | `GET /portal/auth/login`、`GET /portal/auth/callback` | **公开**（登录本身不能先要求登录） | 新增 |
| WebUI 外壳 | `GET/HEAD` `/portal`、`/portal/`、`/portal/index.html`、`/portal/assets/*` | **公开** | 加登录/退出入口 |
| admin API | `/admin/api/v1/*` | 管理员会话 | 新增 `tenant-members`，自动落在现有门后 |
| bundles | `bundles.shazhou.work/*` | **公开**（摘要不可猜测的静态代码） | 不变 |
| admin / MCP 其余 | `/admin*`、`/mcp`、OAuth 路径 | 既有 | 不变 |

**为什么外壳公开。** admin 对受保护页面是在服务端设门的
（`isProtectedAdminWebUiPath` → 303 `/admin/login`），租户面不照搬，理由按分量排：

1. **hash 路由决定了门只能在前端之后。** 服务端看不到 `#/d/…`。服务端设门时，
   未登录访问深链接会被 303 到登录，回来只能落到首页。只有外壳先加载、由前端读
   `location.hash` 拼进 `returnTo`，被分享的「某文档某条评论」的链接才能在登录后
   还原。
2. 外壳是编译进 worker 的静态资源，不含数据；数据全部经 API，门在 API 上。
3. 服务端设门需要每次加载外壳都读 D1。

公开外壳须守住的约束（T2 与 T3 各有断言）：

- 租户 UI 资源中不得出现数据、fixture 或本地身份值（`t-local`、`user-local`）。
- 前端不得依据 cookie 是否存在渲染「已登录」，登录态只以
  `/portal/auth/session` 的响应为准（现状 `session/bootstrap.ts` 已如此）。
- `index.html` 保持 `no-store`（现状如此），使登录入口上线后立即生效。

**为什么 bundles 可以公开。** 前提是 bundle 只含类型卡与视图的代码和静态资源，
**不含任何租户数据**。若以后允许 bundle 携带示例文档等内容，此条需重新评审。

---

## 4. 设计

### 4.1 数据：`packages/cloudflare-portal/migrations/0015_tenant_members.sql`

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
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((issuer IS NULL) = (subject IS NULL))
);
-- 一人一租户：活跃的 email 与活跃的 Google 身份都全局唯一。
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

要点：

- **`portal_tenant_sessions` 不改结构。** 它已有 `tenant_id` 与
  `principal_id`，与成员表经 `(tenant_id, principal_id)` 关联；只补一个索引，
  供按成员删会话与按成员保留最新 N 条会话。
- **`principal_id` 在邀请时生成**，形如 `user:<uuid>`，此后不变。
  `IdSchema` 是 `NonEmptyStringSchema`，允许冒号；`agent:markdown-primary`
  已是同样形状。
- **成员行永不删除。** 停用只置 `active = 0`。principal → email / subject 的
  历史因此始终可查，为以后的作者显示与身份续接（§8 Q2 方案 C）留数据。
- **一人一租户**由两条全局唯一索引保证，因此登录时无需选择租户。
- **email 一律规范化后入库**（与 `normalizeAdministratorEmail` 同规则，见 4.5）。
  两条唯一索引按字节比较，入库前不规范化就会允许大小写不同的重复邀请。
- **登录事务单独建表**，不复用 admin 的 `portal_login_transactions`：两个面的
  事务互不可见，一个面发起的 state 无法在另一个面完成。
- 会话、登录事务、审计的写入都在 worker 请求内完成；清理策略见 4.3。

### 4.2 每个请求校验成员状态

`D1TenantSessionStore.find` 改为关联成员表：

```sql
SELECT session.* FROM portal_tenant_sessions AS session
JOIN portal_tenant_members AS member
  ON member.tenant_id = session.tenant_id AND member.principal_id = session.principal_id
WHERE session.session_hash = ? AND session.created_at <= ? AND session.expires_at > ?
  AND member.active = 1 AND member.subject IS NOT NULL
```

- 成员被停用：会话仍在表里也查不到，**下一个请求即 401**。
- 停用与强制下线（4.5）都在同一 batch 里删除该成员的全部会话，不留残留行。
- bearer 路径不变，不查成员表（Agent 不是成员）。
- 开发会话（4.4）同样必须有成员行，没有特例分支。

### 4.3 Google 登录

**先解耦 `createGoogleLogin` 里两处写死 admin 的地方**
（`packages/cloudflare-portal/src/google-login.ts:70` 与
`google-config.ts:32`）：

1. `localWebUi = surface.cookieName === LOGIN_COOKIE && isLocalDevOrigin(...)`
   用 admin 的 cookie 名判断是否放行 loopback。改为只看
   `isLocalDevOrigin(config.origin)`。
2. `portalGoogleConfigFromGateway` 把 `redirectUri` 硬编码为
   `${origin}/admin/auth/callback`，`createGoogleLogin` 又断言它等于
   `${origin}${surface.callbackPath}`。从 `PortalGoogleConfig` 删掉
   `redirectUri`，由 `createGoogleLogin` 按 surface 自算。
   `mcp/authorization.ts` 与 `mcp/authorization-transactions.ts` 里的
   `redirectUri` 是 MCP OAuth 客户端的回调，与 `PortalGoogleConfig` 无关，不动。

admin 行为不变，由 `tests/google-login.test.ts` 与 `tests/google-config.test.ts`
守回归。

**租户 surface**

| 项 | 值 |
|---|---|
| begin | `GET /portal/auth/login?returnTo=` |
| callback | `GET /portal/auth/callback` |
| 登录事务 cookie | `__Host-unidocs_tenant_login` |
| 会话 / CSRF cookie | 沿用 `__Host-unidocs_tenant` / `__Host-unidocs_tenant_csrf` |
| 默认 returnTo | `/portal/` |
| returnTo 校验 | 与 `portalReturnPath` 同构（抽出共用函数）：原值不超过 2048 个字符、以 `/portal/` 开头、不含反斜杠与控制字符及空格；解码后的 pathname 仍以 `/portal/` 开头、不在 `/portal/auth` 或 `/portal/auth/` 下、不含 `%`、没有 `.` / `..` 段。search 与 hash 原样保留。 |

`/portal` 与 `/portal/index.html` 不在服务端放宽，由 WebUI 在拼 `returnTo` 时
统一规范化为 `/portal/`（4.6）。

**begin 算法**

1. 删除已过期的登录事务，单次有界：
   `DELETE FROM portal_tenant_login_transactions WHERE rowid IN
   (SELECT rowid FROM portal_tenant_login_transactions WHERE expires_at <= ? LIMIT 100)`。
   表的行数因此以「10 分钟内发起的登录数」为上限。
2. 交给 `createGoogleLogin.begin`。

**callback 算法**

callback 请求来自 accounts.google.com 的顶层跳转，天然带
`sec-fetch-site: cross-site`。**callback 不得调用 `authenticateTenant`**
（包括「若已登录则直接跳回」这类优化），否则会被跨站检查拒绝。

读取阶段：

1. `createGoogleLogin.complete` 验证 state、PKCE、nonce、签名与 claims，
   得到 Google 身份（email 已规范化）。
2. 要求 Google 登录确认在 5 分钟内（复用 `requireRecentAuthentication`；
   `googleIdentityFromConfirmedLogin` 以完成时刻为确认时间）。
3. 按活跃的 `(issuer, subject)` 找成员；找到即为已绑定成员。
4. 否则按活跃且未绑定的 `email` 找邀请行；要求确认时间不早于邀请的
   `created_at`（沿用 admin 的防护：阻止邀请之前签发的身份去认领邀请）。
5. ~~两者都没有 → 拒绝（见下）。**没有自助开户。**~~
   **2026-09-16 修订：两者都没有 → 自助开户，而不是拒绝。** 为这个身份现场
   创建一个新租户与一个新成员（`tenant_id = t-${randomUUID()}`、
   `member_id = randomUUID()`、`principal_id = user:${randomUUID()}`、
   `added_by = 'self-signup'`），随后按下面第 6 步同样的方式绑定并签发会话。
   `AdminAccessError("forbidden")` 只保留给「邀请早于确认时间」这一种情况
   （原第 4 步）。细节与理由见新增的 §9。

写入阶段（一个 D1 batch，**每一步都以 `portal_mutation_guard` 断言**，
0 行更新使整个 batch 失败，参照 `auth-repository.ts` 的 `completeLogin`）：

6. 若是邀请行：
   `UPDATE … SET issuer, subject, revision = revision + 1, updated_at
   WHERE member_id = ? AND email = ? AND active = 1 AND subject IS NULL
   AND revision = ? AND created_at <= ?`，随后 guard；审计 `member.bound`。
   **2026-09-16 修订：** 若两者都没有（自助开户），改为
   `INSERT INTO portal_tenant_members (…, active, added_by, …) VALUES (…, 1,
   'self-signup', …)`，随后同样 guard、同样审计 `member.bound`。两个活跃唯一
   索引（4.1）是这里真正的并发裁判：两个人同时对同一身份自助开户，后写入的
   那个 `INSERT` 直接因唯一索引冲突而报错，使其整个 batch 失败——guard 只是
   让这一步与其余每一步的写法保持一致，不是这条路径唯一的防线。
7. 断言成员此刻仍活跃且身份一致：
   `INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
   (SELECT 1 FROM portal_tenant_members WHERE member_id = ? AND issuer = ?
   AND subject = ? AND active = 1) THEN 1 ELSE 0 END`，随后清空 guard。
   这一步使「登录与 remove 并发」时整个 batch 失败，不会插入指向已停用成员的会话。
8. 删除该成员已过期的会话；再删除该成员除最新 9 条之外的会话，
   使加上本次后至多 **10 条**。
9. 插入会话行，审计 `session.created`。

batch 失败（并发 remove、并发绑定导致 revision 不符）→ 按「其他异常」处理。

成功后 303 回 `returnTo`，同时下发会话 cookie、CSRF cookie，并清除登录事务 cookie。

**同一成员允许多个会话**（多设备），上限 10 条，超出时淘汰最旧的。
新登录不踢掉其余会话。

**失败处理**（begin 与 callback 都是浏览器顶层导航，失败一律 303 回外壳，
不返回 JSON）

| 情况 | 响应 |
|---|---|
| 不在名单 / 身份不符 / 邀请早于确认时间 | 303 `/portal/?login=denied&requestId=…` |
| begin 参数无效（returnTo 被拒、重复参数） | 303 `/portal/?login=failed&requestId=…` |
| Google 往返校验失败 | 303 `/portal/?login=failed&requestId=…`，日志 `tenant_google_login_failed`，只记 `stage` / `reason` |
| Google 配置缺失 | 303 `/portal/?login=unavailable&requestId=…`，日志 `tenant_login_not_configured` |
| 其他异常（含 batch 失败） | 303 `/portal/?login=failed&requestId=…`，日志 `tenant_operation_failed`，只记 `name` / `message` |

所有失败响应在 callback 路径上都清除登录事务 cookie。
日志纪律与 `bff.ts` 一致：**绝不记录** stack、error 对象、token 或 client secret。

**路由接入**：`worker.ts` 的 `isTenantPath` 增加 `/portal/auth/login` 与
`/portal/auth/callback`，让两个登录端点与会话端点走同一个 `serveTenant` 出口
（同一套安全响应头与 `portal_request` 日志）。Google 配置只在这两个路径上读取，
缺失时租户 API 与外壳照常服务，保留 `worker.ts` 现有的性质
「缺 Google client 不应拖垮租户数据面」。

### 4.4 本地免登录开关

`tenant/session-http.ts` 的自动签发改为同时满足以下全部条件才生效：

- `env.PORTAL_TENANT_DEV_SESSION === "true"`；
- `isLocalDevOrigin(env.PORTAL_ORIGIN)`；
- 请求**完全不带** `__Host-unidocs_tenant` cookie（带了但无效——过期、被撤销、
  成员已停用——一律 401，不被悄悄换成开发会话）；
- 现有的三条：请求无 `Authorization`、请求 URL origin 与配置一致、
  非 `sec-fetch-site: cross-site`。

开关为 true 但 origin 不是 loopback 时：不签发，并记一次
`tenant_dev_session_ignored` 警告。

签发时在同一 batch 里先 upsert 开发成员行，再插会话：

```sql
INSERT INTO portal_tenant_members
  (member_id, tenant_id, principal_id, email, issuer, subject, active, added_by, created_at, updated_at)
VALUES ('member-local-dev', 't-local', 'user-local', 'dev@unidocs.local', 'local-dev', 'user-local', 1, 'dev-session', ?, ?)
ON CONFLICT (member_id) DO UPDATE SET active = 1, updated_at = excluded.updated_at
```

使开发会话通过 4.2 的成员校验。本地 Operator 回路因此照常工作
（2026-09-16 起 Agent 承载者的租户从请求路径读取，不再需要与某个配置常量
一致，见 §9.2）。开发会话**不写审计**。

**已知行为**：开关打开时「退出」只结束当前会话并清掉 cookie；WebUI 下一次探测
会话时请求不带 cookie，会立刻得到新的开发会话。要在本地测试真实登录与退出，
须关闭开关。`.dev.vars.example` 写明这一点。

**默认关闭。** 生产 wrangler 配置中不声明该变量。

对测试与脚本的影响（已逐个核实引用 `/portal/auth/session` 的测试）：

| 文件 | 处理 |
|---|---|
| `tests/integration/cloudflare/portal-tenant-api.test.mjs` | 启动 runtime 时打开开关 |
| `tests/integration/cloudflare/portal-operator-loop.test.mjs` | 同上 |
| `tests/integration/cloudflare/portal-local-runtime.test.mjs` | 同上 |
| `tests/integration/cloudflare/portal-seed.test.mjs` | 同上 |
| `packages/cloudflare-portal/tests/worker.test.ts`（223、340、360、376 行附近依赖自动签发） | env 打开开关；另补「开关关闭时 401」的对照 |
| `packages/cloudflare-portal/tests/tenant/session-http.test.ts` | 按新的条件组合重写自动签发用例 |
| `stacks/unidocs-cloudflare/local/runtime.mjs` | `startLocalRuntime` 新增 `tenantDevSession` 选项，映射到该 binding |
| `packages/cloudflare-portal/.dev.vars.example` | 增加开关说明与「开关打开时退出无效」 |

`portal-cas.test.mjs` 只引用了 `t-local` 常量，不依赖自动签发，不需要改动。

### 4.5 admin API：`tenant-members`

契约加在 `packages/protocol-admin-portal`，`adminApiContract.tenantMembers`：

| procedure | 路由 | 要点 |
|---|---|---|
| `list` | `GET /admin/api/v1/tenant-members?tenantId=&cursor=&limit=` | 仅活跃成员；`tenantId` 可选 |
| `add` | `POST /admin/api/v1/tenant-members` | body `{ tenantId, email }`；必须带 `Idempotency-Key`；返回 `{ memberId, principalId, etag }` |
| `remove` | `DELETE /admin/api/v1/tenant-members/{memberId}` | 必须带 `If-Match` 与 `Idempotency-Key`；置 `active=0` 并删除其全部会话 |
| `revokeSessions` | `POST /admin/api/v1/tenant-members/{memberId}/session-revocations` | 必须带 `Idempotency-Key`；删除该成员全部会话，成员保持活跃。用于怀疑账号被盗但不想停用（停用再加入会换 principal，见 §8 Q2）。 |

- **email 规范化**：`add` 先按 `normalizeAdministratorEmail` 同一规则
  （trim + 小写 + 同一 schema）规范化再查重、入库。实现上把该函数提到
  `portal-service` 里一个不带 admin 字样的名字（如 `normalizeGoogleEmail`），
  admin 与租户共用，避免两处规则漂移。
- **原子性**：`remove` 与 `revokeSessions` 的写入各在一个 batch 内，
  以 `portal_mutation_guard` 断言目标成员行的状态（`remove` 断言 revision 与 ETag
  一致；`revokeSessions` 断言成员活跃），失败时什么都不写。
- 错误码：`invalid_request` 400、`not_found` 404、`idempotency_conflict` 409、
  `tenant_member_exists` 409（该 email 已是某租户的活跃成员）、
  `precondition_failed` 412、缺 `If-Match` 为 428。
- 幂等收据沿用 `portal_idempotency_receipts`，operation 分别为
  `addTenantMember`、`removeTenantMember`、`revokeTenantMemberSessions`。
- 审计：`AdminAuditActionSchema` 增加 `tenant_member.added`、
  `tenant_member.removed`、`tenant_member.sessions_revoked`；
  `AdminAuditResourceTypeSchema` 增加 `tenant_member`。
- 分层照 `administrators`：service 在 `portal-service/src/admin/tenant-members.ts`，
  D1 仓储 `cloudflare-portal/src/tenant-members-repository.ts`，
  HTTP `cloudflare-portal/src/tenant-members-http.ts`，
  `worker.ts` 的 `adminApi` 分发加前缀 `/admin/api/v1/tenant-members`。
- 门：`bff.ts` 对所有 `/admin/api/v1/*` 先 `authenticate`，新端点自动在门后，
  与 `administrators` 同样要求管理员会话、写操作要求 CSRF。

**重新加入同一个 email**：`remove` 之后再 `add` 会生成新的 `member_id` 与
**新的 `principal_id`**（§8 Q2 定案）。旧成员行保留为停用状态。

**2026-09-16 修订：** 上面说的是「管理员主动重新 `add`」这一条路径，`add`
把这个 email 加回**同一个**（或另一个管理员指定的）租户。它不是这个 email
唯一的复活方式：自助开户上线后，被 `remove` 的成员完全可以不经过任何
`add`，直接用同一个 Google 身份重新走 `/portal/auth/login`——那样得到的不是
「同租户下的新 principal」，而是**一个全新的、空的租户**（§4.3 第 5 步）。
`remove` 因此不再是「封禁这个人」，而是「把这个人移出这一个租户」；新增的
§9 记录了这一变化。

**seed**：`stacks/unidocs-cloudflare/local/portal-seed.mjs` 在注册 markdown 类型
之后，用它已有的管理员会话（`adminClient`）调用该 API，把
`PORTAL_BOOTSTRAP_EMAIL`（若已配置）加入 `t-local`，使 `pnpm dev portal`
起来后可以直接走真实登录。409 `tenant_member_exists` 视为成功（幂等）。

### 4.6 WebUI（`packages/tenant-portal-webui`）

**登录入口**

- 未登录提示页增加「使用 Google 账号登录」链接，指向
  `/portal/auth/login?returnTo=<encodeURIComponent(规范化 pathname + hash)>`。
- 规范化：pathname 为 `/portal` 或 `/portal/index.html` 时改为 `/portal/`；
  其余不以 `/portal/` 开头的情况一律用 `/portal/`。hash 原样保留，
  深链接的位置因此在登录后得以还原。
- 读取 `?login=denied` / `?login=failed` / `?login=unavailable`，分别显示
  「这个账号还没有加入工作区」/「登录没有完成，请重试」/「登录暂不可用，请稍后再试」，
  并显示 `requestId`；展示后用 `history.replaceState` 去掉 `login` 与
  `requestId` 参数（保留 hash），避免刷新重复提示。

**退出**

- 侧边栏增加「退出」：`POST /portal/auth/logout`，带 `x-csrf-token`
  （复用现有 `readCsrfCookie`），完成后回到未登录提示页。
- 退出请求得到 401（会话已过期或已被撤销）时同样视为已退出，回到未登录提示页。

**会话过期**

- `withSessionRefresh` 不变：会话过期时它重新探测一次，拿不回来就交给
  `onSignedOut`，现在 `onSignedOut` 展示的是带登录入口的页面。
- 草稿在 localStorage，跳转登录再回来不丢字。

**草稿按身份隔离**

- 存储 key 改为 `unidocs.portal.drafts.v2:<tenantId>:<principalId>`，
  `createDraftStore` 接收 `{ tenantId, principalId }`，取自已登录会话。
- 退出**不清草稿**：key 已隔离，下一个人看不到；本人再登录后恢复。
- 旧 key `unidocs.portal.drafts.v1`：生产此前没有租户面，只可能存在于本地开发环境。
  首次以某个身份加载时把其中草稿并入该身份的 key，并删除旧 key。

改动后重新生成 `packages/cloudflare-portal/src/tenant-ui-assets.generated.ts`。

### 4.7 生产配置

**路由。** `packages/cloudflare-portal/wrangler.production.jsonc` 的 `routes` 增加：

- `unidocs.shazhou.work/portal`
- `unidocs.shazhou.work/portal/*`
- `unidocs.shazhou.work/api/v1/tenants/*`

Cloudflare 以更具体的路由优先，这三条从 gateway 的 catch-all 中划出。gateway
（`packages/cloudflare-gateway/wrangler.toml`）另有的具体路由是 `/tenants/*`、
`/ui/*` 与 unicas 域上的 OAuth 路径，与新增三条无重叠。

**数据面配置**（§1.2 第 3 条）。本轮上线的前提是租户数据面在生产可用：

- ~~`vars` 增加 `AGENT_TENANT_ID`（等于首个上线租户的 id）与~~ `vars` 增加
  `CAS_ORIGIN`、`CAS_STACK_ID`、`CAS_ISSUER`、`CAS_AUDIENCE`、`CAS_REF_DOMAIN`、
  `CAS_SIGNING_KID`（2026-09-16 起不再需要 `AGENT_TENANT_ID`，见 §9.2）；
- `secrets.required` 增加 `AGENT_API_TOKEN` 与 `CAS_SIGNING_KEY`；
- 生产 markdown worker（`packages/cloudflare-markdown/wrangler.toml` 注释写明 v0 故意
  未部署这些）补齐 Operator 回路：`PLATFORM_SERVICE` service binding 指向
  `unidocs-portal`、`PLATFORM_ORIGIN`、`PLATFORM_AGENT_TOKEN`（与 portal 的
  `AGENT_API_TOKEN` 同值）与 `OPERATOR_CAS_*`（Operator 以 Agent 身份写快照的
  UniCAS 凭据）。

~~因为 `AGENT_TENANT_ID` 只有一个，本轮生产**只开一个租户**；Operator 只为这个
租户工作。多租户与 Agent 凭据改造一起做，不在本轮。~~
**2026-09-16 起不再成立**：Agent 承载者的租户改为从请求路径读取，
`AGENT_TENANT_ID` 已整体删除，Operator 对生产开出的每一个租户都能工作，
不再受限于「本轮只开一个」，见 §9.2。

**注释。** `worker.ts:248-250` 那段注释改写而不是删除：`/` 在生产上仍归 gateway，
「根路径跳转只在本地生效」的结论依然成立，只是理由从「生产只路由 admin、MCP 与
OAuth 路径」改为「生产不路由 `/`」。`serveTenantWebUi` 前的注释
「the tenant UI has no login to gate it with」改为指向 §3 外壳公开的理由。
`tests/worker.test.ts:127` 的同类注释一并更新。

### 4.8 守门测试

这是本设计 G4 的落点。

**T1 契约遍历：`packages/cloudflare-portal/tests/tenant/auth-coverage-walk.test.ts`**

- 走 **`worker.fetch`**，env 使用 `tests/tenant/real-d1.ts` 的真实 D1，
  使请求经过 `serveTenant` 里真正的认证点。
- 被遍历的 procedure 集合 = `tenantApiContract` ∪ `agentApiContract` 的全部 procedure，
  从契约对象里递归读出，不手写。
- **预置数据**：`beforeAll` 在本租户建好 fixture 引用的文档、版本、线程与评论，
  另建一个租户的活跃成员及其会话、一个已停用成员及其（残留）会话。
  没有这些数据，读接口的对照组会得到 404，无法与「门缺失」区分。
- 每个 procedure 用一个能通过输入校验、指向预置数据的 fixture
  （沿用 bearer walk 的写法：否则 400 会掩盖缺失的门）。
- 对 `tenantApiContract` 的每个 procedure 断言：
  1. 无任何凭据 → **401**；
  2. **另一租户成员的有效会话 → 403**。这是本组里唯一依赖 handler 自身检查
     （`requireTenantScope`）的断言，也是逐 procedure 遍历最有价值的一条：
     新 handler 漏掉 scope 检查，只有它能发现；
  3. 已停用成员的会话 → **401**（4.2）；
  4. 有效会话但 `sec-fetch-site: cross-site` → **403**；
  5. 非 GET：有效会话但缺 `x-csrf-token` → **403**；
  6. 对照组：本租户活跃成员的有效会话 → **不是** 400/401/403/404
     （证明上面的拒绝来自门，而不是 fixture 无效）。

  第 1、3、4、5 条在 `serveTenant` 进入路由前就判定，与具体路径无关；逐 procedure
  执行它们证明的是「该路径确实进入了 `serveTenant`」。
- 对 `agentApiContract` 的每个 procedure 断言：无凭据 → **401**；
  本租户活跃成员的有效用户会话 → **403** `forbidden`
  （`tenant/agent-http.ts:183`：非 bearer 一律拒绝）；
  对照组：有效 bearer → 不是 400/401/403/404。
- 写操作的对照组会触发 `onCommitted` 派发与 retention sweep；测试不传
  ExecutionContext，派发会启动但不被等待，且不会 reject（`worker.ts` 的
  `inBackground`），不影响断言。
- **完整性断言**：被断言的 procedure 数量 = 两份契约 procedure 总数；
  fixture 表的键集合 = 契约 procedure 路径集合。契约新增 procedure 而未补
  fixture，测试直接失败。

**T2 生产路由遍历：`packages/cloudflare-portal/tests/production-routes-auth.test.ts`**

- 用 `jsonc-parser`（锁文件里已有 3.3.1，但只是传递依赖；需加为
  `cloudflare-portal` 的 devDependency）解析 `wrangler.production.jsonc` 的
  `routes` 与 `vars`，解析错误即测试失败。**不得**用正则去注释：文件里的
  `https://…` 字符串含 `//`。
- **env 取生产 `vars`**，再补上测试用的 D1 / KV / R2 binding 与 secrets 占位。
  这一点是必须的：本地 `wrangler.jsonc` 里 `MCP_ENABLED` 是 `"false"`，
  所有 MCP 路径返回 404；生产是 `"true"`，匿名 `/mcp` 应得到 401。
  用本地 vars 跑出来的结论对生产无效。
- **传入 ExecutionContext 替身**：`worker.ts:201` 在 MCP 路径上没有 context 会抛错，
  被外层兜成 503。
- **替换全局 `fetch`**：`/portal/auth/login` 与 `/admin/auth/login` 的 begin 会先请求
  Google 的 discovery 文档，测试不得访问真实网络。替身对 Google 的三个固定 URL
  返回合法元数据，其余 URL 抛错。
- 每条 route 展开为代表样例（`方法 + 路径`）：
  - 精确 route 取其本身；
  - `/*` route 取前缀下的一组已知路径：`/portal/*` 取
    `isTenantWebUiPath` 与 `isTenantPath` 覆盖的全部固定路径；
    `/api/v1/tenants/*` 取契约里每条路径代入样例参数、配契约里的方法；
    `/admin/*` 与 `/oauth/admin-mcp/*` 取 bff 方法表与 `ADMIN_MCP_PATHS` 中的路径；
  - **每个 `/*` route 另加一个随机未知路径**（如 `/portal/__probe_<uuid>`）。
- 匿名请求（**不带 `Origin`、不带任何 cookie 与 `Authorization`**）打 `worker.fetch`，
  期望结果属于以下之一：
  - 401 / 403；
  - 303 且 `Location` 的 pathname 恰为 `/admin/login`、`/admin/auth/login`、
    `/portal/auth/login` 或 `/portal/`（后者仅限带 `login=` 参数的登录失败回跳），
    查询参数不限；
  - 随机未知路径：404 且响应体为空；认证先于路由的面（`/api/v1/tenants/*`）
    为 401；
  - 命中测试文件内的**显式公开白名单**（按 `方法 + 路径`）。

  不带 `Origin` 是有意的：匿名 `POST /admin/auth/logout` 若带同源 `Origin`，
  会得到清除 cookie 的 204（`bff.ts:88`），不属于数据泄漏，但会让结论随请求头变化。
- 公开白名单（全部写在测试里，改动需评审）：

  | 方法 | 路径 | 断言 |
  |---|---|---|
  | GET、HEAD | `/portal`、`/portal/`、`/portal/index.html` | 200，`Content-Type: text/html` |
  | GET、HEAD | `/portal/assets/*`（取构建产物中的实际文件） | 200 |
  | GET | `/portal/auth/login` | 303 到 accounts.google.com |
  | GET | `/portal/auth/callback` | 303 到 `/portal/?login=failed…` |
  | GET | `/admin/login`、`/admin/access-denied` | 200（bff 方法表只允许 GET） |
  | GET | `/admin/assets/*`（取构建产物中的实际文件） | 200 |
  | GET | `/admin/auth/login` | 303 到 accounts.google.com |
  | GET | `/admin/auth/callback` | 非 2xx，非 5xx |
  | GET | `/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server` | 200 JSON |
  | POST | `/oauth/admin-mcp/register`、`/oauth/admin-mcp/token`、`/oauth/admin-mcp/revoke` | 4xx（匿名、无合法 OAuth 参数） |
  | GET | `/oauth/admin-mcp/authorize` | 400（无合法 OAuth 参数时在查会话之前就拒绝） |
  | GET | `bundles.shazhou.work/(type-card-bundles\|view-bundles)/<id>/<path>` | 200 或 404 |

  白名单不含通配的 `/oauth/admin-mcp/*`：该前缀下新增的路径必须显式归类。
  `/oauth/admin-mcp/authorize` 只有携带合法 OAuth 参数、且没有管理员会话时才会
  303 到 `/admin/auth/login`（`mcp/authorization.ts:58`）；T2 发出的裸请求在解析
  OAuth 参数时就被 400 拒绝，因此按 400 列出。
- **公开外壳约束**：对 `/portal/index.html` 与全部 `/portal/assets/*` 的响应体断言
  不含 `t-local`、`user-local`、`dev@unidocs.local`。
- **完整性断言**：每条 route 至少产生一个样例；出现未被样例覆盖的 route
  则失败。今后在生产配置里加路由而没想清楚它的认证，这里会变红。

**T3 其余单测**

- 成员绑定 / 拒绝 / 确认时效；邀请 email 大小写与 Google email 大小写不同时仍能绑定。
- **并发**：绑定 batch 执行前成员被 remove → batch 失败、无会话行、303 `login=failed`；
  两次并发绑定同一邀请 → 至多一次成功。
- 会话上限：第 11 次登录后该成员恰有 10 条会话，被淘汰的是最旧的；过期会话被清理。
- begin 清理过期登录事务，单次至多 100 条。
- callback 各失败分支的 303 目标与日志字段；callback 带 `sec-fetch-site: cross-site`
  时正常完成。
- returnTo 校验的接受与拒绝样例。
- 开关的条件组合：开关 × loopback × 是否带 cookie。
- `tenant-members`：email 规范化、幂等、ETag、审计、「停用即删会话」、
  `revokeSessions` 删会话但成员仍可再次登录、停用行不被删除。
- WebUI：登录链接的 returnTo 规范化（`/portal`、`/portal/index.html`、带 hash）、
  三种 `?login=` 提示与参数清除、退出（含 401 视为已退出）、
  草稿按身份隔离与 v1 迁移。

### 4.9 可观测

- 所有租户响应沿用 `serveTenant` 已设置的 `Cache-Control: no-store`、
  `X-Content-Type-Options`、`Referrer-Policy`、`Content-Security-Policy`、
  `X-Request-ID`。登录端点纳入 `serveTenant` 同一出口，不另起一套。
- 新增日志事件：`tenant_google_login_failed`、`tenant_login_not_configured`、
  `tenant_dev_session_ignored`。`portal_request` 行照旧记录每个请求的 path 与 status。

---

## 5. 迁移与兼容

- **生产**：此前没有租户路由，因此没有租户数据、没有租户会话，
  上线不需要数据迁移。上线顺序见 §6。
- **本地已有数据**：作者为 `user-local` 的文档与评论保留。打开开关后开发会话
  仍是 `user-local`，与旧数据一致；用真实 Google 登录则是新的 principal，
  能看到同租户的全部文档（租户内全可见）。评论的 `author_id` 归属不同 principal，
  目前 WebUI 不显示作者，界面上看不出差别。
- **本地草稿**：v1 草稿在首次加载时并入当前身份（4.6）。
- **`pnpm dev portal` 行为变化**：默认不再自动登录。开发者要么配置
  `PORTAL_BOOTSTRAP_EMAIL` 并走真实登录（seed 已将其加为成员），要么在
  `.dev.vars` 打开开关。`docs/deployment-and-local-configuration.md` 需同步说明。

## 6. 外部前提（需人工完成）

按顺序：

1. Google Cloud Console 为 `GATEWAY_OIDC_CLIENT_ID` 增加授权回调：
   `https://unidocs.shazhou.work/portal/auth/callback`，以及本地 dev 的 loopback
   回调地址。**不加则 callback 必定失败。**
2. 为首个租户准备 UniCAS：确定 `CAS_*` 各值，`wrangler secret put CAS_SIGNING_KEY`。
3. 生成 Agent token：portal `wrangler secret put AGENT_API_TOKEN`，生产 markdown
   worker 的 `PLATFORM_AGENT_TOKEN` 设为同一值；为 markdown worker 准备
   `OPERATOR_CAS_*`。
4. 执行 `wrangler d1 migrations apply`（`wrangler deploy` 不会自动应用）。
5. 部署 markdown worker，再部署 portal worker（含新路由与新 vars）。
6. 用 admin API 邀请第一位租户成员。
7. 该成员登录，创建文档，确认 Operator 产出首个版本。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 新增生产路由从 gateway catch-all 抢走路径 | 已核对 gateway 具体路由无重叠；上线后抽查 `/ui/*`、`/tenants/*` |
| 改 `PortalGoogleConfig` 形状牵动 admin 登录 | 先改并跑通 admin 登录测试，再动租户 |
| 默认关闭开关改变本地开发习惯 | seed 自动加成员；`.dev.vars.example` 与部署文档写明 |
| 每请求多一次 JOIN | 走会话主键与 `(tenant_id, principal_id)` 索引 |
| 登录 begin 是匿名写 D1 的端点，可被刷 | 事务表以「10 分钟内的 begin 数」为上限（4.3 清理）；admin 的 `/admin/auth/login` 同样如此。需要时在 Cloudflare 上对两个 begin 路径加限流规则，不在本轮代码范围 |
| **2026-09-16 新增：** 自助开户把 callback（同样匿名可达，只是多一次真实 Google 往返）从「认领邀请」变成「创建永久的租户与成员行」，而 remove 不再是封禁（§9.1）——同一个人被拒绝重新自助开户的唯一方式在本轮不存在，理论上可以反复走完整的 Google 登录流程来堆积空租户。这是产品决定「自助开户」的已接受后果，不是要重新讨论要不要做自助开户；缓解手段与 begin 一样是 Cloudflare 侧限流，不在本轮代码范围 |
| 会话 cookie 被盗 | 固定 8 小时有效期；管理员可 `revokeSessions`；每成员至多 10 条会话 |
| 将来开放直连 UniCAS capability 后，停用成员的 JWT 在有效期内仍可用 | v0 不签发（固定 503）；开放签发的设计须声明该窗口 |
| ~~本轮生产只支持一个租户~~（2026-09-16 起不再成立，见 §9） | ~~由单一 `AGENT_TENANT_ID` 决定，已写入 §4.7；多租户与 Agent 凭据改造一并做~~ |

## 8. 开放问题的定案

- **Q1 一人一租户：接受。** 两条全局唯一索引简化了登录。以后支持多租户时，
  把这两条索引改为按 `tenant_id` 分区，并在登录后加租户选择。

  **2026-09-16 修订：** 自助开户没有改变这条定案，只是给它添了一种新的达成
  方式——「一人一租户」现在既可能来自一次邀请绑定，也可能来自登录当场
  开出的一个新租户（§4.3 第 5 步）。两条全局唯一索引仍是唯一的裁判：不管
  member 行是 `UPDATE`（邀请）出来的还是 `INSERT`（自助开户）出来的，同一个
  活跃 email 或同一个活跃 `(issuer, subject)` 都不可能同时属于两行、两个租户。

- **Q2 重新加入后换 principal：接受「换新」（方案 A）。**
  - 考虑过的方案 B「`add` 时按 email 复活停用行」被否决：
    1. email 与人不是一一对应，Workspace 回收邮箱后发给新人，新人会继承前任的作者身份；
    2. 复活会让登录与 remove 并发时残留的会话行重新生效（虽然 4.3 的 guard 已阻止
       产生这类行，但不应让安全性依赖单一防线）。
  - 以后若要历史连续，走方案 C「按 Google 身份续接」：`add` 仍新建行，**绑定时**
    若同租户有停用行的 `(issuer, subject)` 相同，则沿用其 `principal_id`。为此：
    成员行永不删除（4.1，已做）；届时把 `portal_tenant_member_principal` 改为
    `WHERE active = 1` 的部分唯一索引。
  - 眼下影响有限：WebUI 不显示作者，影响只在 `author_id` 的数据归属。

  **2026-09-16 修订：** 以上讨论的「换新」只覆盖「管理员重新 `add`」这一条
  路径。自助开户开出了第二条、影响更大的路径：一个被 `remove` 的成员**不需要
  任何人重新 `add`**，自己用同一个 Google 身份重新登录即可——那时换的不只是
  principal，连**租户**都是全新、空的（旧租户的文档、评论都留在旧
  `tenant_id` 下，新租户看不见）。`remove` 的含义因此从「封禁这个人」变成
  「把这个人移出这一个租户」；管理员如果想真正阻止某人访问任何租户，需要在
  其自助登录前就有相应手段——本轮没有设计这类「全局封禁」，是已知的空白，见
  §9。

- **Q3 多会话：允许，但加三项约束。**
  1. 每成员至多 10 条会话，登录时淘汰最旧的并清理过期的（4.3）；
  2. 管理员可 `revokeSessions` 强制下线而不停用（4.5）；
  3. 草稿按 `tenantId:principalId` 隔离，共用电脑换人登录看不到前一个人的草稿（4.6）。

  不采用「新登录踢掉旧会话」：租户用户多设备并用是常态；8 小时固定有效期已为被盗
  cookie 设了上限。

- **Q4 外壳公开：接受。** 决定性理由是 hash 路由（§3）：服务端设门会让深链接在
  登录后丢失位置。约束（不含数据、登录态以 API 为准、`index.html` 不缓存）写入 §3，
  由 T2 断言。

- **Q5 T2 公开白名单：已修订（4.8）。**
  1. 白名单按「方法 + 路径」列出，并对每项给出具体断言；
  2. `/oauth/admin-mcp/*` 收窄为 `register`、`token`、`authorize`、`revoke` 四个精确
     路径，各自给出预期状态；
  3. bundles 保留，前提「bundle 不含租户数据」写入 §3；
  4. 跳转登录的 `Location` 精确到 pathname；
  5. 匿名请求不带 `Origin`，避开 admin 退出接口的 204 特例；
  6. 每个通配 route 另测一个随机未知路径，必须 404 无体。

## 9. 2026-09-16 修订：自助开户，与 Agent 凭据的作用域扩大

产品方决定反转本文两处原定案。以下记录改了什么、为什么、以及新的后果——
不是重写 §1～§8 的历史，那些仍是 2026-09-15 上线时的事实与理由。

### 9.1 从「邀请制」到「自助开户」

**改了什么。** `D1TenantLoginRepository.completeLogin`（4.3 第 5 步）不再在
「既非已绑定成员、也非邀请」时拒绝登录。任何通过 Google 身份校验（`email_verified`、
5 分钟内确认）的账号，第一次登录时都会现场获得一个全新、独立的租户：

```
tenant_id    = t-${randomUUID()}
member_id    = randomUUID()
principal_id = user:${randomUUID()}
email        = 规范化后的登录 email
issuer/subject = 本次登录绑定的 Google 身份
active       = 1
added_by     = 'self-signup'
```

写法与「绑定邀请」完全对称：一条 `INSERT`，紧跟
`INSERT INTO portal_mutation_guard SELECT changes()` 与清空，审计
`member.bound`，其余步骤（8/9：会话上限、`session.created`）不变。
`AdminAccessError("forbidden")`（`login=denied`）只保留给一种情况：邀请的
确认时间早于邀请本身的 `created_at`。

**为什么。** 产品方认定租户面应当像大多数 SaaS 一样开箱可用，而不是每个人
都要先等管理员邀请。「一人一租户」（§8 Q1）没有变：判定「是否已有归属」的
两条全局唯一索引（活跃 email、活跃 `(issuer, subject)`）原样保留，自助开户
只是在两条索引都查无结果时，多出的第三个分支，而不是绕开它们。

**并发。** 两个人（或同一个人开两个标签页）同时用同一身份第一次登录，
不再依赖一次 `revision` 比对：两次 `INSERT` 会撞上同一条活跃唯一索引，后
提交的那次直接收到 D1 层的约束错误，使它那一整个 batch 失败——它不是
`AdminAccessError`，`login-http.ts` 按「其他异常」处理，落到 `login=failed`，
这是预期行为，不是 bug。

**移除的新含义。** 因为自助开户不查「历史上是否曾经是成员」，一个被管理员
`remove` 的成员，只要还记得自己的 Google 账号，隔一秒重新登录就能拿到
**一个全新的、空的租户**——旧租户和它的文档原地不动，新租户与旧租户之间
没有任何关联。也就是说：

> **`remove` 现在的含义是「把这个人移出这一个租户」，不是「禁止这个人使用
> 租户面」。**

这与 §8 Q2 原先讨论的「重新加入换 principal」是两件不同的事：Q2 说的是
管理员主动 `add` 回同一个（或另一个）租户时换新 principal；这里说的是完全
不经过 `add`，自助登录本身就会开一个新租户。本轮没有设计「全局封禁」这一
能力（例如按 email 或 `(issuer, subject)` 拉黑，阻止其触发自助开户）；这是
已知的空白，留给以后有实际需要时再设计，不是遗漏。同一条「活跃 email 全局
唯一」索引是这两件事背后共同的裁判：它既是「被 remove 的人重新登录会拿到
新租户而不是复活旧的」的原因，也是「已经自助登录过的人不能再被 `add` 进
另一个租户，除非先 `remove`」的原因——`add` 与自助开户在同一个 email 上
永远互斥，谁先发生，另一条路径就会被这条唯一索引挡下。

### 9.2 Agent 凭据：共享 token，作用域从一个租户扩大到全部

**改了什么。** `authenticateAgent`（`tenant/agent-auth.ts`）不再从配置
（`AGENT_TENANT_ID`）读取它认证的租户，而是解析请求路径
`/api/v1/tenants/{tenantId}/...` 里的 `{tenantId}` 段——百分号解码后按
`/^[\x21-\x7e]{1,128}$/` 校验，与租户面其余地方校验标识符的方式一致。
`AGENT_TENANT_ID` 已从 `authenticateAgent`、`authenticateTenant`、
`worker.ts`、`packages/cloudflare-portal/wrangler.jsonc` 的 `vars`、以及
`stacks/unidocs-cloudflare/local/runtime.mjs` 里删除。路径不含合法租户段的
请求（例如带 `Authorization` 头的 `/portal/auth/session`）得到
`TenantAccessError("unauthorized")`，与改造前的行为一致。

**为什么。** 自助开户让「本轮生产只开一个租户」（原 §4.7、§7 的前提）不再
成立：新用户随时可能开出一个 `AGENT_TENANT_ID` 从未听说过的新租户，
Markdown Operator 却仍要能替它写入版本——`platform-client.ts` 已经按路径
寻址租户，缺的只是 portal 这一侧不再把 bearer 钉死在一个租户上。

**接受的取舍。** Token 本身没变：仍是一份共享密钥，`authenticateAgent`
只验证「这个 token 是不是配置的那一个」，不再验证「这个 token 能不能代表
这个租户」——因为它现在对所有租户都有效。后果是：

> **这份共享 token 一旦泄露，暴露的不再是一个租户的文档读写权限，而是
> 全部租户的。**

产品方接受这个后果，是有意的取舍，不是遗漏。**收窄的路径**：把「Operator
出示一份长期有效的共享密钥」换成「Operator 出示一份按租户签发、短期有效的
凭据」（例如 UniCAS 已有的按 stack 签发短期 JWT 的模式），使一份凭据泄露
只影响它对应的那一个租户，代价是要给 Operator 增加取得/续期该凭据的流程。
这不在本轮范围内。

**对 §7 风险表与 §4.7 的影响。** 「本轮生产只支持一个租户」这条风险随
`AGENT_TENANT_ID` 一并作废；生产配置不再需要为「开几个租户」预先决定
Agent 凭据的形状——所有租户的 Agent 流量走同一份共享 token，见上一段的
取舍。`docs/deployment-and-local-configuration.md`「Tenant console go-live in
production」一节已同步移除 `AGENT_TENANT_ID` 这一步。
