# Iteration 02：本地版本与草稿恢复

日期：2026-09-07。状态：已部署。

- 入口：https://unidocs.shazhou.work/?iteration=02
- Worker：`unidocs-gateway`。
- 最终发布版本：`82d2e18b-0206-456f-9e50-28d7e030e455`。
- 本轮早先发布 `5d536b89-f713-484e-8112-d06263f3b5a3` 后发现旧资源缓存阻挡更新，最终版本包含缓存修正。

## 可体验变化

- 图层修改后自动将草稿存入 IndexedDB；「保存到本地版本」仍是创建版本的显式动作，两者分开。
- 刷新可恢复所有已存本地版本、未提交草稿、基础版本、编辑／预览模式与所查看的版本。
- 未知结果候选先持久化，再执行本地模拟。刷新后恢复同一 candidateId，保持冻结直到确认结果。
- 存储成功以 readwrite transaction 完成为准，不以 put 请求发出为准。失败不显示已保存，并提供重试。
- 多页面写入通过 IndexedDB 中的 revision 条件检查；旧页面写入被拒绝，其内存草稿不被清除，也不覆盖较新记录。
- IndexedDB 禁用、打不开或结构不兼容时停止加载并解释原因，不覆盖已有数据。配额错误中止事务，原记录保留。

## 数据边界

这仍是公开的本地样例，未接云端 apply。数据库 `unidocs-local-studio-v1` 的 `public-local-sample` 记录属于此 origin 的浏览器配置文件，不是按已登录用户隔离的云端文档存储。

同一浏览器配置文件的使用者共享这个样例；清除站点数据、浏览器回收或隐私模式结束可能删除记录。它不是备份，不支持跨设备恢复。页面已明确披露此范围，不用于真实敏感云端内容。

本轮存储完整的 raster 样例状态及版本，使用 structured clone 保留像素数组；未解决大文档增量 checkpoint、资源去重、版本配额与 SBlob 序列化。EditorDraft 的 checkpoint 恢复仅在此样例边界验证，不能据此宣称所有 PSD operation／惰性资源均可持久化。

发生本地 revision 冲突后，重试不会强制覆盖较新的页面。当前可下载画面，刷新读取已存记录；原始草稿导出／另存分支尚未实现，不承诺自动合并。

## 发布缓存修正

线上检查发现原先 Vite 使用固定文件名，而 Gateway 对直接命中的 HTML、JS、CSS 都标记一年 immutable，导致新构建复用旧 JS。

- Vite entry/chunk/style 改用内容哈希文件名。
- 根页、`/ui`、`/ui/index.html` 和 SPA fallback 的 HTML 改为 `Cache-Control: no-store`。
- 哈希资源继续长期 immutable 缓存。
- 已经保存旧 HTML 的浏览器首次需强制刷新，或访问上面的新 query 入口；不通过清除整个站点数据解决缓存，避免删除草稿或登录状态。

## 验证

```sh
pnpm --filter @unidocs/psd-client test -- tests/editor-draft.test.ts tests/doc-session.test.ts
# 23 passed
pnpm --filter @unidocs/web-gateway test
# 14 passed
pnpm --filter @unidocs/web-gateway typecheck
# passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed, hashed assets
pnpm --filter @unidocs/cloudflare-gateway test
# 25 passed
```

共 62 条相关测试通过。新增覆盖草稿隔离复制、未知候选恢复、事务提交后读取、并发 revision 冲突、存储打开失败、配额事务中止和 HTML 缓存规则。

浏览器实测：

- 本地未提交草稿刷新前后 canvas 像素完全一致；保存的 v2 刷新后存在。
- 本地 unknown 候选刷新后冻结，确认拒绝再刷新可编辑，草稿仍存在。
- 用独立 IndexedDB 连接模拟另一页面先写，当前页面显示 revision 冲突且没有成功提示。
- 线上 Iteration 02 草稿刷新前后像素一致，恢复 dirty/baseVersion。
- 线上未登录 API 返回 401、OAuth metadata 返回 200、HTML 响应为 no-store。
- 平板 820px 无横向溢出，手机 390px 显示提示页；完成桌面截图检查。

部署只更新 Gateway build；未修改 OAuth 配置、执行数据迁移或部署 doctype 服务。cfg 凭据仅在进程内使用并在 finally 清理。尚未提交 Git。

## 下一小步

接入真实云端作品的只读加载，先保持云端写入禁用。真实用户内容落盘之前必须加入身份／文档隔离、资源编码和退出登录清理，不能复用这里的匿名样例 key。iframe 协议与持久 opId receipt 仍是后续 gate。