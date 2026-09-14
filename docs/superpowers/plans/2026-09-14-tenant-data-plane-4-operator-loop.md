# Tenant 数据面 Plan 4：Agent 提交、Operator 回路与本地种子

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 spec §15 的验收在 `pnpm dev portal` 下成立：新建 Markdown 文档 → Operator 写出首个版本 → 选中文字发评论 → Operator 回复（必要时产出新版本并记录溯源）→ 刷新后全部仍在。

**Architecture:** Platform（portal worker）新增 Agent Bearer 认证与 `agentApiContract` 的 submissions 端点：读回 Agent 已写入 UniCAS 的 snapshot、按 contract revision 校验、在一个 D1 batch 内以两类相等锁原子提交 version / replies / 收据，提交后 retain。tenant 写操作提交后经 service binding 向 Operator 派发签名 webhook。`cloudflare-markdown` worker 接收 webhook，直连 CAS 写 snapshot，再以 Bearer 回调 submissions。本地运行时把两个 worker 连起来，dev 种子经 admin API 登记 markdown 文档类型与 Operator。

**Tech Stack:** TypeScript 5.9、oRPC 1.15、Cloudflare D1 / Miniflare 5（`5.20260811.1-alpha`）、UniCAS（`@unicas/tenant-client`、`@unicas/tenant-blob-client`）、`@unidocs/svalue-codec`、`@cfworker/json-schema`、React 19、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-09-12-tenant-data-plane-design.md` §3.2、§3.3、§3.5、§4、§7、§8、§9、§10、§11、§15、§16；语义权威 `docs/design/platform-v0/agent-mediated-document-collaboration.md` §5、§7。

## 范围

**做：** submissions 表与收据、snapshot 校验、提交服务与 D1 仓储、Agent Bearer 认证与作用域、agent HTTP 适配层、webhook 签名与派发、markdown Operator 回路、本地运行时连线、dev 种子、webui 新建文档与异步刷新、真 worker 端到端。

**不做：** 真实 Agent 凭据体系（v0 本地共享 token）、webhook 重试队列 / outbox、归档与 release 路径的执行、`issueCasCapability` 实签发、SBlob snapshot 的校验、生产部署。

## Global Constraints

- **测试保真度必须按 task 写的来。** `tests/tenant/d1-double.ts` 不执行 SQL。凡 task 标注「真 D1」「真 CAS」「真 worker」，用替身写的测试不算完成。真 D1 一律用 `tests/tenant/real-d1.ts` 的 `startRealD1()`。
- **每个 task 报告前必须跑 mutation check**：把测试所命名的行为改坏，确认对应测试变红，再改回。报告写明改了什么、哪条红了。**若 brief 给的 mutation 没能让测试变红，修测试让它能红，并在报告里说明**（Plan 3 出现过两次）。
- **不得让可选能力拖垮 worker。** portal worker 每个请求构造服务；任何可能因缺 binding 而抛的构造（CAS、Operator 传输、Agent token）必须惰性化，只在需要它的路由内发生，并转成作用域内的响应。
- **错误不泄漏。** 未预期错误只记 `portal_operation_failed`（name + message），响应给固定文案。
- **提交拒绝是 201 成功响应**，不是 HTTP 错误（spec §4、§10）。只有认证、畸形请求、资源不存在、内容不可读、location 违约是 4xx。
- **被拒绝的提交不留任何持久化痕迹**（设计文档 §7.3、不变量 #3）——包括收据。
- **时钟单位：D1 一律秒**，对外 ISO 字符串。
- **不得修改** `packages/portal-service/src/tenant/{access,catalog,documents,threads,versions,cas}.ts` 的既有导出签名；可以新增文件。
- `packages/cloudflare-portal/wrangler.jsonc` 的 `compatibility_date` 不要动。本地验证用 `pnpm dev portal`。
- `CLAUDE.md` 是 local-only：绝不编辑、绝不 `git add`、绝不 `git add -A`。按路径显式暂存。
- Commit message 英文祈使句并说明原因，结尾一行 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`。**不要 push，不要开 PR。**
- 门禁：改动包的 `test` 与 `typecheck`。聚焦跑测试用 `pnpm --filter <pkg> exec vitest run <pattern>`（`test -- <pattern>` 在这些包里不过滤）。不要用 `pnpm -r typecheck` 当门禁（`portal-service` 在 main 上就是红的）。
- 每个 git 命令都要带 Bash 工具的 `dangerouslyDisableSandbox: true`。

## 已确认的代码事实（写 plan 时核对过，实施时以代码为准）

- `packages/protocol-platform/src/contract.ts`：`agentApiContract.submissions.{create,get}`，`POST|GET /api/v1/tenants/{tenantId}/documents/{documentId}/submissions[/{submissionId}]`，create `successStatus: 201`，输入 `inputStructure: "detailed"`、**无 headers**。错误映射 `AgentApiErrorMap`：INVALID_REQUEST 400、UNAUTHORIZED 401、FORBIDDEN 403、NOT_FOUND 404、CONTENT_UNAVAILABLE 409、LOCATION_CONTRACT_VIOLATION 422、UNAVAILABLE 503，data 为 `{ requestId }`。
- `AgentSubmissionRequestSchema`：`submissionId`、`observedCurrentVersionIdx?: number|null`、`newDocumentContractIdx?`、`newSnapshotBlob?: CasBlobRef`、`threadUpdates[{threadId, observedAcknowledgedCommentIdx: number|null, respondThroughCommentIdx, content, resultLocations}]`。superRefine：有 resultLocations 必须有 snapshot；有 snapshot 必须有 `observedCurrentVersionIdx`（可为 null）与 `newDocumentContractIdx`。**请求里没有 `addressedComments`，由服务端派生。**
- `SubmissionReceiptSchema`：`{state:"committed", submissionId, version: VersionRecord|null, replies: ReplyRecord[], committedAt}` | `{state:"rejected", submissionId, reason: version_conflict|document_contract_conflict|reply_watermark_conflict, conflict: {currentVersionIdx, availableDocumentContractIdxs, threads[{threadId, acknowledgedCommentIdx|null, latestCommentIdx}]}, rejectedAt}`。
- `OperatorWebhookRequestSchema`：`{protocol:"unidocs-operator-webhook/v1", eventId, reason, tenantId, documentId, documentType, currentVersionIdx|null, newComments[{threadId, commentIdx, acknowledgedCommentIdx|null}], occurredAt}`；响应 `{accepted:true, eventId}`。
- thread 水位是派生的：acknowledged = `COALESCE(MAX(portal_replies.respond_through_comment_idx), -1)`，latest = `COALESCE(MAX(portal_comments.comment_idx), -1)`（`thread-repository.ts` ~404）。`ThreadDetail` 只有 `threadId/comments/replies`。
- `availableDocumentContractIdxs` = view manifest `supportedDocumentContractIdxs` ∩ `registration_json.builtinOperator.descriptor.supportedDocumentContracts[documentType]`（`catalog-repository.ts` ~111-117，私有函数）。当前 Operator 就是 `json_extract(portal_document_types.registration_json, '$.builtinOperator')`，含 `baseUrl`。
- `operator-transport.ts` 的 `createBoundOperatorTransport` 只有 `discovery` 与 `probe`；`canonicalBaseUrl` 未导出。`operator-validation-target.ts`：`MARKDOWN_OPERATOR_BASE_URL = "https://unidocs-markdown.shazhou.workers.dev"`，经 `ADMIN_MARKDOWN_SERVICE` binding，key 必须 64 位小写十六进制。
- `authenticateTenant`（`tenant/session.ts`）：带 `Authorization` 头一律 401；返回 `transport:"session"`，无 scopes。`TenantContext` 有 `transport: "bearer"|"session"`、`scopes?`。
- `worker.ts` 的 `serveTenant(request, env, path)` 不接收 `ExecutionContext`；`fetch(request, env, context?)`。
- `@unidocs/svalue-codec`：`decodeSValue(bytes)`、`encodeSValue(value)`、`toJsonValue(value)`（遇 SBlob 抛）。**全仓没有 SValue schema 校验器。**
- markdown worker（`packages/cloudflare-markdown/src/worker.ts`）`fetch(request, env)` 无 ctx；路由顺序 `markdownOperatorEndpoint` → `markdownDiscovery` → doc-type handler。依赖里**没有** `@unicas/tenant-blob-client`、`@unidocs/protocol-platform`。
- 本地运行时：`pnpm dev portal` 只启动 portal 组件，**不启动 markdown worker**，portal 也没有 `ADMIN_MARKDOWN_SERVICE` / `MARKDOWN_OPERATOR_HMAC_KEY`。`startLocalRuntime({ bindingDefaults })` 只作用于 doc-type worker。Agent 式 CAS 写入范例：`tests/integration/cloudflare/portal-cas.test.mjs:40-76`（同一 stack fixture key，不带 refDomain）。
- admin 登录本地**无法程序化完成**（只认 Google）。现有集成测试都直接调 `D1PortalAuthRepository.completeLogin`。
- admin 新建 document type 的 id 是服务端生成的 `dt-<uuid>`，而 markdown Operator 必须在 discovery 前知道它（`MARKDOWN_OPERATOR_DOCUMENT_TYPE`）。
- 两个 bundle 都是原始 `application/zip` 请求体；仓库里没有现成 markdown bundle 文件，测试内联造 zip（`tests/integration/cloudflare/portal-type-card-bundles.test.mjs:34-51`、`portal-view-bundles.test.mjs:34-45`）。enable 要求 contract、type card、view、operator 齐全且 contract 交集非空；view manifest 引用的 contract idx 必须已存在。
- webui 工作台**没有新建文档入口**，也**没有任何轮询**。

## 本 plan 的设计裁决（spec 未写或与代码冲突之处）

