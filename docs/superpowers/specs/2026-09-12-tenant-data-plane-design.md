# UniDocs Tenant 数据面端到端设计

状态：待评审。2026-09-12。
基线：`2b590db`。
分支：`feat/tenant-data-plane`。

## 1. 目标与范围

### 1.1 目标

让 `tenant-portal-webui` 显示的数据来自真实后端：`pnpm dev portal` 起来之后，在
`http://127.0.0.1:8795/portal/` 能创建文档、看到 Operator 初始化出来的正文、选中文字
发评论、收到 Operator 的回复和它产生的新版本，刷新页面后一切仍在。

### 1.2 现状

契约层与浏览器 client 是完整的，服务端数据面是空的。逐条证据：

| 层 | 位置 | 状态 |
| --- | --- | --- |
| Tenant 契约 | `packages/protocol-tenant-portal` | 15 个 operation，oRPC contract + OpenAPI 已生成 |
| 浏览器 client | `packages/tenant-portal-client` | 14 个方法已实现，`createHttpTransport` 已写好并有单测 |
| Tenant 业务逻辑 | `packages/portal-service/src/tenant/*` | 已实现，69 条单测 |
| Tenant HTTP 适配层 | — | 不存在 |
| Tenant repository 实现 | — | 只有接口，零实现 |
| Tenant D1 表 | `packages/cloudflare-portal/migrations/` | 不存在；现有 4 个迁移全是 admin 的 |
| Worker 路由 | `packages/cloudflare-portal/src/worker.ts` | 只有 `/admin/api/v1/...`，没有 `/api/v1/tenants/...` |
| Tenant session | — | 不存在；`serveTenantWebUi` 目前跑在 BFF 之前，无登录 |
| Operator | `packages/cloudflare-markdown/src/operator-endpoint.ts` | discovery 与 probe 已实现（2026-09-14 随 main 到位）；webhook 接收与 submissions 回调待实现 |
| Agent submissions 端点 | — | 不存在 |

判定依据：全仓搜索 `createTenantDocumentService` / `createTenantThreadService` /
`createTenantVersionService` / `createTenantCatalogService` / `createTenantCasService`，
除 `portal-service/src/index.ts` 的 re-export 与 `src/tenant/` 自身定义外，**引用者
全部是 `packages/portal-service/tests/*.test.ts`**，没有任何生产代码消费它们。

`stacks/README.md` 对此有一致的记述：

> Two things are still missing behind the tenant console. It renders against an in-memory
> fixture (`tenant-portal-webui/src/main.tsx` injects `createMemoryTransport`), because the
> tenant business core in `@unidocs/portal-service` has no HTTP adapter yet; and it has no
> sign-in, so `serveTenantWebUi` runs ahead of the admin-shaped BFF rather than through it.
> Both change together when the tenant API lands.

### 1.3 本轮范围

**做**：

- 给 `@unidocs/protocol-platform` 补 oRPC contract（Agent submissions + Operator webhook）
- Tenant D1 迁移与 repository 实现
- Tenant HTTP 适配层与 worker 路由
- Tenant session（本地自动签发）
- Agent submissions 端点与 Agent bearer 认证
- Platform → Operator webhook 派发
- 一个 Markdown Operator，作为独立 worker，经 service binding 接入
- 本地 dev 种子：admin 目录数据 + Operator 登记
- 前端从 memory transport 切到 `createHttpTransport`

**不做**（明确排除，不是遗漏）：

- 真实多租户：表结构带 `tenant_id` 列，但 v0 只跑一个固定 tenant，没有 tenant 注册、
  成员关系或邀请流程
- 真实 tenant 身份源：不接 Google OIDC 或 CAS OIDC，本地自动签发 session
- 生产部署与冲烟
- **浏览器直连 UniCAS**：`issueCasCapability` 保留契约形状但 v0 不实现。这与「snapshot
  存 CAS」不矛盾——snapshot 由 Platform 写入与读出，浏览器经 `getVersionSnapshot` 取
  字节流，不直连 CAS。直连只在读取 snapshot **内部**的 SBlob 时才需要（例如 PSD 的
  图层位图），Markdown 的 snapshot 是 `{ content: string }`，不含 SBlob
- `listDocumentAuditEvents`：client 侧本就未实现（见 `client.ts` 顶部注释），本轮不补
- PSD 或 Markdown 以外的文档类型

## 2. 架构

三跳，不是两跳。Operator 是外部服务，不是 Platform 内部模块。

```
浏览器 /portal/                    (已有，serveTenantWebUi)
    │
    ├──► GET/POST /api/v1/tenants/{t}/...        [新] Tenant HTTP 适配层
    │         └─► portal-service/src/tenant/*     (已有业务逻辑)
    │                 └─► D1 (可变关系) + UniCAS (不可变 snapshot 字节，Platform 只读+retain)
    │
    └── 写操作提交后，Platform 派发 webhook
              │
              ▼
        POST {operatorBaseUrl}/tenants/{t}/documents/{d}     [新] Operator worker
              │   reason: document.created | comment.appended | current_version.moved
              │
              └──► POST /api/v1/tenants/{t}/documents/{d}/submissions   [新] Agent 端点
                        Authorization: Bearer <agent token>
                        原子提交 version + reply
```

### 2.1 为什么 Operator 是外部服务

