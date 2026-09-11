# Tenant Portal 线契约 —— `@unidocs/protocol-tenant-portal`

**日期：** 2026-09-11
**状态：** 已实施，2026-09-11
**基线：** `main @ 570a531`

## 现状

`docs/design/platform-v0` 的目标设计里，Platform 对外有三个面：Admin 控制面（§6）、
面向 Platform Web Host 的 tenant 数据面（§7）、Agent 数据面（§9）。

这三个面在代码里的成熟度差一个量级：

| 面 | 包 | 形态 |
| --- | --- | --- |
| Admin §6 | `@unidocs/protocol-admin-portal` | contract-first：Zod 4 schema + oRPC contract + OpenAPI 3.1 + Scalar HTML + 20 个测试 |
| tenant §7 | `@unidocs/protocol-platform` `src/platform.ts` | 纯 `interface`，`EndpointContract<TReq,TRes>` 手写草案，无运行时校验、无 OpenAPI、无测试 |
| Agent §9 | `@unidocs/protocol-platform` `src/agent.ts` | 同上 |

`docs/design/platform-v0/tenant/TODO.md` 明确挂着一条：

> 从 `@unidocs/protocol-platform` 的 tenant HTTP contract 生成 OpenAPI 与可读文档。

本设计把 §7 从类型草案升级为与 Admin 对称的 contract-first 协议包，并顺手补上
§7 里四处写不下去的地方（见「设计决定」D4–D7）。

### 为什么现在做

Admin Portal 已经进入实现（`@unidocs/portal-service` + `@unidocs/cloudflare-portal`，
3/26 个 handler 上线）。Tenant Portal 的 webui/client 一旦开工就需要一份可由
TypeScript 检查、可生成 client、可生成文档的契约；现在这份只是 `interface`，
`tenant-portal-client` 拿它既校验不了运行时输入，也生成不了 OpenAPI client。

## 设计决定

### D1：包边界只覆盖 §7，与 admin-portal 一对一对称

`@unidocs/protocol-tenant-portal` 覆盖 §7「面向 Platform Web Host 的 HTTP API」：
类型目录、文档 CRUD、版本浏览、移动 current、thread/comment、CAS capability、文档审计。

不覆盖：

- **§8 View Host RPC** —— 走 MessageChannel 不走 HTTP，oRPC/OpenAPI 套不上；
- **§9 Agent API** —— 虽然共用 `/api/v1/tenants/{tenantId}` 根路径，但鉴权主体、
  scope 和幂等机制（`submissionId` 而非 `Idempotency-Key`）都不同；
- **§10 Operator webhook** —— Platform 出方向，不是 portal。

这三部分留在 `@unidocs/protocol-platform`。判据很简单：**一个 portal 一个 HTTP 契约包**。

### D2：依赖形状照抄 admin-portal —— 只依赖 `@unidocs/protocol`

新包依赖 `@unidocs/protocol`（SValue schema dialect、`DocumentTypePattern`、
媒体类型派生函数）+ `zod@^4` + `@orpc/{contract,openapi,zod}`。

**不依赖 `@unidocs/protocol-platform`。** 理由与 Admin 拆分时相同：协议包是线契约的
事实源，依赖另一个协议包会让"哪份是权威"变得含糊。Zod schema 推导出的静态类型
就是 DTO 的唯一定义。

这意味着 `DocumentRecord` / `CommentRecord` / `ThreadDetail` 等在两个包里各有一份定义——
与 Admin 包和 protocol-platform 各有一份 `DocumentContractRecord` 是同一种重复，
已经是本仓接受的形状。

### D3：`protocol-platform/src/platform.ts` 拆出后删除

照 Admin 先例（「管理员控制面已从 `@unidocs/protocol-platform` 拆分到
`@unidocs/protocol-admin-portal`」），不留两份 §7 定义。

`platform.ts` 里唯一还有别的消费者的，是被 `view.ts` 用的两个类型：