| # | 裁决 | 理由 |
| --- | --- | --- |
| R1 | 被拒绝的提交**不写收据**；`GET submissions/{id}` 对拒绝过的 id 返回 404 | 不变量 #3「不留持久化痕迹」；拒绝无副作用，Operator 重算重提即可 |
| R2 | 同一 `submissionId` 不同请求体 → 400 `invalid_request`；相同请求体 → 重放已提交收据（201） | 契约错误映射没有 IDEMPOTENCY_CONFLICT |
| R3 | snapshot 与 schema 不符 / content type 不符 / 超过 8 MiB → 400 `invalid_request`；blob 读不到或尺寸不符 → 409 `content_unavailable`；contract 的 snapshot schema 声明了 `x-unidocs-sblob` → 503 `unavailable` | v0 校验器只支持无 SBlob 的 schema，这是服务端能力缺口不是调用方错误 |
| R4 | `resultLocations` 每项的 `documentContractIdx` 必须等于 `newDocumentContractIdx` 且通过该 revision 的 location schema，否则 422 | 结果位置落在新版本上 |
| R5 | `threadUpdates` 里 thread 不存在 → 404；同一 thread 重复 → 400；空提交（无 snapshot 且无 threadUpdates）→ 400；`respondThroughCommentIdx` 必须满足 `observedAck < r ≤ latest`，否则 400 | 累计水位只能前进且不越过已存在的评论 |
| R6 | `addressedComments` 服务端派生：仅当本次创建版本时，取每个 threadUpdate 中 `observedAck < commentIdx ≤ respondThrough` 的评论 `{threadId, commentIdx, baseVersionIdx}`，按 threadUpdates 顺序再按 commentIdx 升序 | 与 `memory/agent.ts:89-99` 一致 |
| R7 | 锁判定顺序：版本锁 → contract → thread 锁，报第一个失败的 reason；conflict 体从提交后重新读取的状态构造 | 契约只允许一个 reason |
| R8 | retain 在 D1 提交之后；retain 失败**不回滚**，记 `portal_snapshot_retain_failed` 日志，收据照常返回 | spec §3.2 时序；回滚已提交事务不可能 |
| R9 | Agent Bearer：本地共享 token。portal 读 `AGENT_API_TOKEN` 与 `AGENT_TENANT_ID`，比较 SHA-256 摘要（`timingSafeEqual`），匹配 → `{transport:"bearer", tenantId: AGENT_TENANT_ID, principalId:"agent:markdown-primary", scopes:["documents:read","comments:read","comments:reply","versions:submit"]}`；不匹配或未配置 → 401，**不回退 cookie**。Bearer 不查 Origin/CSRF/sec-fetch-site，但请求 URL origin 仍须等于 `PORTAL_ORIGIN` | spec §3.5 |
| R10 | 作用域：bearer 只能调 tenant API 的 GET 与 submissions；bearer 调 tenant 写操作 → 403；session 调 submissions → 403 | 最小权限 |
| R11 | webhook 认证：HMAC-SHA256，密钥复用 `MARKDOWN_OPERATOR_HMAC_KEY`，头 `x-unidocs-webhook-timestamp`（Unix 秒）与 `x-unidocs-webhook-signature`（base64url），签名串 `"unidocs-operator-webhook-v1\n" + timestamp + "\n" + base64url(SHA-256(body))`，窗口 ±300 秒 | spec 未定义；service binding 是部署侧信任，签名防止 worker 公网 URL 被伪造调用 |
| R12 | 本地 Operator baseUrl 用现有字面量 `MARKDOWN_OPERATOR_BASE_URL`（不是 spec 写的 `https://markdown-operator.unidocs.local`） | 校验目标只认这个字面量，改它要动 admin 校验链路 |
| R13 | 派发失败只记日志 `portal_operator_webhook_failed`，不回滚、不重试 | spec §9 at-least-once 由后续事件与 Operator 幂等吸收；outbox 不在本轮 |
| R14 | dev 种子唯一的非 API 写入是**铸造一个本地种子管理员 session**（直接写 D1），其余全部经 admin HTTP API（cookie + CSRF） | 本地无法完成 Google 登录 |
| R15 | markdown Operator 的 `MARKDOWN_OPERATOR_DOCUMENT_TYPE` 在种子建出 document type 之后再注入（运行时重新配置 markdown worker 的 binding） | id 服务端生成，discovery 前必须知道 |
| R16 | Operator 行为判定：最新未响应评论文本匹配 `/^(?:改为|替换为|replace with)[:：]\s*([\s\S]+)$/i` 且带 text-range location → 改写版本 + reply；否则纯 reply | spec §8 两条路径都要实现，v0 判定可粗 |
| R17 | webui 异步刷新：文档 `currentVersionIdx === null` 时每 1.5 秒重拉文档，最长 60 秒；发出评论后每 1.5 秒重拉该线程，直到出现覆盖该评论的 reply，最长 60 秒 | Operator 异步；无推送通道 |
| R18 | Agent principal 用 `agent:markdown-primary`，而非 spec §3.5 所说与 descriptor `declaredOperatorId`（`markdown-primary`）完全相同 | 与 tenant 用户 principal 的命名空间区分；descriptor id 作为后缀保持可追溯 |

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `packages/service-auth/src/operator-webhook.ts` | **新建。** webhook 签名与验签（R11） |
| `packages/cloudflare-portal/migrations/0013_tenant_submissions.sql` | **新建。** `portal_submissions` |
| `packages/cloudflare-portal/src/tenant/snapshot-validator.ts` | **新建。** SValue snapshot 字节 → schema 校验（R3） |
| `packages/portal-service/src/tenant/submissions.ts` | **新建。** 提交服务与仓储接口 |
| `packages/cloudflare-portal/src/tenant/submission-repository.ts` | **新建。** D1 实现，原子提交 |
| `packages/cloudflare-portal/src/tenant/agent-auth.ts` | **新建。** Bearer 认证（R9） |
| `packages/cloudflare-portal/src/tenant/session.ts` | 修改：Authorization 分支交给 agent-auth |
| `packages/cloudflare-portal/src/tenant/agent-http.ts` | **新建。** `implement(agentApiContract)` |
| `packages/cloudflare-portal/src/operator-transport.ts` | 修改：新增 `webhook` |
| `packages/cloudflare-portal/src/tenant/operator-dispatch.ts` | **新建。** 组装、签名、派发 webhook |
| `packages/cloudflare-portal/src/tenant/tenant-http.ts` | 修改：写操作提交后回调、作用域（R10） |
| `packages/cloudflare-portal/src/worker.ts` | 修改：submissions 路由、ctx 传递、派发接线 |
| `packages/cloudflare-markdown/src/operator-webhook.ts` | **新建。** webhook 接收 |
| `packages/cloudflare-markdown/src/operator-agent.ts` | **新建。** 判定与提交逻辑 |
| `packages/cloudflare-markdown/src/platform-client.ts` | **新建。** 经 binding 调 Platform 的最小客户端 |
| `stacks/unidocs-cloudflare/local/{services,doc-types,runtime}.mjs` | 修改：portal 连带 markdown、双向 binding、共享密钥 |
| `stacks/unidocs-cloudflare/local/portal-seed.mjs` | **新建。** dev 种子 |
| `scripts/dev.mjs` | 修改：portal 启动后跑种子 |
| `packages/tenant-portal-webui/src/...` | 修改：新建文档、异步刷新 |
| `tests/integration/cloudflare/portal-operator-loop.test.mjs` | **新建。** 端到端 |

---

### Task 1: webhook 签名原语

**Files:**
- Create: `packages/service-auth/src/operator-webhook.ts`
- Modify: `packages/service-auth/src/index.ts`
- Test: `packages/service-auth/tests/operator-webhook.test.ts`

**Interfaces — Produces:**

```ts
export const OperatorWebhookTimestampHeader = "x-unidocs-webhook-timestamp";
export const OperatorWebhookSignatureHeader = "x-unidocs-webhook-signature";
export function signOperatorWebhook(body: Uint8Array, keyBytes: Uint8Array, issuedAt: Date): Promise<{ timestamp: string; signature: string }>;
export function verifyOperatorWebhook(body: Uint8Array, headers: { timestamp: string | null; signature: string | null }, keyBytes: Uint8Array, now: Date): Promise<boolean>;
```

**Background：** 照同目录 `operator-probe.ts` 的写法（域分隔串、base64url、密钥 ≥ 32 字节、HMAC 用 WebCrypto）。签名串见 R11。`verifyOperatorWebhook` **从不抛**：头缺失、格式错、窗口外、签名不符都返回 `false`。时间戳必须是纯十进制整数串。比较签名用常量时间（照 `operator-probe.ts` 现有做法；若它用 `crypto.subtle.verify`，同样用它）。

**测试保真度：** 真 WebCrypto，无 mock。

- [ ] **Step 1: 写失败的测试**，至少覆盖：
  1. sign → verify 往返为 true
  2. 改 body 一个字节 → false
  3. 换密钥 → false
  4. `now` 比 timestamp 晚 301 秒 → false；晚 300 秒 → true；早 301 秒 → false
  5. timestamp 为 `"12a"`、`""`、`null` → false
  6. signature 为 `null` 或长度不对 → false
  7. 密钥短于 32 字节 → `sign` 抛 `TypeError`，`verify` 返回 false
  8. 签名串包含域前缀：用同密钥对 `timestamp + "\n" + digest`（无前缀）手算 HMAC，断言它**不等于** `signOperatorWebhook` 的结果
- [ ] **Step 2: 跑测试确认失败**（`pnpm --filter @unidocs/service-auth exec vitest run operator-webhook`）
- [ ] **Step 3: 实现并从 `index.ts` 导出**
- [ ] **Step 4: 跑测试与 `pnpm --filter @unidocs/service-auth typecheck`，确认通过**
- [ ] **Step 5: Mutation check**：去掉窗口判断；去掉域前缀。各自确认对应测试变红，改回。
- [ ] **Step 6: Commit** — `feat(service-auth): sign and verify operator webhooks`，正文说明 service binding 之外为什么还要签名（worker 有公网 URL）。

---

### Task 2: submissions 表与 snapshot 校验器

**Files:**
- Create: `packages/cloudflare-portal/migrations/0013_tenant_submissions.sql`
- Create: `packages/cloudflare-portal/src/tenant/snapshot-validator.ts`
- Test: `packages/cloudflare-portal/tests/tenant/snapshot-validator.test.ts`
- Modify: `packages/cloudflare-portal/tests/tenant/migration.test.ts`（或新建 `submission-migration.test.ts`）

**迁移：**

```sql
CREATE TABLE portal_submissions (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, submission_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES portal_documents(tenant_id, document_id)
);
```