代码已经把这条路径定死了，本设计只是接上它：

- `packages/cloudflare-portal/src/operator-transport.ts`
  - `OPERATOR_DISCOVERY_PATH = "/.well-known/unidocs-operator"`
  - `canonicalBaseUrl()` 强制 `https:`，拒绝端口、query、fragment、凭据
  - `createBoundOperatorTransport(targets)` 是 allowlist：每个 target 带
    `service: { fetch }`，实际流量走 service binding 而非任意出网
  - I/O 上限 `OPERATOR_IO_LIMITS`：5s 超时、64KiB 响应、16KiB probe
- `packages/portal-service/src/operators/discovery.ts`
  - `validateOperatorDiscovery()` 校验 `declaredOperatorId`、`supportedDocumentTypes`、
    `supportedDocumentContracts` 与已有 contract revision 的包含关系
- `packages/protocol-platform/src/operator.ts`
  - webhook：`POST {operatorBaseUrl}/tenants/{tenantId}/documents/{documentId}`
  - `OperatorWebhookRequest.reason`：`document.created` / `comment.appended` /
    `current_version.moved`；at-least-once，`accepted` 不代表 Agent 工作已完成
- admin 契约已有完整注册流程：`POST /admin/api/v1/operator-validations` 产出短期
  immutable validation，`POST /admin/api/v1/operators` 将其转成持久 Operator

把 Operator 做成 worker 内联函数会绕过 discovery、baseUrl 注册、probe 与 webhook 这
一整套，且与 `PublicDocumentType.availableDocumentContractIdxs` 的定义冲突（见 §11）。

## 3. 技术选型

### 3.1 Tenant HTTP 层：oRPC `implement(tenantApiContract)`

照 `packages/cloudflare-portal/src/document-types-http.ts` 的写法：
`implement(contract).$context<...>()` 定义 handler，`OpenAPIHandler` 依据 contract 的
`.route({ method, path })` 自动完成路由分发、输入校验与错误编码，handler 体内只写对
`portal-service` 业务方法的调用。

*替代方案*：手写 fetch 路由。否决理由——15 个 operation 的路径解析与 Zod 校验要手写
一遍，且必然与 contract 漂移；admin 侧已经证明了 oRPC 路径可行。

### 3.2 Snapshot 存储：UniCAS

按 `agent-mediated-document-collaboration.md` §10.1，不可变内容进入内容寻址存储。
snapshot 的 canonical SValue CBOR（`encodeSValue`，`@unidocs/svalue-codec`）写入
UniCAS，`portal_versions` 只保存它的 `CasBlobRef`。

**写入路径：Agent 直连 CAS，Platform 只 retain**

Platform **不代理 CAS 节点流量**，这是 tenant 契约 `issueCasCapability` 的明写原则：
「The Platform does not proxy CAS node traffic; the caller builds a tenant blob client
and reads or writes UniCAS directly.」

1. **Agent** 用自己的 `cas:write` / `cas:lease` capability，经
   `createCasBlobClient`（`@unicas/tenant-blob-client`）把 canonical SValue CBOR 写入
   UniCAS，得到 `CasBlobRef`。写入的每个节点**自动 lease**，这是临时保护
2. **Agent** 提交 submission，请求体是 JSON，只携带该引用（见 §4）
3. **Platform** 用 `cas:read` 把 blob 读回、`decodeSValue`，按该版本 Document Contract
   revision 的 snapshot schema **校验内容**。Platform 不能因为「没代理流量」就不校验
4. **Platform** 校验两类锁并提交 D1 事务，`portal_versions` 记录
   `snapshot_blob_hash` / `snapshot_size` / `snapshot_content_type`
5. **Platform** 在事务提交**之后** `retain` blob root，把临时 lease 转成业务根引用

第 5 步的时序不是随意选的，`storeBlob` 的接口注释明写：「Every written node is
automatically leased. Call `retain` **after the surrounding business transaction
commits** to preserve the blob root.」

**两侧的差别在 `refDomain`，不在权限集**（2026-09-14 按实测修正）：

| 角色 | permissions | `refDomain` |
| --- | --- | --- |
| Agent | `cas:read` + `cas:write` | 无 |
| Platform | `cas:read` + `cas:write` | **有** |

初稿写的是「Platform 只要 `cas:read`，Agent 才要 write」。实际连上 CAS 后
`retain` 直接返回 **403**：CAS 把 Root Refs 更新门控在 `cas:write` 上，而这个权限
同时覆盖 lease blob 内容——**没有更细粒度的「可移动 root ref 但不可 lease」权限**。

所以安全边界落在 `refDomain` 这个 claim 上，不在权限集上。
`IssueCapabilityInput.refDomain` 的注释限定了它：「only stack-authority capabilities
that write root references carry it」。CAS 会拒绝任何不带 refDomain 的 Root Refs
写入，无论 token 持有什么权限。Platform 是 stack authority，Agent 不是——所以 Agent
写得了节点，动不了业务根，GC 的最终裁量权仍在 Platform。

「Platform 不写 blob 内容」因此是**代码层面的事实而非权限层面的强制**：约束落在
`SnapshotStore` 的接口面上——它只暴露 `read` / `retain` / `release`，没有 `storeBlob`。
拿着同一枚 capability 的 `getToken` 去喂裸的 `createCasBlobClient`，就绕过了这条保证。

