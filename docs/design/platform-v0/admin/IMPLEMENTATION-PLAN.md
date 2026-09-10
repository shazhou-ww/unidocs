# UniDocs Admin Portal Cloudflare 实现计划

状态：实施中，Phase 0 部分完成（2026-09-10）
基线：`b58689b`  
范围：只实现 Cloudflare Admin Portal，不实现 Azure、Tenant Portal、Agent/document 数据面或 thumbnail service。

## 当前进展与决策

线上 origin 已由用户确定为 `https://unidocs.shazhou.work`，代码默认配置已固定。Portal 的精确 Google redirect URI 为 **`https://unidocs.shazhou.work/admin/auth/callback`**。仓库 Gateway 配置中的旧 URI 是 `https://unidocs.shazhou.work/oauth/unidocs-cloudflare/login/callback`，保留旧 URI。用户已于 2026-09-10 确认新回调配置完成；这不是实际 Google 登录验收结果，仍需接通 BFF 后验证。

域名复用是对原计划“独立 hostname”的更新，不改变独立 Worker/D1/R2 的边界。当前 Gateway catch-all 与旧管理页面已占用 `/admin/`；未来路由切换会替换旧后台入口，需要在 Portal 完成后单独确认切换和回退。当前未修改 Gateway 路由、未部署 Portal，不接管旧 OAuth callback、`/ui/`、`/tenants/` 或文档 API。共同 origin 也不是浏览器安全隔离边界，bundle 内容仍需独立 origin。

2026-09-10：已落地内容身份、D1 原子写与安全 spike，并开始认证纵向闭环。`@unidocs/cloudflare-portal` 已有首份认证 migration、真实 D1 repository、BFF 和 Worker fetch 入口；**不代表 Phase 0 或 Phase 1 已完成**。尚无线上部署、client 或真实 WebUI，26 个 Admin contract operation 尚无真实 handler。

已验证：

- 认证先行已实现：`cloudflare-portal/migrations/0001_admin_auth.sql` 建立独立管理员、bootstrap marker、登录 state、session family/session、管理员审计和内部认证审计表，不包含 bundle/Operator schema。`auth-repository.ts` 在单个 D1 batch 中提交 bootstrap/身份绑定、session 创建和审计，失败全量回滚；登录 state 按 state hash/browser hash/TTL 原子消费。
- 当前重新认证策略为单管理员单活跃 session：新登录在同一事务内撤销该管理员所有旧 family、删除旧 session，再创建新 family/session；不做滑动续期。不同浏览器重新登录会使旧浏览器退出。邀请绑定要求认证时间不早于邀请时间，移除成员后 session 查询立即失效。session 只保存 token/CSRF hash；短期登录 state 中的 PKCE verifier/nonce 是服务端临时凭据，尚需过期清理任务。
- `bff.ts` 已连接 `/admin/auth/login`、`callback`、`session`、`logout`。callback 成功才提交身份及 session，设置 HttpOnly session cookie 和浏览器可读的 `__Host-unidocs_admin_csrf` cookie；POST logout 强制 cookie 鉴权、同源 Origin 和 CSRF。错误与响应使用 request ID、no-store/no-referrer/nosniff，失败不回显内部数据库错误。业务 API 路径仍返回 404，未伪造文档类型数据。
- `portal-auth-repository.test.mjs` 的 12 个真实 D1/BFF 测试通过，包括 bootstrap/绑定/并发、失败回滚、重新登录/logout、邀请后认证，以及 workerd 内跨请求并跨 Worker 重建的登录到退出流程。Google 响应仍为测试 RSA fixture，不代表真人登录已验收。
- 已新增 `wrangler.jsonc`、`worker.ts` 和 Wrangler 生成的 `src/env.generated.d.ts`。配置仅用于本地准备：无 routes、workers.dev/preview URLs 关闭、D1 ID 为本地占位值、Google client ID 和 bootstrap 邮箱为空；不能直接当生产配置部署。启用 nodejs_compat 和结构化日志，关闭自动 invocation logs，应用日志不含 callback query。缺少 Google 配置时 fail closed 返回 503。类型生成与 `wrangler deploy --dry-run` 通过，无线上写入。