```ts
// view.ts
readonly "host.createThread": { request: CreateThreadRequest; ... }
export interface HostAppendCommentRequest extends AppendCommentRequest { threadId: ThreadId }
```

处理：文件更名 `platform.ts` → `messages.ts`，只保留 `CreateThreadRequest` 与
`AppendCommentRequest`，文件头注释写明它们是 tenant HTTP 与 View Host RPC 共享的
comment 创建体。其余全部移除：`PublicTypeCard*`、`PublicTypeCardIcon*`、
`PublicDocumentType`、`CreateDocumentRequest`、`MoveCurrentVersionRequest`、
`CasCapabilityGrant`、`List*Response` 别名、全部 path/query 类型、
`PlatformEndpointContracts`。

`common.ts` / `resources.ts` / `agent.ts` / `operator.ts` / `view.ts` 保留。

### D4：tenant 的 mutation 返回完整 record，并把这条例外写进 `api-conventions.md`

§7 明写：创建/读取文档和移动 current 返回 `DocumentRecord`，创建 thread 返回
`ThreadDetail`，追加 comment 返回 `CommentRecord`。而 `docs/api-conventions.md` 的规则是
「完整读、瘦写」——mutation 只返回继续操作所需的最小结果。

采信 §7。三条理由：

1. 这些写产生的是**服务端分配身份的新建不可变记录**（`commentIdx`、`documentId`、
   `createdAt` 都由服务端定），record 本身就是 operation 的直接产物，不存在
   「回显请求字段」导致的漂移——那正是瘦写规则要防的东西；
2. **tenant 资源没有 ETag**。Admin 的「写→GET」是因为写完必须拿新 ETag 才能继续；
   tenant 这边没有这个理由，瘦写等于白跑一趟；
3. 响应体本来就小——`MessageContent` 里的 `richContent` / `attachments` 是
   `CasBlobRef` 而不是字节。

`docs/api-conventions.md` 的「Read and mutation responses」一节补一段，把
「服务端分配身份的新建不可变记录，其完整 record 即 operation 的直接产物，可以整体返回」
写成与「同步 validation/execution 可返回完整结果」并列的明确例外。不补这段，
两份文档就会字面冲突，实现者无所适从。

### D5：Idempotency-Key 覆盖三个创建型 POST

§12.2 只列了 thread/comment 创建。补上 `POST /documents`：不然网络重试会凭空多出一份文档。

| operation | Idempotency-Key | 理由 |
| --- | --- | --- |
| `POST /documents` | 必需 | 重试会重复创建 |
| `POST .../threads` | 必需 | §12.2 |
| `POST .../threads/{threadId}/comments` | 必需 | §12.2 |
| `POST .../current-version` | 不要 | `observedCurrentVersionIdx` 等值锁天然幂等 |
| `POST /cas-capabilities` | 不要 | 签发短期凭据，无持久副作用 |

### D6：版本读取拆成 metadata 与 snapshot 两个 operation

§7 写 `GET /documents/{id}/versions/{versionIdx}` 返回 `VersionRecord`，而
`VersionRecord.snapshot` 是 `SValue`。这在线上表示不出来：`SValue` 里的 `SBlob`
是 symbol-branded（`packages/protocol/src/types.ts` 的 `sBlobSignature`），
纯 JSON 编不出来；§2 也说「HTTP 使用 canonical SValue CBOR 编码」。同一个响应体
不可能既是 JSON 又是 CBOR。

拆开：

```text
GET /documents/{documentId}/versions/{versionIdx}
    → application/json，版本元数据（不含 snapshot）

GET /documents/{documentId}/versions/{versionIdx}/snapshot
    → application/vnd.unidocs.{documentType}.snapshot+cbor;version=1
      canonical SValue CBOR body
```

好处：JSON 契约保持纯 JSON；`DocumentContractRecord.snapshot.contentType` 那个
媒体类型终于是一个真的 HTTP `Content-Type` 而不只是记录上的格式标识；View 可以
流式、带缓存地取内容，而版本历史面板不必为了画一条父子连线拉几十 MB 的 PSD。

