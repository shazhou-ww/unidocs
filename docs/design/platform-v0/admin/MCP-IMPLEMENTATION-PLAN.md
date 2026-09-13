# UniDocs Admin Portal MCP 实现计划

状态：read-only canary 已部署并完成 VS Code OAuth 与 read tools 真人验收（15 个 read tools、加密 transaction、成员重查与 code/refresh 单次消费已实现；refresh/revoke 与成员移除验收待完成）

日期：2026-09-12  
范围：为已上线的 26-operation Admin Portal 增加 OAuth 2.1 保护的 remote MCP；不改变 Tenant/Document 数据面，不把 UniCAS 作为运行时依赖。

## 1. 目标

让 GitHub Copilot、VS Code Agent 和其他支持 remote MCP OAuth 的客户端通过浏览器完成 Google 登录与管理员授权，然后以独立的 UniDocs access token 操作文档类型控制面。

```text
MCP client
  -> https://unidocs.shazhou.work/mcp
  -> Portal OAuth provider
  -> Admin MCP tool adapter
  -> @unidocs/portal-service
  -> Portal D1 / R2 / Operator Service Binding
```

必须满足：

- Agent 不接触 Admin WebUI cookie、CSRF token、Google token 或 Worker secret；
- `/mcp` 不接受 Google ID/access token，也不接受 Gateway/Tenant token；
- OAuth token audience 固定为 `https://unidocs.shazhou.work/mcp`；
- 每次 tool call 实时复查 `portal_administrators` 中的 active issuer/subject 绑定；移除管理员后立即失效；
- MCP mutation 与现有 HTTP/WebUI mutation 共享同一 service、repository、幂等、ETag、审计和并发约束；
- 首次上线先 read-only canary，再分别开启内容 mutation、发布 mutation与管理员安全 mutation。

## 2. 明确不做

- 不把 `__Host-unidocs_admin` session cookie 交给 Agent 或接受为 `/mcp` 凭据；浏览器 authorize 页面可以复用同源 Admin 登录状态；
- 不把 Google client secret、OAuth refresh token 或 HMAC key写入 MCP 配置；
- 不在 `@unidocs/*` 中依赖 `@unicas/*` 包；只复用已经生产验证的架构模式；
- 不提供绕过 ETag、确认参数、成员有效性或 enable readiness 的“强制”工具；
- 不允许 MCP 输入任意 Operator 私网目标或任意公网 fetch；继续只使用部署登记的 Service Binding；
- 不把 thumbnail、Tenant Portal、document/version/thread/CAS 数据面暴露给 Admin MCP。

## 3. 部署与 origin 边界

按用户决定复用 Admin WebUI origin：

```text
https://unidocs.shazhou.work/mcp
```

由 `unidocs-portal` Worker 增加比 Gateway catch-all 更具体的 route，但只接受以下精确路径：

```text
/mcp
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/oauth/admin-mcp/register
/oauth/admin-mcp/authorize
/oauth/admin-mcp/token
/oauth/admin-mcp/revoke
```

不接管任意 `/oauth/*`，尤其不接管 Gateway 的 `/oauth/unidocs-cloudflare/*`。Portal production routes 只新增 `/mcp`、两个精确 metadata path 和 `/oauth/admin-mcp/*`；其余 `unidocs.shazhou.work/*` 继续由 Gateway 处理，`/admin/*` 继续由 Portal 处理，`bundles.shazhou.work` 继续只承载不可变 bundle。

同源不是安全隔离边界，因此 dispatcher 必须额外强制：

- `/mcp`、token、register、revoke 路由剥离全部 Cookie；
- authorize GET 只保留 `__Host-unidocs_admin` 与 `__Host-unidocs_admin_mcp_consent`；consent POST 只保留后者，始终剥离 WebUI CSRF cookie；
- `/mcp` 与 token endpoint 不读取 Admin session；只有现有 `/admin/auth/login` 与 `/admin/auth/callback` 创建 Admin session，MCP authorize 不能写入该 cookie；Admin BFF 不读取 MCP consent cookie；
- 所有 MCP response 使用 `no-store`、`no-referrer`、`nosniff`；browser consent CSP 不允许第三方脚本；
- `MCP_ENABLED=false` 可让这些精确路径返回 404，不影响 `/admin/*` 或 Gateway catch-all。

Google client、client ID/secret 与 callback 全部复用现有 Admin WebUI 配置；不新增 Google redirect URI。

## 4. OAuth 2.1 流程

采用已在 UniCAS remote MCP 验证的组件版本与模式：

```text
@cloudflare/workers-oauth-provider 0.10.3
@modelcontextprotocol/server 2.0.0
agents 0.21.0
zod 4
```

实现保留在 `@unidocs/cloudflare-portal`，不从 `unicas-packages` import。

流程：

1. client 请求 `/mcp`，收到带 RFC 9728 metadata URL 的 401；
2. client 读取 protected-resource 与 authorization-server metadata；
3. public client 通过 RFC 7591 dynamic registration 注册 redirect URI；
4. `/oauth/admin-mcp/authorize` 要求 authorization code + PKCE S256，禁止 implicit/plain PKCE；
5. authorize 检查现有 Admin session；没有 session 时加密暂存 OAuth request，并跳转现有 `/admin/auth/login`；
6. 现有 `/admin/auth/callback` 完成 Google OIDC 校验、丢弃 Google access token、创建 Admin session，再通过严格限定的 `/oauth/admin-mcp/authorize?resume=...` 返回；
7. authorize 从 Admin session 取得 memberId/identity，并按 issuer/subject 复查 active administrator；不用 email 临时提升权限；
8. 显示 UniDocs consent 页面，明确 client name、四类 scope 和高风险能力；
9. consent POST 需要同源、一次性 CSRF、SameSite cookie；
10. client 用 code verifier 交换 UniDocs access/refresh token；
11. `/mcp` 只接受 OAuthProvider 验证过的 bearer token；
12. 每次 tool call 再用 grant 中的 memberId + issuer + subject 查询 active member。