- Operator 网络安全新增第一方 Service Binding spike：`cloudflare-portal/src/operator-transport.ts` 只从部署方登记的精确 canonical HTTPS base URL 选择 binding，调用其 `fetch`，没有公网 fetch fallback。请求 URL 不决定连接目标，因此不采用“先 DNS 检查再普通 fetch”的可重绑定方案。这里只证明一方 Worker 出口可行，不把公开 Operator API 永久限制为绑定服务；外部服务出口仍未实现。
- Operator 传输仅允许固定 discovery 路径和部署登记的 probe 路径；不跟随 redirect、不转发管理员 Authorization/cookie 或 CAS/Platform 委托凭据。probe body 最多 16 KiB、proof headers 合计最多 8 KiB、JSON 响应实际字节最多 64 KiB；总 deadline 5 秒覆盖 fetch 和整个 response body，超时取消响应流，即使对端忽略 signal 或 cancel hook 不结束也能返回失败。41 个单测覆盖恶意 URL、路径绕过、redirect、超限、延迟响应及凭据隔离。
- `tests/integration/cloudflare/portal-operator.test.mjs` 使用两个真实 workerd Worker 和 Service Binding，证明不可公网解析的请求 hostname 仍进入指定 Worker；未登记 URL、redirect 和过大响应被拒绝，传入 Portal 的用户凭据未被转发。尚无正式 Wrangler binding 配置；实际配置时再生成 Env。
- `portal-service/src/operators/discovery.ts` 复用协议 schema，拒绝未知字段、非登记 service identity、缺失/过期/弱配置 ETag、不一致类型声明及重复 revisions。对本次验证的文档类型要求所声明 revisions 已登记，其他类型不伪装成已验证；21 个业务测试通过。此函数只验证已解析 descriptor，不创建 successful validation row，原始 JSON 的歧义校验仍需在接线时复用严格解析器。
- Operator probe 当前仅有受控传输，不会把 HTTP 200 或任意 proof headers 当作签名成功。仓库 `service-auth/platform-hmac.ts` 固定使用 DocType 协议标识和 SValue content type，不能直接复用为 Operator JSON probe。Operator 的最终签名 wire format、回执/nonce 校验和双方服务身份验证仍须固定；本轮没有创建 probe 协议或更改旧服务。

