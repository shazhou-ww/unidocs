# UniDocs Platform v0 当前任务状态

更新时间：2026-09-10
分支：`unidocs-webui`  
阶段：目标设计与可执行线契约定义，尚未进入 Platform 服务实现。

## 本轮目标

从新版 Admin WebUI mock 反推文档类型控制面，确定 Platform、View bundle、Type Card bundle、Operator Agent 与 Snapshot Contract 的资源边界和 API 形状。

## 已完成

### 系统边界

- Platform 是文档、版本、thread、current pointer、审计和 Agent submission 的唯一持久权威。
- View bundle 在隔离 iframe 中运行，只通过 Host RPC 使用 Platform 能力。
- Operator Agent 维护自己的任务/session，通过 Platform 查询和原子 submission 生成 pong 与完整 snapshot。
- 不再引入独立 editor service 或由文档类型服务持有的正式 document session。

### 文档类型控制面

- 新类型只用 Admin 内部名称创建，初始为 disabled 草稿。
- 草稿允许长期缺少配置；启用前必须具备最新 Snapshot Contract、当前 Type Card bundle、当前 View bundle 和当前 Operator candidate。
- Type Card bundle 与 View bundle 内容寻址且不可变，上传后显式选择当前包。
- Operator validation 是短期结果，可转换为持久 Operator candidate。
- 三类候选均有独立、可修改、仅 Admin 可见的 `name`、`description` 和 `etag`；这些字段不进入不可变 manifest 或 Operator discovery descriptor。

### Type Card bundle

- manifest 提供多语言名称、描述、sample thumbnail alt、图标和 sample thumbnail。
- `locales` 必须包含 `en`；bundle 不声明默认 locale。
- Host 按用户 UI locale 做 RFC 4647 lookup，最终回退到 `en`。
- 图标是 discriminated union：单个无尺寸 SVG，或包含 16/32/64/128/256 全部预定义尺寸的 PNG 集合。
- Admin preview 的语言选择器属于预览工具栏，不属于最终用户卡片。

### Snapshot Contract

- 每种文档类型有从 1 开始单调递增的 `SnapshotContractIdx`。
- revision 只能追加，不可修改、删除、弃用、回退或手动设为 current。
- 最大 idx 自动成为最新版，也是唯一允许创建新 snapshot 的 revision。
- 已启用类型不能追加 revision；必须先停用，再追加并配置支持最新版的 View/Operator 后重新启用。
- `VersionRecord` 永久记录 `snapshotContractIdx`；历史 contract 用于读取和验证旧版本。
- Agent submission 创建版本时必须携带 `newSnapshotContractIdx`，且必须等于最新版。

### SValue schema

- `SValueSchema` 定义在 `@unidocs/protocol`，是 JSON Schema 2020-12 的扩展 dialect。
- `$schema` 固定为 `https://schemas.unidocs.dev/svalue/v1`。
- `x-unidocs-sblob: true` 表示 schema 节点匹配原子 `SBlob`。
- 可用 `x-unidocs-blob-content-types` 和 `x-unidocs-blob-max-size` 约束 blob。

### 设计上下文

本轮权威上下文已收拢到本目录：

- [协作范式](../agent-mediated-document-collaboration.md)
- [统一 API 设计](../platform-view-operator-api-v0.md)
- [Admin WebUI mock](unidocs-admin-mock.html)
- [Admin 上下文索引](README.md)
- [Platform v0 上下文索引](../README.md)

旧的 Admin 单 URL API/WebUI 文档保留在上级目录，仅作历史对照，并已标记由本设计取代。

## 已修改的契约

- `packages/protocol/src/types.ts`：`SValueSchema` dialect。
- `packages/protocol-platform/src/common.ts`：Snapshot Contract 与候选项身份类型。
- `packages/protocol-platform/src/resources.ts`：`SnapshotContractRecord`、版本 revision。
- `packages/protocol-admin/src/schemas.ts`：管理员控制面 DTO 的 Zod 4 runtime schema 与静态类型。
- `packages/protocol-admin/src/contract.ts`：bundle、Snapshot Contract、Operator、文档类型与管理员成员 API。
- `packages/protocol-platform/src/platform.ts`：公共类型目录与 contract 读取。
- `packages/protocol-platform/src/agent.ts`：最新版 contract submission 锁。

管理员控制面已从 `@unidocs/protocol-platform` 拆分到 `@unidocs/protocol-admin`。新包只依赖拥有 SValue schema dialect 的基础 `@unidocs/protocol`，不依赖 Platform 服务、`@unidocs/protocol-platform`、Node.js 或 Cloudflare adapter。

`@unidocs/protocol-admin` 已升级为 contract-first 协议包：Zod 4 schema 是 Admin DTO 的运行时与静态类型来源，oRPC contract 定义 23 个 Admin v1 operation 的 method、path、headers、status 与领域错误，并从同一 contract 生成 OpenAPI 3.1 JSON 和内嵌规范的 Scalar HTML。文档分组按 Admin UI 排列为 Document types、Snapshot Contracts、Type Card bundles、View bundles、Operators、Members。bundle 上传的初始 `name`/`description` 使用 UTF-8 query 参数，body 保持原始 `application/zip` 流。

目前没有实现 Platform HTTP handler、持久化、Snapshot Contract validator 或 bundle validator；Admin 协议包只负责 wire contract、基础 DTO runtime validation 与文档生成。

## 已验证

- `pnpm typecheck`：41 个 workspace package 通过。
- `pnpm check:cas-contract-docs`：64 份当前契约文档通过。
- `pnpm --filter @unidocs/protocol-admin test`：9 个 schema、contract、OpenAPI 与 Scalar HTML 测试通过。
- `pnpm --filter @unidocs/protocol-admin typecheck`：源码、测试与文档生成脚本通过。
- `node --check docs/design/platform-v0/admin/unidocs-admin-mock.js`：通过。
- `git diff --check`：通过。
- 浏览器验证：停用类型可追加 revision 2；新 revision 自动成为唯一可写；旧 revision 只读；无删除或“设为当前”操作；移动后的 mock 资源正常加载。

## 当前不做

- 不实现真实 Admin WebUI；`unidocs-admin-mock.html` 只是页面内存 mock。
- 不实现 Platform 服务、数据库表、R2 repository 或 Operator 服务。
- 不设计旧系统兼容或迁移。
- 不把目标设计描述为已部署能力。

## 下一轮建议

1. 审查 `SValueSchema` 类型是否需要更精确地覆盖递归 JSON Schema 关键字，以及 `$defs` 中的 SBlob 扩展。
2. 明确 Snapshot Contract append 的 canonical JSON、`schemaHash` 算法、content type 规范和大小限制。
3. 明确新 revision 对已有文档的迁移工作流；当前只规定新 snapshot 必须使用最新版。
4. 审查 View/Operator 对 revision 的支持声明，是显式 idx 集合还是连续范围。
5. 从 Admin mock 逐项核对候选 metadata PATCH、`If-Match`、`Idempotency-Key` 与协议包生成的 OpenAPI。
6. 基于 `@unidocs/protocol-admin` contract 实现云中立 Admin handler，再分别接 Node.js 与 Cloudflare Fetch adapter。

## 相关提交

- `1cca5aa` `feat(platform): define collaboration protocol contracts`
- `05e34c1` `feat(platform): refine document type admin mock`
- `e76fe0c` `feat(platform): define snapshot contract revisions`