**连带简化：** snapshot 拿掉之后，`VersionRecord` 只剩元数据，字段与原本为轻量列表
设计的 `VersionListItem` 完全相同。因此**不引入 `VersionListItem`**，列表与详情
共用 `VersionRecord`。`protocol-platform/src/resources.ts` 的 `VersionRecord.snapshot`
同步删除——它同时是 `SubmissionReceipt.version` 和 `ViewContext.viewVersion` 的类型，
两处都不需要内嵌 snapshot（`ViewLoadSnapshotRequest` 本来就单独传 snapshot）。

### D7：comment provenance 直接挂在 `VersionRecord` 上

§1.2 把「版本 base forest、comment provenance」列为 Platform 职责，
`tenant/tenant-webui-v0.md` §2.5 要在版本历史面板里画「这一版回应了哪些评论、
它们各自基于哪个版本」。但 §7 的线契约读不到它：`VersionRecord` 既没有
`submissionId` 也没有 addressed comments，客户端只能遍历全部 thread 的 replies 反查。

`VersionRecord` 增两个字段：

```ts
readonly submissionId: SubmissionId;
readonly addressedComments: readonly {
  readonly threadId: ThreadId;
  readonly commentIdx: CommentIdx;
  readonly baseVersionIdx: VersionIdx;
}[];
```

`submissionId` 恒非空——每个版本都由一次 submission 产生（§9.2 规则 10：版本、reply、
水位、provenance 在同一业务事务中生效）。首版本（`document.created` 触发）的
`addressedComments` 是空数组。

`protocol-platform/src/resources.ts` 同步加这两个字段。

### D8：补上文档审计 DTO

§7.1 列了 `GET /documents/{documentId}/audit`，但全文没有定义它的 DTO，§12 总览表里
也没有这一行。ER model 的 `DOCUMENT_AUDIT_EVENT` 有完整字段，且
`tenant-webui-v0.md` §2.5 明确要求「移动 current 会写入文档级审计」——接口不补上，
WebUI 那句话就没法解释。

按 ER model 定义：

```ts
type DocumentAuditAction = "document.created" | "current_version.moved";

interface DocumentAuditEvent {
  readonly auditEventId: string;
  readonly actorId: string;
  readonly action: DocumentAuditAction;
  readonly beforeVersionIdx: VersionIdx | null;
  readonly afterVersionIdx: VersionIdx | null;
  readonly reason: string | null;
  readonly requestId: string;
  readonly occurredAt: IsoDateTime;
}
```

`document.created` 时 before/after 均为 `null`。action 词表可追加，本轮只给这两项。

### D9：鉴权双轨，与 Admin 同构

| | 形态 |
| --- | --- |
| `tenantBearer` | `http` / `bearer`。存在即只走 Bearer，验证失败**不**回落 cookie |
| `tenantSession` | `apiKey` in cookie，名 `__Host-unidocs_tenant`，HttpOnly 同源 |
| `tenantCsrf` | `apiKey` in header，名 `X-CSRF-Token`，仅 cookie 鉴权的 mutation 需要 |

读 operation `[{tenantBearer}, {tenantSession}]`；mutation
`[{tenantBearer}, {tenantSession, tenantCsrf}]`。与 admin 的 OpenAPI 后处理同一套写法。

采用双轨而非只 cookie，是因为 §9.1 明确 Agent 用 OAuth token 打同一批读接口
（`/documents`、`/versions`、`/threads`），同一个 operation 必须同时服务浏览器 Host
和 Agent。`AgentScope` 词表写在 `tenantBearer` 的 description 里——HTTP bearer
scheme 本身不带 scopes 字段。

### D10：协议词表 comment / reply 取代 ping / pong