### Token 生命周期

| 凭据 | 生命周期 | 规则 |
| --- | ---: | --- |
| authorization code | 5 分钟 | 单次使用，PKCE S256 |
| access token | 15 分钟 | audience 绑定 `/mcp` |
| refresh grant | 8 小时 | refresh token 单次轮换 |
| OAuth request/consent transaction | 10 分钟 | AES-GCM 加密存 OAUTH_KV，D1 单次消费 |
| dynamic client | 90 天无活动后可清理 | 删除 client 会使其 grant/token 失效 |

支持 RFC 7009 `/oauth/admin-mcp/revoke`。不把 token 存 D1 明文；OAuthProvider 的 client/grant/token hash 使用独立 KV。

## 5. Scope 模型

Scopes 不互相蕴含；client 必须显式请求，consent 页面逐项展示。

| Scope | 能力 |
| --- | --- |
| `admin:read` | whoami；所有 list/get；audit 读取 |
| `admin:content` | append contract；上传/编辑 Type Card/View；Operator validation、创建与 metadata |
| `admin:publish` | 创建 document type；绑定候选；启用/停用；修改内部名称 |
| `admin:security` | 添加/移除管理员 |

`update_document_type` 始终需要 `admin:publish`。若请求包含 `enabled`，还必须提供与目标值一致的 `confirmEnabled`。管理员 mutation 只接受 `admin:security`。

## 6. Tool catalog

总计 **27 个工具**：26 个 Admin v1 operation 加 `whoami`。

### Identity 与读取

- `whoami`
- `list_document_types`
- `get_document_type`
- `list_document_contracts`
- `get_document_contract`
- `list_type_card_bundles`
- `get_type_card_bundle`
- `list_view_bundles`
- `get_view_bundle`
- `get_operator_validation`
- `list_operators`
- `get_operator`
- `list_administrators`
- `get_administrator`
- `list_admin_audit_events`

以上均需 `admin:read`，设置 `readOnlyHint: true`、`destructiveHint: false`。

### Content candidate mutation

- `append_document_contract`
- `upload_type_card_bundle`
- `update_type_card_bundle_metadata`
- `upload_view_bundle`
- `update_view_bundle_metadata`
- `create_operator_validation`
- `create_operator`
- `update_operator_metadata`

以上需 `admin:content`。

### Registration/publish mutation

- `create_document_type`
- `update_document_type`

以上需 `admin:publish`。

### Administrator security mutation

- `add_administrator`
- `remove_administrator`

以上需 `admin:security`；`remove_administrator` 标记 `destructiveHint: true`。

## 7. Tool 输入规则

### 幂等

所有 create/append/upload/update/remove 工具都要求 Agent 显式提供 `idempotencyKey`，1..128 个 printable ASCII 字符。

MCP server **不自动派生或替换** key。原因：只有调用方知道一次逻辑意图的重试边界；自动从 payload 派生会把两次有意的同内容操作错误合并。

### ETag

以下工具必须显式接收当前 ETag：

- `update_document_type`
- `update_type_card_bundle_metadata`
- `update_view_bundle_metadata`
- `update_operator_metadata`
- `remove_administrator`

MCP server 不静默预取最新 ETag。412 时返回稳定 `precondition_failed`，提示 Agent重新 get 后由用户/Agent 决定是否重试。

### 高风险确认

- `add_administrator`: `confirmEmail` 必须规范化后等于 `email`；
- `remove_administrator`: `confirmAdminId` 必须等于目标 ID，`confirmEmail` 必须等于当前 GET 返回邮箱；
- `update_document_type` 包含 `enabled`: `confirmEnabled` 必须严格等于目标布尔值；
- 清除当前 Operator: `confirmOperatorId` 必须等于当前绑定 ID；
- 切换 Type Card/View/Operator 时要求非空 `reason`，继续由业务 audit 保存。

MCP annotations 只是客户端提示，服务端仍强制 scope、确认、ETag、成员资格和 readiness。

### ZIP 上传 v1

MCP JSON-RPC 无标准“读取客户端本地文件”能力。v1 的两个 upload tool 接受：

```text
base64Zip: 标准 base64（非 data URL）
```

约束：

- 解码后仍使用现有 8 MiB archive hard limit；
- encoded string 最大 `11,184,812` 字符，即 `4 * ceil(8 MiB / 3)`；
- 解码前验证 alphabet、padding 和精确长度，拒绝 whitespace/data URL；
- 不记录 base64、ZIP bytes、manifest 原文或文件名到日志/audit；
- 解码后包装为 `ReadableStream<Uint8Array>`，继续走现有 ZIP/manifest/asset/R2 reservation 实现；
- MCP request body 设置独立有界上限，避免通用 JSON parser 无界读取。

该方式能支持自动化，但不适合模型直接阅读大文件。Phase 2 可增加一次性直传票据：Agent/宿主把本地文件 PUT 到临时 R2 key，再用 tool 提交 ticket；票据绑定 actor/client/hash/size/TTL，publish 后消费。不得让 server fetch 任意 `sourceUrl`。

## 8. MCP 到业务核的调用边界

MCP handler 不通过公网 HTTP 回调自身，也不伪造浏览器 cookie。它直接构造现有 application service/repository：

```text
OAuth grant props
  -> resolve active administrator in D1
  -> AdminContext {
       transport: "bearer",
       memberId,
       identity,
       caller: { channel: "mcp", oauthClientHandle, toolName }
     }
  -> existing create/list/get/update service
  -> existing D1/R2/Service Binding adapters
```

