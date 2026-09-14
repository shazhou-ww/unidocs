# Tenant Portal 登录设计

日期：2026-09-14。状态：设计已确认，待实施。

## 问题

租户面（`/portal/`）没有登录。这不是坏了，是还没建：

- `@unidocs/protocol-tenant-portal` 的契约定义了 session cookie、`x-csrf-token`
  和 401 `UNAUTHORIZED`，但**没有任何 auth 端点**——没有 login/callback/session/logout。
- `packages/portal-service/src/tenant/*` 的业务核在，有单测，`TenantContext`
  也定义好了，但**没有任何 worker 接上 tenant API**：`cloudflare-portal` 里只有
  admin 一套 `*-http.ts`。
- WebUI 跑的是内存假数据（`tenant-portal-webui/src/main.tsx`：「本轮没有真后端」）。
- `cloudflare-portal/src/static-assets.ts` 的 `serveTenantWebUi` 注释写明
  「No authentication gate. The tenant plane has no login yet」。

所以光做登录没有意义——登录完还是假数据。本轮同时接上一个最小的真 API。

## 本轮范围

交付租户登录，外加**只读目录 API**，让登录后能看到真实数据，形成可验证闭环。

不做：documents / versions / threads / cas-capabilities 端点、Bearer（Agent）
通道、租户名单的后台 UI、域名→租户映射。

租户身份用 Google OAuth，复用 admin 已有的那套。租户归属用名单表 + 首登绑定。
本轮只有一个租户，id 固定 `t1`（与 WebUI 现有 mock 一致）。

## A. 生产路由（前提，当前缺失）

`packages/cloudflare-portal/wrangler.production.jsonc` 的 routes 只有
`/admin`、`/admin/*`、`/mcp`、`/.well-known/oauth-*`、`/oauth/admin-mcp/*`
和 `bundles.shazhou.work`。**`/portal/*` 从未路由到 portal worker**——生产上
它被 `packages/cloudflare-gateway/wrangler.toml` 的 `unidocs.shazhou.work/*`
catch-all 接走。提交 `5e82dd84` 加了服务代码，没有加路由。

本轮新增三条更具体的路由（Cloudflare 更具体者优先）：

- `unidocs.shazhou.work/portal`
- `unidocs.shazhou.work/portal/*`
- `unidocs.shazhou.work/api/v1/tenants/*`

gateway 实际使用的路径是 `/admin/api/v1`、`/ui/*`、`/tenants/*`，与上述三条
不冲突。

## B. 复用 `createGoogleLogin`，解耦两处写死的 admin

`cloudflare-portal/src/google-login.ts` 的 `createGoogleLogin` 已经按 surface
参数化（`beginPath`/`callbackPath`/`cookieName`/`returnParameter`/
`defaultReturn`/`validateReturn`），`createPortalGoogleLogin` 只是它的一个调用。
但有两处仍然假定调用方是 admin：

1. `const localWebUi = surface.cookieName === LOGIN_COOKIE && isLocalDevOrigin(config.origin)`
   ——用 cookie 名判断是否放行 loopback origin。租户 surface 换了 cookie 名，
   本地 dev 会直接抛 `Invalid Portal Google configuration`。
   改为只看 `isLocalDevOrigin(config.origin)`。
2. `portalGoogleConfigFromGateway` 把 `redirectUri` 硬编码成
   `${portalOrigin}/admin/auth/callback`，而 `createGoogleLogin` 又反过来断言
   `config.redirectUri === ${config.origin}${surface.callbackPath}`。
   把 `redirectUri` 从 `PortalGoogleConfig` 移除，由 `createGoogleLogin` 按
   surface 自算。这同时消掉了那条冗余断言。

两处都只是去掉 surface 耦合，admin 行为不变，`admin-google-login.test.ts`
守着回归。

## C. 数据：`packages/cloudflare-portal/migrations/0012_tenant_auth.sql`

照 `0001_admin_auth.sql` 的形状，四张表：