Review 中确定。`ping` / `pong` 描述的是"发出—应答"这个握手机制，而人写的那条东西本身就是
一条评论；设计文档自己也已经在用 `comment provenance`（§4.2 那张 DAG 的正式名字）和
`comment marker`（View Host RPC 概念）当协议词，内部本来就不自洽。改完之后
tenant-webui §1 的「一条评论 ↔ 一条 ping」这一行直接消失，因为界面词与协议词重合了。

代价是 `reply` 的名字丢掉了 `pong` 自带的「累计确认」含义——读的人会默认一对一回复，而这
恰恰是这个机制最容易被误解的地方。补偿手段：字段名保留 `respondThroughCommentIdx` 的
`through`；并在 schema 字段描述、`ThreadDetail.replies` 描述、`ReplyRecord` 的类型注释、
`agent-mediated` §5.2 和 tenant-webui §1 各明写一次「一条 reply 通常一次覆盖多条 comment」。
§5.2 的示例记号也从 `p1/q1` 改成 `c1/r1`。

`thread`、`current`、`snapshot`、`submission` 不变：它们没有等价的日常词。

## 契约

### 包结构

```text
packages/protocol-tenant-portal/
  package.json                     @unidocs/protocol-tenant-portal
  tsconfig.json                    composite，references ../protocol
  tsconfig.test.json
  README.md
  src/schemas.ts                   Zod 4 DTO schema + 推导类型
  src/contract.ts                  oRPC contract、TenantApiV1BasePath、TenantApiErrorMap
  src/index.ts                     公共导出
  scripts/openapi.ts               generateTenantOpenApiDocument()
  scripts/html.ts                  renderTenantApiReferenceHtml()
  scripts/generate-openapi.ts      写两份产物
  openapi/tenant-v1.openapi.json
  openapi/tenant-v1.html
  tests/contract.test.ts
```

package exports `.` 与 `./openapi.json`；scripts 与 admin 包同名同结构，
`docs:generate` / `test` / `typecheck` / `build` / `clean` 五个 script 一致。

### Operation 清单（15）

`TenantApiV1BasePath = "/api/v1/tenants/{tenantId}"`。

| # | 方法 | 路径（省略 base） | operationId | 响应 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/document-types` | `listPublicDocumentTypes` | `Page<PublicDocumentType>` |
| 2 | GET | `/document-types/{documentType}/document-contracts/{documentContractIdx}` | `getDocumentContract` | `DocumentContractRecord` |
| 3 | GET | `/documents` | `listDocuments` | `Page<DocumentRecord>` |
| 4 | POST | `/documents` | `createDocument` | 201 `DocumentRecord` |
| 5 | GET | `/documents/{documentId}` | `getDocument` | `DocumentRecord` |
| 6 | GET | `/documents/{documentId}/versions` | `listVersions` | `Page<VersionRecord>` |
| 7 | GET | `/documents/{documentId}/versions/{versionIdx}` | `getVersion` | `VersionRecord` |
| 8 | GET | `/documents/{documentId}/versions/{versionIdx}/snapshot` | `getVersionSnapshot` | CBOR body |
| 9 | POST | `/documents/{documentId}/current-version` | `moveCurrentVersion` | 200 `DocumentRecord` |
| 10 | GET | `/documents/{documentId}/audit` | `listDocumentAuditEvents` | `Page<DocumentAuditEvent>` |
| 11 | GET | `/documents/{documentId}/threads` | `listThreads` | `Page<ThreadRef>` |
| 12 | POST | `/documents/{documentId}/threads` | `createThread` | 201 `ThreadDetail` |
| 13 | GET | `/documents/{documentId}/threads/{threadId}` | `getThread` | `ThreadDetail` |
| 14 | POST | `/documents/{documentId}/threads/{threadId}/comments` | `appendComment` | 201 `CommentRecord` |
| 15 | POST | `/cas-capabilities` | `issueCasCapability` | 200 `CasCapabilityGrant` |

query 参数：#3 `documentType` + cursor/limit；#6 #10 cursor/limit；
#11 `open`、`versionIdx` + cursor/limit；#1 cursor/limit。

