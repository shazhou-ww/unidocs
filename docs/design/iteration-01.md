# Iteration 01：真实 PSD 引擎的可见试验

日期：2026-09-07。状态：已部署。

- 线上入口：https://unidocs.shazhou.work/
- 本地开发：`pnpm --filter @unidocs/web-gateway dev --host 127.0.0.1 --port 5184`，访问 http://127.0.0.1:5184/ui/。
- Cloudflare Worker：`unidocs-gateway`。
- 发布版本：`53f02429-d627-41cd-ac0a-c3040895a746`。

## 本轮可体验

1. 默认打开本地 PSD 样例，使用选定的圆章笔尖品牌。
2. 进入编辑，选择图层，切换显隐或修改透明度。
3. 点击「保存到本地版本」，再切回预览查看旧版本。
4. 展开「提交模拟」，分别体验成功、冲突和结果未知；未知时冻结草稿，确认结果后继续。
5. 下载当前画面的 PNG；当前图层文本是样例栅格内容，不提供文本编辑。
6. 「云端作品」仍进入现有鉴权流程；离开本地工作台时提示当前本地版本不会保留。

## 真实能力与模拟边界

- 真实使用 `@unidocs/doctype-psd` 的 applyOne 与 IncrementalCompositor，经 psd-client RenderCore 合成，不使用 docs/design 中的 mock renderer。
- 使用新的 EditorDraft：串行本地操作、冻结提交候选、明确结果确认、拒绝保留草稿、迟到 ACK 不清空新草稿。
- 当前直接在主线程使用 RenderCore，尚未接 Worker 或跨 origin iframe。
- 初始样例由浏览器 Canvas 生成五个 raster 图层，不是上传／导入的真实 PSD 文件。
- 保存和历史仅驻留当前页面内存，刷新或离开即重置。页面明确标注“本地试验”；未实现 IndexedDB、云端 apply、跨端恢复、评论或固定版本资源服务。
- 不因界面部署而改变 OAuth、API、数据库或存储。未运行迁移、未部署 doctype workers，未重置 secrets。
- PSD 与 Markdown 完整统一工作台仍以原 mock 和实施计划为目标，本轮仅验证一个真实可操作内容区。

## 验证记录

```sh
pnpm --filter @unidocs/psd-client test -- tests/editor-draft.test.ts tests/doc-session.test.ts
# 21 passed，包含真实 RenderCore 像素变化测试
pnpm --filter @unidocs/web-gateway test
# 10 passed，包含默认本地工作台与 OAuth/云端作品回归
pnpm --filter @unidocs/web-gateway typecheck
# passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed，5 个 UI 产物
pnpm --filter @unidocs/cloudflare-gateway test
# 17 passed
pnpm --filter @unidocs/cloudflare-gateway exec wrangler deploy --dry-run
# passed
```

浏览器验证：

- 本地与线上画布均为 960×640，非空，图层修改导致合成像素变化。
- 本地保存 v2 后选择 v1，还原初始像素；本地冲突保留草稿，未知结果冻结，预览中确认已提交后画面正确刷新。
- 820px 平板视口无横向溢出；390px 手机显示提示页。
- 线上 `/ui/assets/studio.js` 返回 200。
- 线上未带凭据的 `/tenants/iteration-probe/docs/markdown/` 返回 401；未访问或修改该 tenant 的数据。
- 线上 OAuth metadata 返回 200。没有代用户执行真人 Google 登录，登录流程通过本地回归测试。
- PNG 按钮已实现，但浏览器工具没有验证最终文件落盘，不计入已通过的端到端项。

部署凭据从 cfg 在进程内捕获，未打印值；部署后已从终端环境清理。部署所需 codec 产物使用现有 `pnpm --filter @unicas/codec build` 生成，没有改动该包源码。

## 下一小步

先补持久草稿恢复与正式提交候选所有权，再将真实云端文档只读加载接入这个内容区。持久 opId receipt／历史读取未完成前，不把本地保存演示替换成无恢复保障的云端写入。