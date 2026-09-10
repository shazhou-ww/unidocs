# UniDocs Platform v0 设计上下文

状态：2026-09-10 目标设计工作区。根目录保存跨角色的 Platform 设计，管理员与最终用户材料分别收拢到 `admin/` 和 `tenant/`。

## 权威材料

- [Admin 设计索引](admin/README.md)：管理员控制面状态、WebUI mock、协议与生成文档入口。
- [Admin 当前任务状态](admin/TASK-STATUS.md)：本轮完成范围、验证结果、未实现边界和下一轮建议。
- [Tenant TODO](tenant/TODO.md)：面向最终用户的 tenant 体验与 API 后续设计入口。
- [人与 Agent 协同编辑文档的新范式](agent-mediated-document-collaboration.md)：评论驱动协作、版本双图、ping/pong 水位和原子 submission 的产品与一致性模型。
- [Platform、View 与 Operator API v0](platform-view-operator-api-v0.md)：Platform、View bundle、Operator Agent、Admin、Host RPC 和 Agent API 的统一目标契约。
- [Platform v0 ER Model](platform-er-model-v0.md)：控制面、文档协作、审计、幂等、submission 与 outbox 的逻辑实体关系和事务约束。

可由 TypeScript 检查的公共、Agent 与 Operator 线契约位于 [`@unidocs/protocol-platform`](../../../packages/protocol-platform/src/index.ts)，管理员控制面契约位于 [`@unidocs/protocol-admin`](../../../packages/protocol-admin/src/index.ts)。SValue JSON Schema dialect 位于 [`@unidocs/protocol`](../../../packages/protocol/src/types.ts)。

管理员 API 的机器可读 OpenAPI 3.1 文档位于 [`admin-v1.openapi.json`](../../../packages/protocol-admin/openapi/admin-v1.openapi.json)，并由 `@unidocs/protocol-admin/openapi.json` 独立导出；供本地或静态站点阅读的 Scalar 页面位于 [`admin-v1.html`](../../../packages/protocol-admin/openapi/admin-v1.html)。两者都保留在 `@unidocs/protocol-admin` 包内，并由 `pnpm --filter @unidocs/protocol-admin docs:generate` 从同一份 contract 生成。

## 已确定决策

1. Platform 是文档、版本、thread、current pointer 与 submission 的唯一持久权威；View 只通过 Host RPC 使用能力，Operator 通过查询与原子 submission 工作。
2. 文档类型先以 Admin 内部名称创建 disabled 草稿；信息不完整可以长期存在，但不能启用。
3. Type Card bundle 和 View bundle 内容寻址且不可变；Operator validation 可转成持久候选项。三类候选都有独立、可修改、仅 Admin 可见的名称与描述。
4. Type Card manifest 提供多语言创建卡片、二选一 SVG/预定义尺寸 PNG 图标和 sample thumbnail；bundle 不声明默认 locale，Host 跟随用户 UI locale 并最终回退到 `en`。
5. 每个文档类型拥有从 0 开始的 append-only Document Contract revisions；同一不可变 JSON 原子携带 snapshot 与 location schema，并共享 `DocumentContractIdx`。所有 `Idx` 均从 0 开始，`null` 才表示不存在。
6. SValue schema 是 JSON Schema 2020-12 扩展，通过 `x-unidocs-sblob` 等关键字描述原子 SBlob。
7. enabled 类型也可上传新 Document Contract；最大 idx 不是唯一可写版本，当前 View/Operator 共同支持的已有 revisions 构成可写集合。

## 当前检查

```text
pnpm typecheck
pnpm check:cas-contract-docs
node --check docs/design/platform-v0/admin/unidocs-admin-mock.js
git diff --check
```

本目录是目标设计，不代表现有部署已经实现。旧的 `unidocs-admin-api-v0.md` 与 `unidocs-admin-webui-v0.md` 保留在上级目录，仅作历史对照。