contract router 分组：

```ts
export const tenantApiContract = {
  documentTypes: { list, getDocumentContract },
  documents: { list, create, get, moveCurrentVersion, listAudit },
  versions: { list, get, getSnapshot },
  threads: { list, create, get, appendComment },
  cas: { issueCapability },
};
```

OpenAPI tag 分组：Document types / Documents / Versions / Threads / Audit / CAS。

### DTO

沿用 §7 已有定义的：`PublicTypeCardLocale`、`PublicTypeCardIconSvg`、
`PublicTypeCardIconPng`、`PublicTypeCard`、`PublicDocumentType`、
`DocumentContractRecord`、`DocumentRecord`、`CreateDocumentRequest`、
`MoveCurrentVersionRequest`、`CreateThreadRequest`、`AppendCommentRequest`、
`CommentRecord`、`ReplyRecord`、`ThreadRef`、`ThreadDetail`、`MessageContent`、
`CasBlobRef`、`DocumentLocation`、`CasCapabilityGrant`、`Page<T>`。

本设计改动的：

```ts
// D6 + D7
interface VersionRecord {
  readonly versionIdx: VersionIdx;
  readonly parentVersionIdx: VersionIdx | null;
  readonly documentContractIdx: DocumentContractIdx;
  readonly authorAgentId: string;
  readonly submissionId: SubmissionId;
  readonly addressedComments: readonly {
    readonly threadId: ThreadId;
    readonly commentIdx: CommentIdx;
    readonly baseVersionIdx: VersionIdx;
  }[];
  readonly createdAt: IsoDateTime;
}
```

新增的：`DocumentAuditAction`、`DocumentAuditEvent`（D8）。

### 错误映射

`PlatformErrorCode`（`protocol-platform/src/common.ts`）在 tenant 面的子集：

| code | status | 说明 |
| --- | --- | --- |
| `invalid_request` | 400 | |
| `unauthorized` | 401 | |
| `forbidden` | 403 | 不得通过 404/403 差异泄露其他 tenant 身份（§12.1） |
| `not_found` | 404 | |
| `limit_exceeded` | 413 | 逻辑 blob 大小、草稿配额 |
| `location_contract_violation` | 422 | location 未过所属 revision 的 location schema |
| `document_type_disabled` | 409 | 对 disabled 类型创建文档 |
| `version_conflict` | 409 | `observedCurrentVersionIdx` 等值锁失败，details 带当前 `currentVersionIdx` |
| `idempotency_conflict` | 409 | 同 key 不同 body |
| `content_unavailable` | 409 | 引用的 blob 未 lease 或已 GC |
| `unavailable` | 503 | |

不进 tenant contract 的：`upload_expired`、`bundle_invalid`、
`operator_validation_required`（Admin 面）；`document_contract_conflict`、
`revision_conflict`、`reply_watermark_conflict`（Agent submission 面）；
`unsupported_content_type`（tenant 面没有接受非 JSON 请求体的 operation，
`getVersionSnapshot` 是响应侧媒体类型，不产生这个错误）。

oRPC 错误 key 用大写 snake（`VERSION_CONFLICT`），OpenAPI 里的
`error.code` 由 `customErrorResponseBodySchema` 小写回原样——与 admin 同一套。

按 operation 挂错误，不搞"全挂一遍"：

```text
base            INVALID_REQUEST, UNAUTHORIZED, FORBIDDEN, UNAVAILABLE
+ read          NOT_FOUND
+ mutation      IDEMPOTENCY_CONFLICT
createDocument  + DOCUMENT_TYPE_DISABLED, LIMIT_EXCEEDED
createThread    + NOT_FOUND, LOCATION_CONTRACT_VIOLATION, LIMIT_EXCEEDED, CONTENT_UNAVAILABLE
appendComment      + 同 createThread
moveCurrent     + NOT_FOUND, VERSION_CONFLICT
getVersionSnapshot + CONTENT_UNAVAILABLE
```