**这条执行事实是可测的，应当被测**（例如断言 `SnapshotStore` 的键集恰为
`{read, retain, release}`），不要只靠 code review。真连 CAS 才暴露的是**权限事实**
（retain 需要 `cas:write`），两者是不同的东西。

**字段名需要一行映射**：`@unicas/tenant-blob-client` 的 `CasBlobRef` 是
`{ hash, size, contentType }`，tenant 契约的 `CasBlobRefSchema` 是
`{ blobHash, size, contentType }`。`hash` ↔ `blobHash`，其余同名。

**读取路径**

`TenantVersionRepository.readSnapshot` 经 blob handle 取
`ReadableStream<Uint8Array>`，直接满足 `SnapshotStreamSchema`。响应 content type 由
`documentSnapshotContentType(documentType)` 派生，即
`application/vnd.unidocs.markdown.snapshot+cbor;version=1`。

**生命周期**

§10.1 要求 CAS 提供「业务根引用与生命周期保护」，§10.2 要求「CAS 节点是否可回收，由
可变存储中的业务根和保留策略决定」。因此 retain / release 与版本记录的生命周期绑定：
创建版本时 retain，版本归档或文档删除时 release。v0 不实现归档与删除，所以只有
retain 路径会被执行，**但 release 的接缝（`CasBlobRetentionUpdate`）必须留出来**，
不能让「以后再说」变成「以后改不动」。

**本地接入（本轮新增的 runtime 改动）**

本地 dev 默认已有 embedded CAS：`runtime.mjs` 在 `!casOrigin` 时启动 CAS middleware，
并把 stack fixture（`stackId` / `issuer` / `audience` / `kid` / `jwks` / `refDomains`）
注册进 `CAS_CONTROL_DB`。但 **portal worker 目前没有任何 CAS binding**
（`services.mjs` 的 portal 组件只有 `DB` 和 `BUNDLES`），需要补上 CAS origin 与 stack
签名凭据。不能假设它已经就位。

*替代方案*：R2 或 D1 BLOB。均已否决——绕过 CAS 就失去 Merkle 去重、跨版本共享与统一
GC，而 §10.1 正是为此设立。初稿曾选 R2，评审时明确要求改为 CAS。

### 3.3 Operator：独立 worker + service binding（扩展既有的 markdown worker）

Operator 是**独立进程**，经 service binding 绑给 portal worker。但它不是新包：
`packages/cloudflare-markdown` 已经承载了 `operator-endpoint.ts`（discovery 与 probe
均已实现，见 §8），所以 webhook 接收与 submissions 回调加在同一个 worker 上，
`stacks/unidocs-cloudflare/local/services.mjs` 里它已经是一个可选目标。

`canonicalBaseUrl()` 拒绝 `http:` 和显式端口，所以本地 baseUrl 也必须是一个稳定的
https 形状标识（取 `https://markdown-operator.unidocs.local`），真实流量走 binding 不
出网。这与 iteration 14 里 `ADMIN_MARKDOWN_SERVICE` 的做法一致：绑定的目的地由部署侧
管控，JSON 自报身份不等于对任意外部地址的信任。

*替代方案*：Durable Object。否决理由——v0 的 Operator 不需要跨请求的持久状态，
submissions 的幂等性由 `submissionId` 与 Platform 侧收据保证，引入 DO 只增加 binding
与 migration 负担。

### 3.4 Tenant session：照 admin 结构，本地自动签发

沿用 `packages/cloudflare-portal/src/auth.ts` 的结构（`auth.ts:39-48`、`auth.ts:102-107`）：

- `__Host-unidocs_tenant`：HttpOnly session cookie，服务端存 `sessionHash`
- `__Host-unidocs_tenant_csrf`：非 HttpOnly，供 JS 读取；服务端只存 `csrfHash`
- 变更请求校验 `Origin` 头等于配置的 origin，并比对 `x-csrf-token` 的哈希

差异：本地访问 `/portal/` 且无有效 session 时自动签发一个绑定固定 tenant 与固定
principal 的 session。守卫用仓库已有的 `isLocalDevOrigin()`
（`packages/portal-service/src/local-dev-origin.ts`）——它只接受规范化的 loopback
origin 且要求显式端口，自身再做一次 `new URL(origin).origin === origin` 校验。非
loopback origin 一律不自动签发，走 401。

### 3.5 Agent 认证：本地共享 secret

契约规定 Operator 用 `Authorization: Bearer` 而非 cookie，且 Bearer 被拒绝时**不回退
到 cookie**。v0 的最小实现：

- 本地 runtime 生成一个随机 secret，同时注入 portal worker 与 markdown worker 的 binding
- Platform 侧认这个 token，赋予固定 `principalId`（`agent:markdown-primary`，与
  descriptor 的 `declaredOperatorId` 一致）与固定
  scopes `["documents:read", "comments:read", "comments:reply", "versions:submit"]`
- Bearer 路径不要求 CSRF（契约明示）

生产的真实 Agent 凭据体系（OAuth scopes、轮换、按 Operator 隔离）不在本轮范围。

## 4. 协议层补齐：`@unidocs/protocol-platform` 的 oRPC contract

