# UniDocs Platform v0 Tenant TODO

面向最终用户的 tenant 体验与 API 设计尚待展开。

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
