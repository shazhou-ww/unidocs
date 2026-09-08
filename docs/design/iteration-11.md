# Iteration 11：共享 Google 登录与真实管理员后台

日期：2026-09-08。状态：已部署管理员登录/名单/退出闭环；用户已确认真实 Google 登录成功，生产管理员增删不据此视为已验收。类型目录与审计页面尚未开放。

- 入口：https://unidocs.shazhou.work/admin/
- Worker：`unidocs-gateway`。
- 当前发布版本：`fcd1dc09-5707-4dee-8a06-25a0507ef346`（Google 返回后的管理会话兑换）；auth_time 兼容性修复为 `9ddd6b16-9d3b-4d98-aed5-77d159d724fc`，首次发布为 `65f3c141-2ed0-4b8f-8625-8d9205e31e52`。
- 新增 SQLite Durable Object：`UniDocsAdminControl`，绑定 `UNIDOCS_ADMIN`，migration `unidocs-admin-v1`。
- 用户指定首位管理员：`shazhou.ww@gmail.com`，通过部署变量在 DO 首次初始化时写入名单；已有初始化标记时忽略该变量，不随重启恢复被删除的管理员。无公开 bootstrap 接口。

## 已接通

[共享 Google 适配](../../packages/cloudflare-gateway/src/oauth-identity.ts) 继续使用原 client、secret、登录入口和 callback。普通用户身份返回结构不变；新登录绑定发起浏览器，管理可用身份还要求持久的一次消费 state、Google issuer、verified email 和本次授权码交换的新鲜度证明。旧 cookie 可用于普通工作台，但缺少这些证明时不能直接升为管理身份。

管理登录转入原 Google 流程并使用 prompt=select_account，不再请求 max_age=0 或强制依赖可选 auth_time。在已有签名/issuer/audience/nonce 校验后，检查 ID token 的 iat 落在本次登录事务窗口内（30 秒时钟容差）且 exp 未到期，再记录服务端完成交换的时间。cookie 标记 loginConfirmation=authorization-code-v1；内部兼容字段 authenticatedAt 现在明确表示这次登录确认时间，不是 Google 密码认证时间。创建管理会话不能重置该时间；不承诺重新输入密码或 MFA step-up。

[管理会话](../../packages/cloudflare-gateway/src/admin-auth.ts) 通过同源 POST `/admin/auth/session` 建立，要求 Origin 与自定义防跨站头。cookie 为 opaque `__Host-unidocs_admin`，Secure/HttpOnly/SameSite=Strict；数据库只存随机句柄的 SHA-256 哈希。绑定当前 Google loginId 和不可复用 adminId，当前名单每次请求重查。Google 切换身份或重新登录后，旧管理会话不继续有效。

会话上限 8 小时且不超过上游登录到期时间，空闲 30 分钟；敏感名单写操作要求上述 Google 登录确认距今小于 15 分钟。退出通过原 CSRF token 撤销服务器记录，清管理 cookie，不清普通工作台登录或本地草稿。

[管理 DO](../../packages/cloudflare-gateway/src/admin-control-do.ts) 集中保存名单、登录 nonce、管理会话、审计和幂等结果。Worker 在普通用户路由之前分派精确管理/Google 登录路径，不给管理响应加宽泛 CORS，不接受外部请求头作为管理员身份。未知管理路径和测试入口返回 404。原 D1、CAS 绑定、OAuth issuer/client/callback 与 secrets 保持不变。

[真实管理员页面](../../packages/web-gateway/src/ui/views/admin.tsx) 在 `/admin/` 按需加载，与普通工作台路由和 sessionStorage 分开。当前仅有管理员列表、添加、删除别人、退出、分页加载；本人删除禁用且服务端再次拒绝。写入网络结果不明时固定原 key/载荷重试，输入不允许继续更改。

没有使用 HTML 沙盒的模拟账号或类型数据；类型 URL 注册、主站开关和审计详情仍待接入，不显示不可用按钮冒充实现。

## 持久化与限制

- [会话存储](../../packages/cloudflare-gateway/src/admin-session-store.ts)：登录 nonce 最多 10,000 条，会话最多 1000 条；新建时清理过期记录，state 原子消费，空闲/绝对过期时拒绝会话。
- 管理员最多 1000 条，审计和幂等记录分别最多 100,000 条；达到上限则失败关闭，事务回滚名单变更。不静默丢审计或删除去重结果。
- 当前没有审计归档/导出和幂等过期清理；容量上限不是完整长期运维方案，接近上限需运维处理。幂等记录当前保留到容量上限，不提供自动回收。
- 同一 Google 登录事务的浏览器绑定 cookie 会被下一次登录覆盖，多标签页同时发起登录时较早流程可能被拒绝，重新登录即可；不接受无绑定旧在途回调。
- 同源 `/admin/` 不是浏览器 origin 安全隔离。管理页 CSP 禁止第三方脚本、iframe 嵌入、跨源连接，并继续依赖用户内容安全渲染与 CSRF。
- 管理 UI 未确认命令仅保存在当前页面内存；刷新、崩溃或离开重新认证不承诺保留原命令，需先核对名单，不盲目重复操作。跨刷新任务恢复与完整结果查询 UI 是后续工作。
- 核心审计已有持久记录，HTTP 审计页面尚未实现。Azure 管理存储仍未接入。

## 验证

