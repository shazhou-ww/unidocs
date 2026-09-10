# UniDocs Platform v0 当前任务状态

更新时间：2026-09-10
分支：`unidocs-webui`  
阶段：目标设计与可执行线契约定义，尚未进入 Platform 服务实现。

## 本轮目标

从新版 Admin WebUI mock 反推文档类型控制面，确定 Platform、View bundle、Type Card bundle、Operator Agent 与配对 Document Contract 的资源边界和 API 形状。

## 已完成

### 系统边界

- Platform 是文档、版本、thread、current pointer、审计和 Agent submission 的唯一持久权威。
- View bundle 在隔离 iframe 中运行，只通过 Host RPC 使用 Platform 能力。
- Operator Agent 维护自己的任务/session，通过 Platform 查询和原子 submission 生成 pong 与完整 snapshot。
- 不再引入独立 editor service 或由文档类型服务持有的正式 document session。

### 文档类型控制面

- 新类型只用 Admin 内部名称创建，初始为 disabled 草稿。
- 草稿允许长期缺少配置；启用前必须具备至少一个 Document Contract、当前 Type Card bundle、当前 View bundle 和当前 Operator，且 View/Operator 至少共同支持一个已有 contract revision。
- Type Card bundle 与 View bundle 内容寻址且不可变，上传后显式选择当前包；记录保存上传时确认的 immutable canonical `bundleUrl`。
- 成功 Operator validation 是短期 immutable record，可转换为持久 Operator；失败只写 audit。validation 过期后可物理删除，因此 validation 表不是严格 append-only。
- Type Card bundle、View bundle 与 Operator 均有独立、可修改、仅 Admin 可见的 `name`、`description` 和 `etag`；这些字段不进入不可变 manifest 或 Operator discovery descriptor。

### Type Card bundle

- manifest 提供多语言名称、描述、sample thumbnail alt、图标和 sample thumbnail。
- `locales` 必须包含 `en`；bundle 不声明默认 locale。
- Host 按用户 UI locale 做 RFC 4647 lookup，最终回退到 `en`。
- 图标是 discriminated union：单个无尺寸 SVG，或包含 16/32/64/128/256 全部预定义尺寸的 PNG 集合。
- Admin preview 的语言选择器属于预览工具栏，不属于最终用户卡片。

### View bundle

- manifest 提供不同文件的 `interactive` 与 `thumbnail` 两个 HTML 入口。
- interactive 入口承载完整 snapshot 视图、viewport state、comment 锚点高亮和类型专用视图工具。
- thumbnail 入口不含交互 chrome，按 Host 指定的尺寸、device pixel ratio 和背景策略确定性渲染，供无头浏览器或 `html2canvas` 捕获。
- thumbnail 尺寸不写入 manifest；同一入口通过 View Host RPC 服务多种当前及未来尺寸。

### Document Contract

- `DocumentContractIdx`、`VersionIdx`、`PingIdx` 和 `PongIdx` 均从 0 开始；`null` 表示尚无 record，0 不是 sentinel。
- 同一不可变 JSON 原子携带 snapshot schema 与 location schema；任一部分失败则整个 append 失败。
- revision 只能追加，不可修改、删除、弃用、回退或手动设为 current；最大 idx 只表示最后上传。
- enabled 类型也可随时追加 revision；append 不会改变已有可写集合。
- 当前 View、Operator 与已提交 revisions 的交集构成可用于新数据的集合，不再只有最新 revision 可写。
- `VersionRecord` 与对应的 `DocumentLocation` 永久记录同一 `documentContractIdx`；Platform 分别校验 snapshot 和 `{ locationType, payload }`。
- Agent submission 创建版本时必须携带 `newDocumentContractIdx`，但不要求等于最大 idx。
- append 请求只传配对的 `formatVersion`，不传自由 content type；v1 结合 MIME-safe `documentType` 派生类型专属 snapshot CBOR 与 location JSON media type，例如 PSD 使用 `application/vnd.unidocs.psd.snapshot+cbor;version=1` 和 `application/vnd.unidocs.psd.location+json;version=1`。format version 表示线编码，`DocumentContractIdx` 表示 schema revision。

### SValue schema

- `SValueSchema` 定义在 `@unidocs/protocol`，是 JSON Schema 2020-12 的扩展 dialect。
- `$schema` 固定为 `https://schemas.unidocs.dev/svalue/v1`。
- `x-unidocs-sblob: true` 表示 schema 节点匹配原子 `SBlob`。
- 可用 `x-unidocs-blob-content-types` 约束 blob 的逻辑 content type；大小上限由 UniCAS 统一规定，schema 不接受 `x-unidocs-blob-max-size`。

### 设计上下文

本轮权威上下文已收拢到本目录：

- [协作范式](../agent-mediated-document-collaboration.md)
- [统一 API 设计](../platform-view-operator-api-v0.md)
- [Platform ER Model](../platform-er-model-v0.md)
- [Admin WebUI mock](unidocs-admin-mock.html)
- [Admin 上下文索引](README.md)
- [Platform v0 上下文索引](../README.md)

旧的 Admin 单 URL API/WebUI 文档保留在上级目录，仅作历史对照，并已标记由本设计取代。

## 已修改的契约