- `packages/portal-service/src/identity.ts` 使用 `canonicalize@2.1.0` 与 Web Crypto SHA-256。入口拒绝非有限数字、非 JSON 值、循环引用和孤立 surrogate；不进行 Unicode normalization。测试固定 RFC 8785 序列化、UTF-16 属性顺序及空对象 SHA-256 向量。
- schema hash 为 `sha256:<lowercase hex>`；contract hash 的 canonical 输入固定为 `{ documentType, formatVersion, snapshot: { schema }, location: { schema } }`，不包含 idx、schema hash 或时间。ETag 为带双引号的 `sha256-<base64url>`，只排除资源顶层 `etag`。正式 service 仍须显式组装完整并发控制表示，不能把任意内部数据库行直接作为 ETag 输入。
- `tests/integration/cloudflare/portal-identity.test.mjs` 将同一实现以 browser target 打包到 workerd，对照 Node 结果；无需 Node crypto polyfill。
- `tests/integration/cloudflare/portal-d1-atomicity.test.mjs` 使用真实 Miniflare D1 binding：单个 `batch()` 中插入 actor/operation/key 唯一 receipt、条件更新计数器、插入 contract、audit 及最终 response。紧随条件 UPDATE 的 `changes()` 写入 `CHECK(valid = 1)` guard，让零行更新导致整批回滚。guard 行在同一 batch 内删除，不保留跨请求锁。
- D1 测试覆盖 24 路并发连续零基 idx、12 路同 key 重放、fingerprint 冲突、actor 隔离、旧 revision 竞争、重复内容、缺失类型及审计故障回滚。内存计数器不参与分配。内部 `last_idx = -1` 仅用于该 spike；公开未分配状态仍为 `null`。
- bundle 基础校验已覆盖原始路径穿越、绝对路径、反斜线、百分号编码、控制字符、URL query/fragment、非 NFC 路径以及 512 UTF-8 字节上限。ZIP 检查比较原始 UTF-8 文件名与库解析结果，不允许名称被静默重写。
- `portal-service/src/bundles/zip.ts` 使用 `@zip.js/zip.js@2.13.1`，严格目录/本地文件头校验、CRC 校验和重叠 entry 检查；禁止加密、symlink、非常规文件类型和非 Store/Deflate 方法。限制压缩输入 8 MiB、最多 512 个条目、单文件 4 MiB、解压总量 32 MiB、压缩比 100:1。预算只能收紧；同时校验声明大小与实际输出字节数。
- ZIP 中央目录需要随机访问，当前明确在 8 MiB 硬上限内暂存压缩输入，逐文件有界解压并计算 SHA-256；这不是任意大小的全流式 ingestion。更大的 bundle 应改为临时 R2 对象加 range reader，而非直接提高内存上限。当前函数只返回已验证文件清单和摘要，不写 R2、不发布 bundle。15 个真实 archive fixtures 覆盖重复路径、symlink、加密、文件/目录冲突、CRC 损坏、截断、目录/本地文件名冲突、伪造解压大小、zip bomb 和输入取消；workerd 实际验证 Deflate 与 CRC，无需 Web Worker。
- `portal-service/src/bundles/manifest.ts` 在同一 ZIP 扫描中读取最多 64 KiB 的根 manifest。复用协议 schema 并拒绝未知字段；通过 `jsonc-parser` 解析树拒绝重复 key（包括 Unicode 转义重名）、注释、尾随逗号和超深嵌套，严格 UTF-8 JSON 不接受 BOM。拒绝混合两种 bundle manifest、类型不匹配、缺少或空的引用文件、非规范路径。
- View 检查两个不同 `.html` 入口及非重复、已登记的 Document Contract revisions；Type Card 检查 `en` fallback、canonical BCP 47 locale、SVG/完整五尺寸 PNG 文件引用和 thumbnail 扩展名。此处只验证引用，不做图片解码、PNG 尺寸真实性、SVG/HTML/CSS 安全性或完整 MIME allowlist；测试中的部分图片是明确的 reference-only fixture，不能据此宣称 bundle 可安全发布。
- bundle `contentHash` 为 canonical `{ kind, manifest, files }` 的 SHA-256，`files` 按路径排序并包含非 manifest 资源的 path/size/sha256。ZIP 顺序、时间戳、manifest 空白和属性顺序不进入身份；资源字节/路径、manifest 字段变化会改变身份。返回 `canonicalManifest` 以及按 canonical 字节计算的 manifest 文件摘要；后续 R2 必须写入这些 canonical 字节，不能保留原始排版，否则同一身份会对应不同文件。内部逐文件回调不具备发布或事务语义。33 个 manifest 测试和 Node/workerd 一致性验证通过，尚未生成公开 bundle ID/URL 或持久化记录。
- `boundedBytes` 按实际 chunk 字节累计限制，超限或消费者提前退出时取消流并释放 reader；不依赖 Content-Length，不汇总整个 body。
- `portal-service/src/auth/administrator.ts` 固定 Google issuer、ASCII subject、已验证邮箱和近期认证策略。邮箱只 trim/lowercase，不合并 Gmail 点号或 `+tag`；绑定后以 issuer/subject 授权，不以邮箱匹配替代身份绑定。bootstrap 只允许显式配置的邮箱，并要求最近 300 秒内认证。
- `tests/integration/cloudflare/portal-membership.test.mjs` 验证 persistent singleton bootstrap marker、active email/identity 唯一索引、首次绑定及审计回滚、不可删除自身、邀请中的成员不能充当可登录管理员、互相移除的并发竞争及旧请求事务内再次授权。移除后重新邀请使用新 member ID，旧 session 不复活。
- 同一 D1 spike 还验证 session family 单次轮换、logout 撤销整个 family、logout/rotation 竞争不遗留后继 session、到期或成员失效禁止轮换、轮换审计失败保留旧 session，以及 browser-bound login state 的 TTL 和并发单次消费。这里的 SQL 仍是行为 spike，不是正式 repository 或公开 audit action 的扩展。
- `cloudflare-portal/src/auth.ts` 实现 JWT Bearer 与 session cookie 鉴权。Bearer 使用 `jose` 验证 RS256 签名、Google issuer、配置的 client audience、azp、exp/iat/nbf 与 `auth_time`；固定当前 Google JWKS URL，不读取 JWT 的动态 key URL。最大 token age 3600 秒、时钟容差 30 秒；JWKS 请求超时 5 秒，缓存 10 分钟、刷新冷却 30 秒。任何 Authorization header 的失败均不退回 cookie。
- session/CSRF 各使用独立 256-bit 随机值，持久记录只含 SHA-256 hash；session 绝对寿命 8 小时、不滑动续期。cookie 为 `__Host-unidocs_admin; Path=/; Secure; HttpOnly; SameSite=Lax`。每次读取 session 后重新查询有效成员；cookie mutation 必须同时匹配精确 Origin 与 CSRF hash，比较使用 `timingSafeEqual`。真实 D1/BFF 已接入登录替换 session 和 logout。
- `tests/integration/cloudflare/portal-auth.test.mjs` 以真实 RSA JWT 在 workerd 中验证 Bearer、cookie 和 CSRF，包括无 fallback；Cloudflare 鉴权模块使用 `node:crypto`，Worker 本地配置已启用 `nodejs_compat`，Env 已由 Wrangler 生成。生产资源及路由尚未配置。
- 按用户要求，Google auth 复用现有 Gateway 的 client ID、client secret 和 issuer。`cloudflare-portal/src/google-config.ts` 从 `GATEWAY_OIDC_CLIENT_ID`、`GATEWAY_OIDC_CLIENT_SECRET`、`GATEWAY_OIDC_ISSUER` 解析配置，缺少凭据或非 Google issuer 时拒绝。Portal origin 默认 `https://unidocs.shazhou.work`，测试可显式覆盖；redirect URI 固定为 `<Portal origin>/admin/auth/callback`，不读取 Gateway callback、session cookie 或 session encryption key。部署时将同源凭据配置到独立 Worker，不修改 Gateway 包，也不把 secret 发到浏览器。
- `cloudflare-portal/src/google-login.ts` 使用 `oauth4webapi` 完成登录启动及 authorization-code callback：S256 PKCE、独立 nonce、hashed state/browser cookie 绑定、600 秒 TTL、原子单次消费 port、返回路径校验、ID token 签名/issuer/audience/azp/nonce/时间校验。返回路径先解码再检查，拒绝跳出 `/admin/`、返回 auth 路由或编码绕过。Google discovery/token/JWKS 请求固定端点、禁止 redirect、超时 5 秒、响应最多 64 KiB，超过上限取消流。
- OIDC 模块在验证成功后返回身份与安全 return path，丢弃 Google access token；BFF 已接通管理员绑定、session 持久化和登录 cookie 清理。state 在 token exchange 前消费，失败后须重新登录，不能重放。模拟 Google 测试和 workerd 完整持久化登录流程通过，不等同于已联通真实 Google client。