WebUI/BFF 构造 `caller.channel = "admin-webui"`。`transport: "bearer"` 只描述凭据传输；caller channel 单独表示审计来源。

每个 tool schema 直接引用或组合 `@unidocs/protocol-admin-portal` 的 Zod schema，避免手写第二套字段约束。tool result 同时返回 machine-readable `structuredContent` 和简短 text，不把内部异常、token、cookie 或 upstream body 回显。

## 9. 审计与可观测性

新增 migration：

```sql
ALTER TABLE portal_admin_audit
  ADD COLUMN caller_channel TEXT NOT NULL DEFAULT 'admin-webui'
  CHECK (caller_channel IN ('admin-webui', 'mcp'));
ALTER TABLE portal_admin_audit ADD COLUMN oauth_client_handle TEXT;
ALTER TABLE portal_admin_audit ADD COLUMN tool_name TEXT;
CREATE INDEX portal_admin_audit_channel_page
  ON portal_admin_audit(caller_channel, occurred_at DESC, audit_event_id DESC);
```

所有 mutation repository 的业务写、receipt 与 audit 继续同 batch，并从 `AdminContext.caller` 写入：

- `caller_channel`
- `oauth_client_handle = sha256(client_id)`，不保存原始 client_id
- `tool_name`

扩展公开 `AdminAuditEvent` DTO 与筛选 query，使 WebUI/MCP 可按 channel/tool 查询。历史行 migration 默认 `admin-webui`。

每个 MCP tool call 另写结构化 Worker log：requestId、memberId、client handle、tool、scope decision、status、duration；不记录 tool 原始输入。读取调用不写业务 audit，以免将查询流量混入配置变更历史；OAuth grant/revoke 进入独立 auth/security log。

## 10. 文件与包计划

```text
packages/portal-service/src/mcp/
  catalog.ts                  27 个工具名、scope、annotations、确认 helper
  context.ts                  grant -> AdminContext caller attribution

packages/cloudflare-portal/src/mcp/
  config.ts                   origin、scope、kill switch
  auth.ts                     Google OIDC + consent + D1 member check
  authorization.ts            OAuth request -> Google -> consent -> grant
  authorization-transactions.ts  加密 OAuth/consent transaction
  server.ts                   McpServer tool handlers
  worker.ts                   OAuthProvider + createMcpHandler
  result.ts                   stable service/MCP error mapping

packages/cloudflare-portal/migrations/
  0008_mcp_audit_attribution.sql
  0009_mcp_refresh_consumption.sql
  0010_mcp_code_consumption.sql
  0011_mcp_authorization_transaction_consumption.sql

packages/admin-portal-webui/src/
  mcp-configuration-dialog.tsx
```

新增依赖只放在 Cloudflare adapter：

```text
@cloudflare/workers-oauth-provider 0.10.3
@modelcontextprotocol/server 2.0.0
agents 0.21.0
zod 4（仓库已有版本需锁定兼容）
```

新增 bindings/secrets：

```text
OAUTH_KV                     独立 namespace: unidocs-admin-mcp-oauth
OAUTH_STATE_ENCRYPTION_KEY   base64url 32-byte AES key
```

新增 vars/kill switches：

```text
MCP_PUBLIC_ORIGIN=https://unidocs.shazhou.work
MCP_ENABLED=false
MCP_CONTENT_MUTATIONS_ENABLED=false
MCP_PUBLISH_MUTATIONS_ENABLED=false
MCP_SECURITY_MUTATIONS_ENABLED=false
MCP_ALLOWED_ORIGIN_HOSTNAMES=
MCP_ADMIN_EMAIL_ALLOWLIST=shazhou.ww@gmail.com
```

MCP email allowlist 只作为 canary 附加门禁；每次请求仍以 D1 issuer/subject member 为权威。空 allowlist fail closed，不代表所有 Admin 成员自动开放。

## 11. 分阶段实施

2026-09-12 合并验证记录：第三至第六批已提交为 `9aae392`。本地整合 `origin/main` 时解决 Google 登录 profile、Worker 分派和生成 WebUI 资源冲突，保留远端 Tenant WebUI 与 WebUI loopback 登录支持，MCP 仍要求 HTTPS。Admin/Tenant WebUI 构建、226 项 Portal 包测试、22 项 MCP 集成、全仓 49 个项目 typecheck 和 CAS 文档检查通过。完整 `test:local` 实际结果为 932 passed、14 failed、10 skipped（9 个失败文件）；包括 Portal 本地 runtime 503、manifest 跨 runtime 比较、compute CAS、PSD 字体及脚本契约测试。失败原因未全部定性，不宣称都是历史问题；远端 push 暂缓，待修复或用户明确确认门禁豁免。未部署，MCP 保持关闭。

当前 checkpoint（2026-09-12）：`d7f4dcf` 已提交前两批工具契约、输入与成员校验、D1 原子审计归因及测试。本次 checkpoint 纳入第三至第六批 dispatcher、OAuth provider 工厂、D1 code/refresh 单次消费、真实成员查询和 MCP OIDC 核心，按用户要求提交并与 remote main 合并。最近验证：22 项 MCP 集成、171 项 Portal 包测试、2 项 WebUI BFF 回归及包级 typecheck 通过。下一步接加密 transaction 存储、consent 和 read-only tools；完整 `test:local` 的历史失败仍需合并后核实。此 checkpoint 不代表可生产发布，MCP 保持关闭。

### Phase 0：contract 与安全 fixtures

