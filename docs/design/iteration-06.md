# Iteration 06：创建状态核实

日期：2026-09-07。状态：已部署，生产创建中的真实作品核实待实际任务验收。

- 入口：https://unidocs.shazhou.work/?iteration=06#/documents
- Worker：`unidocs-gateway`。
- 发布版本：`d3676b2f-a2f0-4085-9dbf-c7112ad6e22e`。

## 可体验变化

- 空白创建或文件导入返回 `202 creating` 后，列表上方保留作品 ID 和「检查创建状态」。可继续创建其他作品，各项独立检查。
- 不自动轮询、不重复上传、不再次创建 session；每次点击只发一个状态 GET，进行中禁用重复点击，离开页面取消请求。
- 返回 creating 则继续等待；确认 ready 且 version 有效时才显示预览链接，并刷新目录；failed 显示终态失败，不自动重建。
- 网络错误保留作品标识，可再次检查；401 回到登录。前端验证响应中的 docId、doctype、状态和就绪版本，不把无效响应当成成功。

## Gateway 变化

原状态 GET 只返回目录记录。本轮对已授权的 creating 记录复用原有 reconcileCreatingDocument：向该记录绑定的原 session 发 status GET；确认 exists 且 version 为正安全整数后标记 ready。后端未完成、不可达或返回无效版本时仍保留 creating。

不会新建 session，也不会向其他注册服务寻找同 ID。既有身份、tenant、doctype 与 serviceId 检查仍在核实之前执行。ready／failed 记录不触发探测，ready 状态仍是目录元数据，不是最新正文版本查询。

所有状态响应使用 `Cache-Control: no-store`。公开响应仍为 `{ success, data: { doc_id, doc_type, state, version, ... } }`，前端修正了过去将其误声明为 create 响应的类型。

此变化允许状态 GET 核实并更新创建目录元数据，不是内容修改；接口说明已同步到 [HTTP 协议](../doc-service-http-protocol.md)。

## 验证

```sh
pnpm --filter @unidocs/web-gateway test
# 53 passed
pnpm --filter @unidocs/gateway-common test
# 58 passed
pnpm --filter @unidocs/cloudflare-gateway test
# 25 passed
pnpm --filter @unidocs/web-gateway typecheck
# passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed
pnpm check:cas-contract-docs
# passed (38 files)
```

136 条相关测试通过。新增服务端原 session 核实／不重复创建／无效版本／no-store 测试，前端状态解包校验、取消与去重、失败与过期，以及创建列表到就绪的集成测试。

浏览器 localhost 替身：一次创建 POST、两次手动状态 GET，先 creating 后 ready；确认前预览链接为零，确认后指向原 docId；桌面截图、820px 平板无溢出、390px 手机提示通过。

线上：HTML 200/no-store、新 bundle 200 且包含状态控件、未登录状态 GET 为 401、OAuth metadata 为 200。没有通过生产账号创建测试作品，因此不宣称真实生产导入核实已经端到端验证。

## 边界与后续

- 当前状态跟踪在组件内存中，刷新／离开后丢失跟踪行，不具备跨刷新任务恢复。不能据此声称 P0 持久提交结果 receipt 已实现；此处是创建状态，不是 apply 操作结果。
- 后端不可达与未完成均可能表现为 creating，不附加虚构进度百分比或失败判断；永久悬挂需要另行恢复机制。
- 新建状态与之前的作品集／作品级业务状态无关，不增加“待审阅”导航。
- 共享 Gateway 代码由 Azure/Cloudflare 复用，本轮只部署 Cloudflare；没有执行 Azure 生产验证、数据迁移或 doctype 发布。
- 用户离开期间没有代为上传、编辑或删除既有作品；凭据仅在进程使用并于 finally 清理。未提交 Git，先前推送认证阻塞未尝试绕过。

下一步应把未完成创建的最小身份与状态恢复接到宿主持久任务记录，或在真实文件导入验收后继续内容编辑；不得靠重新创建来代替核实。