# UniDocs Admin Portal Cloudflare 实现计划

状态：待审查  
基线：`b58689b`  
范围：只实现 Cloudflare Admin Portal，不实现 Azure、Tenant Portal、Agent/document 数据面或 thumbnail service。

## 1. 目标

在不修改现有 Gateway 包的前提下，实现 Admin Portal 的完整纵向闭环：

```text
@unidocs/admin-portal-webui
  -> @unidocs/admin-portal-client
  -> @unidocs/protocol-admin-portal

@unidocs/cloudflare-portal
  -> @unidocs/portal-service
  -> @unidocs/protocol-admin-portal
```

本期交付：

- `@unidocs/protocol-admin-portal` 中 26 个 Admin v1 operation 的真实实现；
- 文档类型、Document Contract、Type Card/View bundle、Operator、管理员与审计；
- Bearer 与同源 Admin session cookie 两套鉴权，mutation cookie 路径强制 CSRF；
- D1 权威数据、R2 不可变 bundle、Cloudflare Worker/BFF 和静态 WebUI；
- 与当前 Admin mock 对齐的真实 React WebUI；
- 本地 Cloudflare stack、迁移、集成测试与部署 smoke。

## 2. 明确不做

- 不创建 `@unidocs/tenant-portal-client` 或 `@unidocs/tenant-portal-webui`；
- 不创建 `@unidocs/azure-portal`，不设计 PostgreSQL/Blob adapter；
- `@unidocs/portal-service` 本期不依赖 `@unidocs/protocol-platform`；
- 不实现 tenant、document、version、thread、ping/pong、submission、CAS retain 或 Operator outbox；
- 不实现 View Host、View bundle runtime 或 thumbnail 生成服务；本期只验证和托管双入口 View bundle；
- 不迁移、不复用或重命名现有 `gateway-common`、`web-gateway`、`cloudflare-gateway`、`azure-gateway`；
- 不提供旧 Admin API 兼容层。

## 3. 实现前技术决策

以下决策必须在冻结首份 D1 migration 前完成，并以测试固定：

1. 选择 Workers 与测试环境都可用的 RFC 8785 canonical JSON 实现，验证 ETag、schema hash 和 contract hash 测试向量。
2. 确定 D1 多行原子写与 `DocumentContractIdx` 分配策略，证明并发 append 不会重复 idx 或留下部分记录。
3. 确定管理员首次 bootstrap、OIDC issuer/subject 绑定、成员失效和最后一名管理员保护流程。
4. 确定 Admin Bearer 的 issuer、audience、JWKS 配置及 cookie session 有效期、轮换和撤销策略。
5. 确定 bundle 上传总大小、文件数量、单文件大小、解压后总大小、压缩比、路径长度和允许 MIME 列表。
6. 确定 Operator validation 的 SSRF、DNS rebinding、redirect、超时、响应大小、签名 probe 和 validation TTL 策略。

这一步只做最小 spike 和行为测试，不先搭建完整抽象。无法在 D1 中证明所需原子性的方案不得进入正式 repository 实现。

## 4. 包职责

### `@unidocs/portal-service`

云中立 Admin 业务核，不包含 Worker、D1、R2、OIDC callback 或静态资源逻辑。

建议结构：

```text
src/
  admin/          26 个 operation 的 application services
  bundles/        ZIP 安全校验、manifest 校验、内容身份
  operators/      validation 与持久候选项规则
  auth/           已认证 Admin context 与授权策略
  ports/          unit of work、bundle store、operator probe、clock、ID/hash
  http/           oRPC contract implementation 与错误映射
tests/
  admin/
  bundles/
  operators/
  contract/
```

业务 mutation、idempotency receipt 与 audit event 必须在同一 unit of work 中提交。R2 写入和 Operator 网络 probe 不伪装成数据库事务；需要跨请求状态时使用明确的 reservation/cleanup 流程。

### `@unidocs/cloudflare-portal`