- [x] 固定 27-tool catalog、scope map、annotations 和 Zod input snapshots；
- [x] 固定 OAuth metadata、DCR、PKCE S256 fixtures；
- [x] 固定 refresh 单次消费、并发、故障与 revoke fixtures；
- [x] 固定已消费 authorization code 重放撤销 grant 的 fixtures；
- [x] 固定模拟成员移除后 access/refresh token 拒绝的 provider fixtures；
- [x] 固定精确路径、Cookie 隔离与同源 consent POST 门禁 fixtures；
- [x] 固定 MCP Google state/nonce、签名与 claims 核心 fixtures（transaction port 使用内存测试实现）；
- [x] 实现独立 AES-GCM transaction 存储与 D1 持久化单次消费 adapter；
- [x] 将加密 transaction adapter 接入 authorize/callback 浏览器闭环；
- [x] 固定一次性 consent CSRF fixtures；
- [x] 固定 authorization code 并发单次消费；
- [x] 接入真实 D1 成员查询并验证 OAuth 成员移除/重新邀请；
- [x] 固定 caller attribution migration 与每个 mutation audit；
- [x] 固定 base64 ZIP 边界、取消与 audit 脱敏 fixtures；
- [ ] 固定 Worker 日志脱敏 fixtures；
- [ ] 验证生产跨地域 KV 撤销可见性。

2026-09-12 首批实现进度：

- `packages/protocol-admin-portal/src/mcp.ts` 组合现有业务 schema，固定全部 27 个工具的输入、JSON schema 指纹快照、显式幂等键、5 类 ETag 入参和高风险确认字段；拒绝未知 transport credential 与 `sourceUrl` 字段。
- `packages/portal-service/src/mcp/catalog.ts` 固定 scope/annotations，并测试四类 scope 不互相蕴含、全局及三类 mutation 开关独立拒绝；尚未连接 Worker 环境变量。
- `packages/portal-service/src/mcp/input.ts` 提供基于当前资源的确认 helper，以及标准 base64 的有界、惰性、可取消 ZIP 解码。测试覆盖精确 8 MiB、非规范 padding、相同编码长度的超限输入、现有 ZIP bomb 校验；完整 request body 限制与 Worker 日志脱敏仍待 adapter 接入。
- `packages/portal-service/src/mcp/context.ts` 接受可信 OAuth adapter 已验证的 grant，每次重新读取 active member，核对 memberId/issuer/subject，并用当前成员邮箱执行 fail-closed canary；仅生成 client ID 的 SHA-256 caller handle，不创建 session。该 helper 本身不验证 bearer token，尚无 access/refresh token 集成。
- `AdminContext.caller` 已增加可选归因类型；后续第二批已接入 D1 migration、repository 原子 audit 写入、公开 audit DTO/filter 和 WebUI session caller 标记。
- 共享 Admin service 的幂等键字符范围已对齐 printable ASCII（含空格），原样传入 repository，不自动生成或 trim；Tenant service 不变。
- 后续 mutation adapter 必须在适当位置处理已提交 receipt/replay，再进行当前状态确认，不能用预取当前 ETag 替换调用方 ETag，也不能让成功后的重试因资源已变更或删除而丢失原有幂等语义。
- 首批本地验证：protocol 全部 46 项、portal-service 全部 402 项测试通过，两个包的 source/test typecheck 通过。尚未运行 remote MCP/Copilot 验收或生产部署。

2026-09-12 第二批实现进度：

- 新增 `0008_mcp_audit_attribution.sql`，历史行默认 `admin-webui`，新增 channel 分页索引；仅在本地 D1 测试应用，未执行生产 migration。
- 全部 12 个 mutation 的现有 audit INSERT 已在原业务 batch 内写入 caller channel、client hash、tool name；Operator validation 失败审计同样归因。不增加第二次写入，不改变业务、receipt、ETag 或成员有效性 guard。
- `audit-attribution.ts` 校验 MCP bearer transport、64 位小写 SHA-256 hex client handle 与 catalog 工具名。旧调用方缺少 caller 时保留 `admin-webui` 默认值，浏览器 session authenticator 显式标记 WebUI 来源。
- 公开 audit DTO 增加兼容旧 producer 的可选归因字段，新 D1 reader 始终返回这些字段。HTTP/MCP audit query 支持 `callerChannel` 和 `toolName`，cursor 绑定这两个过滤条件；Admin OpenAPI 与 MCP schema 快照已更新。WebUI 审计页面的可视化筛选控件仍未新增。
- 本地回归覆盖所有 mutation 归因、跨 client 重试保留首次归因、删除后重放、审计失败回滚、channel/tool 分页隔离、ZIP/上游错误不进入新增审计内容，以及既有 WebUI/workerd 路径。
- 第二批验证：三个相关包共 571 项测试、四组 D1/workerd 集成共 48 项测试、全仓 47 个项目 typecheck 通过。OAuth discovery/授权/token/refresh/revoke、MCP transport、浏览器 consent 与生产发布仍未接入。
- 完整 `pnpm test:local` 已尝试但未通过：日志出现 Gateway 测试打包无法解析 `cloudflare:workers`、workspace alias 缺项、compute CAS redirect 断言、PSD 字体脚本断言及 esbuild 异常输出。本批未修改这些实现，不将其混入 MCP 审计改动；该合并门禁仍阻塞。CAS 文档检查通过，`git diff --check` 无错误。
- 部署本批 repository 代码前必须先应用 migration 0008；回退 Worker 代码不需要删除新增 D1 列或历史审计数据。

2026-09-12 第三批实现进度（纳入本次 checkpoint）：