```sh
pnpm --filter @unidocs/web-gateway --filter @unidocs/gateway-common --filter @unidocs/cloudflare-gateway test -- --silent
# 73 + 70 + 47 passed；之后追加容量边界测试并单独通过
pnpm --filter @unidocs/cloudflare-gateway exec vitest run tests/admin-directory.test.ts
# 9 passed（含新增容量边界）
pnpm --filter @unidocs/web-gateway --filter @unidocs/cloudflare-gateway typecheck
# passed
pnpm exec vitest run tests/integration/cloudflare/admin-control.test.mjs tests/integration/cloudflare/admin-directory.test.mjs --fileParallelism=false --silent
# 2 passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed
pnpm --filter @unidocs/cloudflare-gateway exec wrangler deploy --dry-run
# passed
```

包回归 190 条，加新增容量边界 1 条、真实管理 DO 集成 2 条，覆盖 193 条不同测试。已有测试的单独复跑不重复计数。JWT 测试使用真实 RS256 签名和现有 OIDC 验证器；集成使用真实 workerd/SQLite 与隔离的测试 Google provider，不是生产真人 Google 登录。

浏览器 localhost：1440px 桌面截图，820px 平板删除弹窗及无横向溢出；添加、取消/确认删除、自删禁用、退出通过。390px 只有设备提示。浏览器 UI 验收使用 localhost fetch 替身，不向生产发送名单写请求。

首次上线检查：HTML 200/no-store，未登录 session/list 401，原 OAuth metadata 200。管理登录两次 303 后指向 Google，callback 为 `/oauth/unidocs-cloudflare/login/callback`，当时包含 max_age=0，浏览器绑定 cookie 存在。只检查安全元数据，没有输出 state、nonce、cookie 或 token。该参数在后续修复中移除，见下节。

### Google 登录兼容性修复

用户实际登录遇到 `Google reauthentication required`。本地复现了缺少 auth_time 时被拒绝的路径；未读取用户 ID token，所以不把具体用户 token 的字段情况当作已观测事实。根本缺陷是把 Google 可选 claim 当作通用登录必须条件，测试提供方也错误地总是返回它。

[Google 官方 OIDC 文档](https://developers.google.com/identity/openid-connect/openid-connect) 将 iat/exp 列为始终提供，而 auth_time 需要请求并启用相关设置。因此本轮采用普通 Google 登录确认的语义，不声称实现强制近期密码认证。签名、邮箱验证、nonce、浏览器绑定、state 一次消费与管理员名单检查保持。

补测：缺少 auth_time 但有效 iat/exp 的登录通过；缺失、过旧、未来 iat 仍拒绝；消费过的回调不能重放。真实 workerd 集成提供方也移除 auth_time，整条登录/名单/退出/重启链路通过。Cloudflare Gateway 48 条测试、真实 DO 集成 1 条及部署构建通过。

修复已部署为当前版本。线上已确认 prompt=select_account、无 max_age、原 callback 路径不变，未登录 session 仍 401。真人需重新从 `/admin/` 发起登录，不能刷新已经消费过授权码的错误 callback 页面；最终真人登录成功仍待确认。

管理页 CSP 拦截 Cloudflare 自动注入的统计 beacon，浏览器记录一条 CSP 错误；这是第三方统计被禁止，不是主 UI 资源加载失败。未为了统计而放宽 script-src。

## 发布与后续

### Google 返回页面的会话兑换修复

用户完成 Google 登录后返回登录页，并看到 session 和 administrators 两个 401。代码核实：Google callback 只设置共享 `gw_sess`，页面初次挂载却直接并发读取管理 session/list；只有再次点进入才兑换管理 cookie，缺失回调自动接续。

修复：管理登录的站内 continue 指向 `/admin/?google=complete`。页面捕获并立即清除这个非敏感标记，先以同源 POST `/admin/auth/session` 兑换管理上下文，成功后按顺序 GET 管理 session、GET 名单。标记只是 UI 流程提示，不是身份凭据；后端仍验证 Google cookie 和实时管理员名单。

回调兑换失败只显示错误，不自动再跳 Google，避免循环；普通打开 `/admin/` 不自动兑换，退出管理后刷新不会立即重新登入。StrictMode 双 effect 通过在途标记保证只发一次兑换。没有会话时不再同时请求管理员名单。

验证：前端管理员/工作台路由共 11 条测试通过，新增回调兑换顺序、StrictMode 去重及拒绝不循环测试；真实管理 DO 集成验证 callback Location 带完成标记；前端类型检查和 Gateway 构建通过。已部署为当前版本，线上无 Google cookie 分支验证只发兑换、清标记、显示错误且不跳转；真人成功分支仍待用户重新 Google 登录确认。

Cloudflare beacon 的 CSP 拒绝不是本次 401 的原因，保留管理页第三方脚本限制；没有放宽授权或改动管理员名单。

部署使用 cfg 凭据，仅注入命令进程并于 finally 删除，执行 `wrangler deploy --keep-vars --strict`。新增管理 DO；没有修改原 D1 schema 或部署 doctype/CAS 微服务，没有启用实验 receipt 写入模式，没有操作用户生产文档。代码尚未提交 Git。

下一步：用户用 `shazhou.ww@gmail.com` 完成线上 Google 登录验收，然后实现精简的 URL 目录 API 和对应真实页面。原型中的 URL 验证仍是假数据，不能把测试域名登记到生产。