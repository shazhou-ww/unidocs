# Iteration 14：Admin 类型目录闭环

日期：2026-09-08。状态：已部署真实目录与审计，主站消费明确推迟，不读取后台注册数据。未提交 Git。

- 后台入口：https://unidocs.shazhou.work/admin/
- Gateway 发布：`2ca49f84-021a-4333-a004-a6e901bd2de5`。
- Markdown 发布：`c356cb66-b784-4275-b465-93f159949f23`。
- 首版可登记 Base URL：`https://unidocs-markdown.shazhou.workers.dev/`。
- 没有自动导入类型、打开目标状态、添加管理员或创建生产文档。上线验收时目录为空。

## 本轮范围

按用户最新决定，admin 与主站动态接入分开交付。后台真实保存 docType/baseUrl/enabled，验证后登记或改 URL，记录审计；enabled 仅为目标配置，响应带 consumption=not-connected，UI 明示“尚未接入主站”。不改变 DOC_SERVICES_JSON、主站目录、新建/编辑权限或已有作品的服务绑定。

不再要求已提供 editor 才能保存 enabled=true。描述仍明确 Markdown 的 editorProtocol=null、preview/edit=false，页面同时显示能力缺口；后续主站消费时必须计算实际能力交集，不能直接将目标开关视为可编辑证据。旧第 13 轮“无 editor 禁止后台启用”是当时的阶段约束，已被本轮目标配置语义取代。

## 实现

- [管理页面](../../packages/web-gateway/src/ui/views/admin.tsx) 增加文档类型/管理员/审计导航，保留已有 Google 登录和名单操作；当前默认仍进入管理员页面。
- [目录与审计 UI](../../packages/web-gateway/src/ui/views/admin-catalog.tsx)：目录分页、已加载结果搜索/筛选、详情、只输入 URL 的登记、验证后更换 URL、确认保存目标状态。输入 URL 变化使验证失效；保存失败保留原配置；网络结果不明固定 key/载荷，先核实原命令，未知再原样重试。
- 目录表单内容只在页面内存中，beforeunload 提醒；关闭未知结果须确认，刷新或关闭不承诺恢复命令。收到身份撤销会清除目录/表单并退出管理展示。配置冲突须重新读取，不能自动覆盖。
- 审计读取最近 100 条，明示展示范围，支持已加载结果搜索和详情。展示动作、稳定操作者 ID、目标、原/新配置、原因及时间；不提供删除审计或内容浏览。
- [目录 API](../../packages/gateway-common/src/admin-handler.ts) 接入真实管理 DO；新增 GET /audit-events 与 GET /changes/{key}（当前仅核实本人类型命令）。注册/更新和审计仍原子完成，Google 近期确认、CSRF、ETag、幂等和实时名单约束保持。

## URL 验证与运维边界

[固定服务传输](../../packages/cloudflare-gateway/src/admin-type-service.ts) 只允许部署配置的精确 Markdown base URL。验证实际通过 ADMIN_MARKDOWN_SERVICE binding 访问 `unidocs-markdown`，不是按用户 URL 任意出网。只允许描述 GET、health HEAD、editor HEAD 三个明确路径/方法，删除用户鉴权信息，不跟随重定向。不能借管理 API 访问任意域名、私网或云 metadata。

Cloudflare 只读元数据已确认原 MarkdownEditor namespace 为 `ff628e0e897f4ef0b85388a319097cdf`，以 `cf-do:` 前缀形成存储身份标签；未新建或切换该 namespace。服务描述和管理策略中 ID/audience/storageIdentity 匹配。service binding 的部署映射由我们管控，JSON 自报一致不等于对任意外部服务的迁移证明。

首版只批准上述一个真实 URL，没有批准第二个可切换目的地。更换 URL 表单可使用，但未批准目标一律拒绝，不能绕过安全门槛；新增一方服务或可替换地址需部署侧配置相应固定 binding/允许路径。本轮不开放自助改变 allowlist。

验证仍是有界同步请求，成功 200 返回短时验证记录，非 202 队列。health 为 configuration-only，不假装完整业务健康；Markdown 未提供嵌入 editor，因此没有探测不存在的 editor 页面。验证成功快照有效 15 分钟，期间部署升级可改变服务；当前目录不控制线上请求，未来真实路由切换前必须再补连续性/兼容验证。

## 发布内容

先部署 Markdown 的真实发现、health、原鉴权链路 `/api/` 别名和第 13 轮已验证的空白创建正文消费修复，再部署 Gateway。保留原变量、Google secrets、D1、CAS 与原 DO namespace，没有开启 DOC_EXPLICIT_COMMITS；现有显式提交实验实现仍关闭。

更新共享 SDK 的 DO 代码会带上此前本地提交可靠性代码。实验接口仍受开关限制，但既有 DO 请求可能执行兼容性补列等加载逻辑；没有主动运行数据迁移、修改文档内容或测试写入生产文档。不能把“不切换主站 registry”理解为本次未更新微服务代码。

管理 SQLite 在已有控制 DO 内按需增加目录/验证/幂等表，不触碰主站目录 D1。所有部署使用 cfg 凭据，`wrangler deploy --keep-vars --strict`，凭据仅限进程并在 finally 清除。

## 验证

```sh
pnpm --filter @unidocs/gateway-common --filter @unidocs/cloudflare-gateway --filter @unidocs/web-gateway --filter @unidocs/cloudflare-markdown test -- --silent
# 75 + 56 + 78 + 3 = 212 passed
pnpm exec vitest run tests/integration/cloudflare/admin-control.test.mjs tests/integration/cloudflare/admin-directory.test.mjs tests/integration/cloudflare/markdown-discovery.test.mjs --fileParallelism=false --silent
# 3 passed
pnpm --filter @unidocs/web-gateway --filter @unidocs/cloudflare-gateway typecheck
# passed
pnpm --filter @unidocs/cloudflare-gateway --filter @unidocs/cloudflare-markdown build
# passed
pnpm --filter @unidocs/cloudflare-markdown --filter @unidocs/cloudflare-gateway exec wrangler deploy --dry-run
# passed
```

共 215 条相关测试。真实 workerd 测试通过实际 Markdown 发现处理器的 service binding 完成 Google 管理会话、验证、登记目标 enabled、重启、读取、停用、原命令核实及审计检查，未批准 URL 拒绝。

localhost 浏览器：1440px 登记与详情截图、820px 目标状态修改和审计详情/按钮无溢出、390px 设备提示通过。UI 截图使用隔离的 fetch 替身，不当作真实后端验收。

生产只读验收：Markdown 描述 200，editorProtocol=null，未授权 `/api/.../ir` 为 401；后台当前真人 Google 登录仍有效，三项导航可见，目录为空、审计两条，无页面告警；不携带 cookie 读取目录和审计均为 401。保留 CSP 拦截第三方统计 beacon。没有代用户在生产登记或启停，真实生产目录写入体验由用户确认。

## 后续

用户可刷新后台，进入文档类型，登记上述 Markdown URL 并保存目标配置，再查看审计。登录确认超过 15 分钟时按提示重走 Google；保存不会改变主站功能。

主站消费、通用 editor、其他 doctype 接入、更多一方 binding 配置、URL 切换的生产连续性验证、审计完整分页和跨刷新操作恢复另行推进。本轮不加入版本/发布管理。