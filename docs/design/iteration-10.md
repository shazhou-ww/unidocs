# Iteration 10：运营后台，管理员原子核心与名单 API

日期：2026-09-08。状态：首个实现切片完成本地验证，未部署、未提交 Git。不是可登录的生产管理后台；类型目录仍未实现。

后续更新：共享 Google 登录、管理 DO 和真实管理员页面已在 [Iteration 11](iteration-11.md) 接通并部署。本文的未接入项为首切片历史快照，当前状态以第 11 轮为准。

## 已实现

- [管理员核心](../../packages/gateway-common/src/admin-directory.ts)：邮箱规范化、一次性 bootstrap、经过上游验证的 Google 身份绑定、实时名单授权、自删保护、最后管理员约束、幂等增删和原子审计。
- [SQLite 适配](../../packages/cloudflare-gateway/src/admin-directory-sqlite.ts)：名单、初始化标记、审计及命令结果放同一事务。适配 ctx.storage.sql/transactionSync，不使用进程锁；构造时建立四个独立管理表，但当前未在生产入口构造。
- [管理 HTTP handler](../../packages/gateway-common/src/admin-handler.ts)：独立 `/admin/api/v1` 路径，可注入可信管理会话解析器；校验管理 origin、有效期、近期认证、CSRF、幂等键与删除 ETag；新增 JSON body 流式限制 4 KiB。错误不泄漏存储详情。

已经可独立调用并测试的 HTTP 路径：GET /session、GET /administrators、POST /administrators、DELETE /administrators/{adminId}。列表按邮箱分页，每条有删除 ETag 和 isSelf；不返回 Google subject/issuer。审计目前通过核心只读方法访问，尚未实现 HTTP 审计查询。

## 安全不变量

- 第一名管理员只能由受控 bootstrap 函数建立；没有 bootstrap HTTP 路由，没有“首次登录抢占管理员”。初始化和审计失败一起回滚。
- Google 身份只允许受信 Google issuer、verified email，首次绑定 issuer/sub 后，同邮箱其他 sub 不能继承权限。`bindGoogleIdentity` 的输入必须来自服务端验证过的 OIDC adapter；它本身不是 JWT 签名验证器。
- 会话使用不可复用的 adminId 关联当前名单；删除再添加同邮箱会得到新 ID，旧会话不能复活。当前实现没有另存 generation，唯一新 adminId 承担同等撤销边界。
- 每次命令以及原命令重试都在事务内重新检查操作者。两个管理员互删时至多一个成功，另一请求因操作者已失去资格拒绝。
- 审计或命令结果写入失败时，名单修改回滚。不以“删了但审计没写成”当成功。
- 同主体/key/规范请求重复返回原结果，不重复审计；同 key 异载荷拒绝。成功删除的重复请求在操作者仍有权限时仍能核实原结果。
- 绑定 Google 身份会增加名单 ETag；删除使用绑定前 ETag 必须重新读取，不能忽略并发变化。
- HTTP 写请求需同源与会话 CSRF，管理员操作需最近 15 分钟认证。普通 tenant 登录令牌不会自动获得管理权。

## 验证

```sh
pnpm --filter @unidocs/cloudflare-gateway exec vitest run tests/admin-directory.test.ts tests/admin-handler.test.ts
# 14 passed: 8 SQLite/domain + 6 HTTP
pnpm exec vitest run tests/integration/cloudflare/admin-directory.test.mjs --fileParallelism=false
# 1 passed: real workerd SQLite, concurrent requests, graceful restarts
pnpm --filter @unidocs/gateway-common --filter @unidocs/cloudflare-gateway typecheck
# passed
pnpm --filter @unidocs/gateway-common --filter @unidocs/cloudflare-gateway test -- --silent
# 70 + 39 passed; includes the 14 new tests
```

共 110 条通过（14 条已计入包回归，不重复加算）。Node SQLite 测试覆盖磁盘关闭重开、双连接交错操作；真实 workerd 测试发起并发请求并两次重启，验证名单保留、审计异常回滚、重复结果与旧身份失效。这不是强杀进程或断电测试，也不是生产 Google 登录测试。

[测试探针](../../tests/integration/cloudflare/admin-directory-probe.ts) 允许直接传入测试身份并注入审计失败，仅在隔离 Miniflare 测试打包，绝不能挂到生产路由或注册为管理登录入口。

## 尚未接入

- 真实 Google callback、独立 cookie/session 存储、最近认证流程、退出及撤销会话端点。当前 HTTP handler 的 currentSession 是注入端口，测试用虚构会话。
- 生产 DO namespace/export/binding 和迁移、受控初始化命令、首位管理员配置、管理 origin。当前 Worker 不导入管理适配器或分派管理 handler，生产默认不开放。
- 真正管理 WebUI、薄客户端、类型 URL 验证与切换、enabled 主站控制、完整审计/结果核实 HTTP API。HTML 原型仍是原型，未覆盖用户的原型文件修改。
- PostgreSQL 管理适配。当前事务回调是同步、禁止 thenable 的契约，不能把异步 SQL 查询直接塞入；Azure 实现必须提供等价的原子命令边界后再接入。
- 审计与幂等记录容量/保留/清理。当前没有过期回收，名单最多 1000 条，核心审计读取最多最近 100 条；这只是有界返回，不等于存储已做容量控制。生产启用前必须补齐，不能承诺无限保存。

## 下一切片

用户后续确认：管理后台先复用 UniDocs 同一个 Google client、登录和 callback，首版同源 `/admin/`，不再建设第二套 Google 登录。下一切片从现有服务端 Google 身份接管理名单授权与独立管理上下文，补齐可信认证时间等证明，不信任客户端自报身份；随后接管理员页面形成登录/名单/退出闭环。首位管理员邮箱已由用户指定为 `shazhou.ww@gmail.com`，不能从当前工作台身份猜测。本节更新不表示登录接入已经完成，上文已验证切片范围保持不变。

### Cloudflare 部署准备

- 建议首版地址：`https://unidocs.shazhou.work/admin/`，沿用现有 `unidocs-gateway` Worker；其现有 catch-all 路由已覆盖该路径，不需要新增子域名或 Google callback。该地址是部署目标，当前未实现管理页面路由，不是已上线入口。
- 2026-09-08 通过 cfg 检查 token 和 account ID 配置，Cloudflare `/client/v4/user/tokens/verify` 返回 `active`；未输出或落盘 token，未据此宣称所有部署权限已验证。
- 初始管理员：`shazhou.ww@gmail.com`。待管理存储和受控初始化命令接通后，只在尚未初始化时原子写入名单；不是硬编码永久超级管理员，不随部署重灌，不信任请求传入的邮箱。
- 本次没有执行生产初始化、创建 DO namespace、修改 Google secrets 或部署 Worker。正式上线前必须补齐 Google 管理上下文、真实管理员 UI、管理存储绑定/初始化和隔离回归；不能上传 HTML 沙盒或测试探针冒充真实后台。
- 单独子域名可留作后续安全隔离方案，但 host-only 登录 cookie 不会自动跨子域共享，需要额外的受控登录交接，首版不增加这项复杂度。路径不是安全隔离边界，同源方案仍需 CSRF、实时名单授权与严格内容隔离。

类型管理继续遵循 [精简 API](unidocs-admin-api-v0.md)：每种类型仅一个 base URL 和主站 enabled，服务 API/editor 相对该 URL；版本、发布与部署由微服务自行管理，不重新引入 service/editor/release 独立管理。