现状：`packages/protocol-platform/src/` 下有 `agent.ts`、`operator.ts` 等，但**没有
`contract.ts`**。`AgentSubmissionRequest`、`SubmissionReceipt`、`SubmissionConflict`、
`OperatorWebhookRequest` 都是纯 TypeScript interface —— 编译期有效，运行时不做任何校验。

本轮新增：

- `src/schemas.ts`：把上述 interface 改写为 Zod 4 schema，与
  `protocol-tenant-portal/src/schemas.ts` 同风格（`.readonly()`、`.meta({ id })`、
  `.describe()`）
- `src/contract.ts`：
  - `agentApiContract`：`submissions.create`（`POST .../submissions`，201）与
    `submissions.get`（`GET .../submissions/{submissionId}`）
  - **`newSnapshot` 的类型要改**，这不是加 Zod 外壳而是修改既有定义：现在是
    `newSnapshot?: SValue`，但 SValue 没有 JSON 表示——`svalue-codec/json.ts` 的
    `toJsonValue` 遇到 SBlob 直接抛 "SBlob cannot be represented as JSON"。改为
    `newSnapshotBlob?: CasBlobRef`，由 Agent 先直连写入 CAS（§3.2）。submission 请求
    体因此保持 JSON，oRPC 的 contract 自动路由与校验得以适用
  - `AgentSubmissionRequestSchema` 必须用 `superRefine` 落实 §7.1 的两条结构约束，
    它们在现有 TypeScript interface 里表达不出来（两个字段都是可选的）：
    1. `threadUpdates[].resultLocations` 非空时，**必须**同时有 `newSnapshotBlob`
    2. 有 `newSnapshotBlob` 时，`observedCurrentVersionIdx` **必填**
  - `operatorWebhookContract`：`notifyDocument`
  - 错误映射沿用 tenant 的形状。**submission 的三种拒绝不是 HTTP 错误**：
    `AgentEndpointContracts.createSubmission` 的返回类型就是 `SubmissionReceipt`，
    而它是 `committed | rejected` 的联合，所以被拒绝同样是一次成功响应，携带
    `reason` 与 `SubmissionConflict`。Operator 据此重算后重新提交，而不是处理 4xx。
    contract 的 `.output()` 因此是整个联合，不是只有 committed 分支
- 导出保持向后兼容：现有 interface 从 Zod schema `z.infer` 出来，不改变已有 import

收益：submissions 端点的路由与输入校验同样白送，且可以纳入 OpenAPI 生成，将来外部
Agent 接入时有文档可读。

## 5. 数据模型

新增迁移 `packages/cloudflare-portal/migrations/0012_tenant.sql`。本地 runtime 会自动
应用（`services.mjs` 的 `migrations` 字段，经 `splitSqlStatements` 逐条执行）。

**编号随 main 前移**：初稿写的是 `0005_tenant.sql`，但 2026-09-14 rebase 后 main 已经
占用到 `0011`（view bundles、operator validations、operators、四个 MCP 表），所以 tenant
迁移落在 `0012`。落地前需再次确认当时的最大编号。

| 表 | 主键 | 说明 |
| --- | --- | --- |
| `portal_documents` | (`tenant_id`, `document_id`) | `name`、`document_type`、`current_version_idx`（可空）、`created_at` |
| `portal_versions` | (`tenant_id`, `document_id`, `version_idx`) | `parent_version_idx`、`document_contract_idx`、`author_agent_id`、`submission_id`、`addressed_comments_json`、`created_at`，以及 snapshot 的 `CasBlobRef`：`snapshot_blob_hash`、`snapshot_size`、`snapshot_content_type` |
| `portal_threads` | (`tenant_id`, `document_id`, `thread_id`) | `created_at` |
| `portal_comments` | (`tenant_id`, `document_id`, `thread_id`, `comment_idx`) | `base_version_idx`、`content_json`、`location_json`、`author_id`、`created_at` |
| `portal_replies` | (`tenant_id`, `document_id`, `thread_id`, `reply_idx`) | `respond_through_comment_idx`、`content_json`、`result_locations_json`、`author_agent_id`、`submission_id`、`created_at` |
| `portal_document_audit` | `audit_event_id` | `action`、`actor_id`、`before_version_idx`、`after_version_idx`、`reason`、`request_id`、`occurred_at` |
| `portal_submissions` | (`tenant_id`, `document_id`, `submission_id`) | `state`、`receipt_json`、`created_at` —— Agent submission 的持久收据 |
| `portal_tenant_sessions` | `session_hash` | `tenant_id`、`principal_id`、`csrf_hash`、`created_at`、`expires_at` |
| `portal_tenant_idempotency_receipts` | (`actor_id`, `operation`, `key`) | `fingerprint`、`response_json`、`created_at`。结构同 admin 版但无 administrator 外键 |

### 5.1 三条要点

**每张表带 `tenant_id` 列，但 v0 只跑一个 tenant。** 不做注册流程，也不埋下事后全表
改主键的坑。固定值取 `t-local`。

**`open` 不落库。** 契约明示线程的 open 状态是派生的
（`latestCommentIdx > acknowledgedCommentIdx`），"there is consequently no resolve or
reopen operation anywhere in this contract"。`listThreads` 的 `open` 过滤在 SQL 里用两
个聚合算出来，不加布尔列。