只存 committed 收据（R1），所以不需要 `state` 列——在迁移文件顶部用一行 SQL 注释写明这一点，并确认该注释能被 `splitSqlStatements` 正确处理（Task 1 of Plan 3 的真 D1 脚手架会应用全部迁移）。

**校验器 Interfaces — Produces:**

```ts
export type SnapshotValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid_request" | "unavailable" };
export function validateSnapshotBytes(bytes: Uint8Array, schema: SValueSchema): SnapshotValidation;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
```

**Background：** 规则（R3）：
- `schema.$schema !== SValueSchemaDialect` → `invalid_request`（contract 数据被写坏，但对调用方而言提交不成立；在注释里说明）
- schema 任意位置出现 `x-unidocs-sblob` → `unavailable`（v0 能力缺口）
- `bytes.byteLength > MAX_SNAPSHOT_BYTES` → `invalid_request`
- `decodeSValue` 抛 → `invalid_request`
- `toJsonValue` 抛（含 SBlob）→ `invalid_request`
- 去掉 `$schema` 后用 `@cfworker/json-schema` `Validator(schema, "2020-12", false)` 校验 JSON 投影，不通过 → `invalid_request`
- 从不抛

照 `src/tenant/location-validator.ts` 的写法（包括「从不抛」的 try/catch）。**不要**复制它的 `declaresSBlob`：把它提到一个共享的小函数（例如 `src/tenant/svalue-schema.ts` 的 `declaresSBlob`），两个校验器都用它，并保持 location-validator 的测试全绿。

**预审修正（优先于上文）：**
- 不要改 `tests/tenant/migration.test.ts`（它只把 0012 当文本读，没有 D1）。新建 `tests/tenant/submission-migration.test.ts`，用 `startRealD1()`。D1 默认强制外键：引用不存在的文档**必须**抛，直接这样断言。

**测试保真度：** 真 `@unidocs/svalue-codec` 编码的字节、真校验器。迁移测试真 D1。

- [ ] **Step 1: 写失败的测试**
  - 校验器：以 markdown snapshot schema `{ $schema: dialect, type:"object", required:["content"], additionalProperties:false, properties:{ content:{type:"string"} } }` 为基准：
    1. `encodeSValue({content:"# a"})` → ok
    2. `encodeSValue({content: 1})` → invalid_request
    3. `encodeSValue({content:"a", extra:"b"})` → invalid_request
    4. 随机垃圾字节 → invalid_request
    5. 超过 `MAX_SNAPSHOT_BYTES` 的 `Uint8Array`（不必是合法 CBOR）→ invalid_request，且断言没有调用解码（用尺寸检查先于解码的方式证明：传一个 8 MiB+1 的全零数组，仍返回 invalid_request 且耗时可忽略即可，不要 mock）
    6. schema 声明 `x-unidocs-sblob` → unavailable
    7. 非 SValue dialect → invalid_request
    8. 含 SBlob 的 SValue（`createSBlob`）配无 SBlob schema → invalid_request
  - 迁移（真 D1）：插入一行后，同主键再插 → 抛；`receipt_json` 非法 JSON → 抛；引用不存在的文档 → 抛（若 D1 默认未开外键，断言改为「在 `PRAGMA foreign_keys` 当前设置下的实际行为」并在报告说明）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑 `@unidocs/cloudflare-portal` 全包测试与 typecheck**
- [ ] **Step 5: Mutation check**：去掉尺寸上限；去掉 SBlob 声明检查；把 location-validator 改回自带的 `declaresSBlob` 副本并删掉共享函数里的数组递归——确认对应测试红。改回。
- [ ] **Step 6: Commit** — `feat(portal): store submission receipts and validate snapshot bytes`

---

### Task 3: 提交服务（portal-service）

**Files:**
- Create: `packages/portal-service/src/tenant/submissions.ts`
- Modify: `packages/portal-service/src/index.ts`（新增导出）
- Test: `packages/portal-service/tests/tenant-submissions.test.ts`

**Interfaces — Produces:**

```ts
export interface SubmissionThreadState {
  readonly threadId: string;
  readonly acknowledgedCommentIdx: number | null; // -1 在接口里表达为 null
  readonly latestCommentIdx: number;
  readonly comments: readonly { readonly commentIdx: number; readonly baseVersionIdx: number }[];
}
export interface SubmissionState {
  readonly documentType: string;
  readonly currentVersionIdx: number | null;
  readonly availableDocumentContractIdxs: readonly number[];
  readonly threads: ReadonlyMap<string, SubmissionThreadState>; // 只含请求里提到且存在的 thread
}
export interface SubmissionContract { readonly snapshotSchema: SValueSchema; readonly locationSchema: SValueSchema }
export interface SubmissionCommitCommand {
  readonly context: TenantContext;
  readonly documentId: string;
  readonly fingerprint: string;
  readonly request: AgentSubmissionRequest;
  readonly observed: SubmissionState;          // 服务读到并据此判定的状态
  readonly addressedComments: readonly AddressedComment[];
  readonly now: Date;
}
export type SubmissionCommitOutcome =
  | { readonly kind: "committed"; readonly receipt: CommittedSubmissionReceipt }
  | { readonly kind: "conflict" }; // 原子锁在提交瞬间失败
export interface TenantSubmissionRepository {
  findReceipt(context: TenantContext, documentId: string, submissionId: string): Promise<{ fingerprint: string; receipt: CommittedSubmissionReceipt } | null>;
  loadState(context: TenantContext, documentId: string, threadIds: readonly string[]): Promise<SubmissionState | null>;
  loadContract(documentType: string, documentContractIdx: number): Promise<SubmissionContract | null>;
  commit(command: SubmissionCommitCommand): Promise<SubmissionCommitOutcome>;
}
export type SnapshotVerifier = (ref: CasBlobRef, schema: SValueSchema, expectedContentType: string) => Promise<"ok" | "invalid_request" | "content_unavailable" | "unavailable">;
export function createTenantSubmissionService(repository: TenantSubmissionRepository, options: {
  readonly validateLocation: DocumentLocationValidator;
  readonly verifySnapshot: SnapshotVerifier;
  readonly now?: () => Date;
}): {
  create(context: TenantContext, tenantId: string, documentId: string, body: AgentSubmissionRequest): Promise<SubmissionReceipt>;
  get(context: TenantContext, tenantId: string, documentId: string, submissionId: string): Promise<CommittedSubmissionReceipt>;
};
```

`CommittedSubmissionReceipt` 是 `SubmissionReceipt` 的 committed 分支类型（用 `Extract` 取）。类型从 `@unidocs/protocol-platform` 导入；若 portal-service 尚未依赖它，加依赖与 tsconfig reference。

**`create` 流程（顺序是契约，测试要逐条钉住）：**

1. `requireTenantScope(context, tenantId)`；`requireIdentifier` 校验 documentId、submissionId、每个 threadId
2. 作用域：`context.transport !== "bearer"` 或 scopes 不含 `versions:submit` → `TenantAccessError("forbidden")`（R10）。**无 snapshot 的纯回复**只要求 `comments:reply`：规则为「有 snapshot 需要 `versions:submit`；有 threadUpdates 需要 `comments:reply`」
3. 结构（R5）：空提交 → invalid_request；`threadUpdates.length > 50` → invalid_request；threadId 重复 → invalid_request；每条回复 `content.text` 长度 > `TENANT_LIMITS.messageText` 或附件数 > `TENANT_LIMITS.attachments`，或任一 resultLocation 的 `canonicalJson(payload)` 字节数 > `TENANT_LIMITS.locationPayloadBytes` → invalid_request（Agent 契约没有 LIMIT_EXCEEDED，所以不是 `limit_exceeded`）。规则与 `threads.ts:46-52` 的 `requireBoundedMessage` 相同，但它未导出且不得改动 `threads.ts`：在 `submissions.ts` 内实现，注释指向 `threads.ts:46`
4. 指纹 = `await guardCanonicalization(() => schemaHash({ operation: "createSubmission", documentId, body }))`，`schemaHash`/`canonicalJson` 来自 `../identity.js`，与 `threads.ts:87` 同法
5. `findReceipt`：命中且指纹相同 → 返回收据；指纹不同 → invalid_request（R2）
6. `loadState`：null → not_found；请求中任何 threadId 不在 `state.threads` → not_found
7. 锁（R7），任一失败 → 返回 rejected 收据（conflict 用**这次读到的** state 构造；`rejectedAt = now`）：
   - 有 snapshot 且 `observedCurrentVersionIdx !== state.currentVersionIdx` → `version_conflict`
   - 有 snapshot 且 `newDocumentContractIdx` 不在 `availableDocumentContractIdxs` → `document_contract_conflict`
   - 任一 threadUpdate 的 `observedAcknowledgedCommentIdx !== thread.acknowledgedCommentIdx` → `reply_watermark_conflict`
8. 水位边界（R5）：`(observedAck ?? -1) < respondThrough ≤ latestCommentIdx`，否则 invalid_request
9. 有 snapshot：`loadContract(documentType, newDocumentContractIdx)` 为 null → unavailable；`newSnapshotBlob.contentType !== documentSnapshotContentType(documentType)` → invalid_request；`verifySnapshot` 结果非 ok → 按结果抛 `TenantOperationError`
10. `resultLocations`（R4）：每项 `documentContractIdx === newDocumentContractIdx` 且 `validateLocation(location, contract.locationSchema)`，否则 `location_contract_violation`
11. 派生 `addressedComments`（R6）
12. `commit`：`committed` → 返回收据；`conflict` → 重新 `loadState`，按第 7 步规则找出 reason 构造 rejected 收据；若重新读取后锁全部成立（极少见的竞态），再尝试**一次**完整流程（从第 5 步起）；仍冲突则抛 `unavailable`

`get`：`requireTenantScope` + 标识符 + 任一有效 Agent scope（`documents:read` 即可）；`findReceipt` 为 null → not_found。

**预审修正（优先于上文）：**
- 第 2 步的作用域规则只以这一版为准：`transport === "session"` → forbidden；带 `newSnapshotBlob` 需要 scope `versions:submit`；`threadUpdates` 非空需要 scope `comments:reply`；缺哪个 → forbidden。

