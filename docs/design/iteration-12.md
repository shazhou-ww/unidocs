# Iteration 12：文档类型目录后端切片

日期：2026-09-08。状态：本地实现和验证通过，未部署、未提交。用户已确认第 11 轮真实 Google 管理登录成功；本轮不修改生产账号、作品或服务路由。

## 实现

- [发现契约](../../packages/gateway-common/src/admin-type-contract.ts)：一个目录型 HTTPS base URL，固定相对 API/editor 路径、类型身份及展示信息；拒绝凭据、query、fragment、IP 字面地址与非标准端口。保留目录前缀，响应字段使用白名单。
- [目录核心](../../packages/gateway-common/src/admin-type-directory.ts)：批准地址的发现、验证记录、登记、更换 URL 和 enabled 配置。没有 service/editor/release 独立管理资源，不管理微服务版本或发布。
- [SQLite](../../packages/cloudflare-gateway/src/admin-directory-sqlite.ts)：三张新增表保存目录、验证记录、类型命令结果；与管理员授权和审计共用同步事务。审计失败时目录与命令结果一起回滚。
- [HTTP handler](../../packages/gateway-common/src/admin-handler.ts)：新增可选 types 依赖，提供 GET 列表/详情、POST 验证、GET 验证结果、POST 登记、PATCH 配置。未注入时返回 501 type_directory_unavailable。

目前管理 DO 没有注入该依赖，生产主站没有读取新表。因此这里的 enabled 只是尚未上线的目录配置，不会影响主站新建、编辑或路由。不能把数据库保存成功视为用户侧动态接入完成。

## 已验证约束

目录变更在同一事务重查当前管理员资格；验证期间管理员被删除时，不保存通过结果。验证绑定规范 URL、管理员、配置 ETag、部署策略和有效期（15 分钟）；更换输入、过期或配置变化均不能直接应用。登记/修改重试返回原结果，异载荷复用 key 拒绝。停用无需上游可达，重新启用或改地址必须验证。

发现仅允许部署端提供的精确 URL 及预期 docType/serviceId/storageIdentity/audience。请求不带用户凭据、拒绝重定向，描述最多 16 KiB，总时间限制 10 秒；探测 health 与 editor HEAD。描述的可选额外字段不能覆盖固定入口或注入管理字段。

目录最多 1000 项，验证记录最多 1000 项并在写入时清理过期，类型幂等记录最多 100,000 项。验证同 key/请求复用原记录；并发首次探测可能重复只读网络检查，但不会存两份不同结果。验证记录清理后不承诺原 key 永久去重。目录命令结果尚无过期清理。

## 必须保留的接入门槛

- 当前验证同步完成，成功 HTTP 200，并返回 Location；不是草案中的 202 后台任务。失败直接返回错误，不持久保存失败任务或验证审计。只有成功目录变更有原子审计。
- 当前部署策略中预期身份与上游描述相等，仅证明字段匹配，不证明真实存储连续性、历史作品兼容或完整 editor 握手。没有探测真实文档，不把 HEAD 200 当完整可编辑证明。
- 没有 DNS/IP 与连接目标绑定的 SSRF 保护。精确一方地址名单减少入口，但不能替代该检查；未接生产可编辑 allowlist 或 URL 验证端点。
- 保存使用短时验证快照，不在保存前重新读取远端描述。因此微服务在验证后变化仍需补检查/受控部署保证，当前不能直接开放生产 URL 切换。
- 描述协议及固定路径还需现有 Markdown/PSD 适配；未导入 DOC_SERVICES_JSON，也未切换主站路由来源。用户 API、主站能力发现、统一 iframe 和真实目录页面仍待接入。
- 已有作品的服务身份、在途创建/提交、停用后的读取/恢复、URL 切换的路由一致性必须在用户侧接入时验证，不能仅凭管理表测试宣称完成。

## 验证

```sh
pnpm --filter @unidocs/gateway-common --filter @unidocs/cloudflare-gateway test -- --silent
# 74 + 54 passed
pnpm --filter @unidocs/gateway-common --filter @unidocs/cloudflare-gateway typecheck
# passed
pnpm exec vitest run tests/integration/cloudflare/admin-directory.test.mjs tests/integration/cloudflare/admin-control.test.mjs --fileParallelism=false --silent
# 2 passed
```

共 130 条相关测试通过。新增 4 条契约测试、6 条 SQLite/HTTP 目录测试；workerd 管理探针补充验证记录跨重启、目录登记/停用回滚、幂等恢复及权限拒绝。上游发现使用替身，不是实际文档微服务或生产端到端验证。

下一步先让现有 Markdown 微服务提供统一发现与入口契约，再补生产 URL 验证和主站路由接入，最后开放真实目录页面。不将测试 example.com 地址登记到生产。