**Tenant 幂等收据必须另建表。** 不能复用 `portal_idempotency_receipts`：它的
`actor_id` 带外键 `REFERENCES portal_administrators(member_id)`
（`0002_document_types.sql`），而 tenant principal 不是 administrator，复用会直接违反
外键。新表 `portal_tenant_idempotency_receipts` 列结构相同但去掉该外键，主键同样是
(`actor_id`, `operation`, `key`)，`operation` 取 `createDocument` / `createThread` /
`appendComment`。

## 6. Tenant HTTP 适配层

新增 `packages/cloudflare-portal/src/tenant-http.ts`，导出
`createTenantHttp(repositories, ...)`，形状对齐 `document-types-http.ts`：

- `implement(tenantApiContract)`，`$context<{ tenant: TenantContext; requestId: string }>()`
- interceptor 把 `TenantOperationError` 的 11 个 code 映射到 contract 声明的 status
  （`invalid_request` 400、`not_found` 404、`version_conflict` 409、
  `location_contract_violation` 422、`limit_exceeded` 413、`unavailable` 503 等）
- `customErrorResponseBodyEncoder` 产出 `{ error: { code, message, requestId } }`，与
  `TenantApiErrorSchema` 一致
- 请求体走 `boundedBytes` + `parseStrictJson`，与 admin 同样的上限保护

`getVersionSnapshot` 是唯一不返回 JSON 的 operation：handler 返回
`ReadableStream`，响应 content type 由 `documentSnapshotContentType()` 派生。

新增 `packages/cloudflare-portal/src/tenant-repository.ts`，实现
`TenantDocumentRepository`、`TenantVersionRepository`、`TenantThreadRepository`、
`TenantCatalogRepository` 四个接口。写操作用 `database.batch([...])` 保证原子性，
幂等重放的结构照 `document-types-repository.ts` 的 `replay()` 模式。

`packages/tenant-portal-client/src/memory/store.ts` 是这些语义的可执行参照：它已经实
现了同一套契约的完整行为（版本追加、`parentVersionIdx` 取提交时的当前指针、幂等重放、
`isOpen` 派生）。D1 实现以它为语义对照，两者的行为差异即为缺陷。

## 7. Worker 路由接入

`worker.ts` 现有顺序：bundle origin → `serveTenantWebUi` → BFF。本轮在
`serveTenantWebUi` 之后、BFF 之前插入 tenant API 分支：

- `/api/v1/tenants/...` → tenant session 或 Agent bearer 认证 → `tenantHttp`
- `/portal/auth/session`（GET）→ 返回 `{ tenantId, principalId }`，401 表示未登录
- `/portal/auth/logout`（POST）→ 撤销 session

`serveTenantWebUi` 保持在 BFF 之前的位置不变——它服务的是静态资源，不需要登录门。

## 8. Operator：扩展 `packages/cloudflare-markdown`，不新建包

**本节于 2026-09-14 随 main 重写。** 初稿计划新建 `packages/operator-markdown`，
但 main 上的 `feat(admin-portal): validate markdown operators` 与
`define operator probe proof` 已经把其中两个端点做出来了，实现在
[`packages/cloudflare-markdown/src/operator-endpoint.ts`](../../../packages/cloudflare-markdown/src/operator-endpoint.ts)。
新建包会重复一份已经上线的实现，因此改为在该文件上扩展。

| 端点 | 状态 |
| --- | --- |
| `GET /.well-known/unidocs-operator` | **已实现。** 返回 `declaredOperatorId: "markdown-primary"`、`displayName: "Markdown Operator"`、`supportedDocumentContracts: { [documentType]: [0] }`，并带 descriptor 规范 JSON 的 SHA-256 作为 `ETag` |
| `POST /operator/probe` | **已实现。** 校验 `x-unidocs-probe-signature`，比对 `declaredOperatorId` / `documentType` / `configEtag`，回签 `OperatorProbeReceipt` |
| `POST /tenants/{tenantId}/documents/{documentId}` | **待实现。** 接收 webhook，返回 `{ accepted: true, eventId }` |
| （出站）`POST .../submissions` | **待实现。** 回调 Platform 提交 version 与 reply |

初稿另有两处细节是我编的，以实现为准：probe 路径是 `/operator/probe`（不是
`/unidocs/probe`）；probe 认证用**对称 HMAC 密钥**，由 `MARKDOWN_OPERATOR_HMAC_KEY`
（64 位十六进制）与 `MARKDOWN_OPERATOR_DOCUMENT_TYPE` 两个 binding 提供，签名与验签在
`@unidocs/service-auth` 的 `signOperatorProbeReceipt` / `verifyOperatorProbeRequest`。

未配置这两个 binding 时端点返回 `503 operator_not_configured`，所以本地 dev 必须把它们
配上，否则 §11 的 Operator 登记会在 probe 这一步失败。

行为（待实现部分）：

- `document.created` → 提交首个 version，snapshot 为 `{ content: "# {name}\n\n" }`，
  `addressedComments: []`。文档自此可打开
- `comment.appended` → 读 thread，**按评论内容决定提交形态**：
  - 评论要求可执行的正文修改 → 提交新 version + reply。按锚定的
    `unidocs.markdown.text-range/v1` 位置改写正文，`addressedComments` 记录
    (`threadId`, `commentIdx`, `baseVersionIdx`) 溯源边，`resultLocations` 指向新版本
    中的落点
  - 评论只是提问、只需解释、或要求被拒绝 → **提交纯 reply，不创建版本**