**测试保真度：** 单元测试，仓储用**内存实现的测试替身**（在测试文件里写一个小 class，行为按上面接口），`verifySnapshot` 与 `validateLocation` 用可配置的桩。这一层证明的是**服务的判定顺序与分支**；原子性在 Task 4 用真 D1 证明。

- [ ] **Step 1: 写失败的测试**，每条流程步骤至少一个用例，另加：
  - 第 7 步三种 reason 各一例，断言返回的是 `state:"rejected"`、**`commit` 未被调用**
  - 版本锁与 thread 锁同时失败 → reason 为 `version_conflict`
  - `observedCurrentVersionIdx: null` 对 `currentVersionIdx: null`（首版本）→ 通过
  - addressedComments：thread 有评论 0..3、ack 为 0、respondThrough 为 2 → 恰为 commentIdx 1、2，带各自 baseVersionIdx；无 snapshot 时为空
  - `commit` 返回 conflict、重读后版本锁失败 → rejected `version_conflict`
  - `commit` 连续两次 conflict 且重读后锁都成立 → 抛 unavailable
  - session transport 调用 → forbidden；bearer 但只有 `comments:reply` 却带 snapshot → forbidden；只有 `comments:reply` 的纯回复 → 通过
  - 同 id 同体重放 → 返回旧收据且 commit 未调用；同 id 异体 → invalid_request
- [ ] **Step 2: 跑测试确认失败**（`pnpm --filter @unidocs/portal-service exec vitest run tenant-submissions`）
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑该测试文件与 `pnpm --filter @unidocs/portal-service typecheck`**。portal-service 的 typecheck 在 main 上就有与本 task 无关的错误（测试替身缺 `replayRemove` / `replayUpdate`）——报告中列出 typecheck 输出里**与本 task 文件相关的**错误为零即可
- [ ] **Step 5: Mutation check**：交换第 7 步中版本锁与 thread 锁的顺序；把 addressedComments 的下界从 `>` 改成 `>=`；去掉第 12 步的重读。确认对应测试红，改回。
- [ ] **Step 6: Commit** — `feat(portal-service): decide agent submissions against both optimistic locks`

---

### Task 4: D1 提交仓储

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/submission-repository.ts`
- Test: `packages/cloudflare-portal/tests/tenant/submission-repository.test.ts`

**Interfaces:** 实现 Task 3 的 `TenantSubmissionRepository`：`new D1TenantSubmissionRepository(database: D1Database)`。

**Background：**

- `loadState`：一条查询取文档（`document_type`、`current_version_idx`）；thread 水位照 `thread-repository.ts` 的派生 SQL；`comments` 取 `comment_idx, base_version_idx`；`availableDocumentContractIdxs` 照 `catalog-repository.ts` 的交集规则——**把该计算提成一个导出函数**（例如 `availableContractIdxs(registrationJson, viewManifest, documentType)`）供两处使用，不要复制；catalog 的测试必须保持全绿
- `loadContract`：读 `portal_document_contracts.record_json`，用 `DocumentContractRecordSchema` 解析，取 `snapshot.schema` 与 `location.schema`
- `findReceipt`：按 `(tenant_id, document_id, submission_id)`
- `commit`：**一个 `database.batch`**，顺序：
  1. 守卫：`INSERT INTO portal_mutation_guard (valid) SELECT CASE WHEN <全部锁成立> THEN 1 ELSE 0 END`。条件用 SQL 表达：
     - 有 snapshot：`(SELECT current_version_idx FROM portal_documents WHERE ...) IS ?observed`
     - 每个 threadUpdate：派生 acknowledged `IS ?observedAck`（null 对应 -1 的换算要在 SQL 或绑定值里一致处理）
     守卫失败 → CHECK 约束使整个 batch 回滚
  2. 有 snapshot：`INSERT INTO portal_versions (...)`，`version_idx = (SELECT COALESCE(MAX(version_idx), -1) + 1 ...)`，`parent_version_idx = observed`，`addressed_comments_json` 为 **camelCase** JSON（与 `version-repository.ts` 读取端一致——先读它确认字段名）
  3. 有 snapshot：`UPDATE portal_documents SET current_version_idx = <新 idx>`
  4. 每个 threadUpdate：`INSERT INTO portal_replies`，`reply_idx = MAX+1`，`result_locations_json`、`content_json` 形状与 `thread-repository.ts` 读取端一致
  5. `INSERT INTO portal_submissions`（收据 JSON）
  6. 守卫行清理：照 admin 仓储里 `portal_mutation_guard` 的现有用法（先读 `auth-repository.ts` 的 `guard()` 看它如何避免残留行），同样处理
- batch 抛错时：先 `findReceipt`（并发的同 id 已提交 → 返回 committed，指纹不同由服务层判）；否则判断是守卫 CHECK 失败还是主键冲突：守卫失败 → `{kind:"conflict"}`；主键冲突（并发写入抢了同一 version_idx / reply_idx）→ 最多重试 5 次，仍失败抛 `TenantOperationError("unavailable")`。**不要**用错误 message 文本判别——用「重读锁条件是否仍成立」判别：不成立 → conflict；成立 → 视为主键竞争重试
- 收据里的 `version`/`replies` 必须与随后 `version-repository` / `thread-repository` 读出来的记录**逐字段相等**（`createdAt` 精度一致：写入秒，收据里用同一个秒值转 ISO）

**预审修正（优先于上文）：**
- **索引值在 JS 里先读后绑定**，不要在 SQL 里 `MAX+1`：每次尝试前读 `COALESCE(MAX(version_idx),-1)+1` 与每个 thread 的 `COALESCE(MAX(reply_idx),-1)+1`，作为字面量绑定进 INSERT、`UPDATE portal_documents` 与 `receipt_json`（收据必须含确定的 `versionIdx`/`replyIdx`）。主键冲突即并发竞争，锁仍成立时重试，最多 5 次——照 `thread-repository.ts:274-330` 的 appendComment 写法。
- 守卫行：守卫 INSERT 之后**紧跟** `DELETE FROM portal_mutation_guard`，照 `auth-repository.ts:20` 的 `guard()`，不要放到 batch 末尾。
- 版本锁条件必须同时要求文档存在：`EXISTS (SELECT 1 FROM portal_documents WHERE ... AND current_version_idx IS ?)`，否则 `null IS null` 在文档缺失时也成立。batch 失败分类时文档已不存在 → `TenantOperationError("not_found")`。
- contract 可用性不在守卫里原子复查（admin 在读与提交之间改 view/operator 的窗口）：在 `commit` 的 doc comment 里写明这一已知缺口。

**测试保真度：** **真 D1**。并发用 `Promise.all` 同时发两个 commit。

- [ ] **Step 1: 写失败的测试**：
  1. 首版本提交：`portal_versions` 一行、`portal_documents.current_version_idx = 0`、`portal_submissions` 一行；收据 version 与 `D1TenantVersionRepository.get` 读出的记录深相等
  2. 带两个 threadUpdate 的纯回复：两行 replies、无 version、文档指针不变；`D1TenantThreadRepository.get` 读出的 replies 与收据深相等；该 thread 的派生 acknowledged 等于 respondThrough
  3. 版本锁失败（observed 与实际不同）→ `conflict`，**所有表行数与提交前完全相同**（逐表 COUNT，含 `portal_mutation_guard`）
  4. thread 锁失败 → 同上，零痕迹
  5. 带版本 + 回复的提交，其中 thread 锁失败 → 版本也不存在（原子性）
  6. 两个基于同一 observed 的版本提交并发 → 恰一个 committed、一个 conflict；`portal_versions` 恰一行
  7. 同一 thread 两个纯回复并发、observedAck 相同 → 恰一个 committed
  8. `availableDocumentContractIdxs` 在未登记 Operator 时为空数组；登记后为交集
  9. addressed_comments_json 写入后被 `version-repository` 读回为 `[{threadId, commentIdx, baseVersionIdx}]`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全包测试与 typecheck**（catalog 测试必须仍绿）
- [ ] **Step 5: Mutation check**：删掉守卫语句；把版本锁的 `IS` 改成 `>=`；让 reply 的 `reply_idx` 固定为 0。确认对应测试红，改回。
- [ ] **Step 6: Commit** — `feat(portal): commit agent submissions atomically in D1`

---

### Task 5: Agent Bearer 认证与作用域

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/agent-auth.ts`
- Modify: `packages/cloudflare-portal/src/tenant/session.ts`、`src/tenant/tenant-http.ts`
- Modify: `packages/cloudflare-portal/wrangler.jsonc`（vars 增 `AGENT_TENANT_ID: ""`，secrets.required 增 `AGENT_API_TOKEN`）与 `src/env.generated.d.ts`（照仓库生成方式；找不到生成脚本就手改并在报告说明）
- Test: `packages/cloudflare-portal/tests/tenant/agent-auth.test.ts`，并更新 `session.test.ts`、`session-http.test.ts`、`tenant-http-*.test.ts` 中受影响的用例

**Interfaces — Produces:**

```ts
export const AGENT_PRINCIPAL_ID = "agent:markdown-primary";
export const AGENT_SCOPES = ["documents:read", "comments:read", "comments:reply", "versions:submit"] as const;
export function authenticateAgent(request: Request, options: { origin: string; token: string | undefined; tenantId: string | undefined }): Promise<TenantContext>;
```

**Background：** 规则 R9。`authenticateTenant` 在检测到 `Authorization` 头时改为 `return authenticateAgent(...)`（它需要新增 `agentToken`、`agentTenantId` 两个选项；调用方 `worker.ts` 从 env 传入）。`token` 或 `tenantId` 为空 → 401（未配置等同拒绝）。头必须严格是 `Bearer <token>`（用 `@unidocs/service-auth` 的 `extractBearerCapability` 或同等正则），比较 SHA-256 摘要的 `timingSafeEqual`。

`session-http.ts` 的自动签发前提（带 Authorization 不签发）保持不变——它的测试必须仍绿。

作用域 R10 落在 `tenant-http.ts`：进入写操作（`documents.create`、`documents.moveCurrentVersion`、`threads.create`、`threads.appendComment`、`cas.issueCapability`）前若 `transport === "bearer"` → `TenantAccessError("forbidden")`。顺带修掉 Plan 3 遗留：`cas.issueCapability` 先 `requireTenantScope` 再抛 `unavailable`。