唯一 Cloudflare 部署单元，拥有：

- Worker fetch 入口和 `/admin/api/v1/*` 路由；
- Admin OIDC/BFF、session cookie、CSRF 与 Bearer 验证；
- D1 schema、migration 与 repository adapter；
- R2 bundle store 和不可变 bundle ingress；
- Admin WebUI 静态 assets；
- 绑定类型生成、结构化日志与部署配置。

新项目使用 `wrangler.jsonc`，实现前从当前 Wrangler schema 和 Workers types 生成 `Env`，不手写 binding interface。大 ZIP 和 bundle 文件使用有界流式处理；请求状态不能保存在模块级可变变量中。

### `@unidocs/admin-portal-client`

薄 HTTP client，一项 contract operation 对应一个方法。client 持有 base URL 和 credential transport，负责：

- JSON、ZIP stream 与 query/path/header 编码；
- cookie mutation 的 CSRF、`Idempotency-Key` 和 `If-Match`；
- typed success response 与稳定的 typed API error；
- 不实现业务 workflow，不缓存资源，不自行计算 ETag。

### `@unidocs/admin-portal-webui`

纯浏览器 React/Vite 包，只依赖 Admin client，不直接依赖 service、D1、R2 或 Worker types。页面与当前 mock 对齐：文档类型、六个详情 tab、管理员和审计；所有数据来自真实 API。

Cloudflare 包只在构建阶段消费 WebUI 产物，浏览器包不反向依赖 Cloudflare adapter。

## 5. 分阶段交付

### Phase 0：技术 spike 与 contract fixtures

- 为 canonical JSON、ETag、schema/contract hash 建立共享测试向量；
- 用最小 D1 测试证明 append idx、conditional update、idempotency 与 audit 的原子性；
- 固定 ZIP adversarial fixtures 与 Operator SSRF fixtures；
- 输出第 3 节六项决策的短 ADR 或更新本计划。

退出条件：原子写、hash 一致性和安全限制都有可执行测试；没有未决项会改变 D1 主键或公开 contract。

### Phase 1：四个新包骨架与边界测试

- 创建 `portal-service`、`cloudflare-portal`、`admin-portal-client`、`admin-portal-webui`；
- 加入 workspace、TypeScript project references、build/test/typecheck/clean scripts；
- 固定依赖方向，禁止新包依赖旧 Gateway 或 Azure 包；
- 建立最小 Worker、client 和 WebUI test harness。

退出条件：四包空实现可 build/typecheck，边界测试能对错误依赖失败。

### Phase 2：Admin service 基础语义

- 实现统一错误映射、request ID、Admin context、cursor、clock 和 ID ports；
- 实现强 ETag、`If-Match`、idempotency fingerprint/receipt；
- 实现 audit redaction 和 mutation-with-audit unit of work；
- 先用内存测试 adapter 驱动 cloud-neutral 行为测试。

退出条件：并发条件失败、幂等重放/冲突、事务回滚和审计脱敏均有测试。

### Phase 3：文档类型与 Document Contract

- 实现 register/list/get/patch document type；
- 实现 paired contract append/list/get；
- 校验 SValue dialect、canonical hashes、零基 idx 和 append-only；
- 实现 View/Operator contract 支持交集与 enable 前置条件。

退出条件：相关 7 个 operation 通过 contract、领域和并发测试。

### Phase 4：Type Card 与 View bundle

- 实现有界 ZIP ingestion、zip-slip/zip-bomb/重复路径防护；
- 校验 Type Card locale、图标和 sample thumbnail；
- 校验 View 的 `interactive`/`thumbnail` 双入口、路径与支持 revisions；
- 计算内容身份，写入 R2 不可变对象并持久化 canonical `bundleUrl`；
- 实现两类 bundle 的 upload/list/get/metadata patch。

退出条件：8 个 bundle operation 通过；重复内容、失败清理、不可变缓存 header 和恶意 ZIP fixtures 通过。

