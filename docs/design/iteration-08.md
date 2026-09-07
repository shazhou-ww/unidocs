# Iteration 08：Markdown 编辑与标签页草稿

日期：2026-09-07。状态：已提交并部署现有 Cloudflare Gateway；生产登录后草稿流程待真人验收。

- 实现提交：`d452218`（`feat(webui): add isolated Markdown editing drafts and recovery`）。
- Worker：`unidocs-gateway`，版本 `c3a19a0e-50c7-4a7f-9b1c-0a1e3513a43e`。
- 生产入口：https://unidocs.shazhou.work/ui/?iteration=08#/documents 。

## 可体验变化

- 云端 Markdown 默认仍为预览，点击“编辑 Markdown”进入源码／安全预览双栏，复用 Marked 和 DOMPurify；脚本不执行，外链图片不加载。
- 进入编辑时捕获原始正文和基准版本；云端正文、草稿正文和草稿渲染分开保存。
- 返回云端预览保留草稿，展示已读取的云端正文；“继续编辑草稿”恢复编辑。丢弃必须确认，删除失败仍保留草稿。
- 刷新页面或返回作品后默认展示云端预览，并提供继续编辑入口。新读取版本不会替换旧草稿的正文、基础正文或基准版本，也不自动合并。
- 草稿状态明确区分“当前标签页已暂存”和“未提交云端”。本轮没有云端保存按钮、apply 请求或自动提交器。

## 持久化与清理边界

本轮采用有限的 `sessionStorage` 方案，独立命名空间为 `unidocs.markdown-draft.v1:`。键按 issuer、subject、tenant、doctype 和 docId 分区，正文记录仅保存 schema、content、baseContent 和 baseVersion，不保存令牌。登录声明只用于本地分区，服务端权限验证仍由原有 API 执行。

- 范围为当前浏览器标签页，支持刷新与同标签页路由往返，不承诺关闭标签页后、跨电脑或跨标签页恢复／同步。浏览器复制标签页可能复制 sessionStorage 的初始内容，此后两份记录独立变化。
- 每份序列化记录上限 1,000,000 字符，包含基础正文与草稿。配额、格式或存储访问失败显示错误，不显示暂存成功；损坏记录不自动覆盖，只能重试读取或明确丢弃。
- 每次输入同步尝试暂存；失败后最新输入保留在内存，可重试本地暂存，不请求云端。大文档的同步存储与渲染性能尚未专项验收。
- 未暂存时注册 beforeunload 提醒，并对页面内链接提供离开确认。浏览器后退造成的同页 hash 导航、浏览器崩溃或强制关闭不保证拦截或恢复，仅最后成功暂存的记录可靠。
- 显式退出及会话失效清理当前标签页所有该命名空间的草稿，不触碰公开 PSD 本地样例。清理失败仍关闭当前页面的登录状态并告警；浏览器拒绝清理时不能保证物理删除，应关闭标签页并清除本站数据。
- 403 后隐藏云端正文、草稿源码与预览，保留本地记录；后续打开仍需成功读取云端作品后才显示草稿入口。手机初始提示页不读取草稿或云端正文。

这是第 08 轮的标签页草稿切片，不是 Editor Host Protocol v0 的 IndexedDB checkpoint、独立 draftId、多实例协议或完整导航保护。不勾选 P0/P1/P2 完成。

## 验证

```sh
pnpm --filter @unidocs/web-gateway test
# 70 passed
pnpm --filter @unidocs/web-gateway typecheck
# passed
pnpm --filter @unidocs/web-gateway build
# passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed
pnpm --filter @unidocs/cloudflare-gateway test
# 25 passed
```

新增测试覆盖编辑／预览往返、安全渲染、确认丢弃、刷新恢复、原基础正文和版本保留、身份／tenant／类型／作品隔离、令牌轮换、记录字段白名单、存储上限与损坏、配额失败及本地重试、删除失败、退出清理和清理失败、401 与 403、手机不读取私有内容。

localhost 浏览器替身验收：1440px 桌面和 820px 平板双栏截图与尺寸检查通过，无横向溢出，平板源码／预览各 368px 且不重叠；390px 手机只有提示页，无编辑器或数据请求。v12 草稿在刷新读取 v15 后保留原基准与正文，返回预览显示 v15。退出后令牌和草稿记录已清除。单测验证了取消／确认丢弃及删除失败；浏览器也操作了确认丢弃和退出。

记录到的文档请求均为 `POST /query`，正文为 `{"kind":"getContent"}`；没有云端内容修改请求。调试浏览器替身时曾出现本地代理 500 和 OAuth register 请求，不是生产请求，也不作为真实鉴权验收。本轮没有自动创建、上传、编辑或删除生产作品。

发布使用 `cfg` 的 Cloudflare API token 与 account ID，仅注入发布进程并在 finally 清除。执行现有 Gateway 的 `wrangler deploy --keep-vars --strict`，没有修改配置、服务绑定、secrets 或数据库，没有部署其他 Worker 或 Azure。线上 HTML 为 200／no-store，9 个静态资源 SHA-256 均与本地构建一致，OAuth 元数据端点 200，issuer 与 authorization_endpoint 保持原配置。浏览器加载生产登录页成功；当前无登录会话，未验证真实作品草稿流程。浏览器另有一条未定位的 ERR_CONNECTION_CLOSED 资源事件，不以此宣称所有浏览器网络请求均无错误。

本地开发入口：http://127.0.0.1:5184/ui/ 。真实登录与作品读取需要另外运行／配置本地 Gateway；本轮浏览器验收使用虚构会话和 API 替身。

## 下一步

第 09 轮先完成服务端持久提交结果的最小契约与测试，再接显式云端提交。冲突保留原基准草稿，网络中断核实原次提交；不使用 DocSession 自动 drain/rebase 或创建状态跟踪冒充 apply receipt。生产 Markdown 草稿流程与中文输入法 composition 仍需真人验收。