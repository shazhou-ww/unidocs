# Iteration 03：云端作品只读预览

日期：2026-09-07。状态：已部署；真人登录后已验证生产 Markdown 空文档读取与刷新，非空正文及 PSD 待验收。

- 入口：https://unidocs.shazhou.work/?iteration=03#/documents
- Worker：`unidocs-gateway`。
- 发布版本：`efa42b31-c2d8-4f50-a4b9-da406a871e1c`。

## 可体验流程

1. 从首页点击「云端作品」，使用现有 Google/OAuth 登录。
2. Markdown 和 PSD 的列表项新增「打开预览」；DOCX 本轮仍只保留既有操作。
3. 预览页展示只读内容及服务端实际返回的版本，手动「刷新当前版本」重新读取。列表记录的版本不作为已加载版本。
4. 返回列表或退出登录。退出登录会清除存储的 OAuth 会话，而不是仅隐藏 UI。

路由为 `#/preview/{docType}/{docId}`，tenant 取已登录会话，不来自链接参数。未登录时显示登录页面。当前登录回调仍返回列表；尚未实现登录后自动返回原预览深链接。

## 读取边界

- Markdown：调用现有 `getContent` query，校验返回正文和正整数 version。使用 Marked 和 DOMPurify 渲染；禁止活动内容、样式注入和图片自动请求。外链仅允许 HTTP(S)，新窗口打开并设置 noreferrer/noopener。
- 外链图片显示带 alt 的占位，不自动向第三方发送私有文档阅读信号。此阶段不提供跨作品嵌入资源解析。
- PSD：复用 psd-client 的 loadDoc、CasBlobStore 和 RenderCore，读取当前 IR 与像素资源，再本地合成；只有渲染完成才显示已加载版本。
- PSD transport 只允许当前文档 IR GET、当前 tenant 的规范哈希资源 content GET，拒绝 apply、上传、其他文档 IR、非 Gateway URL 和其他方法。后端仍必须执行真实授权，这不是 iframe 安全边界。
- IR 必须携带有效 X-Doc-Version；没有则报错，不默认 version=0。
- 每次请求经既有 OAuth client 附带用户 Bearer token；读取使用 no-store。此轮不更改 OAuth scope 或服务器权限模型。
- 请求绑定期望 tenant，主动会话切换到其他 tenant 时拒绝发送。导航／刷新会 abort 读取；旧响应不能覆盖新页面。
- 403 清除已显示内容并停止刷新，401 走既有 refresh 后必要时重新登录。返回列表／退出页面时清空 PSD 画布并释放组件中的内容引用。
- 不写 IndexedDB、本地样例 key 或正文缓存；预览不提供编辑、保存、评论或自动更新。

## 当前限制

- 只读取当前保存状态，不支持确切历史版本查询。显示 vN 不等于历史链接已实现。
- PSD 在主线程 RenderCore 中合成，尚未接 Worker/iframe；限制画布为 1600 万像素以内。此限制不是所有内存风险的完整预算。
- 图层列表本轮展示顶层图层名称和显隐状态，没有编辑控件、树形展开或预览 solo。
- 页面以 docId 为标题；元数据名称和统一作品卡片布局还未接入。
- 私有内容在已授权页面显示后，不能因服务端撤权而远程抹除已展示的信息；下一次读取遭拒时会清空当前预览。本轮不承诺实时撤权通知。
- 本地 Iteration 02 仍是匿名样例；云端只读页与其存储和编辑适配器分离。

## 验证证据

```sh
pnpm --filter @unidocs/web-gateway test
# 28 passed
pnpm --filter @unidocs/web-gateway typecheck
# passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed, 10 个带内容哈希的 UI 产物
pnpm --filter @unidocs/cloudflare-gateway test
# 25 passed
```

53 条相关测试通过。本轮新增 API 边界、Markdown 净化、迟到响应隔离、撤权清空、PSD 渲染完成 ACK、资源失败、预览登录门槛与真实退出登录测试。

本地浏览器使用显式 API 替身和仅限 localhost 的测试会话：

- 列表 v1 打开 Markdown 后展示响应 v7，正文、列表、引用正常，外链图片请求为零。
- PSD 使用真实 SValue 编码／解码、SBlob 像素读取及 RenderCore 合成 960×640 非空画布，展示响应 v9。非 GET 请求只包含 Markdown 的只读 query，没有内容写入。
- 完成 Markdown／PSD 桌面截图；820px 平板无横向溢出，390px 手机显示提示页。
- 退出登录后测试会话已清除。测试 token 只用于本地拦截请求，未发送到生产 Gateway。

线上验证：

- 入口与 hash 构建资源返回 200；cloud-preview chunk 返回 200；HTML 缓存策略为 no-store。
- 未登录的文档 API 返回 401，OAuth metadata 返回 200，云端列表显示 Google 登录入口。
- 首次发布检查时共享生产浏览器没有用户登录会话，未读取真实用户文档；当时的本地替身验证不作为生产端到端成功。
- 用户随后自行登录，2026-09-07 补验：通过页面抽查两篇真实 Markdown，均显示 v1 与空内容状态，无加载错误、无编辑入口；手动刷新仍正常返回 v1。未读取／输出令牌，未创建或修改作品。
- 当前账号目录没有 PSD，抽查的 Markdown 均为空；非空 Markdown 渲染与生产 PSD 资源读取仍未验证，不据此扩大验收结论。

部署只更新 Gateway，未执行迁移、写入云端作品、修改 OAuth secrets 或部署 doctype 服务。cfg 凭据未打印，部署结束在 finally 中清理。未提交 Git。

## 下一小步

先通过真实账号验证一篇 Markdown 和一份 PSD 的只读加载，再把云端列表接入已确认的统一工作台布局。云端编辑继续等待可靠的提交结果核实和历史读取契约；iframe 拆分不与本轮只读页面混称为完成。