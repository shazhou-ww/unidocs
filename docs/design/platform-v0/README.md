# UniDocs Platform v0 设计上下文

状态：2026-09-09 目标设计工作区。此目录收拢本轮新版 Platform 设计的权威文档与 Admin WebUI mock，供后续会话直接续接。

## 权威材料

- [当前任务状态](TASK-STATUS.md)：本轮完成范围、验证结果、未实现边界和下一轮建议；续接时先读此文档。
- [人与 Agent 协同编辑文档的新范式](agent-mediated-document-collaboration.md)：评论驱动协作、版本双图、ping/pong 水位和原子 submission 的产品与一致性模型。
- [Platform、View 与 Operator API v0](platform-view-operator-api-v0.md)：Platform、View bundle、Operator Agent、Admin、Host RPC 和 Agent API 的统一目标契约。
- [Admin WebUI mock](unidocs-admin-mock.html)：从 UI 反推控制面资源和 mutation；直接用浏览器打开，无需开发服务器。

可由 TypeScript 检查的线契约位于 [`@unidocs/protocol-platform`](../../../packages/protocol-platform/src/index.ts)。SValue JSON Schema dialect 位于 [`@unidocs/protocol`](../../../packages/protocol/src/types.ts)。

## 已确定决策

1. Platform 是文档、版本、thread、current pointer 与 submission 的唯一持久权威；View 只通过 Host RPC 使用能力，Operator 通过查询与原子 submission 工作。
2. 文档类型先以 Admin 内部名称创建 disabled 草稿；信息不完整可以长期存在，但不能启用。
3. Type Card bundle 和 View bundle 内容寻址且不可变；Operator validation 可转成持久候选项。三类候选都有独立、可修改、仅 Admin 可见的名称与描述。
4. Type Card manifest 提供多语言创建卡片、二选一 SVG/预定义尺寸 PNG 图标和 sample thumbnail；bundle 不声明默认 locale，Host 跟随用户 UI locale 并最终回退到 `en`。
5. 每个文档类型拥有 append-only Snapshot Contract revisions。最大 `SnapshotContractIdx` 自动成为唯一可写 revision；历史 revision 只读、不可删除、不可回退、不可手动设为 current。
6. SValue schema 是 JSON Schema 2020-12 扩展，通过 `x-unidocs-sblob` 等关键字描述原子 SBlob。
7. 已启用类型不能追加 Snapshot Contract；先停用、追加 revision、绑定支持最新版的 View/Operator，再重新启用。

## 当前检查

```text
pnpm typecheck
pnpm check:cas-contract-docs
node --check docs/design/platform-v0/unidocs-admin-mock.js
git diff --check
```

本目录是目标设计，不代表现有部署已经实现。旧的 `unidocs-admin-api-v0.md` 与 `unidocs-admin-webui-v0.md` 保留在上级目录，仅作历史对照。