- `current_version.moved` → v0 不做动作，仅回 `accepted`

**不得为了记录对话而创建内容相同的新版本**（§7.1）。这不是风格建议：无内容变化的
版本会污染 base forest 与 comment provenance 两张图，而工作台的版本面板正是按这两张
图渲染的。

v0 的判定可以很粗（例如评论文本含明确的修改指令则改写，否则纯 reply），但**两条路径
都必须实现**，否则验收时无法区分「Operator 正确地选择了纯 reply」和「Operator 根本
不会产生版本」。

提交时必须带两类锁的观测值（§7.2）：
- 提交新版本时 `observedCurrentVersionIdx` 必填
- 每个 threadUpdate 必带 `observedAcknowledgedCommentIdx`
- `respondThroughCommentIdx` 不得跳过较早的未响应 comment（§5.2），水位只能单调前进

## 9. Webhook 派发

Platform 在三处写操作提交成功后派发，使用
`createBoundOperatorTransport` 的 allowlist 传输：

| 触发点 | reason |
| --- | --- |
| `createDocument` 提交后 | `document.created` |
| `createThread` / `appendComment` 提交后 | `comment.appended` |
| `moveCurrentVersion` 提交后 | `current_version.moved` |

派发在 `ctx.waitUntil()` 中进行，不阻塞用户响应。契约规定 at-least-once 且
`accepted` 不代表工作完成，因此：**派发失败不回滚用户的写操作**，只记审计。
Operator 端的重复投递由 `submissionId` 幂等吸收。

## 10. Agent submissions 端点

`POST /api/v1/tenants/{t}/documents/{d}/submissions`，Bearer 认证。

原子完成：读回并校验 Agent 已写入的 snapshot blob → 在同一事务内校验**两类**乐观锁
（§7.2）→ 可选地创建 version（`CasBlobRef` 落 D1）→ 追加 replies → 推进相关 thread 水位 → 有新版本时推进 current pointer →
持久化收据。

| 锁 | 条件 | 触发 |
| --- | --- | --- |
| 版本锁 | `observedCurrentVersionIdx == currentVersionIdx` | 仅当提交含 `newSnapshot` |
| thread 锁 | 每个 thread 的 `observedAcknowledgedCommentIdx == acknowledgedCommentIdx` | 每个 threadUpdate 都查 |

比较的是**相等**而非新旧：所有者把 current 回退到旧版本时，基于较新版本的提交同样
失败，因为指针移动本身表达了意图。

任一锁失败则整个提交拒绝，**不留任何持久化痕迹**（§7.3、不变量 #3）。

**拒绝也是 2xx。** 三种拒绝理由 `version_conflict` / `document_contract_conflict` /
`reply_watermark_conflict` 作为 `SubmissionReceipt` 的 `rejected` 分支返回，附带
`SubmissionConflict`（当前指针、可用的 contract revision、各 thread 的 watermark）
供 Operator 重算后重提。只有认证失败、请求畸形、文档不存在这类问题才是 4xx。

`GET .../submissions/{submissionId}` 在超时或重试后读回收据，不重复工作。

## 11. 本地 dev 种子

**这是端到端能否跑通的前提，不是可选项。**

`listPublicDocumentTypes` 返回的 `PublicDocumentType` 需要 `typeCardBundleId`、
`typeCard`、`viewBundleId` 和 `availableDocumentContractIdxs`。这些数据全部来自 admin
侧已有的三张表（`portal_document_types`、`portal_document_contracts`、
`portal_type_card_bundles`）——**tenant 目录不需要新表，是对 admin 表的投影**。

但空数据库上一个 markdown 类型都没有，因此 tenant 连文档都创建不了。尤其
`availableDocumentContractIdxs` 的定义是「当前 View 与 built-in Operator **都**支持的
revision 交集」，不登记 Operator 这个字段恒为空，目录就是空的。

种子步骤（跟随 `pnpm dev portal`，仅在空库时执行）：

1. 创建 markdown document type
2. 追加 Document Contract revision 0：snapshot schema 为 `{ content: string }`，
   location schema 覆盖 `unidocs.markdown.text-range/v1` 的 `{ start, end, quote }`
3. 上传最小 Type Card bundle 与 View bundle，并选为 current
4. 配好 `MARKDOWN_OPERATOR_HMAC_KEY` 与 `MARKDOWN_OPERATOR_DOCUMENT_TYPE`，然后走
   `operator-validations` → `operators` 登记 `markdown-primary`。缺这两个 binding 时
   probe 端点返回 `503 operator_not_configured`，登记会卡在这一步
5. enable 该 document type

实现位置：`stacks/unidocs-cloudflare/local/` 下的一个模块，与 `doc-types.mjs` /
`services.mjs` 一样保持无依赖。种子只经由公开的 admin API 写入，不直接操作 D1，这样
它同时充当 admin 控制面的一条集成测试。

## 12. 前端接线