### 测试

`tests/contract.test.ts`，覆盖：

1. `VersionRecord` 不含 snapshot 字段，`addressedComments` 必填（可为空数组）；
2. `MoveCurrentVersionRequest.observedCurrentVersionIdx` 接受 `null` 但不可缺省；
3. `MessageContent` 的 `text` 与 `richContent` 至少一个非空（§2）；
4. `DocumentLocation.documentContractIdx` 为非负整数；
5. `PublicTypeCard.locales` 必须含 `en`（RFC 4647 最终回退，§5.1）；
6. `PublicTypeCardIconPng.imageUrls` 必须齐 16/32/64/128/256 五个尺寸；
7. 三个创建型 POST 的 `idempotency-key` header 必填，其余 POST 无此 header；
8. OpenAPI：读 operation security 是 `Bearer OR cookie`，mutation 是
   `Bearer OR (cookie AND CSRF)`；
9. OpenAPI：每个 operation 只声明自己那份错误码；
10. `getVersionSnapshot` 的响应媒体类型是 `…snapshot+cbor;version=1` 而非 JSON；
11. `ContractRouterClient<typeof tenantApiContract>` 的类型形状（`expectTypeOf`）；
12. Scalar HTML 能从同一份 document 生成。

### 连带改动

| 文件 | 改动 |
| --- | --- |
| `packages/protocol-platform/src/platform.ts` | → `messages.ts`，只留两个 comment 创建体（D3） |
| `packages/protocol-platform/src/resources.ts` | `VersionRecord` 去 snapshot、加 provenance（D6/D7） |
| `packages/protocol-platform/src/index.ts` | 导出随之调整 |
| `packages/protocol-platform/src/view.ts` | import 路径改 `messages.js` |
| `docs/api-conventions.md` | 补新建不可变记录的完整返回例外（D4） |
| `docs/design/platform-v0/README.md` | 协议入口加 `@unidocs/protocol-tenant-portal` |
| `docs/design/platform-v0/tenant/TODO.md` | 划掉 OpenAPI 那条 |
| `docs/design/platform-v0/platform-view-operator-api-v0.md` | §7 同步 D4–D8 的改动 |
| 根 `tsconfig.json` | 加 references |

## 不做

- 不实现任何 handler、持久化或校验器——本包只负责线契约与 DTO 运行时校验；
- 不动 §8 View Host RPC、§9 Agent API、§10 Operator webhook；
- 不设计 `tenant-portal-client` / `tenant-portal-webui`；
- 不碰 §5.1 编辑型 comment、§5.2 子文档评论归属（tenant WebUI 设计已标为未决）；
- 不做 tenant 登录/回调/session 端点——那是 portal-service 的 BFF，Admin 包同样没有。

## 实施结果

D1–D10 全部按本文落地。实施中额外确定的两点：

- `getVersionSnapshot` 的响应在 OpenAPI 里标为 `application/cbor` + `contentEncoding: binary`。
  具体的 `application/vnd.unidocs.{documentType}.snapshot+cbor;version=1` 依赖运行时的
  `documentType`，单一静态 schema 表达不了，因此写在 operation 描述里。
- 生成的参考文档是中英双语单页：contract 保持英文事实源，`scripts/locales/zh.ts` 按英文原文
  做 key 覆盖，出两份 OpenAPI，HTML 内嵌两份并就地切换。四条测试双向卡住漏翻与残留。

验证结果：`pnpm typecheck` 44 个 project 全过；`@unidocs/protocol-tenant-portal` 26 个测试、
`@unidocs/protocol-admin-portal` 20 个测试通过；`git diff --check` 干净。

## 验证

```text
pnpm --filter @unidocs/protocol-tenant-portal test
pnpm --filter @unidocs/protocol-tenant-portal typecheck
pnpm --filter @unidocs/protocol-tenant-portal docs:generate
pnpm typecheck
git diff --check
```