- `packages/cloudflare-portal/src/mcp/dispatcher.ts` 已接入 Worker，先于 Admin BFF/Google 配置及 bundle 分派检查 8 个精确路径。`MCP_ENABLED` 仅字符串 `true` 开启，默认 404；尚无 provider 时返回安全 503，不回落 Admin session。
- 非浏览器 MCP/OAuth 路径剥离全部 Cookie；authorize/callback 仅保留两个独立 OAuth cookie 并拒绝重复 cookie；剥离 WebUI CSRF header。响应禁止写入 Admin session cookie，强制 no-store/no-referrer/nosniff，浏览器页面禁止脚本和 frame 嵌入。
- consent POST 要求同源 Origin；提供 Origin 的请求暂只接受 MCP public origin。Google callback 继续由现有 `/admin/auth/callback` 处理跨站导航。
- JSON-RPC body 上限为 `11,184,812 + 65,536` bytes，OAuth body 上限为 `65,536` bytes；先验证 Content-Length，再按实际流量计数，超限取消上游流。尚未接入 OAuth 参数、PKCE、nonce/state/CSRF 或 token 验证。
- 两份 Wrangler 配置新增默认关闭的 MCP 变量并重新生成 Env；未新增生产 route、KV、secret，未部署。
- 本批验证：Cloudflare Portal 全部 158 项测试、包级 source/test typecheck、1 项真实 workerd dispatcher 集成通过。完整仓库 `test:local` 的既有阻塞仍按第二批记录，未宣称已解决。

2026-09-12 第四批实现进度（纳入本次 checkpoint）：

- Cloudflare adapter 锁定 `@cloudflare/workers-oauth-provider@0.10.3`，新增 `src/mcp/oauth.ts` provider 工厂，复用 exact-path dispatcher。工厂尚未连接生产 Worker，未创建 KV、secret 或生产 route；真实授权保持不可用。
- 实现 canonical resource metadata、authorization-server metadata、public-only DCR、S256/authorization-code 限制、有效 token scope 写入独立 access-token props、成员与 canary 重查、15 分钟 access TTL 和 8 小时绝对 grant 截止时间。
- 授权参数拒绝错误 resource、未知 scope、重复参数；token/revoke 仅接受有界 form POST，分离两类操作。独立 `/oauth/admin-mcp/revoke` 映射到库内部共用的 token endpoint，metadata 公布独立 revoke URL。
- 库将 authorization code 的 KV 记录保留 10 分钟；adapter 在 code exchange callback 额外执行 5 分钟截止检查。已消费 code 再次使用会触发库撤销整个 grant，测试单独固定该行为。
- 库 JSDoc 声称 refresh callback 的 `refreshTokenTTL` 会被忽略，但安装版本源码实际拒绝该字段；adapter 仅在首次 code exchange 设置 refresh TTL，refresh 不延长 grant 截止时间。
- **第四批发现的问题（第五批已补 D1 消费门禁）：** 实测库默认在成功 refresh 后允许同一旧 token 再次兑换。最终一致 KV 的 check-then-put 不能保证原子消费；用户已确认用 D1 保持严格单次轮换，不接受库默认的重试窗口。
- 动态 client TTL 当前使用库的注册后 90 天过期机制，尚未实现“90 天无活动后清理”。真实跨地域 KV 撤销可见性与并发 code/refresh 消费尚未验证，不能用本地 workerd 结果声称生产立即失效。
- workerd fixture 的 authorize handler 仅模拟已完成登录/consent，用真实 provider 验证 code/token 机制，不是生产登录实现；Google nonce/state/verified claims、独立加密 transaction、一次性 CSRF、D1 绑定查询 adapter 和 MCP SDK tools 仍待接入。
- 验证通过：158 项 Cloudflare Portal 包测试、包级 source/test typecheck、10 项 workerd MCP/OAuth 集成（含 refresh 重放行为特征测试）。未重跑有已知失败的全仓 `test:local`，未进行真人 OAuth 验收或部署。

2026-09-12 第五批实现进度（D1 refresh 原子消费，纳入本次 checkpoint）：

- 新增 `0009_mcp_refresh_consumption.sql` 和 `src/mcp/refresh-consumption.ts`。消费表仅存 SHA-256 token 哈希、消费时间、grant 绝对到期时间；哈希主键配合单条 `INSERT ... ON CONFLICT(token_hash) DO NOTHING` 保证同一个 refresh token 只有一个消费赢家，不保存 token 明文或响应。
- 每次 HTTP 请求创建独立 provider，refresh token 仅在本次请求闭包中传入已验证的 token-exchange callback。库完成 token/client/resource 验证、adapter 完成成员与 scope/期限检查后才写 D1，错误 client、非法 token 和已移除成员不会消耗有效 token。
- 同一 token 重复或并发消费返回 `invalid_grant`；D1 不可用返回脱敏的 `temporarily_unavailable`/503，不绕过消费门禁。不同请求不共享可变 token 状态。
- D1 与 OAuth KV 不组成一个事务。D1 消费成功后不删除记录、不恢复 token；KV 后续写入失败、D1 提交回执丢失或客户端丢失成功响应时，旧 token 仍不可重用，客户端可能需要重新授权。已明确失败关闭，不自动重试兑换。
- 消费记录至少保留到 grant 的绝对截止时间；已建立 expiry 索引，但尚未增加自动清理任务。不得提前删除有效 grant 的消费记录；也不得因为 KV revoke 或错误重试删除消费记录。过期 grant 仍由 adapter 的 8 小时检查拒绝。
- 验证通过：16 项真实 workerd MCP/OAuth/D1 集成，覆盖 8 路并发恰好一个成功、后继 token 可用、错误 client 不消耗、D1 写失败、提交结果不确定、KV 写失败、丢失成功响应及独立 grant 并发；158 项 Cloudflare Portal 包测试及包级 source/test typecheck 通过。
- 尚未接入生产 Worker，未部署或执行生产 migration；接入前必须先应用 0009。此项不等同于完成 authorization code 的跨请求并发消费、KV revoke 跨地域可见性、Google 登录/consent 或真人 OAuth 验收；完整 `test:local` 阻塞仍未解决。