| 文件 | 改动 |
| --- | --- |
| `tenant-portal-client/src/http-transport.ts` | 补 `x-csrf-token`（从非 HttpOnly cookie 读，照 `admin-portal-client/src/index.ts:74-102`）；确认 snapshot 的 `accept` 与服务端一致 |
| `tenant-portal-webui/src/main.tsx` | 切 `createHttpTransport`；`tenantId` 从 `/portal/auth/session` 取，不再硬编码 `"t1"` |
| `tenant-portal-webui/src/session/` | 新增：启动时取 session，401 时的处理 |
| `tenant-portal-webui/src/pages/document.tsx` | `currentVersionIdx === null` 显示「等待 Operator 初始化」而非报错，**并禁用评论入口**——§5.4 规定首版本产生前不能创建 thread 或追加 comment，前端不应发出注定失败的请求 |

**memory transport 保留不删。** 它是 `tenant-portal-client` 与 webui 测试的夹具
（`memory/store.ts` 顶部注释已声明这一点），同时是一个有价值的离线开发模式，通过开关
选择而非删除。

改动 webui 后必须执行
`pnpm --filter @unidocs/cloudflare-portal build:webui` —— worker 服务的是
`src/tenant-ui-assets.generated.ts`，不是源码。

## 13. 测试策略

TDD。每层都有既定的测试位置：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| protocol-platform | `packages/protocol-platform/tests/` | contract 形状、schema 边界、中英文档一致性 |
| repository | `packages/cloudflare-portal/tests/` | 以 `memory/store.ts` 的语义为对照的行为测试；幂等重放、乐观锁、`open` 派生 |
| HTTP 层 | `packages/cloudflare-portal/tests/` | 照 `document-types.test.ts`：路由、错误码映射、请求体上限 |
| Operator | `packages/cloudflare-markdown/tests/` | webhook 接收、submission 构造（discovery 与 probe 已有既存测试，不重复） |
| CAS 接入 | `packages/cloudflare-portal/tests/` | stack-authority capability 的 `refDomain` 与权限集；Agent 写入 → Platform 读回的字节往返；retain 之后 GC 仍可读；未 retain 的节点在 lease 过期后不可读 |
| 端到端 | `tests/integration/cloudflare/` | 照 `portal-local-runtime.test.mjs`：真 workerd 上走完建档 → 初始化 → 评论 → 回复 |
| 前端 | `packages/tenant-portal-webui/tests/` | CSRF 头、session 引导、401 处理、空态 |

## 14. 交付切分

八步，每步独立可测、可提交：

1. `protocol-platform` 的 Zod schema 与 oRPC contract
2. **CAS 接入层**：Platform 侧 stack-authority capability 签发（带 `refDomain`）、
   snapshot blob 读回与 retain / release 接缝；portal worker 的 CAS binding 与对应的
   `services.mjs`、`runtime.mjs` 改动。**Platform 不写 blob 内容**，写在 Agent 侧
3. `0012_tenant.sql` 迁移与四个 D1 repository 实现（版本仓储依赖第 2 步）
4. Tenant HTTP 适配层与 worker 路由
5. Tenant session 与本地自动签发
6. Agent bearer 认证与 submissions 端点
7. Webhook 派发 + 在 `cloudflare-markdown` 上补 webhook 接收与 submissions 回调
8. dev 种子与前端接线

第 8 步之前端到端跑不通，这是链路本身的依赖顺序决定的，不是切分不当。

第 2 步是本轮**风险最高**的一步：portal worker 至今完全没接触过 CAS（admin 控制面
一行都不碰），本地 runtime 侧的 binding 也是新写的。建议先用一个只做
「写入 → retain → 读回 → 字节相等」的最小用例把这条路打通，再接 repository。

## 15. 验收标准

`pnpm dev portal` 启动后，在 `http://127.0.0.1:8795/portal/`：

1. 工作台列出文档；新建一个 Markdown 文档
2. 片刻后文档可打开，正文是 Operator 提交的首个 snapshot
3. 选中一段文字发评论，评论出现在线程面板，线程为 open
4. Operator 回复后线程转为已回复，版本面板出现新版本，其 `addressedComments` 指向该评论
5. **刷新浏览器，以上全部仍在**——证明数据在 D1 与 UniCAS 而非内存
6. `pnpm -r test` 与 `pnpm -r typecheck` 通过

## 16. 决策记录

本设计中由实施者决定、未单独征询的选择，集中列出以便评审时推翻：

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| Snapshot 存储 | UniCAS，`portal_versions` 存 `CasBlobRef` | §10.1 要求不可变内容进内容寻址存储。评审明确要求，推翻了初稿的 R2 方案 |
| snapshot 写入方 | **Agent 直连 CAS**，Platform 只读回校验 + retain | `issueCasCapability` 明写 Platform 不代理 CAS 流量；`AgentScope` 含 `cas:lease`；`storeBlob` 注释要求 retain 在业务事务之后。评审确认 |
| `newSnapshot` 字段 | 由 `SValue` 改为 `CasBlobRef` | SValue 无 JSON 表示（`toJsonValue` 遇 SBlob 抛错），否则 submission 请求体无法是 JSON，contract 自动路由失效 |
| 租户模型 | 表带 `tenant_id`，v0 单租户 `t-local` | 不做注册流程，也不埋事后改主键的坑 |
| Tenant 登录 | 本地自动签发，`isLocalDevOrigin` 守卫 | 真实身份源不在本轮范围；复用仓库已有的 loopback 判定 |
| Agent 凭据 | 本地共享 secret + 固定 scopes | 真实凭据体系是独立议题 |
| Operator 位置 | 扩展 `cloudflare-markdown`，经 service binding 接入 | 契约要求 baseUrl 注册与 discovery，内联会绕过整套机制；而 discovery/probe 已在该包实现，另起新包是重复造 |
| Operator 行为 | 按评论内容在「纯 reply」与「reply + 新版本」之间选择 | §7.1 禁止为记录对话而造内容相同的版本；但两条路径都要实现，否则无法区分「正确地选了纯 reply」与「根本不会产生版本」 |
| `open` 状态 | 不落库，SQL 派生 | 契约明示它不是可切换的存储标志 |
| 种子写入方式 | 只经公开 admin API | 兼作 admin 控制面的集成测试 |

