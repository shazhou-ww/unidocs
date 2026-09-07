# Iteration 05：文件导入与失效会话恢复

日期：2026-09-07。状态：已部署，生产文件上传待用户确认选择文件后验收。

- 入口：https://unidocs.shazhou.work/ui/#/documents
- 最终 Worker 版本：`46dd87c0-07a9-4c5e-a622-e5991a2f5295`。
- 初次发布 `90ae1c7a-f495-4248-a67c-e1a54d782b53` 后，线上检查发现已失效登录被显示为目录加载失败，修正后再次发布。

## 本轮能力

- 「新建作品」支持空白作品与导入文件两种方式。导入当前只开放 `.md`、`.markdown`、`.psd`，上限 32 MiB，拒绝空文件。
- 选择文件不会立即上传；显式确认后使用现有 Gateway multipart 创建接口，传 file/format，不手工指定 multipart Content-Type。
- 每次文件选择生成创建幂等键；网络错误或结果不确定时保留同一文件和键，重试复用 Gateway 的持久创建预留。
- 处理中的创建显示 `creating`，就绪作品提供只读预览链接，不覆盖既有作品。
- 明确的 400/413/415/422 文件拒绝允许重新选择文件。扩展名只是前端提示性校验，真正的格式合法性由 doctype 解析器决定，服务端限制可能更严格。
- 导入上下文只在当前组件内存中保留，关闭弹窗后重新打开可继续；刷新或离开会丢失文件和幂等键，不承诺跨刷新恢复或任意失败后的自动恢复。

## OAuth 修正

生产登录检查发现 token endpoint 返回 `400 invalid_grant`，同页三个目录请求同时尝试续期。已确认失效事实，但未证明此次 token 失效的最初原因。

- 同一页面 API 客户端对同一会话的并发续期采用 single-flight，避免重复轮换。
- `invalid_grant` 或缺少 refresh token 映射为 401，清除对应失效会话并返回登录。
- 网络失败、503 等暂时性错误不直接清除会话。
- 尚未实现跨标签页续期协调、登录切换期间所有 OAuth 请求的完整生命周期隔离，不能将同页修正当成跨页面认证方案。

## 验证

```sh
pnpm --filter @unidocs/web-gateway test
# 44 passed
pnpm --filter @unidocs/web-gateway typecheck
# passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed
pnpm --filter @unidocs/cloudflare-gateway test
# 25 passed（首次发布前；最终仅前端续期修正后重新构建）
```

浏览器 localhost 替身验证：确认前上传数为零，确认后仅一次带幂等键的 multipart 请求，ready 后可打开非空 Markdown v1 预览；桌面弹窗截图和平板布局检查通过。PSD multipart 请求已单测，未向生产发送真实 PSD 文件。

线上验证：新版 HTML 与 bundle 为 200，HTML no-store，bundle 含导入入口；真实失效会话重载后返回 Google 登录页、存储会话被清除、目录错误不再显示。仅观察状态与 OAuth 错误码，没有读取或输出 token。

未代用户选择生产文件或执行真实上传；未修改现有作品、执行迁移、修改 OAuth secrets 或部署 doctype 服务。部署凭据仅在进程中使用并在 finally 清理。本轮代码未提交 Git，先前 `9277e02` 的远程推送认证阻塞未在本轮重试。

## 下一步验收

重新登录 → 新建作品 → 导入文件 → 选择 Markdown 或 PSD → 确认导入 → 就绪后打开预览。生产非空 Markdown 与 PSD 解析／资源读取需使用实际文件验证，再决定下一轮云端编辑或引用接入。