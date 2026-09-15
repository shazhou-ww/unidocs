# 租户登录全覆盖 · 设计

日期：2026-09-15。状态：设计已口头确认，书面规格待 review。
分支：`feat/tenant-login`（基于 `5257ac31`，即 #67 合入后的 main）。

本文替换 2026-09-14 的 `tenant-login-design.md` 及其计划。那一版写于 #67
合入之前，其前提（租户 API 未接入 worker、会话认证不存在）已不成立，
其 `0012` 迁移号也已被 `0012_tenant.sql` 占用。

---

## 1. 现状（main @ 5257ac31）

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
  - 否则 → cookie `__Host-unidocs_tenant` + D1 `portal_tenant_sessions`，
    非 GET/HEAD/OPTIONS 另要求 `Origin` 同源与 `x-csrf-token`。
- **bearer 不能写。** `tenant/tenant-http.ts` 每个写 procedure 调
  `forbidBearerWrite`；`tests/tenant/tenant-http-bearer-walk.test.ts`
  遍历 `tenantApiContract` 证明这一点。
- **授权粒度是租户。** 仓储按 `tenant_id` 过滤；`principalId` 只用于作者
  字段与幂等收据，没有文档级 ACL。
- **admin 与 MCP 已有独立认证**，本设计不触碰。

### 1.2 缺的

1. **生产上拿不到租户会话。** 会话唯一的签发点是
   `tenant/session-http.ts` 里的 loopback 自动签发：origin 为 loopback 且
   请求未携带有效会话时，无条件签发固定的 `t-local` / `user-local`。
   不存在登录端点。
2. **生产路由不存在。** `wrangler.production.jsonc` 只把 `/admin`、
   `/admin/*`、`/mcp`、两条 `/.well-known/*`、`/oauth/admin-mcp/*` 和
   `bundles.shazhou.work` 路由到 portal；`/portal*` 与
   `/api/v1/tenants/*` 落在 gateway 的 `unidocs.shazhou.work/*` catch-all 上。
   `worker.ts` 里也有注释明说「Production routes only /admin, /mcp and the
   OAuth paths to this worker」。
3. **没有身份到租户的映射。** 所有会话都是 `user-local`；不存在成员表。
4. **没有覆盖保证。** 现有 walk 测的是 `createTenantHttp` 这一层，而认证发生
   在它外面的 `serveTenant` 里。测 handler 证明不了「每条路由都被认证门挡住」。
5. **WebUI 未登录时没有出路。** `tenant-portal-webui/src/main.tsx` 在 401 时
   只渲染「需要登录后才能查看」，没有登录入口，也没有退出入口。

---

## 2. 目标与非目标

**目标**

- G1 租户面每一个 API 都要求真实身份（用户会话或 Agent bearer）。
- G2 生产上用户能用 Google 登录获得会话。
- G3 身份映射到租户与 principal；被移出名单的人下一个请求就失去访问。
- G4 有一条随契约与生产路由表**自动增长**的测试守门：新增路由若未被认证覆盖，
  测试变红，无需任何人记得去更新清单。

**非目标**

- Agent 凭据改造（仍为共享 token，生产未配置即全部拒绝）。
- gateway 主站（`/ui/*`、`/tenants/*`）的登录体系。
- 成员管理的后台页面。
- 文档级 ACL；租户内全可见保持不变。
- 一人多租户与租户切换。

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
| WebUI 外壳 | `/portal`、`/portal/`、`/portal/index.html`、`/portal/assets/*` | **公开**（外壳不含数据，数据全部经 API） | 加登录/退出入口 |
| admin API | `/admin/api/v1/*` | 管理员会话 | 新增 `tenant-members`，自动落在现有门后 |
| bundles | `bundles.shazhou.work/*` | **公开**（内容寻址的静态代码） | 不变 |
| admin / MCP 其余 | `/admin*`、`/mcp`、OAuth 路径 | 既有 | 不变 |

**关于「外壳公开」**：外壳是编译进 worker 的静态 HTML/JS，与 `/admin/login`
同性质。服务端给外壳加门需要每次读 D1，且挡不住任何数据（数据只经 API）。
因此外壳公开，门在 API 上。