Plan 3 遗留一并做（同一文件）：`session.ts` 的 `find` 增加 `AND created_at <= ?`，`authenticateTenant` / `issue` 对非安全整数或负数 `now` 抛 `TypeError`（照 `auth.ts:72-73`）。

**预审修正（优先于上文）：**
- 时钟守卫测试改为：`now` 为 `1.5`、`-1`、`Number.MAX_SAFE_INTEGER + 1` → TypeError（毫秒级 `Date.now()` 是安全整数，不会抛，不要测它）。
- `session-http.ts`：`GET /portal/auth/session` 与 `POST /portal/auth/logout` 遇到 `transport === "bearer"` 的上下文一律 401（Agent 不是浏览器会话），加测试；自动签发前提（带 Authorization 不签发）不变。

**测试保真度：** 真 D1（session 部分）；agent-auth 纯单元。

- [ ] **Step 1: 写失败的测试**：
  - agent-auth：正确 token → bearer 上下文（断言全部字段）；错 token、`Bearer` 小写、多余空格、`Basic`、未配置 token、未配置 tenantId → 401；请求 URL origin 不符 → 403；**不看 cookie**：带有效 tenant session cookie + 错 token → 401
  - session：带有效 bearer 时 `authenticateTenant` 返回 bearer 上下文且不读 cookie；`now` 为毫秒级大数或 `1.5` → TypeError；`created_at` 在未来的 session 找不到
  - tenant-http：bearer 上下文调 `POST documents` → 403；bearer 调 `GET documents` → 200；`POST /tenants/t-other/cas-capabilities` → 403
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全包测试与 typecheck；跑 `tests/integration/cloudflare/portal-tenant-api.test.mjs`**（其第 2 步之类的 401 断言语义不变）
- [ ] **Step 5: Mutation check**：让错 token 回退到 cookie；去掉 bearer 写操作的 forbidden；去掉 `created_at <= ?`。确认红，改回。
- [ ] **Step 6: Commit** — `feat(portal): authenticate the operator agent with a bearer token`

---

### Task 6: agent HTTP 适配层与 worker 路由

**Files:**
- Create: `packages/cloudflare-portal/src/tenant/agent-http.ts`
- Modify: `packages/cloudflare-portal/src/worker.ts`
- Test: `packages/cloudflare-portal/tests/tenant/agent-http.test.ts`、更新 `tests/worker.test.ts`

**Interfaces — Produces:**

```ts
export interface AgentHttpDependencies {
  readonly submissions: TenantSubmissionRepository;
  readonly snapshots: SnapshotStore;
  readonly validateLocation: DocumentLocationValidator;
}
export function createAgentHttp(dependencies: AgentHttpDependencies): (request: Request, tenant: TenantContext, requestId: string) => Promise<Response>;
export function isSubmissionPath(pathname: string): boolean; // /api/v1/tenants/{t}/documents/{d}/submissions 及其子路径
```

**Background：**

- 照 `tenant-http.ts`：`implement(agentApiContract)`、`clientInterceptors` 做错误映射与日志（Plan 3 Task 7 的结论：只在 procedure 调用周围映射，客户端错误不记日志）、`readBoundedJsonRequest` 限制请求体，上限 `1_048_576` 字节（注释写明：这是整体请求的粗上限，防止无界缓冲；单条文本、附件、location 与 50 条 threadUpdate 的精确上限由服务层 Task 3 第 3 步执行）
- `STATUS` 与 tenant 一致；错误体 `{ error: { code, message, requestId } }`
- `verifySnapshot` 实现：`snapshots.read(ref)` → 流式读入并在超过 `MAX_SNAPSHOT_BYTES` 时停止 → `validateSnapshotBytes`；`read` 抛出的错误：已知的 CAS 404 / 尺寸不符 → `content_unavailable`，其它 → `unavailable`（照 `version-repository.ts:136-142` 的判定）。**CAS 构造失败（缺 binding）要记日志** `portal_cas_unavailable`（Plan 3 遗留），然后 `unavailable`
- 提交成功（committed 且含 version）后 `snapshots.retain(ref, requestId)`；失败按 R8 记日志不影响响应。**重放的收据不再 retain**
- `worker.ts`：在 `serveTenant` 内认证之后，`isSubmissionPath(path)` → `createAgentHttp`，否则 `createTenantHttp`。CAS 仍经 `lazySnapshotStore`。所有 Plan 3 的安全头与日志同样适用

**预审修正（优先于上文）：**
- 区分「CAS 未配置」不得靠 message 匹配：在 `worker.ts` 的 `lazySnapshotStore` 构造闭包里 catch 构造错误并重新抛出一个具名错误类（例如 `src/tenant/cas-unavailable.ts` 导出的 `CasUnavailableError`），适配层用 `instanceof` 判定并记 `portal_cas_unavailable`。`version-repository.ts` 的既有映射保持不变。

**测试保真度：** 适配层测试用**真 D1 仓储** + 内存 `SnapshotStore`（`read` 返回预置字节、`retain` 记录调用）。worker 测试沿用 `tests/worker.test.ts` 的真 D1 + 缺 CAS binding 的方式。

- [ ] **Step 1: 写失败的测试**：
  1. 首版本提交 201 committed；`retain` 恰被调用一次，参数 blobHash 正确
  2. 同 id 重放 201，`retain` 未再调用
  3. 版本锁冲突 201 rejected，conflict 字段正确，`retain` 未调用
  4. snapshot 字节不符 schema → 400；snapshot store `read` 抛 404 类错误 → 409；content type 不符 → 400
  5. resultLocations 违约 → 422
  6. `GET submissions/{id}` 已提交 → 200 收据；未知 / 被拒绝过的 id → 404
  7. session 上下文调 create → 403
  8. `retain` 抛错 → 仍 201，且记录了 `portal_snapshot_retain_failed`（spy console）
  9. worker：CAS binding 缺失时，**纯回复提交**仍 201（不触碰 CAS）；带 snapshot 的提交 → 503 且记 `portal_cas_unavailable`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全包测试、typecheck，与 `portal-tenant-api.test.mjs`**
- [ ] **Step 5: Mutation check**：提交前 retain；重放时 retain；让 `verifySnapshot` 忽略尺寸上限。确认红，改回。
- [ ] **Step 6: Commit** — `feat(portal): accept agent submissions over the platform contract`

---

### Task 7: webhook 派发

**Files:**
- Modify: `packages/cloudflare-portal/src/operator-transport.ts`
- Create: `packages/cloudflare-portal/src/tenant/operator-dispatch.ts`
- Modify: `packages/cloudflare-portal/src/tenant/tenant-http.ts`、`src/worker.ts`
- Test: `packages/cloudflare-portal/tests/operator-transport.test.ts`（若不存在则新建）、`tests/tenant/operator-dispatch.test.ts`、更新 `tests/tenant/tenant-http-write.test.ts`

**Interfaces — Produces:**

```ts
// operator-transport.ts：createBoundOperatorTransport 返回值新增
webhook(baseUrl: string, path: string, body: Uint8Array, headers: Readonly<Record<string, string>>): Promise<OperatorTransportResponse>;

// operator-dispatch.ts
export type CommittedTenantWrite =
  | { readonly kind: "document.created"; readonly tenantId: string; readonly documentId: string }
  | { readonly kind: "comment.appended"; readonly tenantId: string; readonly documentId: string; readonly threadId: string; readonly commentIdx: number }
  | { readonly kind: "current_version.moved"; readonly tenantId: string; readonly documentId: string };
export function createOperatorDispatcher(options: {
  readonly database: D1Database;
  readonly transport: () => ReturnType<typeof createBoundOperatorTransport>; // 惰性
  readonly keys: { resolve(baseUrl: string): Uint8Array | null };
  readonly now?: () => Date;
  readonly id?: () => string;
}): (write: CommittedTenantWrite) => Promise<void>; // 从不抛

// tenant-http.ts：TenantHttpDependencies 新增可选
readonly onCommitted?: (write: CommittedTenantWrite) => void;
```

**Background：**

- `webhook`：POST 到 `baseUrl + path`，`content-type: application/json`，沿用 allowlist、`redirect:"manual"`、超时、64 KiB 响应上限、200 + JSON 的要求；`headers` 只允许 `x-unidocs-` 前缀且沿用禁用名单（照 `probe` 的校验，**抽共用函数**，不要复制）
- 派发器：按文档读 `document_type` 与 `current_version_idx`，读 `registration_json` 的 `builtinOperator.baseUrl`（为 null → 静默返回并记 `portal_operator_webhook_skipped`）；`comment.appended` 读该 thread 派生 acknowledged；组装 `OperatorWebhookRequest`（`eventId = id()`，`occurredAt = now().toISOString()`），用 `OperatorWebhookRequestSchema.parse` 自检；`signOperatorWebhook`；`transport().webhook(baseUrl, "/tenants/{t}/documents/{d}", ...)`（路径段 `encodeURIComponent`）；响应必须 `OperatorWebhookResponseSchema` 且 `eventId` 相同，否则视为失败。任何失败 → `portal_operator_webhook_failed`（仅 name/message 与 eventId、documentId）
- `tenant-http.ts`：四个写操作在 service 成功返回后调用 `onCommitted`（幂等重放同样调用——at-least-once 语义允许；在注释说明）
- `worker.ts`：`serveTenant` 接收 `context?: ExecutionContext`；构造派发器（传输惰性：`() => createMarkdownOperatorValidationTarget(env.ADMIN_MARKDOWN_SERVICE, env.MARKDOWN_OPERATOR_HMAC_KEY).transport`，key 同理；构造失败在派发器内记日志）；`onCommitted = write => { const p = dispatch(write); context ? context.waitUntil(p) : void p; }`

**预审修正（优先于上文）：**
- `keys.resolve` 是异步的：`resolve(baseUrl: string): Promise<Uint8Array | null>`（与 `operator-validation-target.ts:17-21` 一致）。worker 里用一个惰性工厂一次性构造 `createMarkdownOperatorValidationTarget(...)`，同时提供 `transport` 与 `keys`；构造失败（缺 binding / key 格式错）在派发器内记日志并返回。