### Phase 5：Operator、管理员与审计

- 实现 Operator discovery/probe validation、TTL record 和 candidate creation；
- 实现 Operator list/get/metadata patch；
- 实现管理员 bootstrap/list/get/add/remove；
- 实现不可删除自身/最后管理员约束；
- 实现可过滤、稳定 cursor 分页的 Admin audit。

退出条件：剩余 11 个 operation 通过；SSRF、过期 validation、成员竞态和审计过滤测试通过，26 个 operation 全部有真实 handler。

### Phase 6：Cloudflare adapter 与认证入口

- 建立 D1 migrations 和 repository adapter；
- 建立 R2 adapter、bundle ingress 与稳定 public origin；
- 实现 Bearer 优先且失败不 fallback cookie；
- 实现 OIDC authorization code + PKCE、hashed session、`__Host-` cookie、CSRF、logout；
- 通过 Worker adapter 暴露 oRPC/OpenAPI handler，限制 CORS 与安全 headers；
- 生成 Worker binding types并启用结构化 observability。

退出条件：Miniflare/Worker 集成测试覆盖两种鉴权、全部 mutation precondition、D1 migration 和 R2 round trip。

### Phase 7：Admin client 与真实 WebUI

- 先完成 26-operation typed client 与 transport tests；
- 将 mock 视觉与交互迁移到 React 页面；
- 实现 loading、empty、error、401/session expiry、409、412、428 和上传进度状态；
- bundle 详情明确展示 interactive/thumbnail 两个入口；
- 保留键盘操作、焦点恢复、移动端无重叠和基本可访问性。

退出条件：组件测试覆盖主要 workflow；浏览器中可完成类型创建、contract append、bundle 上传/绑定、Operator 配置、启用、成员管理与审计查询。

### Phase 8：Stack、部署与发布门禁

- 在 `stacks/unidocs-cloudflare` 增加 Portal 本地编排、deploy 和 smoke；
- 不替换现有 Gateway 部署，使用独立 Worker 名、D1、R2 和 hostname；
- smoke 覆盖登录、读取、一次幂等 mutation、一次 bundle fetch 和 audit correlation；
- 记录 rollback：Worker 版本回退、向前兼容 migration、不可变 R2 对象保留。

退出条件：全新环境可部署、smoke 通过、旧 Gateway stack 不受影响。

## 6. 验证命令

每阶段至少运行触及包的 focused checks：

```text
pnpm --filter @unidocs/protocol-admin-portal test
pnpm --filter @unidocs/portal-service test
pnpm --filter @unidocs/portal-service typecheck
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
pnpm --filter @unidocs/admin-portal-client test
pnpm --filter @unidocs/admin-portal-client typecheck
pnpm --filter @unidocs/admin-portal-webui test
pnpm --filter @unidocs/admin-portal-webui typecheck
```

合并前门禁：

```text
pnpm typecheck
pnpm test:local
pnpm check:cas-contract-docs
git diff --check
```

WebUI 完成后还需用 Playwright 在桌面与移动 viewport 验证主要 workflow、无文本溢出/遮挡，并检查浏览器 console。Cloudflare 配置与实现时重新查询当前 Workers 文档、Wrangler schema 和生成的 binding types，不依赖计划编写时的 SDK 记忆。

## 7. 完成定义

- `@unidocs/protocol-admin-portal` 的 26 个 operation 全部由 Cloudflare deployment 实现；
- Admin WebUI 不含 mock data，所有 mutation 都遵守 CSRF、idempotency 与 ETag；
- D1 是 Admin 关系状态唯一权威，R2 只存不可变 bundle 内容；
- audit 与业务 mutation 保持原子，日志和错误不泄漏 token、cookie、CSRF 或 bundle 原始内容；
- bundle URL 与内容身份稳定，View 双入口均经过上传验证并可从 ingress 获取；
- 新 Portal 可独立部署和回退，现有 Gateway、Azure、Tenant Portal 不发生行为变化。