---

## 4. 设计

### 4.1 数据：`packages/cloudflare-portal/migrations/0014_tenant_members.sql`

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

CREATE INDEX portal_tenant_session_principal ON portal_tenant_sessions(tenant_id, principal_id);
```

要点：

- **`portal_tenant_sessions` 不改结构。** 它已有 `tenant_id` 与
  `principal_id`，与成员表经 `(tenant_id, principal_id)` 关联；只补一个索引，
  供停用成员时按 principal 删会话。
- **`principal_id` 在邀请时生成**，形如 `user:<uuid>`，此后不变。
  `IdSchema` 是 `NonEmptyStringSchema`，允许冒号；`agent:markdown-primary`
  已是同样形状。
- **一人一租户**由两条全局唯一索引保证，因此登录时无需选择租户。
  以后支持多租户时，要把这两条索引改为按 `tenant_id` 分区，并在登录后加租户选择。

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
- 停用操作同时删除该成员的全部会话（同一 batch），不留僵尸行。
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
| returnTo 校验 | 必须以 `/portal/` 开头；拒绝 `/portal/auth/` 下的路径、`..`、百分号编码的路径段、控制字符与反斜杠、超过 2048 字节 |

**callback 算法**（步骤 1–3 只读；步骤 4–6 的全部写入在同一个 D1 batch 内提交，
任一失败则什么都不写，不会留下指向未绑定成员的会话）：

1. `createGoogleLogin.complete` 验证 state、PKCE、nonce、签名与 claims，
   得到 Google 身份。
2. 要求 Google 登录确认在 5 分钟内（复用 `requireRecentAuthentication`）。
3. 按活跃的 `(issuer, subject)` 找成员；找到即为已绑定成员。
4. 否则按活跃且未绑定的 `email` 找邀请行；要求确认时间不早于邀请的
   `created_at`（沿用 admin 的防护：阻止邀请之前签发的身份去认领邀请）。
   找到则写入 `issuer` / `subject`，`revision + 1`，审计 `member.bound`。
5. 两者都没有 → 拒绝（见下）。**没有自助开户。**
6. 签发会话行，审计 `session.created`，303 回 `returnTo`，
   同时下发会话 cookie、CSRF cookie，并清除登录事务 cookie。

**同一成员允许多个会话**（多设备）。新登录不踢掉旧会话。

**失败处理**

| 情况 | 响应 |
|---|---|
| 不在名单 / 身份不符 | 303 `/portal/?login=denied&requestId=…` |
| Google 往返校验失败 | 303 `/portal/?login=failed&requestId=…`，日志 `tenant_google_login_failed`，只记 `stage` / `reason` |
| 其他异常 | 303 `/portal/?login=failed&requestId=…`，日志 `tenant_operation_failed`，只记 `name` / `message` |

日志纪律与 `bff.ts` 一致：**绝不记录** stack、error 对象、token 或 client secret。

**路由接入**：`worker.ts` 的 `isTenantPath` 增加 `/portal/auth/login` 与
`/portal/auth/callback`，让两个登录端点与会话端点走同一个 `serveTenant` 出口
（同一套安全响应头与 `portal_request` 日志）。Google 配置只在这两个路径上读取。

**Google 配置缺失时**：登录端点返回 503 `login_not_configured`；租户 API 与外壳
照常服务。保留 `worker.ts` 现有的性质「缺 Google client 不应拖垮租户数据面」。

### 4.4 本地免登录开关

`tenant/session-http.ts` 的自动签发改为同时满足以下全部条件才生效：

- `env.PORTAL_TENANT_DEV_SESSION === "true"`；
- `isLocalDevOrigin(env.PORTAL_ORIGIN)`；
- 现有的三条：请求无 `Authorization`、请求 URL origin 与配置一致、
  非 `sec-fetch-site: cross-site`。

开关为 true 但 origin 不是 loopback 时：不签发，并记一次
`tenant_dev_session_ignored` 警告。

签发时先 upsert 开发成员行
`(tenant_id='t-local', principal_id='user-local', email='dev@unidocs.local',
issuer='local-dev', subject='user-local', added_by='dev-session')`，
使开发会话通过 4.2 的成员校验。`t-local` 与
`stacks/unidocs-cloudflare/local/runtime.mjs` 的 `LOCAL_AGENT_TENANT_ID` 一致，
本地 Operator 回路因此照常工作。

**默认关闭。** 生产 wrangler 配置中不声明该变量。

对测试与脚本的影响（已逐个核实引用 `/portal/auth/session` 的集成测试）：

| 文件 | 处理 |
|---|---|
| `tests/integration/cloudflare/portal-tenant-api.test.mjs` | 启动 runtime 时打开开关 |
| `tests/integration/cloudflare/portal-operator-loop.test.mjs` | 同上 |
| `tests/integration/cloudflare/portal-local-runtime.test.mjs` | 同上 |
| `tests/integration/cloudflare/portal-seed.test.mjs` | 同上 |
| `stacks/unidocs-cloudflare/local/runtime.mjs` | `startLocalRuntime` 新增 `tenantDevSession` 选项，映射到该 binding |
| `packages/cloudflare-portal/.dev.vars.example` | 增加注释说明该开关 |

`portal-cas.test.mjs` 只引用了 `t-local` 常量，不依赖自动签发，不需要改动。

### 4.5 admin API：`tenant-members`

契约加在 `packages/protocol-admin-portal`，`adminApiContract.tenantMembers`：

| procedure | 路由 | 要点 |
|---|---|---|
| `list` | `GET /admin/api/v1/tenant-members?tenantId=&cursor=&limit=` | 仅活跃成员；`tenantId` 可选 |
| `add` | `POST /admin/api/v1/tenant-members` | body `{ tenantId, email }`；必须带 `Idempotency-Key`；返回 `{ memberId, principalId, etag }` |
| `remove` | `DELETE /admin/api/v1/tenant-members/{memberId}` | 必须带 `If-Match` 与 `Idempotency-Key`；置 `active=0` 并删除其全部会话 |

- 错误码：`invalid_request` 400、`not_found` 404、`idempotency_conflict` 409、
  `tenant_member_exists` 409（该 email 已是某租户的活跃成员）、
  `precondition_failed` 412、缺 `If-Match` 为 428。
- 审计：`AdminAuditActionSchema` 增加 `tenant_member.added`、
  `tenant_member.removed`；`AdminAuditResourceTypeSchema` 增加 `tenant_member`。
- 分层照 `administrators`：service 在 `portal-service/src/admin/tenant-members.ts`，
  D1 仓储 `cloudflare-portal/src/tenant-members-repository.ts`，
  HTTP `cloudflare-portal/src/tenant-members-http.ts`，
  `worker.ts` 的 `adminApi` 分发加前缀 `/admin/api/v1/tenant-members`。
- 门：`bff.ts` 对所有 `/admin/api/v1/*` 先 `authenticate`，新端点自动在门后，
  与 `administrators` 同样要求管理员会话、写操作要求 CSRF。

**重新加入同一个 email**：`remove` 之后再 `add` 会生成新的 `member_id` 与
**新的 `principal_id`**。此人之前写的评论仍归属旧 principal。
（见 §8 开放问题 Q2。）

**seed**：`stacks/unidocs-cloudflare/local/portal-seed.mjs` 在注册 markdown 类型
之后，通过该 API 把 `PORTAL_BOOTSTRAP_EMAIL`（若已配置）加入 `t-local`，
使 `pnpm dev portal` 起来后可以直接走真实登录。已是成员时视为成功（幂等）。

### 4.6 WebUI（`packages/tenant-portal-webui`）

- 未登录提示页增加「使用 Google 账号登录」链接，指向
  `/portal/auth/login?returnTo=<当前 pathname + hash>`。
  hash 路由的位置因此在登录后得以保留。
- 读取 `?login=denied` / `?login=failed`，分别显示「这个账号还没有加入工作区」/
  「登录没有完成，请重试」，并显示 `requestId`；展示后用 `history.replaceState`
  去掉这两个参数，避免刷新重复提示。
- 侧边栏增加「退出」：`POST /portal/auth/logout`，带 `x-csrf-token`
  （复用现有 `readCsrfCookie`），完成后回到未登录提示页。
- `withSessionRefresh` 不变：会话过期时它重新探测一次，拿不回来就交给
  `onSignedOut`，现在 `onSignedOut` 展示的是带登录入口的页面。
- 改动后重新生成 `packages/cloudflare-portal/src/tenant-ui-assets.generated.ts`。

### 4.7 生产路由

`packages/cloudflare-portal/wrangler.production.jsonc` 的 `routes` 增加：

- `unidocs.shazhou.work/portal`
- `unidocs.shazhou.work/portal/*`
- `unidocs.shazhou.work/api/v1/tenants/*`

Cloudflare 以更具体的路由优先，这三条从 gateway 的 catch-all 中划出。gateway
使用的前缀是 `/admin/api/v1`（gateway 自有 admin，与 portal 的 `/admin*` 路由
早已并存）、`/ui/*`、`/tenants/*`，与新增三条无重叠。

同时删除 `worker.ts` 中「Production routes only /admin, /mcp and the OAuth paths」
那句已过期的注释，以及 `serveTenantWebUi` 注释中「tenant plane has no login yet」。

### 4.8 守门测试

这是本设计 G4 的落点，也是 review 最应该挑剔的部分。

**T1 契约遍历：`packages/cloudflare-portal/tests/tenant/auth-coverage-walk.test.ts`**

- 走 **`worker.fetch`**，env 使用 `tests/tenant/real-d1.ts` 的真实 D1，
  使请求经过 `serveTenant` 里真正的认证点。
- 被遍历的 procedure 集合 = `tenantApiContract` ∪ `agentApiContract` 的全部 procedure，
  从契约对象里递归读出，不手写。
- 每个 procedure 用一个能通过输入校验的 fixture（沿用 bearer walk 的写法：
  否则 400 会掩盖缺失的门）。
- 对 `tenantApiContract` 的每个 procedure 断言：
  1. 无任何凭据 → **401**；
  2. 另一租户成员的有效会话 → **403**（`requireTenantScope`）；
  3. 已停用成员的会话 → **401**（4.2）；
  4. 有效会话但 `sec-fetch-site: cross-site` → **403**；
  5. 非 GET：有效会话但缺 `x-csrf-token` → **403**；
  6. 对照组：本租户活跃成员的有效会话 → **不是** 400/401/403/404
     （证明上面的拒绝来自门，而不是 fixture 无效）。
- 对 `agentApiContract` 的每个 procedure 断言：无凭据 → **401**；
  本租户活跃成员的有效用户会话 → **403** `forbidden`
  （`tenant/agent-http.ts:189`：非 bearer 一律拒绝）；
  对照组：有效 bearer → 不是 400/401/403/404。
- **完整性断言**：被断言的 procedure 数量 = 两份契约 procedure 总数；
  fixture 表的键集合 = 契约 procedure 路径集合。契约新增 procedure 而未补
  fixture，测试直接失败。

**T2 生产路由遍历：`packages/cloudflare-portal/tests/production-routes-auth.test.ts`**

- 解析 `wrangler.production.jsonc` 的 `routes` 与 `vars`（去注释后 `JSON.parse`）。
- **env 取生产 `vars`**，再补上测试用的 D1 / KV / R2 binding 与 secrets 占位。
  这一点是必须的：本地 `wrangler.jsonc` 里 `MCP_ENABLED` 是 `"false"`，
  所有 MCP 路径返回 404；生产是 `"true"`，匿名 `/mcp` 应得到 401。
  用本地 vars 跑出来的结论对生产无效。
- 每条 route 展开为代表路径：精确路由取其本身；`/*` 路由取前缀下的
  一组样例（`/portal/*` 取 `/portal/`、`/portal/auth/session`；
  `/api/v1/tenants/*` 取契约里每条路径代入样例参数）。
- 以匿名请求打 `worker.fetch`，期望结果属于以下之一：
  - 401 / 403；
  - 303 且 `Location` 指向登录页；
  - 命中测试文件内的**显式公开白名单**。
- 公开白名单（全部写在测试里，改动需评审）：
  `/portal`、`/portal/`、`/portal/index.html`、`/portal/assets/*`、
  `/portal/auth/login`、`/portal/auth/callback`、`/admin/login`、
  `/admin/access-denied`、`/admin/assets/*`、`/admin/auth/login`、
  `/admin/auth/callback`、`/.well-known/oauth-protected-resource/mcp`、
  `/.well-known/oauth-authorization-server`、`/oauth/admin-mcp/*`、
  `bundles.shazhou.work/*`。
- **完整性断言**：每条 route 至少产生一个样例；出现未被样例覆盖的 route
  则失败。今后在生产配置里加路由而没想清楚它的认证，这里会变红。

**T3 其余单测**：成员绑定 / 拒绝 / 确认时效；callback 各失败分支的 303 目标；
returnTo 校验；开关四种组合；`tenant-members` 的幂等、ETag、审计、
「停用即删会话」；WebUI 的登录链接 returnTo、`?login=` 提示与退出。

### 4.9 可观测

- 所有租户响应沿用 `serveTenant` 已设置的 `Cache-Control: no-store`、
  `X-Content-Type-Options`、`Referrer-Policy`、`Content-Security-Policy`、
  `X-Request-ID`。登录端点纳入 `serveTenant` 同一出口，不另起一套。
- 新增日志事件：`tenant_google_login_failed`、`tenant_dev_session_ignored`。
  `portal_request` 行照旧记录每个请求的 path 与 status。

---

## 5. 迁移与兼容

- **生产**：此前没有租户路由，因此没有租户数据、没有租户会话，
  上线不需要数据迁移。上线顺序：应用迁移 → 部署 worker（含新路由）→
  用 admin API 邀请第一个成员 → 该成员登录。
- **本地已有数据**：作者为 `user-local` 的文档与评论保留。打开开关后开发会话
  仍是 `user-local`，与旧数据一致；用真实 Google 登录则是新的 principal，
  能看到同租户的全部文档（租户内全可见），但作者显示为另一个人。
- **`pnpm dev portal` 行为变化**：默认不再自动登录。开发者要么配置
  `PORTAL_BOOTSTRAP_EMAIL` 并走真实登录（seed 已将其加为成员），要么在
  `.dev.vars` 打开开关。`docs/deployment-and-local-configuration.md` 需同步说明。

## 6. 外部前提（需人工完成）

1. Google Cloud Console 为 `GATEWAY_OIDC_CLIENT_ID` 增加授权回调：
   `https://unidocs.shazhou.work/portal/auth/callback`，以及本地 dev 的 loopback
   回调地址。**不加则 callback 必定失败。**
2. 部署前执行 `wrangler d1 migrations apply`（`wrangler deploy` 不会自动应用）。
3. 用 admin API 邀请第一位租户成员。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 新增生产路由从 gateway catch-all 抢走路径 | 已核对 gateway 前缀无重叠；上线后抽查 `/ui/*`、`/tenants/*` |
| 改 `PortalGoogleConfig` 形状牵动 admin 登录 | 先改并跑通 admin 登录测试，再动租户 |
| 默认关闭开关改变本地开发习惯 | seed 自动加成员；`.dev.vars.example` 与部署文档写明 |
| T2 解析 jsonc 过于脆弱 | 只去除 `//` 行注释与块注释；解析失败即测试失败，不静默跳过 |
| 每请求多一次 JOIN | 走主键与新增的 `(tenant_id, principal_id)` 索引 |

## 8. 待 review 确认的开放问题

- **Q1 一人一租户。** 两条全局唯一索引简化了登录，但以后要支持多租户，
  需要改索引并在登录后加租户选择。是否接受？
- **Q2 重新加入后换 principal。** remove 后再 add 会产生新的 `principal_id`，
  历史评论不再归属此人。备选：`add` 遇到同一租户下已停用的同 email 行时复活原行，
  保留 principal。当前设计选「换新」，理由是停用可能意味着账号易主。
- **Q3 多会话。** 允许同一成员多设备同时登录；停用成员时一并清除。
  是否需要「新登录踢掉旧会话」？
- **Q4 外壳公开。** 外壳不设服务端门，理由见 §3。是否接受？
- **Q5 T2 的公开白名单**是否完整、是否有不该公开的条目？