2026-09-12 第六批实现进度（成员查询、code 单次消费、MCP OIDC 核心，纳入本次 checkpoint）：

- 新增只读 `src/mcp/members.ts`，OAuth provider 默认使用真实 Portal D1 查询 active、已绑定成员，支持按 memberId 或 issuer/subject 查找。按当前 D1 邮箱执行 canary，不按邮箱自动绑定，不触碰 WebUI session/bootstrap/audit。
- 真实 D1 集成验证成员停用、issuer/subject 改变、邮箱移出 canary、解除绑定，以及相同 Google 身份以新 memberId 重新邀请后旧 grant 仍拒绝；错误请求不消耗有效 refresh token。
- 新增 `0010_mcp_code_consumption.sql`，在库验证 code/client/PKCE 和 adapter 验证成员/期限后，以独立 code 哈希表原子消费。与 refresh 共用内部消费逻辑，但表和到期时间分离；code 消费记录保留至少 5 分钟，不保存明文。
- 8 路并发 code 兑换仅一个成功；错误 PKCE/client/resource 或已移除成员不消耗 code。消费后的 KV 故障、恢复旧 KV grant 也不能再次兑换。D1/KV 无联合事务，仍失败关闭；库在后续已消费 code 重放时可能撤销整个 grant，因此不承诺并发攻击下成功响应中的 token 必然持续有效。
- 此批最初实现的独立 MCP Google callback 后续已按用户决定移除；Google nonce/state、签名和 claims 校验统一复用现有 Admin WebUI 登录与 callback。
- 验证通过：22 项 workerd MCP/OAuth/D1 集成、171 项 Cloudflare Portal 包测试（含 49 项共享 Google 登录测试）、包级 source/test typecheck、2 项真实 D1/workerd WebUI BFF 回归。未重新运行有已知失败的完整 `test:local`。
- 纳入本次 checkpoint，未部署；生产接入前需先应用 0008、0009、0010 及后续必要 migration，默认 MCP 开关仍关闭。

2026-09-12 第七批原独立 MCP Google transaction 实现已撤销：不再保留 `login-transactions.ts`、独立 callback、独立登录 cookie或对应 migration。OAuth request/consent 由第八批 `authorization-transactions.ts` 加密并原子消费，其未发布 migration 顺延为 `0011`。

2026-09-12 第八批实现进度（本地浏览器授权闭环，尚未提交）：

- 新增 `authorization.ts`，由 OAuthProvider 验证原始 authorization request 后检查现有 Admin session；没有 session 时跳现有 Admin Google 登录，并通过严格限定的 resume path 返回。authorize 按 memberId/issuer/subject 实时查询 active D1 member，并以 D1 当前邮箱执行 fail-closed canary。
- callback 查询仍有效的动态 client 后显示 UniDocs consent 页面；每个请求 scope 独立列出，用户可显式降级为请求 scope 的非空子集。consent POST 强制精确同源 Origin、独立 HttpOnly SameSite=Strict cookie 与一次性 CSRF；错误 CSRF、拒绝、scope escalation 和重放都不能签发 grant。
- 新增 `authorization-transactions.ts` 与 `0011_mcp_authorization_transaction_consumption.sql`。OAuth request 和 consent state 使用 AES-256-GCM 存独立 KV，KV key 只含 transaction ID 的 SHA-256；D1 主键保证 resume/consent 各只有一个消费赢家，反序列化后重新验证 PKCE S256、audience、scope、identity 和 10 分钟期限。
- Worker 在 `MCP_ENABLED=true` 时动态加载 OAuth provider，连接 Google login、两类加密 transaction、D1 member lookup 和 consent handler；关闭时不加载 `cloudflare:workers` provider，也不读取 OAuth KV/key/Google 配置。新增本地 Wrangler binding/var 声明；生产 KV namespace ID 和精确 routes 尚未创建或登记。
- 真实 Miniflare 闭环已覆盖 DCR -> PKCE authorize -> 跳现有 Admin login -> Admin session resume -> consent scope downgrade -> authorization code -> access token。现有 Admin callback 的 Google discovery、签名、nonce 与 claims 由共享登录测试覆盖；尚未进行真人 Google 登录。
- 验证通过：Cloudflare Portal 11 个文件共 239 项测试、24 项真实 workerd MCP 集成、包级 source/test typecheck 和 `git diff --check`。未运行完整 `test:local`，未部署或执行生产 migration。

2026-09-12 第九批实现进度（read-only MCP canary 应用闭环，尚未提交）：

- Cloudflare adapter 直接依赖锁定的 `@modelcontextprotocol/server@2.0.0` 与 `agents@0.21.0`，新增 `mcp/server.ts` 和 `mcp/worker.ts`；不通过公网 HTTP 回调自身，也不依赖 UniCAS runtime 包。
- 注册 `whoami` 与全部 14 个 read tools，直接调用现有 Portal application service，并复用 D1/R2/Operator Service Binding adapters。每次 tool call 通过 `resolveAdminMcpContext` 重新检查 scope、mutation policy、memberId/issuer/subject active binding 与当前 canary 邮箱。
- `tools/list` 只公布 15 个 read tools；三个 mutation switch 尚未接入且 mutation tools 不注册。输入直接使用 `AdminMcpInputSchemas`，annotations 直接使用固定 catalog；list/get 返回完整 structuredContent 与简短 text。
- 已知 service error 映射为稳定 code；未知 exception 只返回 `internal_error`，不会向 MCP result 回显 D1/upstream 异常。`whoami` 返回 memberId、当前 D1 邮箱、issuer/subject、grant scopes 与 SHA-256 client handle，不返回 bearer token、Google token 或 cookie。
- OAuthProvider 验证过的 bearer request 通过 verified-context symbol 接入 `agents`，严格复用 provider 写入的 `ExecutionContext.props` 对象引用；独立 adapter 测试路径才附加同结构 context。Host 仅允许 MCP public origin 的 canonical hostname。
- 真实 Miniflare 端到端验证已覆盖 DCR -> PKCE authorize -> 现有 Admin session resume -> consent scope downgrade -> code exchange -> bearer `/mcp` -> 15-tool `tools/list` -> `whoami`。协议测试逐一验证 14 个 read service 的输入拆分、caller toolName、成员移除后下一调用失效与异常脱敏。
- 验证通过：Cloudflare Portal 12 个文件共 243 项测试、24 项真实 workerd MCP 集成、包级 source/test typecheck 和 `git diff --check`。未运行完整 `test:local`，未部署或执行生产 migration。

