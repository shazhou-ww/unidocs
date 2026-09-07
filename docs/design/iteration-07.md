# Iteration 07：待完成创建的刷新恢复

日期：2026-09-07。状态：已部署，登录后的真实目录只读验收通过。

- 入口：https://unidocs.shazhou.work/ui/?iteration=07#/documents
- Worker：`unidocs-gateway`。
- 发布版本：`1746f5d0-493b-4bba-ab8a-bb46c7d4d0c9`。

## 可体验变化

- 空白创建或文件导入收到 `creating` 和作品 ID 后，将待完成项存入当前标签页的 sessionStorage。刷新或离开列表再回来，可以恢复手动检查入口。
- 恢复不自动创建、不重新上传、不轮询状态；只有点击检查时才请求状态。
- 确认 ready 或 failed 后移除恢复记录；当前页面保留终态结果，之后重新进入不再展示该跟踪项。
- 存储失败不会把已经成功返回的创建改判为失败。当前页面继续保留作品 ID，提示保存失败；重试保存跟踪只写本地存储，不重新提交创建。
- 记录按 issuer、subject 和 tenant 分区。令牌更新不改变同一身份的分区，其他身份不会恢复该记录；退出登录清除本地跟踪，不取消服务端任务。

## 数据边界

`unidocs.creation-tracking.v1` 只保存 schema、身份分区及作品类型和 ID，不保存文件、正文、令牌或上传幂等键。身份来自客户端解码的登录声明，仅用于界面分区，所有服务端请求仍由原鉴权验证。

每个存储信封最多 100 项，读取上限 100,000 字符；格式错误、身份不可识别或存储不可用会显示错误。此记录不是跨设备任务系统，也不承诺跨标签页同步或浏览器关闭后的恢复。没有得到作品 ID 的未知创建结果、上传文件与重试上下文仍不能跨刷新恢复。

本轮没有实现 apply 的持久 receipt、云端内容编辑、历史版本读取或 iframe 编辑器隔离；没有修改后端接口或执行数据迁移。

## 验证

```sh
pnpm --filter @unidocs/web-gateway test
# 58 passed
pnpm --filter @unidocs/web-gateway typecheck
# passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed
pnpm --filter @unidocs/cloudflare-gateway test
# 25 passed
```

新增测试覆盖身份分区、去重与字段白名单、退出清理、损坏记录、配额失败、页面重建后的恢复，以及确认就绪后移除恢复记录。

localhost 浏览器替身完成：创建返回 creating → 刷新恢复 → 手动检查 ready → 再刷新移除。全过程一次创建 POST、一次手动状态 GET；恢复不发状态请求。另验证退出登录清理、桌面截图与 820px 平板无横向溢出。

真实生产账号只读验收：发布前目录 23 件作品（12 Markdown、11 DOCX），抽查一件 Markdown 显示实际 v1 空内容，无错误；发布后刷新仍为 23 件作品，无告警，HTML 200/no-store 并加载新 bundle。账户没有 PSD 或待创建项，本轮没有用生产账号创建、上传、编辑或删除作品，因此真实 PSD 预览和真实生产创建恢复尚未端到端验收。

本次仅部署现有 Cloudflare Gateway。凭据限定进程使用并于 finally 清除。未提交 Git；先前 Git 推送认证阻塞未尝试绕过。

下一条核心纵向迭代应回到编辑器宿主协议与可靠提交结果，避免把创建跟踪误当作内容编辑的持久性保证。