## 17. 与 `agent-mediated-document-collaboration.md` 的一致性核对

### 17.1 已对齐

| 该文档条目 | 本设计对应位置 |
| --- | --- |
| §5.3 open 是派生状态；不变量 #4 水位单调前进 | §5.1「`open` 不落库」，SQL 聚合派生 |
| §5.2 累计确认水位；不变量 #5 | 沿用契约的 `respondThroughCommentIdx`，§8 要求不得跳过未响应 comment |
| 不变量 #1 每个版本有且只有一个 base parent | `portal_versions.parent_version_idx`，取提交时的 current 指针 |
| §7.3 全部成功或全部拒绝；不变量 #3 | §10 单事务，失败不留持久化痕迹 |
| §6.3 webhook 是增量通知不是任务 RPC | §9 at-least-once、派发失败不回滚用户写操作 |
| 不变量 #9 current pointer 移动必须审计 | `portal_document_audit` |
| §8.2 平台只校验封套与 contract 一致性 | 沿用 `portal-service` 已实现的 `validateLocation` 接缝 |
| §10.2 可变关系需独立可变存储 | base forest、provenance、current pointer、水位、审计一律在 D1 |
| §5.4 首版本产生前不能创建 thread | §12 前端禁用评论入口 |

### 17.2 有意偏离（需评审确认）

| 偏离 | 该文档 | 本设计 | 理由 |
| --- | --- | --- | --- |
| 提交方数量 | §6.2 + 不变量 #8：注册不授予排他写入权 | v0 只有一个 Operator 持有 Agent 凭据 | 这是**实现现状**，不是架构约束。认证层按 scopes 设计，不按「唯一 Operator」设计，多 Agent 并发提交时由 §10 的两类锁保证安全 |

### 17.3 设计文档与已实现契约之间的既存不一致

**不是本设计引入的**，但实施时会撞上，记录以免被当成新缺陷：

| 议题 | 设计文档 | 已实现契约 | 本设计跟随 |
| --- | --- | --- | --- |
| comment 的 location 基数 | §8.2 与不变量 #6：一个 comment 可携带**零到多个** locations | `CommentRecordSchema.location` 是 `.nullable()` 的**单数**；`CreateThreadRequest` / `AppendCommentRequest` 同样单数 | 跟随契约（单数）。改复数要同时动 contract、client、webui，超出本轮 |
| Operator 注册粒度 | §6.1：每个**文档**可注册一个默认 operator hook | `OperatorRecordSchema.documentType`，`createOperator` 是 for one document type，**类型级** | 跟随契约（类型级）。可解释为类型级是默认值，§6.2 提到的文档级 override 尚未实现 |

`ReplyRecord.resultLocations` 是数组，与设计文档一致；只有 comment 侧是单数。

## 18. 未尽事项

不属于本轮，但已知存在，记录以免遗忘：

- `listThreads` 只返回 `ThreadRef`，`DocumentRecord` 无讨论计数，工作台只能逐个
  `getThread`。N+1 集中在 `discussion-summary.ts`，协议补计数后即可去掉
  （已记于 `docs/design/platform-v0/tenant/TODO.md`）
- `ViewSetMarkersRequest.markers` 区分不了评论位置、Agent 改动位置与已过时位置；临时
  类型在 `tenant-portal-webui/src/view/markers.ts`
- `issueCasCapability` 仅保留契约形状，未落地真实能力签发
- 生产部署、真实 tenant 身份源、多租户注册
- 丢失的 `document.created` 无人补救：派发失败或超时，或 Operator 已接受但随后失败
  （CAS 写入出错、Platform 5xx、连续三次被拒），该文档就永远没有版本 0。§5.4 规定
  版本 0 之前不可能有任何后续事件，所以 Plan 4 R13「由后续事件吸收」对它不成立。
  后续可选：读取方发现 `currentVersionIdx === null` 且创建已超过 N 秒时重新派发；
  webui 提供「重试初始化」，重放创建幂等键；或 Operator 定期扫描未初始化文档
- 漏掉的 retain 永远不会修复：retain 失败，或 worker 在 D1 提交与 retain 之间退出，
  已提交版本就指向一个只有 lease 的 blob，可能被 GC 回收，此后读取该 snapshot 永久
  返回 409。Operator 从不重放已提交的 `submissionId`，所以只靠「重放时补 retain」
  修不好。后续：按 (tenant, document, versionIdx) 生成确定性的 retain requestId，
  重放时也执行 retain，并加一个对账器扫描已提交版本补 retain