2026-09-13 生产 read-only canary 部署记录（尚未提交）：

- 创建独立 KV namespace `unidocs-admin-mcp-oauth`，安装随机 32-byte base64url `OAUTH_STATE_ENCRYPTION_KEY`，应用 production D1 migrations `0008`–`0011`。secret 值未输出或落盘，cfg Cloudflare 凭据仅注入子进程并清除。
- Portal production 配置新增精确 `/mcp`、两条 metadata 与 `/oauth/admin-mcp/*` routes，绑定 `OAUTH_KV` 并设置 `MCP_ENABLED=true`。mutation tools 未注册，read-only canary 只公布 `whoami` 与 14 个 read tools。
- 首次部署版本 `e2ecfb1d-a357-43e3-b325-941b87ea83ee` 暴露故障隔离问题：MCP 初始化发生在所有 Portal 请求之前，导致 Admin、bundle 与 MCP route 同时 503。修复为仅在精确 MCP path 初始化 provider，authorization storage 延迟到 authorize callback；生产版本 `7a83ad1a-d025-4a6d-9ad6-e79674f3bcc9` 已恢复原站。
- 首次安装的 state key 未通过运行时严格形状校验，authorize 返回 503；在尚无有效在途 transaction 时轮换为 Node `randomBytes(32).toString("base64url")` 生成并验证的 43 字符 key，之后 DCR 201、PKCE authorize 303 到现有 `/admin/auth/login`。
- 生产公共 smoke 通过：Admin 登录重定向、bundle route、`/mcp` 401 challenge、protected-resource/authorization-server metadata、四 scope、S256、DCR、共享 Admin login resume 与 unknown path 404。workspace `.vscode/mcp.json` 已增加 `unidocs-admin`。
- 真人 Google session 与 read-only consent 已在 VS Code 完成。当前聊天会话不热加载新增 MCP tool registry，需新聊天继续 `tools/list`、`whoami`、list/get、refresh、revoke 与删除成员即时失效验收；未运行完整 `test:local`。
- VS Code OAuth 浏览器以 opaque origin 渲染 consent：表单 POST 使用 `Origin: null`、`Sec-Fetch-Site: same-origin`，且 CSP `form-action` 会继续约束 302 后的 client callback。生产修复为仅接受该 Fetch Metadata 组合（`null + cross-site` 仍拒绝），并从 OAuthProvider 已验证的 redirect URI 生成精确 HTTPS/loopback origin 或 `vscode:` scheme CSP source；内部 redirect hint 在 dispatcher 删除，不出现在响应。
- 最终生产版本 `1d5c4ac6-a17b-4454-843d-b6ef1aef66d4` 已由 VS Code 完成 consent、302 callback 与 token exchange；production D1 聚合确认最近 authorization code exchange 为 1。此前聊天中暴露的浏览器 session/CSRF/consent cookie 必须通过退出 Admin 并重新登录作废，不作为任何验收凭据。
- VS Code opaque-origin 兼容补丁允许 `Origin: null + Sec-Fetch-Site: same-origin` 的 consent POST，并将 OAuthProvider 已验证的 client redirect HTTPS/loopback origin 或 `vscode:` scheme 加入该 consent 页 `form-action`；`null + cross-site`、任意公网 HTTP 与未知 scheme 仍拒绝。相关版本依次为 `90c30bf4-e627-44ca-998e-4d872d88cac1`、`d715d2b4-d809-42d3-aa76-140e2d678f14`，当前生产 callback CSP 修复版本为 `1d5c4ac6-a17b-4454-843d-b6ef1aef66d4`。真人重试已连接成功。
- 生产 MCP 真人调用已通过：`whoami` 返回当前 bound member、`admin:read` 与 client handle；`list_document_types` 返回当前 Markdown 注册；`list_administrators` 返回两名 bound 管理员并正确标记 self；`get_administrator` 返回 ETag；`list_operators` 返回合法空分页。未在文档中保存 bearer token、Google token 或 cookie。

退出条件：没有未决项会改变 OAuth audience、scope 名、audit schema 或 tool 名。

### Phase 1：read-only remote MCP canary

- [x] 创建 OAUTH_KV 与精确 `/mcp`、metadata、`/oauth/admin-mcp/*` routes；
- [x] 实现 exact-path dispatcher、Cookie 隔离与请求体上限；
- [x] 实现 OAuth provider 工厂及 discovery/register/token/revoke 本地验证；
- [x] 复用现有 Admin Google OIDC callback 与 session；
- [x] 实现加密 transaction 存储与持久化单次消费 adapter；
- [x] 将加密 OAuth request、Admin session resume 与 consent UI 连成本地授权闭环；
- [x] 接入真实 D1 bound-member 查询；
- [x] 将 OAuth provider 与 read-only tool handler 接入 Worker；
- [x] 实现 `whoami` 与 14 个 read tools；
- [x] mutation tools 不注册，三个 mutation kill switch 保持关闭；
- [ ] WebUI 增加“连接 AI 工具”对话框，显示 remote MCP URL 和 VS Code 配置；
- [ ] 用 GitHub Copilot 实测 refresh、revoke（authorize、tools/list、whoami、list/get 已通过）。