Google OIDC 上线前提：在现有 Gateway Google client 的 authorized redirect URIs 中增加 `<Portal origin>/admin/auth/callback`，保留 Gateway 原有 URI。已查询 [Google 当前发现文档](https://accounts.google.com/.well-known/openid-configuration) 和 [官方 OIDC 文档](https://developers.google.com/identity/openid-connect/openid-connect)。`auth_time` 不在默认 discovery claims 中，官方说明须在认证请求中申请且在 Google 配置中启用。Portal 已发送 `max_age=300` 和 essential `auth_time` claim 请求，缺少该 claim 仍拒绝。Gateway 当前以 fresh authorization-code exchange 记录“登录确认”，Portal 不把这一语义当成 Google 近期重新认证证明，也不以 `iat`、`prompt=consent` 或重新选择账号替代。必须用现有实际 client 验证该 claim；若无法取得，需要另行决定可验证的 step-up 方案，不能静默放宽权限。复用 client 也意味着 audience 不再区分 Portal 与 Gateway，因此 Portal 自身的 issuer/subject 成员授权仍为必要条件。部署 token 与 Google OAuth client 凭据互不替代。

验证命令：

```text
pnpm --filter @unidocs/portal-service test
pnpm --filter @unidocs/portal-service typecheck
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
pnpm --filter @unidocs/cloudflare-portal types:generate
pnpm --filter @unidocs/cloudflare-portal deploy:check
pnpm exec vitest run tests/integration/cloudflare/portal-auth-repository.test.mjs --fileParallelism=false
pnpm exec vitest run tests/integration/cloudflare/portal-operator.test.mjs --fileParallelism=false
pnpm exec vitest run tests/integration/cloudflare/portal-d1-atomicity.test.mjs tests/integration/cloudflare/portal-identity.test.mjs tests/integration/cloudflare/portal-membership.test.mjs tests/integration/cloudflare/portal-auth.test.mjs --fileParallelism=false
```

当前业务核 134 个测试、Cloudflare 包 107 个测试、真实认证 repository/BFF 12 个测试，以及此前 D1 原子写 6 个、管理员/session spike 12 个和 6 个跨运行时测试通过。根目录 Miniflare 锁定的 workerd 最高支持 `2026-08-18`，测试继续使用该日期；新 Wrangler 配置使用 `2026-09-10`，已通过类型生成和打包 dry-run，生产运行仍待验证。

上一轮仓库级验证：`pnpm typecheck`、Admin protocol 的 20 个测试、`pnpm check:cas-contract-docs`（69 份文档）及 `git diff --check` 通过。`pnpm test:local` 未通过：639 passed、40 failed、44 skipped，20 个测试文件失败。失败涉及未修改的 Gateway `cloudflare:workers` 打包解析、compute-CAS redirect 断言、PSD 字体脚本 Windows 路径断言，以及 `protocol-doctype`/`tenant-browser-cache` 的 workspace alias 缺项；这些模块本轮未修改，合并门禁仍未全绿。

Phase 0 剩余门禁（按第 5 节已确认的认证先行顺序，对应功能冻结 schema/发布前完成）：

1. 用户已确认现有 Gateway Google OAuth client 的 Portal 回调配置完成；BFF session 持久化已接通，仍需生产 D1/secret/bootstrap 配置、受控认证路由与真人登录验证 `auth_time`，不能提前放宽近期认证。
2. 认证 repository 已独立实现且通过 D1 集成测试，查询过滤 revoked family/无效成员；剩余管理员 CRUD、业务 API precondition/idempotency/audit 接线和过期 state/session 清理仍待完成。
3. ZIP 解析库、大小限制、manifest/引用校验与 canonical 内容身份已落地；继续验证目录条目、本地额外字段/编码歧义及资源预算。尚需 MIME allowlist、图片实际解码/尺寸、SVG 与执行资源安全策略、R2 reservation/cleanup 和稳定 URL；不能把 manifest/引用检查通过当作 bundle 上传完成。
4. 第一方 Operator Service Binding 的固定目标、防 redirect、全程超时/响应上限已验证；外部 Operator 网络出口及 DNS rebinding 防护仍未完成，不能退回任意 URL fetch。接下来固定签名 probe wire format、nonce/回执和服务身份验证、validation TTL 及 D1 原子记录；传输或 discovery 单独通过都不产生成功 validation。
5. 将 D1 spike 推进到正式模型时，验证成员授权条件也在写事务内、公开 ETag 对应的 SQL 并发条件、幂等 receipt 保留期与响应重放、失败分类和审计脱敏；不得把所有 D1 异常统一当作幂等冲突。

本轮未读取 `cfg` 的 token，也未部署线上资源。待具备真实鉴权和可演示的纵向闭环后，使用独立 Portal Worker/D1/R2 部署，凭据仅在本地进程中传递。

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

以下决策按所属功能在冻结对应 D1 schema/发布前完成，并以测试固定。按第 5 节用户已确认的顺序，认证部分可先行独立 migration；bundle/Operator 的未决项不阻塞认证 schema，也不因认证先行而豁免。

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

勾选规则：`[x]` 表示该项实现及对应验证已完成；`[ ]` 表示未完成，包含注明的部分完成项。模块或 spike 完成不等于已接入真实 handler、已部署或整个 Phase 已通过；目前所有 Phase 的退出条件仍未全部满足。

执行顺序更新（2026-09-10，用户已确认）：优先打通真实登录、D1 管理员与文档类型最小纵向闭环，允许认证部分独立冻结首份 migration，不再等待 bundle/Operator 所有决策。第 3 节及 Phase 0 剩余项继续作为对应功能的 schema/发布门禁，不因先行认证 migration 而视为完成。认证 migration、repository 和 BFF 已落地并完成本地集成验证；下一步是受控真实登录验收与文档类型首个业务闭环。

### Phase 0：技术 spike 与 contract fixtures

- [x] 为 canonical JSON、ETag、schema/contract hash 建立 Node/Workers 共享测试向量。
- [x] 用最小 D1 测试证明 append idx、conditional update、idempotency 与 audit 的原子性。
- [x] 固定 ZIP 首批 adversarial fixtures：路径、重复条目、symlink、CRC、截断、伪造大小、zip bomb 和取消行为。
- [x] 固定第一方 Operator Service Binding 的目标、redirect、超时、大小及凭据隔离 fixtures。
- [x] 用 D1 spike 验证 bootstrap、身份唯一绑定、成员移除、session 轮换/撤销和单次登录 state。
- [ ] 完成剩余安全 fixtures：ZIP 目录/额外字段歧义、实际资源内容安全、外部 Operator SSRF 与签名 probe。
- [ ] 完成第 3 节全部六项技术决策；已验证结论已写入本计划，未决项见“Phase 0 剩余门禁”。

- [ ] **退出条件**：原子写、hash 一致性和安全限制都有可执行测试；没有未决项会改变对应功能 D1 主键或公开 contract。

### Phase 1：四个新包骨架与边界测试

- [x] 创建 `portal-service` 和 `cloudflare-portal`。
- [x] 为上述两包加入 workspace、TypeScript project references、build/test/typecheck/clean scripts。
- [x] 建立两包单元测试及 Miniflare/workerd 集成 test harness。
- [ ] 创建 `admin-portal-client`、`admin-portal-webui` 并完成 workspace、TS references 和 scripts 接线。
- [ ] 以边界测试固定依赖方向，禁止新包依赖旧 Gateway 或 Azure 包；当前实现未引入这些依赖，但尚无专门边界测试。
- [x] 建立正式认证 Worker 入口、生成 Env、Wrangler 本地配置和打包 dry-run 检查。
- [ ] 建立 client 和 WebUI test harness。

- [ ] **退出条件**：四包空实现可 build/typecheck，边界测试能对错误依赖失败。

### Phase 2：Admin service 基础语义

- [x] 实现已认证 Admin context、Google 身份绑定及近期认证策略。
- [x] 实现 canonical resource representation 的强 ETag 计算与测试。
- [ ] 实现统一 HTTP 错误映射、request ID、cursor、clock 和 ID ports；当前仅有模块级错误及部分注入式时钟。
- [ ] 实现正式 `If-Match`、idempotency fingerprint/receipt；D1 spike 已验证行为，尚未形成 application service/repository。
- [ ] 实现 audit redaction 和 mutation-with-audit unit of work；当前原子回滚仅在 spike 中验证。
- [ ] 用内存测试 adapter 驱动完整 cloud-neutral mutation 行为测试。

- [ ] **退出条件**：正式 service 的并发条件失败、幂等重放/冲突、事务回滚和审计脱敏均有测试。

### Phase 3：文档类型与 Document Contract

- [ ] 实现 register/list/get/patch document type。
- [ ] 实现 paired contract append/list/get。
- [x] 实现 schema/paired contract canonical hash 及测试。
- [ ] 在真实 append 服务中接入 SValue dialect、零基 idx 和 append-only 校验；协议校验与 D1 分配 spike 已有，handler 尚无。
- [ ] 实现 View/Operator contract 支持交集与 enable 前置条件。

- [ ] **退出条件**：相关 7 个 operation 通过 contract、领域和并发测试。

### Phase 4：Type Card 与 View bundle

- [x] 实现有界 ZIP 扫描、zip-slip/zip-bomb/重复路径防护；当前压缩输入最多暂存 8 MiB，不是无限大小流式 ingestion。
- [x] 校验 Type Card manifest、canonical locale、图标五尺寸文件引用和 sample thumbnail 引用。
- [ ] 校验图标/thumbnail 的真实图片内容、像素尺寸及 SVG 安全性。
- [x] 校验 View 的不同 `interactive`/`thumbnail` 入口、规范路径、文件存在性与已登记 revisions。
- [ ] 校验 MIME allowlist、HTML/JS/CSS 及资源加载安全策略。
- [x] 计算 canonical manifest 与资源文件清单的内容身份，验证 Node/Workers 一致性。
- [ ] 建立 R2 reservation/cleanup，写入不可变对象并持久化 canonical `bundleUrl`。
- [ ] 实现两类 bundle 的 upload/list/get/metadata patch。

- [ ] **退出条件**：8 个 bundle operation 通过；重复内容、失败清理、不可变缓存 header 和恶意 ZIP fixtures 通过。

### Phase 5：Operator、管理员与审计

- [x] 实现 Operator discovery descriptor 的 identity、配置 ETag、类型声明和 revisions 业务校验。
- [x] 验证第一方 Service Binding 受控传输与完整 I/O deadline；当前为未接入 handler 的实现切片。
- [ ] 实现外部 Operator 受控出口、签名 probe/回执验证、TTL record 和 candidate creation。
- [ ] 实现 Operator list/get/metadata patch。
- [ ] 实现管理员 bootstrap/list/get/add/remove 的真实 application service 与 adapter；已有身份策略和 D1 spike。
- [ ] 在真实成员 mutation 中实现不可删除自身/最后管理员约束；并发规则已由 D1 spike 验证。
- [ ] 实现可过滤、稳定 cursor 分页的 Admin audit。

- [ ] **退出条件**：剩余 11 个 operation 通过；SSRF、过期 validation、成员竞态和审计过滤测试通过，26 个 operation 全部有真实 handler。

### Phase 6：Cloudflare adapter 与认证入口

- [x] 建立认证部分 D1 migration 和 repository adapter，并通过真实 D1 集成测试。
- [ ] 建立其余 Admin 业务 D1 migrations 和 repository adapter。
- [ ] 建立 R2 adapter、bundle ingress 与独立稳定 bundle origin。
- [x] 实现 Bearer 优先且失败不 fallback cookie，并通过 Node/workerd 测试。
- [x] 复用 Gateway Google client 配置，固定 Portal origin 和独立 callback；用户已确认回调登记完成。
- [x] 实现 OIDC authorization code + PKCE、nonce、浏览器绑定和单次 state port，并通过模拟 Google/workerd 测试。
- [x] 实现 hashed session、`__Host-` cookie、CSRF 和逐请求成员有效性鉴权模块。
- [x] 接通 D1 state 消费、bootstrap/绑定、session family 创建与登录替换/撤销、BFF logout；当前采用单管理员单活跃 session。
- [ ] 完成过期登录 state、session 和撤销 family 的有界清理任务。
- [ ] 验证真实 Google 登录与 `auth_time`/近期认证配置；不以模拟 token 测试替代。
- [ ] 通过正式 Worker adapter 暴露 oRPC/OpenAPI handler，限制 CORS 与安全 headers。
- [x] 生成 Worker binding types 并配置结构化 observability；生产日志采集仍随部署验收。

- [ ] **退出条件**：Miniflare/Worker 集成测试覆盖两种鉴权、全部 mutation precondition、D1 migration 和 R2 round trip。

### Phase 7：Admin client 与真实 WebUI

- [ ] 完成 26-operation typed client 与 transport tests。
- [ ] 将 mock 视觉与交互迁移到真实数据驱动的 React 页面。
- [ ] 实现 loading、empty、error、401/session expiry、409、412、428 和上传进度状态。
- [ ] bundle 详情明确展示 interactive/thumbnail 两个入口。
- [ ] 保留键盘操作、焦点恢复、移动端无重叠和基本可访问性。

- [ ] **退出条件**：组件测试覆盖主要 workflow；浏览器中可完成类型创建、contract append、bundle 上传/绑定、Operator 配置、启用、成员管理与审计查询。

### Phase 8：Stack、部署与发布门禁

- [ ] 在 `stacks/unidocs-cloudflare` 增加 Portal 本地编排、deploy 和 smoke。
- [ ] 配置独立 Worker 名、D1、R2，复用 `unidocs.shazhou.work`；不替换现有 Gateway Worker。
- [ ] 确认并执行 `/admin/*` 切换及旧后台回退，验证其余 Gateway 路由保留。
- [ ] smoke 覆盖登录、读取、一次幂等 mutation、一次 bundle fetch 和 audit correlation。
- [ ] 记录 rollback：Worker 版本回退、向前兼容 migration、不可变 R2 对象保留。

- [ ] **退出条件**：全新环境可部署、smoke 通过、旧 Gateway stack 不受影响。

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
