# UniDocs Platform v0 Tenant TODO

面向最终用户的 tenant 体验与 API 设计尚待展开。

## UI 对齐进度

`feat/tenant-ui-completion` 基于最新 `origin/main`（5257ac31）补充：

- 工作台：类型筛选、标题/创建时间排序、网格/列表切换、分页读取、搜索空态和失败重试；侧栏显示已加载的作品数。
- 版本历史：独立只读回看、版本下拉、父版本与评论来源、返回原讨论；移动 current 需要填写审计原因，并携带 observed current 并发锁。
- 文档工具栏：复制链接、当前 Markdown 下载、退出分屏；历史回看不开放评论。
- 讨论：折叠动作、最新评论选中、折叠草稿、按筛选区分空态。
- 响应式：修正设备提示与应用的 CSS 显隐选择器；平板分屏上下排列，手机保持设计中的“暂未开放”。

仍未完成，不能将整个设计标为已实现：

- PSD 图层/区域阅读、选区评论与缩略图：当前 `ViewHost` 仅接本地 Markdown renderer，尚未接通隔离 View bundle 与 blob 读取；不能只改类型标签代替实际渲染。
- Fork、标题/标签编辑：现有 tenant client 没有相应操作；标签、更新时间也不能伪造。排序暂使用真实创建时间。
- 生产登录/账号管理不属于这两份作品与讨论设计的实现；登录设计仍保留在 `feat/tenant-login`。
- 真实部署的 HTTP/session、PSD bundle 与 CAS 集成未在本分支的内存演示预览中验证。

## 已完成

- tenant HTTP contract 已从 `@unidocs/protocol-platform` 拆到
  [`@unidocs/protocol-tenant-portal`](../../../../packages/protocol-tenant-portal/README.md)，
  contract-first（Zod 4 + oRPC），并由同一份 contract 生成 OpenAPI 3.1 与中英双语 Scalar 文档：
  `pnpm --filter @unidocs/protocol-tenant-portal docs:generate`。

## TODO

- 定义最终用户的文档目录、创建、打开与权限体验。
- 明确 Platform Web Host、隔离 View iframe 与 tenant session 的边界。
- 补充移动端与桌面端的 end-user WebUI 原型。
- 定义 tenant 侧错误、空状态、加载状态和恢复流程。
- 将 tenant 设计与根目录的统一 Platform、View 与 Operator API 契约逐项核对。
- `ViewSetMarkersRequest.markers` 区分不了「这是评论自己的位置」「这是 Agent 改动后的位置」「这是已过时的位置」。临时的本地类型定义在 `packages/tenant-portal-webui/src/view/markers.ts`；协议 marker 加上 `role` 字段后可以删掉这个文件。
- `listThreads` 只返回 `ThreadRef`（仅 threadId），`DocumentRecord` 也没有讨论计数，工作台只能拉取每个 thread 来算出「N 处待回复」。这个 fan-out 集中在 `loadDiscussionSummary`（`packages/tenant-portal-webui/src/model/discussion-summary.ts`）；协议给计数后即可去掉这个 fan-out。