- `packages/protocol/src/types.ts`：`SValueSchema` dialect。
- `packages/protocol-platform/src/common.ts`：Document Contract、location 与候选项身份类型。
- `packages/protocol-platform/src/resources.ts`：`DocumentContractRecord`、版本 revision。
- `packages/protocol-admin-portal/src/schemas.ts`：管理员控制面 DTO 的 Zod 4 runtime schema 与静态类型。
- `packages/protocol-admin-portal/src/contract.ts`：bundle、Document Contract、Operator、文档类型与管理员成员 API。
- `packages/protocol-platform/src/platform.ts`：公共类型目录与 contract 读取。
- `packages/protocol-platform/src/agent.ts`：可用 paired contract submission 约束。

管理员控制面已从 `@unidocs/protocol-platform` 拆分到 `@unidocs/protocol-admin-portal`。新包只依赖拥有 SValue schema dialect 的基础 `@unidocs/protocol`，不依赖 Platform 服务、`@unidocs/protocol-platform`、Node.js 或 Cloudflare adapter。

`@unidocs/protocol-admin-portal` 已升级为 contract-first 协议包：Zod 4 schema 是 Admin DTO 的运行时与静态类型来源，oRPC contract 定义 26 个 Admin v1 operation 的 method、path、headers、status 与领域错误，并从同一 contract 生成 OpenAPI 3.1 JSON 和内嵌规范的 Scalar HTML。文档分组按 Admin UI 排列为 Document types、Document Contracts、Type Card bundles、View bundles、Operators、Members、Audit。Type Card/View bundle body 保持原始 `application/zip` 流；Document Contract 直接以 JSON body 原子提交两个 schema 与审计原因。`GET /audit-events` 提供 actor、action、resource、document type、时间与 cursor 过滤，并返回带 request correlation 的不可变事件。

Admin v1 的每个 operation 支持 Bearer token 与 Web UI session cookie 两套独立鉴权。请求存在 Bearer token 时只走 Bearer 鉴权，失败不 fallback 到 cookie；没有 Bearer token 时使用 cookie，且 mutation 额外要求 CSRF。OpenAPI 对读取建模为 `Bearer OR cookie`，对 mutation 建模为 `Bearer OR (cookie AND CSRF)`。

Admin API 遵循顶层 `docs/api-conventions.md` 的“完整读、瘦写”规则：持久资源 mutation 只返回资源 ID/idx 与新的 ETag/hash，不回显 manifest、schema、descriptor 或完整 registration；完整 representation 通过 GET 获取。同步 Operator validation 保留完整结果，DELETE 保持 `204`。

所有 collection GET 使用轻量 summary DTO；完整 manifest、Operator descriptor、paired schemas 和 registration 只由 item GET 返回。Operator 与 administrator member 已补充 canonical item GET。每个 operation 只声明实际可能出现的领域错误，不再把 bundle、precondition 等错误复制到无关 GET。

Platform 管理资源的 ETag 是 canonical resource representation 的强 SHA-256 entity-tag，格式为 `"sha256-<base64url digest>"`；hash 输入排除 `etag` 自身，但包含全部并发控制字段。客户端必须原样回传，不能解析或自行重算。

目前没有实现 Platform HTTP handler、持久化、Document Contract validator 或 bundle validator；Admin 协议包只负责 wire contract、基础 DTO runtime validation 与文档生成。

实现前的逻辑 ER Model 已建立：全局文档类型控制面、管理员/审计、tenant 文档、版本、thread/ping/pong、submission receipt、幂等记录和可靠外部效果 outbox 都有明确实体、复合键与事务边界。R2 只保存不可变 bundle 文件，UniCAS 只保存 snapshot/message blob graph。tenant principal 与文档共享角色仍标为物理 schema 冻结前必须确定的开放决策。

## 已验证

- `pnpm typecheck`：41 个 workspace package 通过。
- `pnpm check:cas-contract-docs`：66 份当前契约文档通过。
- `pnpm --filter @unidocs/protocol-admin-portal test`：20 个 schema、contract、OpenAPI 与 Scalar HTML 测试通过。
- `pnpm --filter @unidocs/protocol-admin-portal typecheck`：源码、测试与文档生成脚本通过。
- `node --check docs/design/platform-v0/admin/unidocs-admin-mock.js`：通过。
- `git diff --check`：通过。
- 浏览器验证：enabled 类型可追加配对 revision 2；表单在同一 JSON 中提交 snapshot schema 与 location schema；旧 revision 保持可用于新数据；无删除或“设为当前”操作。

## 当前不做

- 不实现真实 Admin WebUI；`unidocs-admin-mock.html` 只是页面内存 mock。
- 不实现 Platform 服务、数据库表、R2 repository 或 Operator 服务。
- 不设计旧系统兼容或迁移。
- 不把目标设计描述为已部署能力。

## 下一轮建议

1. 审查 `SValueSchema` 类型是否需要更精确地覆盖递归 JSON Schema 关键字，以及 `$defs` 中的 SBlob 扩展。
2. 明确 Document Contract canonical JSON、两个 `schemaHash` 与 `contractHash` 算法和大小限制。
3. 明确当前 View/Operator 可写 revision 交集变化时，对已有文档和进行中 Agent session 的处理。
4. 审查 View/Operator 对 paired revision 的支持声明，是显式 idx 集合还是连续范围。
5. 从 Admin mock 逐项核对候选 metadata PATCH、`If-Match`、`Idempotency-Key` 与协议包生成的 OpenAPI。
6. 基于 `@unidocs/protocol-admin-portal` contract 实现云中立 Admin handler，再分别接 Node.js 与 Cloudflare Fetch adapter。

## 相关提交

- `1cca5aa` `feat(platform): define collaboration protocol contracts`
- `05e34c1` `feat(platform): refine document type admin mock`
- `e76fe0c` `feat(platform): define snapshot contract revisions`
