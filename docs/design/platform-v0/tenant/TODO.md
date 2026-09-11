# UniDocs Platform v0 Tenant TODO

面向最终用户的 tenant 体验与 API 设计尚待展开。

## TODO

- 定义最终用户的文档目录、创建、打开与权限体验。
- 从 `@unidocs/protocol-platform` 的 tenant HTTP contract 生成 OpenAPI 与可读文档。
- 明确 Platform Web Host、隔离 View iframe 与 tenant session 的边界。
- 补充移动端与桌面端的 end-user WebUI 原型。
- 定义 tenant 侧错误、空状态、加载状态和恢复流程。
- 将 tenant 设计与根目录的统一 Platform、View 与 Operator API 契约逐项核对。
- `ViewSetMarkersRequest.markers` 区分不了「这是评论自己的位置」「这是 Agent 改动后的位置」「这是已过时的位置」。临时的本地类型定义在 `packages/tenant-portal-webui/src/view/markers.ts`；协议 marker 加上 `role` 字段后可以删掉这个文件。
- `listThreads` 只返回 `ThreadRef`（仅 threadId），`DocumentRecord` 也没有讨论计数，工作台只能拉取每个 thread 来算出「N 处待回复」。这个 fan-out 集中在 `loadDiscussionSummary`（`packages/tenant-portal-webui/src/model/discussion-summary.ts`）；协议给计数后即可去掉这个 fan-out。