**测试保真度：** 派发器用**真 D1**（种入 document type registration 含 builtinOperator、文档、thread）+ 假 `service.fetch`（记录请求、返回可配置响应），并用真 `verifyOperatorWebhook` 验证签名。tenant-http 用真 D1 + spy `onCommitted`。

- [ ] **Step 1: 写失败的测试**：
  1. transport.webhook：非 allowlist baseUrl 拒绝；禁用头拒绝；非 200 / 非 JSON / 超 64 KiB 拒绝
  2. 派发 `document.created`：请求 URL、方法、body 通过 schema、签名可验
  3. 派发 `comment.appended`：`newComments[0]` 的 acknowledgedCommentIdx 为派生值（先插一条 reply 让它非 null）
  4. Operator 返回错误 eventId → 记 failed 日志，不抛
  5. 无 builtinOperator → 不发请求，记 skipped
  6. tenant-http：createDocument 成功后 `onCommitted` 恰一次、kind 正确；document_type_disabled 失败时未调用；appendComment 带正确 commentIdx
  7. worker：`MARKDOWN_OPERATOR_HMAC_KEY` 缺失时 createDocument 仍 201（派发失败只记日志）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全包测试、typecheck、`portal-tenant-api.test.mjs` 与 `portal-operator.test.mjs`**
- [ ] **Step 5: Mutation check**：派发前不签名；失败时抛出；写操作失败时也调用 `onCommitted`。确认红，改回。
- [ ] **Step 6: Commit** — `feat(portal): notify the document type's operator after tenant writes`

---

### Task 8: markdown Operator 回路

**Files:**
- Create: `packages/cloudflare-markdown/src/platform-client.ts`、`src/operator-agent.ts`、`src/operator-webhook.ts`
- Modify: `packages/cloudflare-markdown/src/worker.ts`、`package.json`、`tsconfig.json`、`wrangler.toml`（新增 binding 声明）
- Test: `packages/cloudflare-markdown/tests/operator-webhook.test.ts`、`tests/operator-agent.test.ts`

**新增 bindings（markdown worker `Env`）：**

| 名称 | 说明 |
| --- | --- |
| `PLATFORM_SERVICE: Fetcher` | 指向 portal worker |
| `PLATFORM_ORIGIN: string` | portal 的 origin，用于拼 URL（流量走 binding） |
| `PLATFORM_AGENT_TOKEN: string` | 与 portal `AGENT_API_TOKEN` 相同 |
| `OPERATOR_CAS_ORIGIN`、`OPERATOR_CAS_STACK_ID`、`OPERATOR_CAS_ISSUER`、`OPERATOR_CAS_AUDIENCE`、`OPERATOR_CAS_SIGNING_KID`、`OPERATOR_CAS_SIGNING_KEY` | Agent CAS 写入凭据；**不带 refDomain** |

（`MARKDOWN_OPERATOR_HMAC_KEY`、`MARKDOWN_OPERATOR_DOCUMENT_TYPE` 已有。）用 `OPERATOR_CAS_*` 前缀避免与该 worker 现有的 `CAS_*` 冲突。

**Interfaces — Produces:**

```ts
// platform-client.ts
export interface PlatformClient {
  getDocument(tenantId: string, documentId: string): Promise<DocumentRecord>;
  getThread(tenantId: string, documentId: string, threadId: string): Promise<ThreadDetail>;
  getSnapshotContent(tenantId: string, documentId: string, versionIdx: number): Promise<string>; // 解码 {content}
  submit(tenantId: string, documentId: string, body: AgentSubmissionRequest): Promise<SubmissionReceipt>;
}
export function createPlatformClient(env: { PLATFORM_SERVICE: Fetcher; PLATFORM_ORIGIN: string; PLATFORM_AGENT_TOKEN: string }): PlatformClient;

// operator-agent.ts
export interface SnapshotWriter { write(tenantId: string, documentType: string, content: string): Promise<CasBlobRef> } // 返回 Platform 形状 {blobHash,size,contentType}
export function createSnapshotWriter(env: OperatorCasEnv): SnapshotWriter; // 惰性构造 issuer
export function handleOperatorEvent(event: OperatorWebhookRequest, deps: { platform: PlatformClient; snapshots: SnapshotWriter; log?: (entry: object) => void }): Promise<void>;

// operator-webhook.ts
export function markdownOperatorWebhook(request: Request, env: Env, context: ExecutionContext | undefined, now?: () => Date): Promise<Response | null>;
```

**Background：**

- 路由：`POST /tenants/{tenantId}/documents/{documentId}`，其它方法 405。请求体照 `operator-endpoint.ts` 的 `boundedJson`（抽出来共用，不复制；上限 64 KiB）；`verifyOperatorWebhook` 失败 → 401 `{error:"operator_webhook_rejected"}`；body 不过 `OperatorWebhookRequestSchema` 或路径参数与 body 的 tenantId/documentId 不符，或 `documentType !== MARKDOWN_OPERATOR_DOCUMENT_TYPE` → 400；未配置（HMAC key / document type 缺）→ 503 `operator_not_configured`
- 验签通过后**立即**返回 200 `{accepted:true, eventId}`，工作放 `context.waitUntil(handleOperatorEvent(...))`（无 context 时直接 `void`）
- `worker.ts` 的 `fetch(request, env, ctx)`，路由顺序：`markdownOperatorWebhook` → `markdownOperatorEndpoint` → 其余不变
- `handleOperatorEvent`（R16）：
  - `document.created`：`currentVersionIdx !== null` → 不做事（重复投递）。否则 `getDocument` 取 name，content = `` `# ${name}\n\n` ``，`snapshots.write`，`submit({ submissionId: \`evt-${eventId}\`, observedCurrentVersionIdx: null, newDocumentContractIdx: 0, newSnapshotBlob, threadUpdates: [] })`
  - `comment.appended`：对 `newComments` 中每个不同 threadId：`getThread`；ack = replies 中最大 `respondThroughCommentIdx`（无则 null）；latest = 最大 commentIdx；latest ≤ (ack ?? -1) → 跳过（已被回复）。取 latest 评论：
    - 文本匹配 R16 且 `location?.locationType === "unidocs.markdown.text-range/v1"`：`getDocument` 取当前 `currentVersionIdx`，`getSnapshotContent` 取正文；定位：若 `content.slice(start, end) === quote` 用该范围，否则 `content.indexOf(quote)`（-1 → 走纯回复并说明找不到原文）；替换得新正文；写 CAS；提交 `observedCurrentVersionIdx: current, newDocumentContractIdx: 0, newSnapshotBlob, threadUpdates: [{ threadId, observedAcknowledgedCommentIdx: ack, respondThroughCommentIdx: latest, content: { text: \`已按评论修改：「${quote}」→「${replacement}」\`, richContent: null, attachments: [] }, resultLocations: [{ documentContractIdx: 0, locationType, payload: { start, end: start + replacement.length, quote: replacement } }] }]`
    - 否则纯回复：`threadUpdates` 同上但 `text: \`收到：${评论文本前 80 字}\``、`resultLocations: []`，无 snapshot 字段
    - `submissionId = \`evt-${eventId}-${threadId}-${attempt}\``
  - 收到 `rejected`：重读并重算，最多 3 次（attempt 0..2）；仍 rejected → 记日志放弃
  - `current_version.moved`：不做事
  - 任何异常记 `markdown_operator_event_failed`（name/message/eventId），不抛
- 消息内容字段形状以 `MessageContentSchema` 为准（先读 `protocol-tenant-portal` 确认 `richContent`/`attachments` 的确切要求）
- `createSnapshotWriter`：照 `tests/integration/cloudflare/portal-cas.test.mjs:40-76`：`createPkcs8CapabilityIssuer` + `createTenantCasClient({ baseUrl: OPERATOR_CAS_ORIGIN, stackId, tenantId, getToken: () => issuer.issue({ subject: "agent:markdown-primary", audience, tenantId, permissions: [casReadPermission(t), casWritePermission(t)] }) })` + `createCasBlobClient(cas).storeBlob(stream(encodeSValue({content})), { contentType: documentSnapshotContentType(documentType), size })`，返回 `{ blobHash: ref.hash, size: ref.size, contentType: ref.contentType }`
- `createPlatformClient`：所有请求 `new Request(\`${PLATFORM_ORIGIN}${path}\`, { headers: { authorization: \`Bearer ${token}\`, accept } })` 经 `PLATFORM_SERVICE.fetch`；非 2xx 抛带 status 的错误；响应用对应 Zod schema 解析

**预审修正（优先于上文）：**
- `createPlatformClient` 的 POST 必须带 `content-type: application/json`，body 为 `JSON.stringify(...)`（portal 的 `readBoundedJsonRequest` 拒绝其它类型）。
- webhook 路由不能复用返回解析值的 `boundedJson`：抽一个共享的有界读取函数 `readBoundedJson(request, maxBytes) → { bytes, value } | null`，probe 用 16 384、webhook 用 65 536。**验签必须对原始 `bytes`**，schema 解析用 `value`。判定顺序：未配置 503 → 读取失败 400 → 验签失败 401 → schema / 路径 / documentType 不符 400 → 200。
- `document.created` 的重试规则：提交返回 rejected 时，重新 `getDocument`；`currentVersionIdx !== null` → 停止（别人已初始化）；否则以 `evt-${eventId}-${attempt}` 重试，最多 3 次。首次提交的 submissionId 也用 `evt-${eventId}-0`。

**测试保真度：** webhook 路由单元测试用真 `signOperatorWebhook`；`handleOperatorEvent` 用内存 `PlatformClient` 与 `SnapshotWriter` 替身（行为：按预置状态返回、记录 submit 调用、可配置返回 rejected）。真 CAS 与真 portal 在 Task 11 的端到端里证明。

- [ ] **Step 1: 写失败的测试**：
  - webhook：签名正确 → 200 且 `waitUntil` 收到一个 promise；签名错 → 401 且未调度工作；documentType 不符 → 400；GET → 405；未配置 → 503
  - agent：
    1. document.created（current null）→ 一次 submit，snapshot 内容 `# 名称\n\n`，observed null，threadUpdates 空
    2. document.created（current 0）→ 无 submit
    3. 评论「改为：新文字」带 location 且 quote 匹配 → submit 含 snapshot（替换后的正文）与一条 threadUpdate，resultLocations 的 end 正确
    4. 评论「这里是什么意思？」→ submit 无 snapshot，resultLocations 空
    5. 已回复的 thread（ack = latest）→ 无 submit
    6. 第一次 rejected、第二次 committed → 两次 submit，submissionId 的 attempt 递增，第二次使用重读后的 ack / current
    7. quote 在原位不匹配但在别处存在 → 用 indexOf 位置
    8. 三次 rejected → 恰三次 submit，记放弃日志，不抛