- `portal_tenant_members(member_id PK, tenant_id, email, issuer, subject,
  principal_id, active, revision, created_at, updated_at)`，
  活跃 email 与活跃 (issuer, subject) 各一个唯一索引，
  `CHECK ((issuer IS NULL) = (subject IS NULL))`。
- `portal_tenant_login_transactions(state_hash PK, browser_hash, verifier,
  nonce, return_to, created_at, expires_at)`，`CHECK` 生存期 ≤ 600s。
- `portal_tenant_sessions(session_hash PK, member_id, csrf_hash,
  identity_json, created_at, expires_at)`，`CHECK` 生存期 ≤ 8h。
- `portal_tenant_auth_audit(event_id PK, member_id, action, occurred_at,
  request_id)`，action 限 `session.created` / `session.revoked`。

**不与 admin 表共用。** 管理员与租户用户是两套主体；混一张表会让「管理员自动
成为租户用户」变成默认行为，是隐式越权。

## D. 业务核（`packages/portal-service`，保持 cloud-neutral）

新增 `src/auth/tenant-member.ts`：

- `BoundTenantMember`：`{ memberId, tenantId, principalId, email, issuer, subject }`
- `requireBoundTenantMember(identity, member)`：不在名单或未激活抛
  `TenantAccessError("forbidden")`；identity 与已绑定的 issuer/subject 不符
  同样 forbidden；首次登录（member 未绑定）允许并返回待绑定标记。
- 复用已有的 `requireRecentAuthentication`、`googleIdentityFromConfirmedLogin`、
  `googleIdentityFromVerifiedClaims`、`normalizeAdministratorEmail`
  （邮箱规范化抽成共用函数，避免两套规则漂移）。

`TenantContext` 已在 `src/tenant/access.ts` 定义，不新增类型。
从 `index.ts` 导出新符号。

## E. HTTP 层（`packages/cloudflare-portal`）

新增四个文件，命名与 admin 一侧对齐：

- `tenant-auth.ts`
  - cookie `__Host-unidocs_tenant`，CSRF cookie `__Host-unidocs_tenant_csrf`，
    登录事务 cookie `__Host-unidocs_tenant_login`
  - `createTenantSession` / `clearedTenantCookie` / `tenantTokenFromCookie`
  - `createTenantAuthenticator`：cookie → 会话 → `TenantContext`；
    非 GET/HEAD/OPTIONS 校验 `x-csrf-token` 与 `Origin`（timing-safe 比较），
    与 `auth.ts` 的 admin 实现同构。本轮 catalog 只读，CSRF 先建好备用。
  - 本轮不实现 Bearer 分支；`transport` 恒为 `"session"`。
- `tenant-auth-repository.ts`：`D1TenantAuthRepository`，
  `put`/`take`/`findSession`/`findMemberById`/`findMemberByIdentity`/
  `completeLogin`/`revokeSession`，形状照 `D1PortalAuthRepository`。
- `tenant-bff.ts`：`createTenantBff(config, repository, options)`
  - `GET /portal/auth/login` → 转 Google
  - `GET /portal/auth/callback` → 建会话，303 回 returnTo
  - `GET /portal/auth/session` → `{ tenantId, principalId, email, csrfToken }`
  - `POST /portal/auth/logout` → 撤销会话，204
  - `returnTo` 校验函数只接受 `/portal/` 开头、非 `/portal/auth*` 的路径
- `tenant-catalog-http.ts` + `tenant-catalog-repository.ts`
  - `GET /api/v1/tenants/{tenantId}/document-types`
  - `GET /api/v1/tenants/{tenantId}/document-types/{documentType}/document-contracts/{documentContractIdx}`
  - `D1TenantCatalogRepository` 读**现有**的 `portal_document_types` /
    `portal_document_contracts`，零新表。只返回 `enabled` 的类型。
  - 经 `createTenantCatalogService`，`requireTenantScope` 负责越权拦截。

`worker.ts`：在现有 `serveTenantWebUi` 调用处换成一个 tenant 面分发器，顺序为
auth 端点 → catalog API → WebUI（带认证门）。admin BFF 保持在其后不变。

## F. 认证门：要打破一条现有约定