退出条件：仅 allowlist 管理员可授权；删除成员后现有 token 立即无法调用；read tool 不泄漏 Admin cookie/Google token。

### Phase 2：content mutation

- [ ] 接入 8 个 `admin:content` tools；
- [ ] 显式 idempotency key、ETag 与 base64 ZIP 边界；
- [ ] 开启 `MCP_CONTENT_MUTATIONS_ENABLED` canary；
- [ ] 验证一次 validation→Operator candidate、metadata PATCH、bundle upload replay 与 audit attribution。

### Phase 3：publish mutation

- [ ] 接入 create/update document type；
- [ ] 强制 reason、confirmEnabled、resource compatibility 与完整 ETag；
- [ ] 开启 `MCP_PUBLISH_MUTATIONS_ENABLED`；
- [ ] 验证绑定候选、启用、停用和 412 恢复流程。

### Phase 4：admin security mutation

- [ ] 接入 add/remove administrator；
- [ ] 双确认、不可自删、最后管理员保护继续由 service/repository 强制；
- [ ] 单独开启 `MCP_SECURITY_MUTATIONS_ENABLED`；
- [ ] 实测移除成员即时使其 MCP grant 不可用。

### Phase 5：发布门禁与运维

- [ ] OAuth KV client/grant 保留与 90 天 inactive cleanup；
- [ ] grant/client revoke 运维流程与 MCP 全局 kill switch 演练；
- [ ] structured logs/dashboard 按 client/tool/status 查询；
- [ ] route rollback 不删除 D1/KV；
- [ ] stack runner 独立接入，不让 Gateway 默认发布误触 MCP。

## 12. 验证矩阵

Focused checks：

```text
pnpm --filter @unidocs/protocol-admin-portal test
pnpm --filter @unidocs/portal-service test
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
pnpm --filter @unidocs/admin-portal-webui test
pnpm exec vitest run tests/integration/cloudflare/portal-admin-mcp.test.mjs --fileParallelism=false
```

必须覆盖：

- metadata discovery 与 401 `WWW-Authenticate`；
- DCR redirect URI 校验、public client、PKCE、code 单次消费；
- 现有 Admin Google callback 的 nonce/issuer/audience/azp/time/email_verified；
- consent CSRF 与 scope downgrade；
- access expiry、refresh rotation、revoke、wrong audience；
- client A token 不能重放 client B grant；
- active member 每次重查，删除后立即拒绝；
- read/content/publish/security scope 逐工具拒绝矩阵；
- mutation kill switches；
- idempotency replay/conflict、428/412、确认参数；
- ZIP 精确最大值、非法 base64、ZIP bomb 与取消；
- MCP mutation 与 business audit 原子，caller attribution 正确；
- cookies/Google token/Admin session 不进入 MCP request、result、log 或 audit。

合并前继续运行：

```text
pnpm typecheck
pnpm test:local
pnpm check:cas-contract-docs
git diff --check
```

## 13. 生产发布顺序

1. 提交计划 checkpoint；
2. 创建 `unidocs-admin-mcp-oauth` KV；
3. 生成并通过 stdin 安装 `OAUTH_STATE_ENCRYPTION_KEY`；
4. 应用 `0008_mcp_audit_attribution.sql`、`0009_mcp_refresh_consumption.sql`、`0010_mcp_code_consumption.sql` 和 `0011_mcp_authorization_transaction_consumption.sql`，以及后续实现新增的必要 migration；
6. 部署精确 MCP/OAuth routes，`MCP_ENABLED=true`、三个 mutation switch 全 false、email allowlist 仅当前验收账号；
7. GitHub Copilot 配置：

```json
{
  "servers": {
    "unidocs-admin": {
      "type": "http",
      "url": "https://unidocs.shazhou.work/mcp"
    }
  }
}
```

1. 真人完成 Google 登录、scope consent、whoami/read、refresh/revoke；
2. 按 content → publish → security 顺序分三次开启 mutation；
3. 每次检查 D1 business audit、OAuth structured log 和既有 WebUI/Gateway smoke；
4. 完成后移除 canary email allowlist，或改为明确的全体 active Admin 策略。

## 14. 回退与事件响应

- `MCP_ENABLED=false`：整个 MCP/OAuth exact-path surface 返回 404；
- 单类 mutation switch=false：保留 read-only 或较低权限能力；
- 删除/禁用 OAuth client 或 revoke grant：立即撤销单个 Agent；
- 移除管理员：每次 tool call 的 D1 重查立即阻止其所有 client；
- rotate `OAUTH_STATE_ENCRYPTION_KEY`：只使在途 authorize/consent transaction 失效，不解密或暴露 token；
- route rollback：移除 Portal 的 `/mcp`、metadata 和 `/oauth/admin-mcp/*` routes，不删除 OAUTH_KV 或 Portal D1；Gateway catch-all 自动恢复处理这些路径；
- suspected token theft：先关闭对应 mutation switches，再 revoke grant/client，按 oauthClientHandle/toolName/requestId 查询日志和 business audit。

## 15. 实施前需要确认

默认建议如下，若无异议即按此执行：

1. MCP 使用 `https://unidocs.shazhou.work/mcp`，OAuth endpoint 固定在 `/oauth/admin-mcp/*`，并强制 cookie stripping；
2. 使用四个 scope：read/content/publish/security；
3. v1 暴露全部 27 个工具，ZIP 使用严格 base64；
4. 所有 mutation 要求显式 idempotency key，不自动生成；
5. 初始仅 `shazhou.ww@gmail.com` 可完成 MCP OAuth canary；
6. 首次部署只开放 read tools，mutation 分三阶段开启。