- [ ] **Step 2: 跑测试确认失败**（`pnpm --filter @unidocs/cloudflare-markdown exec vitest run operator-`）
- [ ] **Step 3: 实现**（加依赖 `@unicas/tenant-blob-client`、`@unidocs/protocol-platform`、`@unidocs/protocol-tenant-portal`（若需要）并补 tsconfig references；`pnpm install`）
- [ ] **Step 4: 跑该包测试与 typecheck（`tsc --noEmit` 或包内既有命令）；原有 `operator-endpoint.test.ts`、`discovery.test.ts` 必须仍绿**
- [ ] **Step 5: Mutation check**：验签前就调度工作；纯回复路径也带 snapshot；rejected 后不重读直接重提。确认红，改回。
- [ ] **Step 6: Commit** — `feat(markdown): answer operator webhooks by submitting versions and replies`

---

### Task 9: 本地运行时连线

**Files:**
- Modify: `stacks/unidocs-cloudflare/local/services.mjs`、`doc-types.mjs`、`runtime.mjs`
- Test: `tests/integration/cloudflare/portal-local-runtime.test.mjs`（追加用例）

**Background：**

- 当 `services` 含 `portal` 时，**同时启动 markdown worker**（即使 `docTypes` 为空）。在 `parseTargets` 或 `startLocalRuntime` 里实现，二选一，保证 `pnpm dev portal` 与 `startLocalRuntime({ services: ["portal"] })` 行为一致
- 运行时每次启动生成（除非 `.dev.vars` 或环境变量已提供）：`MARKDOWN_OPERATOR_HMAC_KEY`（32 字节随机 → 64 位小写十六进制）与 `AGENT_API_TOKEN`（32 字节随机 base64url）
- portal worker 追加 bindings：`ADMIN_MARKDOWN_SERVICE` service binding → `unidocs-markdown`、`MARKDOWN_OPERATOR_HMAC_KEY`、`AGENT_API_TOKEN`、`AGENT_TENANT_ID: "t-local"`
- markdown worker 追加 bindings：`PLATFORM_SERVICE` → `unidocs-portal`、`PLATFORM_ORIGIN`（= portal 的 `PORTAL_ORIGIN`）、`PLATFORM_AGENT_TOKEN`、`MARKDOWN_OPERATOR_HMAC_KEY`、`OPERATOR_CAS_*`（取 stack fixture：`CAS_ORIGIN` 同 portal、`stackId`/`issuer`/`audience`/`kid`/`privateKeyPkcs8`）；`MARKDOWN_OPERATOR_DOCUMENT_TYPE` 初始**不设**
- R15：`startLocalRuntime` 返回值新增 `setMarkdownOperatorDocumentType(documentType: string): Promise<void>`，用 Miniflare 的 `setOptions` 以更新后的 bindings 重新配置（保留持久化与端口）。若 `setOptions` 在该版本不可用或会改变端口，改为在返回对象上提供等效实现并在报告说明取舍
- 返回值新增 `secrets: { agentToken, operatorHmacKey }`，供种子与测试使用

**预审修正（优先于上文）：**
- 在 `startLocalRuntime` 内实现「portal 连带 markdown」，**不要改 `parseTargets`**：`tests/unit/scripts/services.test.mjs:37-39`、`dev-targets.test.mjs:84`、`doc-types.test.mjs` 断言了现有形状；这三个单元测试加入 Step 4 并保持绿（若 `buildWorkers` 形状断言必须更新，只更新与新增 worker 相关的部分并在报告说明）。
- 端口：`ports` 新增 `markdown` 键（默认 8788）。给 `portal-local-runtime.test.mjs`、`portal-tenant-api.test.mjs`、`portal-cas.test.mjs`（它目前没有端口覆盖，补上完整覆盖）的 `PORTS` 都加 `markdown`，避免与正在运行的 dev 撞端口。
- binding：`extraBindings` 只支持普通值。`PLATFORM_SERVICE` 加在 doc-type worker 循环的 `serviceBindings`（与 `CAS_SERVICE` 并列，仅 markdown）；`ADMIN_MARKDOWN_SERVICE` 加在 portal 的 service worker 配置里。
- Miniflare 版本是根 `package.json` 的 `5.20260811.1-alpha`（不是 4）。`setOptions` 存在，但会使先前取得的 `getD1Database` / `getBindings` 句柄失效（poison proxies）：`startLocalRuntime` 保留一个 options 构造函数，重配置时用完整 options 重新 `convertV4MiniflareOptions` 后调用；**测试 2 必须在 `setMarkdownOperatorDocumentType` 之后重新获取 D1 句柄**再读回数据。

**测试保真度：** **真 worker**（`startLocalRuntime`）。

- [ ] **Step 1: 写失败的测试**（追加到 `portal-local-runtime.test.mjs`，沿用其 PORTS 覆盖）：
  1. `services:["portal"]` 时：`mf.getBindings("unidocs-portal")` 含 `MARKDOWN_OPERATOR_HMAC_KEY`（64 位小写十六进制）、`AGENT_API_TOKEN`（非空）、`AGENT_TENANT_ID === "t-local"`；markdown worker 已启动——直接 `fetch` 它的端口 `/.well-known/unidocs-operator` 得到 503 `operator_not_configured`（document type 尚未注入）
  2. `setMarkdownOperatorDocumentType("dt-test")` 后同一请求返回 200 且 descriptor 的 `supportedDocumentTypes` 为 `["dt-test"]`；portal 的 D1 数据在重配置后仍在（重配置前插一行，之后读回）
  3. markdown worker 的 `PLATFORM_AGENT_TOKEN` 等于 portal 的 `AGENT_API_TOKEN`
- [ ] **Step 2: 跑测试确认失败**（`pnpm exec vitest run tests/integration/cloudflare/portal-local-runtime.test.mjs --fileParallelism=false`）
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑 `portal-local-runtime`、`portal-cas`、`portal-tenant-api`、`markdown-discovery`、`portal-operator` 集成测试**，全部通过
- [ ] **Step 5: Mutation check**：不生成 HMAC key；重配置时丢掉 persist 选项。确认红，改回。
- [ ] **Step 6: Commit** — `feat(stack): run the markdown operator beside the portal and wire them together`

---

### Task 10: dev 种子

**Files:**
- Create: `stacks/unidocs-cloudflare/local/portal-seed.mjs`
- Modify: `scripts/dev.mjs`
- Test: `tests/integration/cloudflare/portal-seed.test.mjs`

**Interfaces — Produces:**

```js
/** 幂等。返回 markdown document type id。 */
export async function seedPortalCatalog(runtime, options?: { log?: (line: string) => void }): Promise<{ documentType: string }>;
```

**Background：**

1. **铸造种子管理员 session（R14，唯一的 D1 直写）**：经 `runtime.mf.getD1Database("DB", "unidocs-portal")`。先读 `packages/cloudflare-portal/src/auth-repository.ts` 的 `completeLogin`、`src/auth.ts` 的 `createAdminSession` / `hashSessionSecret` 与 `packages/portal-service` 的 `validateAdminIdentity`，按它们要求的形状写 `portal_administrators`（若表空则同时写 `portal_bootstrap`）、`portal_session_families`、`portal_sessions`（`identity_json` 必须能通过 `authenticate` 的校验）。邮箱 `seed@unidocs.local`，issuer `https://accounts.google.com`，subject `local-portal-seed`。已存在该管理员则复用。token 与 csrf 用 32 字节随机 base64url
2. 之后全部经 HTTP：`fetch(\`${PORTAL_ORIGIN}/admin/api/v1/...\`, { headers: { cookie: "__Host-unidocs_admin=<token>", "x-csrf-token": csrf, origin: PORTAL_ORIGIN, "idempotency-key": <随机> } })`，PATCH 带 `if-match`
3. 查找 `internalName === "markdown"` 的 document type（`GET /document-types?q=markdown` 或列表后过滤）；已 enabled 且 builtinOperator 非空 → 调 `runtime.setMarkdownOperatorDocumentType(dt)` 后直接返回
4. 否则按顺序：create type → append contract revision 0（snapshot schema 同 Task 2；location schema 同 `tests/tenant/location-validator.test.ts` 的 markdownRange）→ 上传 type card bundle（manifest `unidocs-type-card.json`，svg 图标，缩略图用 `portal-type-card-bundles.test.mjs` 里的 webp 字节）→ 上传 view bundle（`unidocs-view.json`，`supportedDocumentContractIdxs:[0]`，两个 html 入口）→ `runtime.setMarkdownOperatorDocumentType(dt)` → `POST /operator-validations`（`baseUrl: "https://unidocs-markdown.shazhou.workers.dev"`，`expectedDocumentType: dt`，`expectedConfigEtag: null`）→ `POST /operators` → `PATCH` 设 `typeCardBundleId`、`viewBundleId`、`builtinOperatorId`、`enabled: true`（按 schema 要求可一次或分次）
5. zip 用一个**无依赖的 STORED（不压缩）写法**在本文件内实现（本地 CRC32 表）；种子模块保持无第三方依赖（spec §11）
6. 每步失败抛出带步骤名与响应体的错误
7. `scripts/dev.mjs`：`services` 含 `portal` 时，`startLocalRuntime` 之后调用 `seedPortalCatalog`；失败只打印警告，不终止 dev

