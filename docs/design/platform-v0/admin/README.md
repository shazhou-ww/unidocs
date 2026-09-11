# UniDocs Platform v0 Admin 设计

本目录收拢管理员控制面的状态记录与 WebUI mock。

- [当前任务状态](TASK-STATUS.md)：Admin 控制面、协议包与文档生成的完成范围和后续工作。
- [Cloudflare 实现计划](IMPLEMENTATION-PLAN.md)：Admin Portal 四个新包、分阶段交付、验证门禁与明确非目标。
- [Admin WebUI mock](unidocs-admin-mock.html)：文档类型、配对 Document Contract、Type Card bundle、View bundle、Operator 与管理员成员管理原型。

管理员 API 的可执行契约位于 [`@unidocs/protocol-admin-portal`](../../../../packages/protocol-admin-portal/src/index.ts)，生成的 [OpenAPI JSON](../../../../packages/protocol-admin-portal/openapi/admin-v1.openapi.json) 保留在该包内；可阅读的 API Reference 由共享文档门户发布到 `https://docs.shazhou.work/unidocs/reference/admin`。
