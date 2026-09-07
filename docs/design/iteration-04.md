# Iteration 04：统一云端作品列表

日期：2026-09-07。状态：已部署；生产账号目录和创建操作待真人登录验收。

- 入口：https://unidocs.shazhou.work/?iteration=04#/documents
- Worker：`unidocs-gateway`，发布版本 `ee86ac2d-8176-4cf7-aee3-a363942f655a`。
- 实施前已将 Iteration 01–03 与设计文档整合远程 main，合并提交 `05f7963`；未强推。

## 可见变化

- 云端类型分组表格改为单一作品列表，采用确认过的圆章 logo、侧栏、克制配色与紧凑工具栏。
- MD、PSD、DOCX 显示类型色标；使用真实目录中的 docId、version 和更新时间，不生成假标题或内容缩略图。
- 支持已加载目录的 ID 搜索、类型过滤、更新时间／创建时间／ID 排序；筛选不请求正文。
- 统一「新建作品」弹窗，选择配置中已有的 doctype 后显式创建；取消不写数据，创建中阻止重复提交。
- `202 creating` 显示处理中与刷新提示，不显示不存在的版本，不自动打开未就绪作品。刷新是用户操作，不新增无限轮询。
- Markdown／PSD 保留只读预览链接；DOCX 不显示尚未实现的在线预览入口，仍可下载。
- 一个类型目录失败时保留其他成功目录，显示失败类型与重试入口；401 不展示部分数据，退回登录。
- 切 tenant／离开页面取消旧列表请求，按 tenant 重建组件，防止迟到数据混入。
- 保留手机提示页；本地试验通过侧栏独立入口访问。

## 仍未实现

标题、tag、全文搜索、内容缩略图、网格视图、服务端跨类型分页和动态编辑器注册均未接通。本轮 ID 搜索仅过滤已返回的目录结果，不声称完整语义检索或服务端搜索。类型选项来自现有配置，不是新注册服务。

暂不为填满卡片而逐篇获取正文／图片，也不把测试替身中的易读 ID 当作生产标题。后续以真实元数据接口补齐作品信息，再接设计中的缩略图卡片。

## 验证

```sh
pnpm --filter @unidocs/web-gateway test
# 34 passed
pnpm --filter @unidocs/web-gateway typecheck
# passed
pnpm --filter @unidocs/cloudflare-gateway build
# passed
pnpm --filter @unidocs/cloudflare-gateway test
# 25 passed
```

59 条相关回归通过，新增 6 条统一列表测试：混合类型／排序／组合过滤、创建取消与类型选择、重复提交保护、部分失败重试、401 清空、取消迟到请求。

浏览器使用仅 localhost 的 API 替身：

- 6 条不同类型记录混排，PSD + cover 搜索只显示 1 条；操作不额外读取正文。
- 原生 dialog 打开、取消时写请求为 0；创建选定 Markdown 时只有 1 次 POST，模拟 202 正确显示处理中。
- 完成桌面截图，820px 平板无横向溢出，390px 手机显示提示页。

线上只检查公开入口与安全边界：HTML 200/no-store、新 bundle 200 且包含统一列表、未登录 API 401、OAuth metadata 200。未使用测试 token 或部署凭据读写真实用户作品；Google 登录后的实际目录、创建和导出未代真人执行。

## 合并与发布边界

远程 main 含初版 mock 的等价提交 `eb74bbc`，本地初版为 `b008f8c`。逐文件比较两份初版无内容差异，因此 add/add 冲突保留后续设计迭代，其他远程更新正常合入。

合并后执行冻结锁文件安装、28 条旧版 WebUI 与 23 条 PSD 回归、Gateway 构建，随后正常推送 `HEAD:main` 到 `05f7963`。本轮列表改动在该合并之后独立实现和提交。

部署只发布 Gateway Worker，未部署其他 doctype 或 UniCAS 服务，未运行远程数据库迁移。cfg 凭据在进程中使用并于 finally 清理。