**预审修正（优先于上文）：**
- **不要写 `portal_bootstrap`**：它会让本地 Google bootstrap 永久失效（`auth-repository.ts:81-84`）。只写种子管理员、session family、session。若环境变量 `PORTAL_BOOTSTRAP_EMAIL` 或 `.dev.vars` 里配了 bootstrap 邮箱，种子完成后经 `POST /admin/api/v1/administrators` 邀请该邮箱（先读该契约的请求体）。
- 必填字段：bundle 上传 query `name`（非空）与 `description`；contract 追加 `formatVersion: 1` 与非空 `reason`；`POST /operators` 需 `name` 与 `description`；每个变更请求带新的 `idempotency-key`；PATCH 的 `if-match` 取 create 或 GET 响应里的 etag（每次 PATCH 后更新）；两个 manifest 的 `documentType` 用服务端返回的 `dt-…`。
- 幂等要支持**断点续跑**：按 `internalName === "markdown"` 找到已存在的草稿类型就沿用它，逐项检查已有的 contract（idx 0）、bundle、operator、enabled 状态，只补缺的步骤，不新建第二个类型。
- `setMarkdownOperatorDocumentType` 会使先前的 D1 / bindings 句柄失效：之后需要 D1 时重新获取。
- `scripts/dev.mjs` 在 stub 运行时（`dev-targets.test.mjs` 的 harness，没有 `mf`）下跳过种子；该单元测试保持绿。

**测试保真度：** **真 worker** + 真 admin API。

- [ ] **Step 1: 写失败的测试**：
  1. 空库调用 → 返回 dt；`GET /api/v1/tenants/t-local/document-types`（先取 tenant session）列出该类型，`availableDocumentContractIdxs` 为 `[0]`
  2. 再调一次 → 返回同一 dt，且 `portal_document_types`、`portal_operators`、`portal_view_bundles` 行数不变
  3. 种子后 `portal_administrators` 恰有种子管理员一行（空库场景）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑该测试与 Task 9 列出的集成测试**
- [ ] **Step 5: Mutation check**：省略 `setMarkdownOperatorDocumentType` 调用（operator validation 应失败，测试红）；去掉幂等查找（第二次调用行数变化，测试红）。改回。
- [ ] **Step 6: Commit** — `feat(stack): seed the markdown document type and operator through the admin API`

---

### Task 11: 端到端回路

**Files:**
- Test: `tests/integration/cloudflare/portal-operator-loop.test.mjs`

**Background：** 一个 `startLocalRuntime({ services: ["portal"], ports: <独立端口> })` + `seedPortalCatalog`，然后以 tenant session 走完。等待异步结果用有界轮询（每 250ms，最多 20 秒），超时信息写明在等什么。

序列（每步独立断言，失败信息能看出是哪一步）：

1. 取 tenant session；`POST documents`（idempotency-key、csrf、origin）→ 201，`currentVersionIdx` null
2. 轮询 `GET documents/{id}` 直到 `currentVersionIdx === 0`
3. `GET versions/0/snapshot` → 200，content type 为 markdown snapshot 类型，`decodeSValue` 后 `content === "# <name>\n\n"`；`GET versions/0` 的 `authorAgentId === "agent:markdown-primary"`
4. **验证 CAS 业务根被 retain**：直接用 stack fixture 构造 Agent 读客户端 `openBlob(hash)` 成功（与 `portal-cas.test.mjs` 同法）。若 embedded CAS 暴露 root ref 查询，额外断言该 hash 有根引用；否则在测试注释中说明只验证了可读
5. 发纯回复型评论：`POST threads`，body `baseVersionIdx: 0`、text「这是什么？」、location 为覆盖标题的 text-range → 201
6. 轮询 `GET threads/{id}` 直到出现 reply；断言 `respondThroughCommentIdx === 0`、`resultLocations` 空；`GET documents/{id}` 的 `currentVersionIdx` 仍为 0
7. 发修改型评论：另一个 thread，text「改为：新标题」，location 覆盖 `<name>`（start/end/quote 精确）
8. 轮询直到 `currentVersionIdx === 1` 且该 thread 有 reply；`GET versions/1` 的 `parentVersionIdx === 0`、`addressedComments` 为 `[{threadId, commentIdx: 0, baseVersionIdx: 0}]`；snapshot content 为 `# 新标题\n\n`；reply 的 `resultLocations[0].payload.quote === "新标题"`
9. `GET threads?open=true` 不含这两个 thread
10. 读 `portal_submissions` 行数，断言恰为 3（首版本、纯回复、修改），且 `portal_versions` 恰为 2——证明 Operator 没有为记录对话造版本、也没有重复提交

**预审修正（优先于上文）：**
- 启动参数必须是 `startLocalRuntime({ docTypes: [], services: ["portal"], ports: <含 markdown 的完整独立端口> })`——省略 `docTypes` 会启动全部文档类型。
- 第 4 步改为用运行时现有的根引用探针断言 retain：`runtime.storage.middlewareRetainedRoots(stackId, tenantId)`（`runtime.mjs:339-351`）中包含版本 0 的 blobHash 且 count ≥ 1。仅 `openBlob` 成功不能证明 retain（lease 中的节点也可读）。

**测试保真度：** **真 worker、真 CAS、真 D1**，不 mock 任何东西。

- [ ] **Step 1: 写测试**（此时 Task 1–10 已完成，预期直接通过或暴露集成缺陷）
- [ ] **Step 2: 运行**：`pnpm exec vitest run tests/integration/cloudflare/portal-operator-loop.test.mjs --fileParallelism=false`
- [ ] **Step 3: 若失败，定位根因并修复在对应源文件**（不要改测试去迁就），每个修复附带一个能在更低层复现它的单元或集成测试
- [ ] **Step 4: 跑全部相关集成测试**：`portal-local-runtime`、`portal-cas`、`portal-tenant-api`、`portal-seed`、`portal-operator`、`markdown-discovery`、`portal-operator-loop`
- [ ] **Step 5: Mutation check**：让 Operator 在纯回复路径也提交 snapshot（第 6 步或第 10 步应红）；让 portal 派发不调用 `waitUntil` 也不启动 promise（第 2 步超时红）。改回。
- [ ] **Step 6: Commit** — `test(portal): prove the operator loop end to end on a real stack`

---

### Task 12: webui 新建文档与异步刷新，最终验收

**Files:**
- Modify: `packages/tenant-portal-webui/src/pages/workbench.tsx`、`src/pages/document.tsx`，以及实现所需的 hook / model 文件
- Test: `packages/tenant-portal-webui/tests/workbench.test.tsx`、`tests/document-page.test.tsx`（或新建 `tests/polling.test.ts`）
- Modify: `packages/cloudflare-portal/src/tenant-ui-assets.generated.ts`（构建生成）

**Background：**

- 工作台新建入口：按钮「新建文档」→ 表单（名称输入 + 文档类型选择，类型来自 `client.listDocumentTypes()`，显示 type card 的名称；只有一个类型时默认选中）→ `client.createDocument(crypto.randomUUID(), { documentType, name })` → 成功后跳转文档页。失败显示错误文案（沿用 `error-text.ts`）。**提交中禁用按钮**，同一次提交重试沿用同一个 idempotency key
- R17 轮询：抽成可测试的纯函数或 hook（例如 `pollUntil(read, done, { intervalMs, timeoutMs, signal })`），组件卸载时取消。文档页 `currentVersionIdx === null` 时轮询文档；发出评论（新 thread 或追加）后轮询该 thread，直到存在 reply 的 `respondThroughCommentIdx >= 新评论 commentIdx`，并同时刷新文档（可能产生新版本）。超时后显示「Operator 暂未响应，可稍后刷新」
- Plan 3 遗留：session 中途过期（任一请求 401）→ 重新调用 `loadTenantSession`，成功则重试一次原请求，失败显示登录提示。实现位置自选（transport 包装或 client 层），加测试
- 改完执行 `pnpm --filter @unidocs/cloudflare-portal build:webui` 并提交生成文件；若 `ui-assets.generated.ts`（admin）无内容变化则不暂存

**预审修正（优先于上文）：**
- 类型列表方法是 `client.listPublicDocumentTypes()`（`tenant-portal-client/src/client.ts:33`）。显示名取 `typeCard.locales` 中 `zh` → `en` → 第一个键的 `name`。

**测试保真度：** jsdom + testing-library，client 用内存 transport（它现在要求 idempotency key）；轮询用 fake timers。最终验收在真 stack 上手工进行。

- [ ] **Step 1: 写失败的测试**：
  1. 工作台点「新建文档」、输入名称、提交 → `createDocument` 以非空 key 调用一次，路由跳到新文档
  2. 提交中按钮禁用；失败后重试沿用同一 key
  3. `pollUntil`：done 在第 3 次读取为真 → 恰读 3 次；超时 → reject；signal 取消后不再读取
  4. 文档页 null 版本 → 轮询到版本出现后正文渲染、等待文案消失
  5. 发评论后轮询到 reply 出现即停止
  6. 401 → 重新取 session → 重试成功
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑 webui 与 client 的 test、typecheck；构建 webui；跑 `portal-tenant-api` 与 `portal-operator-loop` 集成测试**
- [ ] **Step 5: 真 stack 验收（spec §15）**：后台启动 `pnpm dev portal`（若 8795 已被占用，不要杀进程，改用 `startLocalRuntime` 的独立端口脚本复现同一流程），读 `.dev-cloudflare.log` 确认种子成功。浏览器不可用时用 curl + cookie jar 走一遍：session → 列类型 → 建文档 → 等版本 → 取 snapshot → 建评论 → 等回复。报告逐条对照 §15 的 1–5 写明观察结果（第 6 条的 `pnpm -r test/typecheck` 只报告与本分支相关包的结果，并列出 main 上既有的失败）。结束后停止进程
- [ ] **Step 6: Mutation check**：轮询不在卸载时取消（测试应检测到卸载后仍读取）；创建重试生成新 key。确认红，改回。
- [ ] **Step 7: Commit**（源码与生成文件可分两个 commit）— `feat(tenant-portal): create documents and follow the operator's asynchronous replies`

---

## Plan 4 完成标准

- [ ] 改动包（`service-auth`、`portal-service` 中本 plan 新增文件、`cloudflare-portal`、`cloudflare-markdown`、`tenant-portal-client`、`tenant-portal-webui`）test 与 typecheck 通过
- [ ] 集成测试全部通过：`portal-local-runtime`、`portal-cas`、`portal-tenant-api`、`portal-seed`、`portal-operator`、`markdown-discovery`、`portal-operator-loop`
- [ ] `pnpm dev portal` 下 spec §15 第 1–5 条成立（Task 12 Step 5 的报告为证）
- [ ] 被拒绝的提交在真 D1 上零痕迹（Task 4 测试为证）
