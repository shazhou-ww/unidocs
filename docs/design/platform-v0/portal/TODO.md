# UniDocs Platform v0 Portal TODO

普通用户使用的 portal 体验与租户侧 API 设计尚待展开。

命名：**tenant** 指组织与租户平面（`tenantId`、tenant HTTP contract、tenant session），
**portal** 指普通用户使用的门户界面，与 admin 控制台对位。

## TODO

- 定义最终用户的文档目录、创建、打开与权限体验。
- 从 `@unidocs/protocol-platform` 的 tenant HTTP contract 生成 OpenAPI 与可读文档。
- 明确 Platform Web Host、隔离 View iframe 与 tenant session 的边界。
- 补充 portal 的移动端与桌面端原型。
- 定义 portal 侧错误、空状态、加载状态和恢复流程。
- 将 portal 设计与根目录的统一 Platform、View 与 Operator API 契约逐项核对。