`serveTenantWebUi` 现在的注释写着「**No SPA fallback list.** The tenant UI is
hash-routed…inventing path routes here would serve the shell on URLs the app
itself never produces」。登录必须破这一条：Google 回跳和 303 重定向只能落在
路径上，不能落在 hash 上。

- 新增两个路径路由 `/portal/login`、`/portal/access-denied`，都回同一个 shell。
- 其余保持 hash 路由不变，不做通配 fallback。
- `/portal/`、`/portal/index.html` 无有效会话 → 303 `/portal/login`。
- `/portal/assets/*` 不设门（静态资源，且 shell 本身要能加载登录页）。
- **那段注释必须同步改掉**，写清现在为什么有且只有这两个路径路由，
  否则会误导下一个人。

## G. WebUI（`packages/tenant-portal-webui`）

- `main.tsx`：先 `GET /portal/auth/session`；401 → `location.assign("/portal/login")`；
  成功才建 client 并渲染。
- 新增登录页与拒绝页组件，按 `window.location.pathname` 选择渲染，
  不改动既有 hash 路由。
- 侧边栏加当前邮箱与「退出」（POST logout 带 CSRF）。
- transport：新增 `createSplitTransport({ http, memory, httpPrefixes })`，
  把「哪些路径已经有真后端」显式列成一个数组（本轮只有 `/document-types`
  和 `/document-contracts`），其余仍走 `createMemoryTransport`。
  **代码里注明这是过渡态**，documents 等端点落地后逐条搬走、最终删掉这一层。
- CSP 已是 `connect-src 'self'`，同源调用不受影响，无需放宽。

## H. 错误与可观测

- 401 → 登录页；403（不在名单）→ `/portal/access-denied?code=forbidden&requestId=…`
- 登录失败沿用现有结构化日志形状，事件名 `tenant_google_login_failed`，
  只记 `stage` / `reason` / `requestId`。
- 与 admin 一样：**绝不记 stack、不记 error 对象**，避免 client secret 或
  token 随异常进日志。
- 每个响应带 `X-Request-ID`、`Cache-Control: no-store`、
  `Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。

## I. 测试

- `portal-service/tests/tenant-member.test.ts`：名单绑定、未激活拒绝、
  identity 不符拒绝、首登绑定、确认时效。
- `cloudflare-portal/tests/tenant-auth.test.ts`：cookie 缺失/重复/格式非法、
  会话过期、createdAt 越界、跨站、CSRF 缺失与不符。
- `cloudflare-portal/tests/tenant-google-login.test.ts`：登录往返，
  复用 `admin-google-login.test.ts` 的假 Google fetch 夹具。
- `cloudflare-portal/tests/tenant-catalog.test.ts`：仓储读取、
  `requireTenantScope` 越权、只返回 enabled。
- `tenant-portal-webui/tests/`：session 探测的 401 分支、split transport 选路。
- 本地 `pnpm dev portal` 跑通一次真实 Google 登录。

## J. 外部前提（需要人工完成，实施无法代劳）

1. Google Cloud Console 给现有 OAuth client（`GATEWAY_OIDC_CLIENT_ID`）增加
   authorized redirect URI：`https://unidocs.shazhou.work/portal/auth/callback`，
   以及本地 dev 的 loopback 回调。**不加则回调必失败。**
2. 部署前 `wrangler d1 migrations apply` 应用 `0012_tenant_auth.sql`。
3. 第一个租户成员入库（bootstrap 邮箱或手工 SQL），否则任何人登录都是 403。

## K. 风险

- **抢路由**：新增 `/portal/*` 与 `/api/v1/tenants/*` 会把这些路径从 gateway
  的 catch-all 划走。已核实 gateway 未使用这两个前缀，但部署后需确认主站
  `/ui/*` 与 `/tenants/*` 未受影响。
- **改 `PortalGoogleConfig` 形状**牵动 admin 登录。靠现有 admin 测试守，
  实施时先跑 admin 测试再动 tenant。
- **`__Host-` + `Secure` cookie 在本地 http**：Chrome/Firefox 视
  `http://localhost` 为安全上下文，可用；换成 `127.0.0.1` 以外的本地域名会失效。
