# UniDocs Admin Portal Cloudflare 实现计划

状态：实施中，Admin WebUI MVP 已上线（2026-09-11）
基线：`b58689b`  
范围：只实现 Cloudflare Admin Portal，不实现 Azure、Tenant Portal、Agent/document 数据面或 thumbnail service。

## 当前进展与决策

下一阶段：为 Agent 提供独立 OAuth 2.1 保护的 remote MCP，实施方案见 [Admin Portal MCP 实现计划](MCP-IMPLEMENTATION-PLAN.md)。该入口不复用浏览器 Admin session，不接受 Google/Gateway token，首次按 read-only canary 发布。

### Admin v1 与 WebUI 完整闭环（2026-09-11）

已上线剩余 `createOperator`、`listOperators`、`getOperator`、`updateOperatorMetadata` 与完整 `updateDocumentType`，Admin v1 达到 **26/26**。独立 Portal D1 已应用 `0007_operators.sql`，生产 Worker 版本 `73b86398-fd44-4f07-a3d7-589d4a987f2e`。

- validation 按 actor/TTL 在一个 D1 batch 中单次消费，并与持久 Operator、idempotency receipt、`operator.created` audit 原子提交；相同 key 优先重放，不因 validation 已消费误报。Operator metadata PATCH 只改变 name/description/ETag，使用 If-Match 与内部 revision 条件更新，list/get 返回真实 D1 candidate。
- document type PATCH 已接入持久 Operator resolver，并在启用或保持启用时要求真实 Document Contract、Type Card、View、Operator 齐全且 View/Operator 对至少一个已登记 revision 有交集。不兼容资源不能使类型进入或停留在 enabled 状态。
- WebUI 的“处理服务”tab 已覆盖 discovery/signature validation、刷新恢复、validation 转持久候选、候选 list/get、metadata 编辑、绑定/解绑；Type Card/View 详情可绑定候选，基本信息可启用/停用，右侧持续展示完整准备度。所有 mutation 继续使用 CSRF、Idempotency-Key 与 If-Match，无 mock candidate state。
- 验证：portal-service 329 个测试、Cloudflare Portal 119 个测试、Admin client 12 个 transport tests、WebUI 16 个组件测试、真实 D1 validation/Operator 集成测试 5 个、全仓 typecheck、WebUI build 与 production dry-run 通过。生产匿名 `/operators`、`/operator-validations` 均为 401，后台 303、Markdown discovery 200/强 ETag、主站与 `/ui/` 200；smoke 后 validation/operator/receipt/success audit 均为 0。真人可从文档类型“处理服务”tab 执行验证→保存候选→绑定，再在“基本信息”启用；这些操作会写真实生产 D1，尚未自动代为执行。
- Operator UX 后续对齐已部署为 `c99fa558-58ea-4daf-b1cf-997526ba5352`：tab 以多候选列表为主，候选行直接显示当前状态、设为当前和 metadata 编辑入口；“添加操作代理”独立展开 validation→登记流程，验证成功不自动切换当前项。修复了误嵌套 CSS，页面 input/textarea 统一继承站点字体、尺寸和 focus ring；移动导航移至右上 header，不再遮挡页面操作。线上 390×844 与桌面实页验证均无横向溢出或控件重叠。
- 最后的“变更记录”tab 已部署为 `a777035e-0d65-4b0b-accc-7cceaf0f36c7`：固定按当前 document type 查询真实 audit API，提供倒序时间线、中文动作/资源/操作者、reason、request/resource identity、结构化 details 和 cursor 加载更多；直达 `?tab=changes` 可刷新恢复。WebUI 17 个组件测试、typecheck、build 与 production dry-run 通过；部署后共享浏览器 session 过期，真实生产事件页面等待管理员重新登录刷新验收。

### Operator 签名 probe wire checkpoint（2026-09-11）

已固定 Operator validation 的签名 probe 原语，尚未接入 transport、D1 或公开 handler，因此 Admin v1 完整 operation 仍为 **19/26**。每个部署登记 target 使用独立的至少 256-bit HMAC-SHA256 key；该 key 只属于 Portal 与对应 Operator，不复用 DocType service auth。

- Portal request 使用 256-bit 单次 challenge，绑定部署登记的 `declaredOperatorId`、待验证 document type、discovery config ETag、秒精度 issued/expires 时间；TTL 上限 300 秒。Operator receipt 必须原样回显这些字段，request 与 receipt 使用不同 domain separator 对 RFC 8785 canonical JSON 签名。
- receipt 验证使用 Web Crypto HMAC verify，拒绝未知/缺失字段、错误 challenge/key/signature、identity/document type/config ETag 错配、未来签发和过期回执。probe 不包含管理员身份、document 内容、CAS capability、cookie 或 bearer token。
- 当前只完成 cloud-neutral wire primitive 与 6 个篡改/过期测试。下一切片将其接入现有 bounded Service Binding transport，严格解析 discovery/receipt，并在验证全通过后才以 D1 原子写发布短期 validation record 与 audit；失败不创建 validation record。

### Operator validation 纵向闭环（2026-09-11）

已上线 `createOperatorValidation` 与 `getOperatorValidation`，Admin v1 完整 operation 增至 **21/26**。Portal Worker 版本 `0c425c93-b810-4540-a791-4851e3e3e984`，Markdown Worker 版本 `53a5a8ad-d04f-47d4-a075-d3206f81756c`；独立 Portal D1 已应用 `0006_operator_validations.sql`。

- probe HMAC wire 已下沉到 cloud-neutral `@unidocs/service-auth`，Portal 与 Markdown 共用同一字节实现。Markdown 暴露 `/.well-known/unidocs-operator` 与 `/operator/probe`，严格有界解析 JSON、验证 request 签名/时间/identity/document type/config ETag，再返回 domain-separated signed receipt；缺 secret/document type 时 503 fail closed。
- 第一方目标固定为 `unidocs-markdown` Service Binding，无公网 fetch fallback。生产 Portal D1 只读确认 Markdown registration 为 `dt-292d2d45-fbd9-4392-99cd-f46474679667`、latest contract revision 0；Markdown descriptor 从部署配置声明该精确 document type 和 revision 0，强 config ETag 由完整 descriptor SHA-256 派生。
- validation service 在任何网络 I/O 前完成幂等 replay、target key 与 document type/contract 查询；discovery 与 probe 全部通过后才发布 15 分钟 immutable validation。D1 batch 原子写 validation、receipt 与 `operator.validation_passed` audit；失败只写脱敏 phase audit，不创建 validation/receipt；过期 validation 对 GET 隐藏。持久化故障不伪装成对端验证失败。
- 同一随机 256-bit HMAC key 已通过 stdin 分别安装为两个 Worker secret，未写入配置、源码或日志。Cloudflare 首次将公开 discovery 强 ETag 弱化为 `W/`；加入 `Cache-Control: no-store, no-transform` 后生产重新验证为强 `"sha256-..."`，Service Binding 与公开 discovery 使用同一 descriptor identity。
- 验证：portal-service 326 个测试、Cloudflare Portal 119 个测试、Admin client 11 个 transport tests、Markdown Worker 6 个测试、service-auth 105 个测试、真实 D1/HTTP 4 个 validation 集成测试、真实双 Worker Service Binding 签名交换 2 个集成测试、全仓 typecheck、Markdown/Portal production-shaped dry-run 与 `git diff --check` 通过。生产匿名 validation API 401、Operator discovery 200/强 ETag、无签名 probe 401、旧 DocType discovery 与主站 200；smoke 后 validation/receipt/success audit 仍均为 0。一次登录管理员发起的真实 validation 与 audit correlation 尚待验收。

### View bundle 纵向闭环（2026-09-11）

已上线 `uploadViewBundle`、`listViewBundles`、`getViewBundle`、`updateViewBundleMetadata` 纵向闭环：service、D1 repository、migration、HTTP/Worker、R2 ingress、client 与 WebUI 均已接通。Admin v1 完整 operation 增至 **19/26**，Phase 4 为 Type Card **4/4**、View bundle **4/4**；生产 Worker 版本 `eae033db-f724-4221-bf97-3fe5c62b2ba9`。

- View ZIP 保留全部已扫描资源字节，并按扩展名与实际内容固定 allowlist：严格 UTF-8 HTML/CSS/JS、严格 JSON、安全 SVG、实际 PNG/JPEG/WebP，以及带正确文件签名的 WOFF/WOFF2；未知扩展、伪装图片、非法 UTF-8、BOM/NUL 文本均拒绝。manifest 要求不同 HTML 入口、规范路径、无重复 revisions，supported revisions 必须来自 D1 对 manifest document type 的真实查询。
- View 对象使用完整内容 SHA-256 身份 `vb_<64 lowercase hex>`，canonical manifest 与全部已验证资源写入 `view-bundles/{id}/`，每个对象携带固定 MIME、SHA-256 和一年 immutable cache metadata。service 在 reservation replay 时不写对象，metadata 更新只改变 name/description/ETag。
- D1 对 content hash 与 actor/idempotency key 建立唯一 reservation；R2 写完后 candidate、receipt、reservation 消费与 audit 在一个 batch 发布。同 key publish 竞争窗口会再次读取 receipt 后重放，不误报重复内容；该修复也同步覆盖 Type Card。metadata PATCH 使用 If-Match 与内部 revision 条件更新。
- bundle ingress 仅接受完整 View hash 路径与固定 MIME。HTML CSP 只允许当前 immutable bundle 根路径的 script/style/image/font，禁止 connect/worker/object，使用不含 `allow-same-origin` 的 `sandbox allow-scripts`，并仅允许 Portal origin 嵌入。WebUI 的“界面包”tab 提供候选列表、双入口/revision/URL 详情、ZIP upload 和 metadata 编辑，直达 `?tab=bundles` 可刷新恢复。
- 独立 Portal D1 已应用 `0005_view_bundles.sql`，生产 candidate/reservation 初始均为 0 行；部署与 smoke 未上传 bundle。匿名 production smoke 已确认 `/admin/` 303 到登录页、View API 401、完整假 ID bundle ingress 404，主站、`/ui/` 与旧 OAuth discovery 仍为 200。
- 验证：portal-service 315 个测试、Cloudflare Portal 118 个测试、Admin client 10 个 transport tests、WebUI 15 个组件测试、真实 D1/HTTP 4 个 View 集成测试、两类 bundle 并发集成测试、全仓 typecheck、production dry-run 与 `git diff --check` 通过。一次真人上传、真实 HTML/JS 对象 fetch、隔离 iframe 执行和 audit correlation 尚待验收。

### Type Card bundle 纵向闭环（2026-09-11）

已上线 `uploadTypeCardBundle`、`listTypeCardBundles`、`getTypeCardBundle`、`updateTypeCardBundleMetadata`，Admin v1 完整 operation 总数增至 **15/26**，Phase 4 为 Type Card **4/4**、View bundle **0/4**；生产 Worker 版本 `f2faecd8-dfb0-4118-93af-2b4fc6bdd73f`。独立 Portal D1 已应用 `0004_type_card_bundles.sql`，生产 candidate/reservation 初始均为 0 行，部署和 smoke 未自动上传 bundle。

- service 在 8 MiB 有界 ZIP 内验证 canonical Type Card manifest、BCP 47 locale、引用闭包、PNG/JPEG/WebP 实际结构与像素预算、五尺寸 PNG 图标和受限 SVG；只把 canonical manifest 与已验证图片字节写入内容寻址 R2 key。公开 ID 使用完整 SHA-256：`tb_<64 lowercase hex>`，record 的 `size` 保存原始压缩 ZIP 字节数。
- D1 reservation 对 content hash 和 actor/idempotency key 唯一。R2 全部写成功后，candidate、idempotency receipt、reservation 消费和 `type_card_bundle.uploaded` audit 才在一个 D1 batch 中发布；重复内容用 409 返回既有 identity。metadata PATCH 通过 If-Match 与内部 revision 原子更新，只改变 name/description/ETag，并原子写 receipt/audit。
- 独立 R2 bucket `unidocs-portal-bundles`、`BUNDLES` binding 与 `https://bundles.shazhou.work` custom-domain trigger 已部署。ingress 只接受完整 hash Type Card 路径以及 canonical JSON/PNG/JPEG/WebP/SVG，成功响应重新固定 MIME、`nosniff`、sandbox CSP、cross-origin resource policy 和一年 immutable cache；Admin CSP 只额外允许该 origin 的图片。最初选择的三层 hostname `bundles.unidocs.shazhou.work` 在 custom certificate 就绪前持续 TLS 握手失败；生产尚无 candidate，因此改用 zone wildcard 已覆盖的单层 hostname，无既有 `bundleUrl` 兼容负担。新 origin 的 DNS/TLS/Worker 404 smoke 已通过。
- client 已接入 raw ZIP upload、list/get 和 metadata PATCH。WebUI 按 Admin mock 的“类型卡片包”tab 提供候选列表、upload/validate、manifest/locale/icon/thumbnail 详情、跨 origin 图片预览和 metadata 编辑；直达 `?tab=cards` 的组件测试固定刷新安全路由。
- 验证：portal-service 182 个测试、Admin client 9 个 transport tests、WebUI 14 个组件测试、Cloudflare Portal 114 个测试、真实 D1/HTTP 4 个 Type Card 集成测试、全仓 typecheck、production dry-run 与 `git diff --check` 通过。生产匿名 smoke 已确认 `/admin/` 303、Type Card API 401、CSP 包含独立图片 origin，以及 bundle hostname DNS/TLS/404 ingress；一次真人上传、真实对象 fetch 和 audit correlation 尚待验收。

### Type Card bundle 阶段启动约束（2026-09-11）

本阶段启动时按 R2 adapter → D1 record/reservation → API/client/WebUI → migration/Worker/smoke 顺序推进，完整 operation 数为 **11/26**。当前完成状态以上方纵向闭环记录为准。

- 使用独立 Portal R2 bucket，不复用 Gateway/CAS bucket。对象 key 由 canonical bundle content hash 派生，canonical manifest 字节与已验证资源字节不可变；D1 是 bundle metadata、identity、reservation 和 selection 的权威，R2 不充当关系数据库。
- 上传必须复用现有有界 ZIP 与 Type Card manifest 检查，补齐当前发布门禁：实际 PNG 解码/五尺寸验证、SVG 安全规则、sample thumbnail 实际图片验证、MIME allowlist 和可执行资源拒绝。验证通过不等于发布成功；R2 写失败或 D1 提交失败需有显式 reservation/cleanup，不能伪装成单事务。
- stable `bundleUrl` 使用 Portal 控制的独立 bundle ingress；在独立 hostname 就绪前不得返回 `/admin` cookie origin 下可执行的不受信任内容。Type Card 仅允许受控图片/manifest 资源，响应固定 MIME、nosniff、immutable cache 和禁止 HTML/script 执行策略。
- UI 继续参考 Admin mock 的“类型卡片包”tab：候选摘要、上传并验证、manifest 协议/语言/图标/thumbnail 结果、多语言卡片预览、metadata 编辑和后续选择入口；所有数据来自真实 API，不复制 mock candidate state。页面/tab URL 必须继续 refresh-safe。
- metadata PATCH 只改变 name/description 和 ETag，不改变 content hash、manifest、size 或 bundle URL；upload/patch 继续遵守 CSRF、Idempotency-Key/If-Match、事务内权限复查与原子 audit。重复 content 不创建第二份对象或 candidate。

### 内部开发数据策略（2026-09-11）

当前系统尚未正式上线，`unidocs-portal` D1 与 `unidocs-portal-bundles` R2 中的现有数据均视为可丢弃开发数据。实现未冻结 schema/对象布局时，优先选择干净的数据模型，不为当前测试记录增加复杂的兼容迁移、双写或长期 GC 负担。

- 如重建比向前兼容更清晰，可 drop/recreate Portal 自有 D1 表或清空 Portal R2 objects，并重新执行 migrations/bootstrap；每次破坏性操作前仍要明确报告影响范围和重建步骤，不静默删除。
- 该授权只覆盖独立 Portal D1/R2，不覆盖 Gateway 的 `unidocs-snapshots`、CAS、文档数据面或其他服务资源；不得因开发数据可丢而降低认证、CSRF、幂等、并发、审计和 bundle 内容安全要求。
- 正式上线准备阶段必须显式结束此策略：冻结 schema/object key，改为只允许向前兼容 migration，定义 receipt/reservation/孤儿对象保留与 GC SLA，并完成备份/恢复和 rollback 演练。

### Document Contract 纵向闭环（2026-09-11）

已上线 `appendDocumentContract`、`listDocumentContracts`、`getDocumentContract`，Admin v1 完整 operation 总数增至 **11/26**，Phase 3 进度为 **6/7**；生产 Worker 版本 `4608b2d3-fad7-483f-baf7-c69d0974290b`。独立 Portal D1 已应用 `0003_document_contracts.sql`，为 document type 增加 `last_contract_idx` 并建立不可变 paired contract 表/倒序分页索引；migration 后现有 Markdown registration 保持 latest=null、idx=-1，contract 表为空。

- service 严格验证 SValue dialect、format v1、reason 和幂等 key，计算 snapshot/location schema hash 与不含 idx/时间/hash 字段的 paired contract hash。repository 每次竞争尝试读取最新 registration/idx，构建候选 record 和新 registration ETag，再以 `last_contract_idx + current ETag` 双条件原子提交 receipt、idx 分配、contract、registration 与 `document_contract.appended` audit。
- append 在有限重试内处理 D1 竞争；8 路真实并发测试得到连续零基 revision 0..7，最终 registration/latest/last_contract_idx 一致。相同 key/内容重放原 response，不同 fingerprint 409；重复内容不同 key 拒绝。audit 故障会回滚 receipt、record、counter 和 registration，不留下 idx gap。
- list 按 revision 倒序稳定 cursor 分页，cursor 绑定 document type；get 返回完整 snapshot/location schema、派生 media type、schema hash、contract hash 和 createdAt。HTTP body 上限 256 KiB，使用严格 JSON parser，拒绝重复/非标准 JSON 和非法 query；认证、CSRF 与 no-store 继续由 BFF 负责。
- Admin client 已接入 append/list/get。WebUI 按 Admin mock 重构为六 tab 文档类型配置工作区；“文档契约”tab 提供 revision 摘要、完整 schema/hash 详情、cursor 加载和 append 对话框，右侧展示启用准备度；其他候选 tab 在真实 API 上线前只显示明确空状态，不含 mock data。URL `?tab=contracts` 在桌面/移动刷新后保持，append 对话框同时编辑 snapshot/location JSON 和 reason。
- 验证：portal-service 173 个测试、Admin client 8 个 transport tests、WebUI 13 个组件测试、Cloudflare Portal 112 个测试、真实 D1/BFF 28 个集成测试、全仓 typecheck、production dry-run 与 `git diff --check` 通过。生产桌面验证六 tab、空 revision 0 状态、append 表单和刷新恢复；390×844 下页面/对话框无横向溢出。部署与 smoke 未创建生产 Contract，等待用户人工提交首个 revision 验收。

### Document Contract 阶段启动约束（2026-09-11）

下一阶段按“先计划 checkpoint，再实现可部署纵向切片”的顺序推进 Document Contract append/list/get；阶段开始前先更新本计划并提交，功能完成后再单独部署、验收和提交。当前完整 operation 数仍为 **8/26**，不因计划或路由骨架提前计数。

- 文档类型配置 UI 必须以 `docs/design/platform-v0/admin/unidocs-admin-mock.html` / `unidocs-admin-mock.js` 为交互参考：详情使用基本信息、文档契约、类型卡片包、界面包、处理服务、变更记录六个 tab；Document Contract 首版对齐 mock 的 revision 摘要、append 表单、schema/hash 信息和右侧启用准备度，但数据全部来自真实 client/API，不复制 mock state 或伪数据。
- 在扩展文档类型详情前先建立真实前端路由，不再只用 React 内存 `view`。目标 URL 为 `/admin/document-types`、`/admin/document-types/{documentType}?tab=contracts`、`/admin/administrators`、`/admin/audit`；Worker 对这些受保护路径提供 SPA shell，WebUI 从 pathname/query 恢复 page、选中类型和 tab，并用 History API 更新。桌面/移动端刷新、前进/后退必须保持正确位置。
- 路由不可与 `/admin/api/*`、`/admin/auth/*`、`/admin/login` 或 `/admin/access-denied` 混淆；未知受保护 UI route 返回明确 404 或安全默认页，不能吞掉 API/auth 路径。路由行为需有 BFF/静态资源测试和浏览器刷新验收。
- Document Contract 持久化继续遵守已验证约束：document-type scoped 零基 idx、append-only、canonical snapshot/location schema hash 与 paired contract hash、同 key 重放、事务内权限复查、idx 分配和 audit 原子提交。公开 list/get 必须从真实 D1 返回稳定 cursor 与完整 schema DTO。
- refresh-safe 路由基础已部署为 `540f5fc3-ed5a-4135-aec8-ce94d70d1e0b`：Worker 只对固定 `/admin/document-types[/id]`、`/admin/administrators`、`/admin/audit` 路径在鉴权后返回 SPA shell，不吞 API/auth/未知路径；WebUI 从 URL 初始化 page/detail/tab，使用 History API 导航并监听 popstate。生产浏览器已验证审计刷新、管理员→后退恢复审计、文档类型详情 `?tab=contracts` 刷新恢复与无横向溢出；Contract tab 内容尚待下一切片接入。

### Admin audit 查询闭环（2026-09-11）

已上线 `listAdminAuditEvents`，Admin v1 完整 operation 总数增至 **8/26**；生产 Worker 版本 `e3d9cdf3-886b-4117-809f-a383fa5761c6`。WebUI 新增“审计”导航、动作/资源筛选、反向时间列表、cursor 加载更多和事件详情；详情展示 event/request/actor/resource identity、document type、reason 与结构化 details。

- cloud-neutral service 严格验证 protocol query、长度预算和时间范围；D1 adapter 逐请求验证当前管理员/session，按 `(occurred_at DESC, audit_event_id DESC)` 稳定分页。cursor 绑定 actor/action/resource/document type/time 全部筛选条件，换筛选后重放 cursor 返回 400。
- 同秒事件用复合 cursor 比较，真实 D1 测试固定跨页无丢失、无重复；`occurredFrom` 为包含下界，`occurredTo` 为排除上界。每条数据库行在返回前经过 `AdminAuditEventSchema` 验证，`details_json` 只在存在时解析为公开 details。
- HTTP 拒绝重复/未知 query 和非法 limit，复用 oRPC/OpenAPI contract，不另建兼容 API。Admin client 编码全部八个筛选/分页字段；任意 401 继续进入统一 session-invalid UI。
- 验证：portal-service 168 个测试、Admin client 7 个 transport tests、WebUI 10 个组件测试、Cloudflare Portal 112 个测试、真实 D1/BFF 25 个集成测试、全仓 typecheck、production dry-run 与 `git diff --check` 通过。生产匿名 audit API 为 401；D1 回读现有 10 条事件、5 种动作，未产生测试 mutation。共享浏览器 session 已过期，等待用户重新登录进行 WebUI 人工验收。
- 审计 UX 后续迭代已部署为 `eeb9d73b-801a-4d78-bcf4-2f9e210cf0f5`：进入审计页时并行读取 active 管理员目录，actor 优先显示 email 本地部分作为可读名称和完整 email，详情保留 member UUID；已删除或无法解析的历史 actor 回退 UUID。筛选顺序调整为“资源 → 动作”，动作选项按资源类型一对多收窄，切换资源会清除不兼容动作并以新筛选重新查询。生产真实事件已验证显示 `shazhou.ww`/`shazhou.ww@gmail.com`，管理员资源只提供四个成员动作，桌面无横向溢出。
- 审计 i18n 补全已部署为 `e59ca86d-5df7-4538-ab9f-e8fcb52659dc`：协议定义的 21 个审计动作与 7 个资源类型都有明确中文 label，列表、详情和两级下拉不再回退 `type_card_bundle.*` 等机器值。label map 使用完整 `Record`，协议未来新增枚举但 UI 未翻译时 typecheck 会失败。生产浏览器回读全部 option，资源 8 项（含“全部资源”）、动作 22 项（含“全部动作”），机器 label 计数为 0。

### 管理员移除闭环（2026-09-11）

已上线 `removeAdministratorMember`，Admin v1 完整 operation 总数增至 **7/26**；生产 Worker 版本 `036dcee4-ad56-46b5-86e8-43614357e74a`。WebUI 管理员表只对非当前成员显示移除操作，确认框明确目标邮箱和 session 撤销后果；部署与 smoke 不自动删除任何生产成员，需由真人在 WebUI 确认。

- DELETE 要求同源 cookie mutation 的 CSRF、`Idempotency-Key` 和当前成员 `If-Match`。service 生成稳定 fingerprint 与 `administrator.removed` audit；相同 key/请求在首次成功后可重放 204，不会因资源已软删除而误报 404。
- D1 repository 先用公开完整成员表示验证 ETag，再将内部 revision 放入条件 UPDATE。事务内重新验证操作者及 session，原子提交 receipt、`active=0`/revision 递增、目标全部 session family 撤销、session 删除和 audit；任一步失败全部回滚。
- 当前成员不能移除自身；移除已绑定成员必须保证事务提交后仍有至少一位 active、已绑定管理员。真实 D1 并发互删测试证明两个管理员同时移除对方时只允许一个成功，最终保留一位已绑定管理员和一个 live session。
- 错误保持稳定：缺 `If-Match` 为 428，旧 ETag 为 412，自删和最后管理员保护为 409，目标不存在为 404。WebUI 对这些冲突显示可操作中文信息，失败后关闭确认框并要求刷新或调整操作。
- 验证：portal-service 159 个测试、Admin client 5 个 transport tests、WebUI 7 个组件测试、Cloudflare Portal 112 个测试、真实 D1/BFF 24 个集成测试、全仓 typecheck、production dry-run 与 `git diff --check` 通过。生产部署后未执行真实 DELETE；共享浏览器 session 在视觉检查前已过期，等待用户重新登录试用验收。
- 后续 UX 修复已部署为 `770cdb99-a3bf-4427-9b2e-a64a580b2556`：侧栏不再显示依赖按需加载数据的数量徽标，避免管理员 tab 首次打开前错误显示 0；Admin client 对任意受保护请求的 401 统一导航到 `code=session_invalid` 的拒绝页，不再只显示页面内 banner。该页面明确 session 或成员资格已失效，展示 request ID，并提供“退出并返回登录”。当前验证数字为 Admin client 6 个 tests、WebUI 9 个 tests，Cloudflare Portal 112 个 tests 及全仓 typecheck/dry-run 通过。

### 登录、授权与退出四态闭环（2026-09-11）

已按真人反馈重构浏览器认证状态机并部署 Worker 版本 `48ffb028-6a9c-40b1-a8c4-00000836fca2`：未登录、已登录有权限、已登录无权限和 logout 四种状态均有独立且可恢复的 UI/路由行为，不再把登录提示、OIDC 启动、授权拒绝和 session 清理混在同一个跳转中。

- 未登录访问 `/admin/` 时 303 到公开的 `/admin/login` 提示页；只有点击“使用 Google Account 登录”才进入 `/admin/auth/login`。OIDC authorization 固定 `prompt=select_account`，每次都显示 Google 账号选择器，同时保留 PKCE S256、nonce、单次 state 和既有授权码登录确认语义。
- 有效且有权限的 session 直接进入真实管理页面。生产回读确认 `shazhou.ww@gmail.com`、`yanjiayiceshi@gmail.com` 和 `neko.shazhou.ww@gmail.com` 均为 active、已绑定成员。
- 浏览器 callback 的 401/403 303 到 `/admin/access-denied`；页面展示安全原因、request ID 和“退出并返回登录”。该操作先尝试 POST logout，再回 `/admin/login`，不会直接重启 OIDC。API 与非 HTML 调用继续返回稳定 JSON。
- logout 对浏览器保持幂等：有效 session 会撤销 family 并清除 session/CSRF cookie；session 已过期或不存在时，同源 POST 仍返回 204 并清除两枚 cookie。正常退出最终回到 `/admin/login`，不会自动进入 Google。
- 已处理并发 callback 的陈旧页面竞态：`/admin/login` 和 `/admin/access-denied` 首帧只显示中性的“正在确认登录状态”，先读取 `/admin/auth/session`。若另一个 callback 已建立有效 session，则直接 `replace('/admin/')`；只有 session 探测失败才显示登录或拒绝内容，因此不会闪现错误的“没有管理员权限”。生产浏览器记录的完整标题序列为“正在确认登录状态”→“文档类型”。
- 验证：Google OIDC 36 个测试、Admin client 4 个 transport tests、WebUI 6 个组件测试、Cloudflare Portal 112 个测试、真实 D1/BFF 22 个集成测试，以及相关 typecheck/build/dry-run 通过。匿名 production smoke 固定 `/admin/`→`/admin/login`、提示页 200、OIDC 303 且 `prompt=select_account`、拒绝页 200、无 session logout 204 且清除两枚 cookie；有效 `shazhou.ww@gmail.com` session 在线回读为 200 并可进入管理页面。

### 管理员首个 API 与 WebUI 闭环（2026-09-11）

已上线 `listAdministratorMembers`、`getAdministratorMember`、`addAdministratorMember`，Admin v1 完整 operation 总数增至 **6/26**；生产 Worker 版本 `1adaa634-9f7f-47d5-a082-93e62446b863`。WebUI 新增管理员导航、真实 allowlist、身份绑定状态、自身标识和添加邮箱对话框；同批保留搜索框 Enter 提交且不显示冗余搜索按钮的交互调整。

- add service 先 trim/lowercase 规范化 Google 邮箱，创建未绑定成员与 canonical ETag；D1 batch 在事务内复查当前管理员/session，并原子提交 actor/operation/key receipt、allowlist 行和 `administrator.added` audit。同 key 同请求重放，不同请求返回 409；已有 active 邮箱返回 `administrator_exists`。
- list/get 只返回 active 成员，按稳定 member ID cursor 分页；`bound` 来自 issuer/subject 是否已完成绑定，`isSelf` 只出现在列表 DTO。成员时间在写入前固定到 D1 的秒精度，保证 mutation 返回与后续 GET 的 ETag 相同。
- 生产 allowlist 已加入 `yanjiayiceshi@gmail.com`，成员、receipt 与 audit 通过一次 D1 原子 import 提交并回读均为 1；该账号及随后通过正式 WebUI 添加的 `neko.shazhou.ww@gmail.com` 均已完成身份绑定。邀请前失败的 OAuth state 不可重放，必须从 `/admin/` 重新开始登录。
- 浏览器 callback 的 401/403 不再显示裸 JSON：带 `Accept: text/html` 的失败导航会 303 到 `/admin/access-denied`，显示安全原因、request ID 和退出操作；API 与非 HTML 调用仍返回原稳定 JSON。拒绝页只读取 session 状态，不调用业务 API，390×844 下无横向或纵向溢出。
- 最新验证数字与认证 UX 见上方四态闭环记录。生产 WebUI 已回读三位 active、已绑定管理员；搜索按钮不存在且 Enter 查询测试保留。

### Admin WebUI MVP 上线（2026-09-11）

已将首个可用 WebUI 部署到 `https://unidocs.shazhou.work/admin/`，Worker 版本 `90b50031-30d7-4f59-a47f-38468f4ca3b1`。未登录入口继续 303 到现有 Google 登录；登录后根路由不再返回 session JSON，而是返回真实 React WebUI，机器可读 session 保留在 `/admin/auth/session`。

- 新增 `@unidocs/admin-portal-client` 与 `@unidocs/admin-portal-webui`。MVP 使用真实 API 提供 session 展示、文档类型列表/名称与 enabled 筛选、详情检查、创建 disabled 草稿、退出登录，以及 loading/empty/error 状态；不含 mock data。桌面使用紧凑表格与详情面板，移动端使用右下入口和右侧抽屉。
- client 当前只覆盖 session/logout 和 document type create/list/get/update transport，不声称已完成 26-operation client。mutation 统一发送同源 cookie、CSRF、幂等 key，PATCH 发送 `If-Match`；稳定 API error 带 status/code/requestId。
- WebUI 由 Vite 构建后生成 Worker 内嵌 asset map。HTML `no-store`，带 hash 的 JS/CSS 为 immutable；`/admin/` 先认证再返回 HTML，静态 asset 不含管理员数据。CSP 仅允许同源脚本、样式和连接，不使用 inline script/style。
- 同批完成 PATCH document type 的 service/D1/HTTP 并发控制切片：幂等 receipt 在旧 `If-Match` 重试时先重放，D1 事务内条件更新、管理员/session 再授权和 audit 原子提交，旧 ETag 返回 412，缺失 ETag 返回 428。当前 D1 尚无 contract/bundle/Operator 候选表，候选 resolver 明确返回 not found，启用不完整类型会拒绝；因此 PATCH **仍不计为完整 operation**；当前完整总数因管理员三个 operation 上线增至 **6/26**，WebUI 暂不展示重命名/绑定/启用控件。
- 当时验证：client 2 个测试、WebUI 1 个组件测试、portal-service 149 个测试、Cloudflare Portal 112 个测试、真实 D1/BFF 20 个集成测试及相关 typecheck/build 通过；最新数字见上方管理员闭环记录。Playwright 在 1440×900 与 390×844 验证无横向溢出，移动详情关闭控件可见。生产匿名 smoke：`/admin/` 303、hashed JS 200、session/API 401、主站与 `/ui/` 200。
- 待真人验收：已登录后检查真实空/已有列表与详情，并按需创建一个生产草稿。WebUI 创建会写真实 D1 数据，不自动启用类型；反馈应优先覆盖信息密度、筛选、详情字段和创建流程。

### 文档类型首个 API 闭环（2026-09-10）

用户已确认真实 Google 登录成功，返回 session、`loginConfirmation: "authorization-code-v1"` 与独立的 `loginConfirmedAt`；Google `authenticatedAt` 为 null，符合已批准语义。该项真人认证验收完成，不声称近期密码/MFA。

- 已上线 `createDocumentType`、`listDocumentTypes`、`getDocumentType`，共 **3/26** 个 Admin v1 operation；使用现有 oRPC contract 的真实 OpenAPI handler，非手写兼容 API。版本 `2b41733b-ceb9-443a-991c-ba83b164fa74`，独立 Portal D1 已应用 `0002_document_types.sql`。
- `portal-service/src/admin/document-types.ts` 创建稳定 `dt-<UUID>` disabled 草稿，所有 bundle/contract/Operator 引用为空；强 ETag 来自完整 canonical GET representation。mutation 仅返回 documentType/etag，不自动启用类型。
- `cloudflare-portal/src/document-types-repository.ts` 同批提交资源、actor/operation/key 作用域的幂等 receipt 和成功 audit；同 key 同内容重放原结果，不同内容 409。事务内再次检查有效管理员及 session/family，前置鉴权后 logout 的竞争请求不能提交；撤销会话也不能重放旧 receipt。当前 receipt 无自动清理，保留期策略待统一制定。
- 列表提供 name/ID 文本筛选、enabled 筛选及按稳定 documentType ID 的 cursor 分页；cursor 绑定筛选条件，列表为 summary DTO。当前数据库搜索大小写折叠使用 SQLite lower，非完整 Unicode case folding；跨请求分页不是数据库 snapshot。
- HTTP 创建 body 限制 16 KiB，复用严格 JSON parser，拒绝重复 key、非标准 JSON、未知创建字段、重复/非法 query；GET 单独启用锁定版本的 Zod query coercion，POST 不进行类型纠正。错误保持稳定 code/requestId，认证和 CSRF 在 BFF 执行，响应 no-store。PATCH、contract、bundle 和 Operator handler 尚未注册。
- 验证：147 个业务核测试、111 个 Cloudflare 测试、20 个 D1/BFF/HTTP 集成测试、全仓 typecheck 与生产 dry-run 通过。workerd 内完成登录→创建→重放→详情→筛选列表→logout→拒绝旧 cookie 的全链路；线上只做匿名 smoke，读写均 401，主站及 `/ui/` 仍为 200。未用用户 cookie 创建生产测试数据。
- 已登录用户可访问 `https://unidocs.shazhou.work/admin/api/v1/document-types` 检查真实列表。`/admin/` 已于 2026-09-11 切换为 MVP WebUI，范围与限制见上方最新记录。

以下上线记录按时间保留；当前 operation 数与版本以上述段落为准。

### 认证上线记录（2026-09-10）

最新策略与版本：用户复验确认失败为 `identity/auth_time_missing`（request ID `00d15aa3-6959-4c6a-9fbd-29c66bdd4e9b`），随后明确批准与 Gateway 对齐的“近期登录确认”语义。已部署 `98b2084e-56b4-482f-89df-270bfb6a7ed4`：仅在 PKCE、浏览器绑定、单次 state、签名、nonce、issuer/audience/azp、token 签发和到期检查通过后，生成 `loginConfirmedAt` 与 `loginConfirmation: "authorization-code-v1"`。Google `authenticatedAt` 独立保留，缺少时为 `null`，不以 `iat` 或 callback 时间伪造 Google 认证时间。五分钟确认窗口从 `loginConfirmedAt` 起算，session 查询不会续期；这不是近期密码/MFA 证明。Bearer 仍要求原来的 `auth_time` 校验，token 自带的确认字段不被采纳。无需 migration，确认字段保存在现有 D1 session JSON。136 个业务核测试、111 个 Cloudflare 测试、14 个 D1/BFF 集成测试及两包类型检查通过；该版本上线时真人登录尚待验收，随后已成功，见顶部最新记录。以下早期严格 auth_time 策略记录仅为历史。

真人首次验收返回 `unauthorized`，request ID `f2ae6b04-a44f-4506-83d2-0e61e7ecff4d`。旧响应合并了所有 callback 校验失败，无法从该响应确定根因；`auth_time` 缺失仅为候选原因，未确认。已部署诊断版 `3b729507-5892-4be5-bdee-a66d48325bda`，用固定枚举返回 `details.stage`/`details.reason` 并关联 request ID，不记录原始 OAuth 错误、claims、code、token 或 cookie。110 个 Cloudflare 包测试、12 个 D1/BFF 测试及类型检查通过；线上缺参 callback 的安全诊断和 Google 303 跳转验证通过。认证策略未降低，真人登录仍未通过；需要从 `/admin/` 重新开始，不重放已消费的 callback。

用户已明确允许直接切换旧后台。认证版 Portal 已部署到 `https://unidocs.shazhou.work/admin/`：未登录时跳转 Google，登录成功后返回 session JSON；这不是完整 Admin WebUI，26 个业务 operation 仍未实现。

- Worker：`unidocs-portal`；版本：`f67f8a85-82f8-4ecc-9906-4573986f2c84`。
- 独立 D1：`unidocs-portal`，ID `b03c6e6b-e4b7-49a8-b3f1-6ab8e5baeae1`，已在远端应用 `0001_admin_auth.sql`。未改动 Gateway 的 `unidocs-snapshots` 数据。
- 生产配置：`packages/cloudflare-portal/wrangler.production.jsonc`，仅接管 `unidocs.shazhou.work/admin` 和 `unidocs.shazhou.work/admin/*`。Gateway 原 OAuth callback、主站和文档 API 保留；旧后台 UI/管理接口暂由认证版取代。
- Google client secret 从用户提供的本地 JSON 经 stdin 注入 Worker，未写入源码/配置或输出日志；部署 token 仅用于临时进程环境。初始管理员沿用原 Gateway 配置的 `shazhou.ww@gmail.com`，首次成功登录才原子 bootstrap。
- 线上匿名 smoke：`/admin/` 303、session 无 cookie 401、缺参数 callback 401、GET logout 405；login 303 指向 Google、callback 精确匹配已登记 URI、PKCE 为 S256、响应 no-store。主站 `/`、`/ui/` 和旧 OAuth discovery 切换前后均为 200。没有验证受保护文档 mutation 或真人登录。
- **待用户验收**：从 `/admin/` 重新开始登录，不刷新旧 callback。成功应看到 `memberId`、`email`、`transport: "session"`、`loginConfirmedAt` 与 `loginConfirmation: "authorization-code-v1"`；`authenticatedAt: null` 表示 Google 未提供认证时间。如失败只提供错误 JSON，不发送 callback 完整 URL、code、cookie 或 token。
- **回退**：把生产配置的 `routes` 改回 `[]` 后部署同一 Portal Worker，移除其两个后台路由，使旧 Gateway catch-all 恢复处理后台。不要删除任何 D1 数据或修改 Gateway 原 OAuth route。由于 cookie 名共享，回退后可能需要在旧后台重新登录。回退方案已记录，未实际执行演练。

以下较早进度条目保留其阶段背景；当前部署状态以上述上线记录为准。

认证闭环与验证基础已提交为 `c45f080`（未 push）。提交后开始生产认证部署准备：新增 `stacks/unidocs-cloudflare/deploy/portal-auth.mjs`，以独立 Worker/D1、空 routes、关闭 workers.dev/preview 的临时配置执行纯 dry-run；拒绝本地 D1 占位值和当前 Gateway D1 ID，不复制 secret 值，成功/失败均清理临时配置。9 个预检测试和使用测试参数的真实 Wrangler dry-run 通过，不代表生产数据库或凭据已验证。

部署前检查发现：旧 Gateway 与新 Portal 共享 `/admin/auth/login`、`/admin/auth/session` 及 `__Host-unidocs_admin` cookie；旧 session API 为 POST，新查询接口为 GET。用户已接受旧后台切换，不能声称此切换不影响旧后台；主站和文档 API 的路由保持不变。

较早本地凭据存在性检查只输出布尔状态：部署 token 可从 cfg 读取，但所查 Google/D1 键名未找到。用户随后提供本地 Google JSON，生产 Portal D1 已独立创建；缺凭据阻塞已解除。凭据轮换应继续只在本地进程/Worker secret 中进行，不写入仓库。

线上 origin 已由用户确定为 `https://unidocs.shazhou.work`，代码默认配置已固定。Portal 的精确 Google redirect URI 为 **`https://unidocs.shazhou.work/admin/auth/callback`**。仓库 Gateway 配置中的旧 URI 是 `https://unidocs.shazhou.work/oauth/unidocs-cloudflare/login/callback`，保留旧 URI。用户已于 2026-09-10 确认新回调配置完成；这不是实际 Google 登录验收结果，仍需接通 BFF 后验证。

域名复用是对原计划“独立 hostname”的更新，不改变独立 Worker/D1/R2 的边界。用户已批准并完成后台路径切换，未修改 Gateway 包或其原有路由配置；Portal 更具体的后台路由优先生效，不接管旧 OAuth callback、`/ui/`、`/tenants/` 或文档 API。共同 origin 也不是浏览器安全隔离边界，bundle 内容仍需独立 origin。

2026-09-10：已落地内容身份、D1 原子写与安全 spike、真实认证闭环与文档类型 create/list/get；**不代表 Phase 0 或 Phase 1 已完成**。Portal 已有线上部署和 3/26 个真实 Admin handler，client 与真实 WebUI 仍未创建。

已验证：

- 认证先行已实现：`cloudflare-portal/migrations/0001_admin_auth.sql` 建立独立管理员、bootstrap marker、登录 state、session family/session、管理员审计和内部认证审计表，不包含 bundle/Operator schema。`auth-repository.ts` 在单个 D1 batch 中提交 bootstrap/身份绑定、session 创建和审计，失败全量回滚；登录 state 按 state hash/browser hash/TTL 原子消费。
- 当前重新认证策略为单管理员单活跃 session：新登录在同一事务内撤销该管理员所有旧 family、删除旧 session，再创建新 family/session；不做滑动续期。不同浏览器重新登录会使旧浏览器退出。邀请绑定要求认证时间不早于邀请时间，移除成员后 session 查询立即失效。session 只保存 token/CSRF hash；短期登录 state 中的 PKCE verifier/nonce 是服务端临时凭据，尚需过期清理任务。
- `bff.ts` 已连接 `/admin/auth/login`、`callback`、`session`、`logout`。callback 成功才提交身份及 session，设置 HttpOnly session cookie 和浏览器可读的 `__Host-unidocs_admin_csrf` cookie；POST logout 强制 cookie 鉴权、同源 Origin 和 CSRF。错误与响应使用 request ID、no-store/no-referrer/nosniff，失败不回显内部数据库错误。业务 API 路径仍返回 404，未伪造文档类型数据。
- `portal-auth-repository.test.mjs` 的 12 个真实 D1/BFF 测试通过，包括 bootstrap/绑定/并发、失败回滚、重新登录/logout、邀请后认证，以及 workerd 内跨请求并跨 Worker 重建的登录到退出流程。Google 响应仍为测试 RSA fixture，不代表真人登录已验收。
- 已新增 `wrangler.jsonc`、`worker.ts` 和 Wrangler 生成的 `src/env.generated.d.ts`。配置仅用于本地准备：无 routes、workers.dev/preview URLs 关闭、D1 ID 为本地占位值、Google client ID 和 bootstrap 邮箱为空；不能直接当生产配置部署。启用 nodejs_compat 和结构化日志，关闭自动 invocation logs，应用日志不含 callback query。缺少 Google 配置时 fail closed 返回 503。类型生成与 `wrangler deploy --dry-run` 通过，无线上写入。

- Operator 网络安全新增第一方 Service Binding spike：`cloudflare-portal/src/operator-transport.ts` 只从部署方登记的精确 canonical HTTPS base URL 选择 binding，调用其 `fetch`，没有公网 fetch fallback。请求 URL 不决定连接目标，因此不采用“先 DNS 检查再普通 fetch”的可重绑定方案。这里只证明一方 Worker 出口可行，不把公开 Operator API 永久限制为绑定服务；外部服务出口仍未实现。
- Operator 传输仅允许固定 discovery 路径和部署登记的 probe 路径；不跟随 redirect、不转发管理员 Authorization/cookie 或 CAS/Platform 委托凭据。probe body 最多 16 KiB、proof headers 合计最多 8 KiB、JSON 响应实际字节最多 64 KiB；总 deadline 5 秒覆盖 fetch 和整个 response body，超时取消响应流，即使对端忽略 signal 或 cancel hook 不结束也能返回失败。41 个单测覆盖恶意 URL、路径绕过、redirect、超限、延迟响应及凭据隔离。
- `tests/integration/cloudflare/portal-operator.test.mjs` 使用两个真实 workerd Worker 和 Service Binding，证明不可公网解析的请求 hostname 仍进入指定 Worker；未登记 URL、redirect 和过大响应被拒绝，传入 Portal 的用户凭据未被转发。尚无正式 Wrangler binding 配置；实际配置时再生成 Env。
- `portal-service/src/operators/discovery.ts` 复用协议 schema，拒绝未知字段、非登记 service identity、缺失/过期/弱配置 ETag、不一致类型声明及重复 revisions。对本次验证的文档类型要求所声明 revisions 已登记，其他类型不伪装成已验证；21 个业务测试通过。此函数只验证已解析 descriptor，不创建 successful validation row，原始 JSON 的歧义校验仍需在接线时复用严格解析器。
- Operator probe 当前仅有受控传输，不会把 HTTP 200 或任意 proof headers 当作签名成功。仓库 `service-auth/platform-hmac.ts` 固定使用 DocType 协议标识和 SValue content type，不能直接复用为 Operator JSON probe。Operator 的最终签名 wire format、回执/nonce 校验和双方服务身份验证仍须固定；本轮没有创建 probe 协议或更改旧服务。

- `packages/portal-service/src/identity.ts` 使用 `canonicalize@2.1.0` 与 Web Crypto SHA-256。入口拒绝非有限数字、非 JSON 值、循环引用和孤立 surrogate；不进行 Unicode normalization。测试固定 RFC 8785 序列化、UTF-16 属性顺序及空对象 SHA-256 向量。
- schema hash 为 `sha256:<lowercase hex>`；contract hash 的 canonical 输入固定为 `{ documentType, formatVersion, snapshot: { schema }, location: { schema } }`，不包含 idx、schema hash 或时间。ETag 为带双引号的 `sha256-<base64url>`，只排除资源顶层 `etag`。正式 service 仍须显式组装完整并发控制表示，不能把任意内部数据库行直接作为 ETag 输入。
- `tests/integration/cloudflare/portal-identity.test.mjs` 将同一实现以 browser target 打包到 workerd，对照 Node 结果；无需 Node crypto polyfill。
- `tests/integration/cloudflare/portal-d1-atomicity.test.mjs` 使用真实 Miniflare D1 binding：单个 `batch()` 中插入 actor/operation/key 唯一 receipt、条件更新计数器、插入 contract、audit 及最终 response。紧随条件 UPDATE 的 `changes()` 写入 `CHECK(valid = 1)` guard，让零行更新导致整批回滚。guard 行在同一 batch 内删除，不保留跨请求锁。
- D1 测试覆盖 24 路并发连续零基 idx、12 路同 key 重放、fingerprint 冲突、actor 隔离、旧 revision 竞争、重复内容、缺失类型及审计故障回滚。内存计数器不参与分配。内部 `last_idx = -1` 仅用于该 spike；公开未分配状态仍为 `null`。
- bundle 基础校验已覆盖原始路径穿越、绝对路径、反斜线、百分号编码、控制字符、URL query/fragment、非 NFC 路径以及 512 UTF-8 字节上限。ZIP 检查比较原始 UTF-8 文件名与库解析结果，不允许名称被静默重写。
- `portal-service/src/bundles/zip.ts` 使用 `@zip.js/zip.js@2.13.1`，严格目录/本地文件头校验、CRC 校验和重叠 entry 检查；禁止加密、symlink、非常规文件类型和非 Store/Deflate 方法。限制压缩输入 8 MiB、最多 512 个条目、单文件 4 MiB、解压总量 32 MiB、压缩比 100:1。预算只能收紧；同时校验声明大小与实际输出字节数。
- ZIP 中央目录需要随机访问，当前明确在 8 MiB 硬上限内暂存压缩输入，逐文件有界解压并计算 SHA-256；这不是任意大小的全流式 ingestion。更大的 bundle 应改为临时 R2 对象加 range reader，而非直接提高内存上限。当前函数只返回已验证文件清单和摘要，不写 R2、不发布 bundle。15 个真实 archive fixtures 覆盖重复路径、symlink、加密、文件/目录冲突、CRC 损坏、截断、目录/本地文件名冲突、伪造解压大小、zip bomb 和输入取消；workerd 实际验证 Deflate 与 CRC，无需 Web Worker。
- `portal-service/src/bundles/manifest.ts` 在同一 ZIP 扫描中读取最多 64 KiB 的根 manifest。复用协议 schema 并拒绝未知字段；通过 `jsonc-parser` 解析树拒绝重复 key（包括 Unicode 转义重名）、注释、尾随逗号和超深嵌套，严格 UTF-8 JSON 不接受 BOM。拒绝混合两种 bundle manifest、类型不匹配、缺少或空的引用文件、非规范路径。
- View 检查两个不同 `.html` 入口及非重复、已登记的 Document Contract revisions；Type Card 检查 `en` fallback、canonical BCP 47 locale、SVG/完整五尺寸 PNG 文件引用和 thumbnail 扩展名。此处只验证引用，不做图片解码、PNG 尺寸真实性、SVG/HTML/CSS 安全性或完整 MIME allowlist；测试中的部分图片是明确的 reference-only fixture，不能据此宣称 bundle 可安全发布。
- bundle `contentHash` 为 canonical `{ kind, manifest, files }` 的 SHA-256，`files` 按路径排序并包含非 manifest 资源的 path/size/sha256。ZIP 顺序、时间戳、manifest 空白和属性顺序不进入身份；资源字节/路径、manifest 字段变化会改变身份。返回 `canonicalManifest` 以及按 canonical 字节计算的 manifest 文件摘要；后续 R2 必须写入这些 canonical 字节，不能保留原始排版，否则同一身份会对应不同文件。内部逐文件回调不具备发布或事务语义。33 个 manifest 测试和 Node/workerd 一致性验证通过，尚未生成公开 bundle ID/URL 或持久化记录。
- `boundedBytes` 按实际 chunk 字节累计限制，超限或消费者提前退出时取消流并释放 reader；不依赖 Content-Length，不汇总整个 body。
- `portal-service/src/auth/administrator.ts` 固定 Google issuer、ASCII subject、已验证邮箱和近期认证策略。邮箱只 trim/lowercase，不合并 Gmail 点号或 `+tag`；绑定后以 issuer/subject 授权，不以邮箱匹配替代身份绑定。bootstrap 只允许显式配置的邮箱，并要求最近 300 秒内认证。
- `tests/integration/cloudflare/portal-membership.test.mjs` 验证 persistent singleton bootstrap marker、active email/identity 唯一索引、首次绑定及审计回滚、不可删除自身、邀请中的成员不能充当可登录管理员、互相移除的并发竞争及旧请求事务内再次授权。移除后重新邀请使用新 member ID，旧 session 不复活。
- 同一 D1 spike 还验证 session family 单次轮换、logout 撤销整个 family、logout/rotation 竞争不遗留后继 session、到期或成员失效禁止轮换、轮换审计失败保留旧 session，以及 browser-bound login state 的 TTL 和并发单次消费。这里的 SQL 仍是行为 spike，不是正式 repository 或公开 audit action 的扩展。
- `cloudflare-portal/src/auth.ts` 实现 JWT Bearer 与 session cookie 鉴权。Bearer 使用 `jose` 验证 RS256 签名、Google issuer、配置的 client audience、azp、exp/iat/nbf 与 `auth_time`；固定当前 Google JWKS URL，不读取 JWT 的动态 key URL。最大 token age 3600 秒、时钟容差 30 秒；JWKS 请求超时 5 秒，缓存 10 分钟、刷新冷却 30 秒。任何 Authorization header 的失败均不退回 cookie。
- session/CSRF 各使用独立 256-bit 随机值，持久记录只含 SHA-256 hash；session 绝对寿命 8 小时、不滑动续期。cookie 为 `__Host-unidocs_admin; Path=/; Secure; HttpOnly; SameSite=Lax`。每次读取 session 后重新查询有效成员；cookie mutation 必须同时匹配精确 Origin 与 CSRF hash，比较使用 `timingSafeEqual`。真实 D1/BFF 已接入登录替换 session 和 logout。
- `tests/integration/cloudflare/portal-auth.test.mjs` 以真实 RSA JWT 在 workerd 中验证 Bearer、cookie 和 CSRF，包括无 fallback；Cloudflare 鉴权模块使用 `node:crypto`，Worker 配置已启用 `nodejs_compat`，Env 已由 Wrangler 生成。生产认证资源和后台路由随后已部署，详见顶部最新记录。
- 按用户要求，Google auth 复用现有 Gateway 的 client ID、client secret 和 issuer。`cloudflare-portal/src/google-config.ts` 从 `GATEWAY_OIDC_CLIENT_ID`、`GATEWAY_OIDC_CLIENT_SECRET`、`GATEWAY_OIDC_ISSUER` 解析配置，缺少凭据或非 Google issuer 时拒绝。Portal origin 默认 `https://unidocs.shazhou.work`，测试可显式覆盖；redirect URI 固定为 `<Portal origin>/admin/auth/callback`，不读取 Gateway callback、session cookie 或 session encryption key。部署时将同源凭据配置到独立 Worker，不修改 Gateway 包，也不把 secret 发到浏览器。
- `cloudflare-portal/src/google-login.ts` 使用 `oauth4webapi` 完成登录启动及 authorization-code callback：S256 PKCE、独立 nonce、hashed state/browser cookie 绑定、600 秒 TTL、原子单次消费 port、返回路径校验、ID token 签名/issuer/audience/azp/nonce/时间校验。返回路径先解码再检查，拒绝跳出 `/admin/`、返回 auth 路由或编码绕过。Google discovery/token/JWKS 请求固定端点、禁止 redirect、超时 5 秒、响应最多 64 KiB，超过上限取消流。
- OIDC 模块在验证成功后返回身份与安全 return path，丢弃 Google access token；BFF 已接通管理员绑定、session 持久化和登录 cookie 清理。state 在 token exchange 前消费，失败后须重新登录，不能重放。模拟 Google 测试和 workerd 完整持久化登录流程通过，不等同于已联通真实 Google client。

Google OIDC 当前策略（用户已批准）：现有 Google client 保留 Gateway URI 并已追加 Portal callback。实际 Google token 未返回 `auth_time`，因此浏览器登录改用完成验证的 fresh authorization-code exchange 作为“近期登录确认”，不再发送 `max_age` 或 essential `auth_time` 请求。不证明 Google 刚要求密码/MFA，不用 `iat` 充当认证时间；若 token 带 `auth_time`，仍校验其类型/范围并单独保存。bootstrap、邀请绑定与 session 创建使用独立确认时间，Bearer 不获得此例外。复用 client 的 audience 不能区分 Gateway 与 Portal，必须继续检查 Portal 自身 issuer/subject 成员授权。将来若需要真正 step-up，须另行选择可验证的密码/MFA 方案。

验证命令：

```text
pnpm --filter @unidocs/portal-service test
pnpm --filter @unidocs/portal-service typecheck
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
pnpm --filter @unidocs/cloudflare-portal types:generate
pnpm --filter @unidocs/cloudflare-portal deploy:check
pnpm exec vitest run tests/integration/cloudflare/portal-auth-repository.test.mjs --fileParallelism=false
pnpm exec vitest run tests/integration/cloudflare/portal-operator.test.mjs --fileParallelism=false
pnpm exec vitest run tests/integration/cloudflare/portal-d1-atomicity.test.mjs tests/integration/cloudflare/portal-identity.test.mjs tests/integration/cloudflare/portal-membership.test.mjs tests/integration/cloudflare/portal-auth.test.mjs --fileParallelism=false
```

当前业务核 134 个测试、Cloudflare 包 107 个测试、真实认证 repository/BFF 12 个测试，以及此前 D1 原子写 6 个、管理员/session spike 12 个和 6 个跨运行时测试通过。根目录 Miniflare 锁定的 workerd 最高支持 `2026-08-18`，测试继续使用该日期；新 Wrangler 配置使用 `2026-09-10`，已通过类型生成和打包 dry-run，生产运行仍待验证。

上一轮仓库级验证：`pnpm typecheck`、Admin protocol 的 20 个测试、`pnpm check:cas-contract-docs`（69 份文档）及 `git diff --check` 通过。`pnpm test:local` 未通过：639 passed、40 failed、44 skipped，20 个测试文件失败。失败涉及未修改的 Gateway `cloudflare:workers` 打包解析、compute-CAS redirect 断言、PSD 字体脚本 Windows 路径断言，以及 `protocol-doctype`/`tenant-browser-cache` 的 workspace alias 缺项；这些模块本轮未修改，合并门禁仍未全绿。

Phase 0 剩余门禁（按第 5 节已确认的认证先行顺序，对应功能冻结 schema/发布前完成）：

1. 生产 D1、secret、bootstrap 配置与认证路由已部署，匿名 smoke 通过；等待用户真人登录验证 `auth_time`，不能提前放宽近期认证。
2. 认证 repository 已独立实现且通过 D1 集成测试，查询过滤 revoked family/无效成员；剩余管理员 CRUD、业务 API precondition/idempotency/audit 接线和过期 state/session 清理仍待完成。
3. ZIP 解析库、大小限制、manifest/引用校验与 canonical 内容身份已落地；继续验证目录条目、本地额外字段/编码歧义及资源预算。尚需 MIME allowlist、图片实际解码/尺寸、SVG 与执行资源安全策略、R2 reservation/cleanup 和稳定 URL；不能把 manifest/引用检查通过当作 bundle 上传完成。
4. 第一方 Operator Service Binding 的固定目标、防 redirect、全程超时/响应上限已验证；外部 Operator 网络出口及 DNS rebinding 防护仍未完成，不能退回任意 URL fetch。接下来固定签名 probe wire format、nonce/回执和服务身份验证、validation TTL 及 D1 原子记录；传输或 discovery 单独通过都不产生成功 validation。
5. 将 D1 spike 推进到正式模型时，验证成员授权条件也在写事务内、公开 ETag 对应的 SQL 并发条件、幂等 receipt 保留期与响应重放、失败分类和审计脱敏；不得把所有 D1 异常统一当作幂等冲突。

认证版已按用户授权完成线上切换；完整业务闭环与 R2 部署仍未完成，详见顶部上线记录。凭据仅在本地进程和 Worker secret 中传递。

## 1. 目标

在不修改现有 Gateway 包的前提下，实现 Admin Portal 的完整纵向闭环：

```text
@unidocs/admin-portal-webui
  -> @unidocs/admin-portal-client
  -> @unidocs/protocol-admin-portal

@unidocs/cloudflare-portal
  -> @unidocs/portal-service
  -> @unidocs/protocol-admin-portal
```

本期交付：

- `@unidocs/protocol-admin-portal` 中 26 个 Admin v1 operation 的真实实现；
- 文档类型、Document Contract、Type Card/View bundle、Operator、管理员与审计；
- Bearer 与同源 Admin session cookie 两套鉴权，mutation cookie 路径强制 CSRF；
- D1 权威数据、R2 不可变 bundle、Cloudflare Worker/BFF 和静态 WebUI；
- 与当前 Admin mock 对齐的真实 React WebUI；
- 本地 Cloudflare stack、迁移、集成测试与部署 smoke。

## 2. 明确不做

- 不创建 `@unidocs/tenant-portal-client` 或 `@unidocs/tenant-portal-webui`；
- 不创建 `@unidocs/azure-portal`，不设计 PostgreSQL/Blob adapter；
- `@unidocs/portal-service` 本期不依赖 `@unidocs/protocol-platform`；
- 不实现 tenant、document、version、thread、comment/reply、submission、CAS retain 或 Operator outbox；
- 不实现 View Host、View bundle runtime 或 thumbnail 生成服务；本期只验证和托管双入口 View bundle；
- 不迁移、不复用或重命名现有 `gateway-common`、`web-gateway`、`cloudflare-gateway`、`azure-gateway`；
- 不提供旧 Admin API 兼容层。

## 3. 实现前技术决策

以下决策按所属功能在冻结对应 D1 schema/发布前完成，并以测试固定。按第 5 节用户已确认的顺序，认证部分可先行独立 migration；bundle/Operator 的未决项不阻塞认证 schema，也不因认证先行而豁免。

1. 选择 Workers 与测试环境都可用的 RFC 8785 canonical JSON 实现，验证 ETag、schema hash 和 contract hash 测试向量。
2. 确定 D1 多行原子写与 `DocumentContractIdx` 分配策略，证明并发 append 不会重复 idx 或留下部分记录。
3. 确定管理员首次 bootstrap、OIDC issuer/subject 绑定、成员失效和最后一名管理员保护流程。
4. 确定 Admin Bearer 的 issuer、audience、JWKS 配置及 cookie session 有效期、轮换和撤销策略。
5. 确定 bundle 上传总大小、文件数量、单文件大小、解压后总大小、压缩比、路径长度和允许 MIME 列表。
6. 确定 Operator validation 的 SSRF、DNS rebinding、redirect、超时、响应大小、签名 probe 和 validation TTL 策略。

这一步只做最小 spike 和行为测试，不先搭建完整抽象。无法在 D1 中证明所需原子性的方案不得进入正式 repository 实现。

## 4. 包职责

### `@unidocs/portal-service`

云中立 Admin 业务核，不包含 Worker、D1、R2、OIDC callback 或静态资源逻辑。

建议结构：

```text
src/
  admin/          26 个 operation 的 application services
  bundles/        ZIP 安全校验、manifest 校验、内容身份
  operators/      validation 与持久候选项规则
  auth/           已认证 Admin context 与授权策略
  ports/          unit of work、bundle store、operator probe、clock、ID/hash
  http/           oRPC contract implementation 与错误映射
tests/
  admin/
  bundles/
  operators/
  contract/
```

业务 mutation、idempotency receipt 与 audit event 必须在同一 unit of work 中提交。R2 写入和 Operator 网络 probe 不伪装成数据库事务；需要跨请求状态时使用明确的 reservation/cleanup 流程。

### `@unidocs/cloudflare-portal`

唯一 Cloudflare 部署单元，拥有：

- Worker fetch 入口和 `/admin/api/v1/*` 路由；
- Admin OIDC/BFF、session cookie、CSRF 与 Bearer 验证；
- D1 schema、migration 与 repository adapter；
- R2 bundle store 和不可变 bundle ingress；
- Admin WebUI 静态 assets；
- 绑定类型生成、结构化日志与部署配置。

新项目使用 `wrangler.jsonc`，实现前从当前 Wrangler schema 和 Workers types 生成 `Env`，不手写 binding interface。大 ZIP 和 bundle 文件使用有界流式处理；请求状态不能保存在模块级可变变量中。

### `@unidocs/admin-portal-client`

薄 HTTP client，一项 contract operation 对应一个方法。client 持有 base URL 和 credential transport，负责：

- JSON、ZIP stream 与 query/path/header 编码；
- cookie mutation 的 CSRF、`Idempotency-Key` 和 `If-Match`；
- typed success response 与稳定的 typed API error；
- 不实现业务 workflow，不缓存资源，不自行计算 ETag。

### `@unidocs/admin-portal-webui`

纯浏览器 React/Vite 包，只依赖 Admin client，不直接依赖 service、D1、R2 或 Worker types。页面与当前 mock 对齐：文档类型、六个详情 tab、管理员和审计；所有数据来自真实 API。

Cloudflare 包只在构建阶段消费 WebUI 产物，浏览器包不反向依赖 Cloudflare adapter。

## 5. 分阶段交付

勾选规则：`[x]` 表示该项实现及对应验证已完成；`[ ]` 表示未完成，包含注明的部分完成项。模块或 spike 完成不等于已接入真实 handler、已部署或整个 Phase 已通过；目前所有 Phase 的退出条件仍未全部满足。

执行顺序更新（2026-09-10，用户已确认）：优先打通真实登录、D1 管理员与文档类型最小纵向闭环，允许认证部分独立冻结首份 migration，不再等待 bundle/Operator 所有决策。第 3 节及 Phase 0 剩余项继续作为对应功能的 schema/发布门禁，不因先行认证 migration 而视为完成。认证 migration、repository 和 BFF 已落地并完成本地集成验证；下一步是受控真实登录验收与文档类型首个业务闭环。

### Phase 0：技术 spike 与 contract fixtures

- [x] 为 canonical JSON、ETag、schema/contract hash 建立 Node/Workers 共享测试向量。
- [x] 用最小 D1 测试证明 append idx、conditional update、idempotency 与 audit 的原子性。
- [x] 固定 ZIP 首批 adversarial fixtures：路径、重复条目、symlink、CRC、截断、伪造大小、zip bomb 和取消行为。
- [x] 固定第一方 Operator Service Binding 的目标、redirect、超时、大小及凭据隔离 fixtures。
- [x] 用 D1 spike 验证 bootstrap、身份唯一绑定、成员移除、session 轮换/撤销和单次登录 state。
- [ ] 完成剩余安全 fixtures：ZIP 目录/额外字段歧义和外部 Operator SSRF；第一方签名 probe/receipt 已固定并通过真实 Service Binding 测试。
- [ ] 完成第 3 节全部六项技术决策；已验证结论已写入本计划，未决项见“Phase 0 剩余门禁”。

- [ ] **退出条件**：原子写、hash 一致性和安全限制都有可执行测试；没有未决项会改变对应功能 D1 主键或公开 contract。

### Phase 1：四个新包骨架与边界测试

- [x] 创建 `portal-service` 和 `cloudflare-portal`。
- [x] 为上述两包加入 workspace、TypeScript project references、build/test/typecheck/clean scripts。
- [x] 建立两包单元测试及 Miniflare/workerd 集成 test harness。
- [ ] 创建 `admin-portal-client`、`admin-portal-webui` 并完成 workspace、TS references 和 scripts 接线；两包及 build/test/typecheck scripts 已创建，根 TS project references 与专门依赖边界测试待补。
- [ ] 以边界测试固定依赖方向，禁止新包依赖旧 Gateway 或 Azure 包；当前实现未引入这些依赖，但尚无专门边界测试。
- [x] 建立正式认证 Worker 入口、生成 Env、Wrangler 本地配置和打包 dry-run 检查。
- [ ] 建立 client 和 WebUI test harness。

- [ ] **退出条件**：四包空实现可 build/typecheck，边界测试能对错误依赖失败。

### Phase 2：Admin service 基础语义

- [x] 实现已认证 Admin context、Google 身份绑定及近期认证策略。
- [x] 实现 canonical resource representation 的强 ETag 计算与测试。
- [ ] 实现统一 HTTP 错误映射、request ID、cursor、clock 和 ID ports；当前仅有模块级错误及部分注入式时钟。
- [x] 在文档类型创建实现正式 idempotency fingerprint/receipt、原子审计与回滚，D1/HTTP 并发测试通过。
- [ ] 实现正式 `If-Match` 与其余 mutation 的统一幂等/audit unit of work；创建用例不替代全量基础设施。
- [ ] 实现 audit redaction 和 mutation-with-audit unit of work；当前原子回滚仅在 spike 中验证。
- [ ] 用内存测试 adapter 驱动完整 cloud-neutral mutation 行为测试。

- [ ] **退出条件**：正式 service 的并发条件失败、幂等重放/冲突、事务回滚和审计脱敏均有测试。

### Phase 3：文档类型与 Document Contract

- 当前进度：本 Phase 6/7 个 operation、全部 Admin v1 15/26 个 operation 已上线。
- [x] 实现并上线 register/list/get document type，使用真实 service/D1/oRPC handler，涵盖鉴权、CSRF、幂等、审计及筛选分页。
- [ ] 实现 PATCH document type，包括并发 If-Match、候选绑定及启用条件。
- [x] 实现 paired contract append/list/get，涵盖真实 service/D1/oRPC/client/WebUI、零基并发分配、幂等、原子审计和刷新恢复。
- [x] 实现 schema/paired contract canonical hash 及测试。
- [x] 在真实 append 服务中接入 SValue dialect、零基 idx、append-only 校验与 canonical hashes。
- [ ] 实现 View/Operator contract 支持交集与 enable 前置条件。

- [ ] **退出条件**：相关 7 个 operation 通过 contract、领域和并发测试。

### Phase 4：Type Card 与 View bundle

- 当前进度：Type Card 4/4、View bundle 4/4 均已上线，Phase 合计 8/8。
- [x] 实现有界 ZIP 扫描、zip-slip/zip-bomb/重复路径防护；当前压缩输入最多暂存 8 MiB，不是无限大小流式 ingestion。
- [x] 校验 Type Card manifest、canonical locale、图标五尺寸文件引用和 sample thumbnail 引用。
- [x] 校验 Type Card 图标/thumbnail 的真实 PNG/JPEG/WebP 内容、像素尺寸及 SVG 安全性。
- [x] 校验 View 的不同 `interactive`/`thumbnail` 入口、规范路径、文件存在性与已登记 revisions。
- [x] 校验 MIME allowlist、HTML/JS/CSS 及资源加载安全策略；Type Card 与 View 均由隔离 ingress 固定 MIME/CSP，View 子资源限制在单个 immutable bundle 根路径。
- [x] 计算 canonical manifest 与资源文件清单的内容身份，验证 Node/Workers 一致性。
- [ ] 建立 R2 reservation/cleanup，写入不可变对象并持久化 canonical `bundleUrl`；Type Card reservation/write/publish 已完成，过期 reservation 与孤儿对象 GC 尚待实现。
- [x] 实现并上线两类 bundle 的 upload/list/get/metadata patch。

- [ ] **退出条件**：8 个 bundle operation 通过；重复内容、失败清理、不可变缓存 header 和恶意 ZIP fixtures 通过。

### Phase 5：Operator、管理员与审计

- [x] 实现 Operator discovery descriptor 的 identity、配置 ETag、类型声明和 revisions 业务校验。
- [x] 验证第一方 Service Binding 受控传输与完整 I/O deadline；当前为未接入 handler 的实现切片。
- [ ] 实现 Operator validation 与 candidate creation；第一方 Markdown validation 与持久 candidate 已在本地完成，外部 Operator 受控出口尚待实现。
- [x] 实现 Operator list/get/metadata patch。
- [x] 实现管理员 bootstrap/list/get/add/remove 的真实 application service 与 adapter。
- [x] 在真实成员 mutation 中实现不可删除自身/最后管理员约束，并以真实 D1 并发互删测试固定。
- [x] 实现可过滤、稳定 cursor 分页的 Admin audit，并接入真实 D1、HTTP、client 与 WebUI 详情。

- [ ] **退出条件**：剩余 11 个 operation 通过；SSRF、过期 validation、成员竞态和审计过滤测试通过，26 个 operation 全部有真实 handler。

### Phase 6：Cloudflare adapter 与认证入口

- [x] 建立认证部分 D1 migration 和 repository adapter，并通过真实 D1 集成测试。
- [ ] 建立其余 Admin 业务 D1 migrations 和 repository adapter；document type、Document Contract、Type Card、View bundle、管理员、audit 与 Operator validation 已接入，持久 Operator candidate 尚待实现。
- [x] 建立 R2 adapter、bundle ingress 与独立稳定 bundle origin；Type Card/View adapter 与 ingress 已上线，custom domain 的 DNS/TLS/404 smoke 已通过，真实 View 对象等待首次人工上传验收。
- [x] 实现 Bearer 优先且失败不 fallback cookie，并通过 Node/workerd 测试。
- [x] 复用 Gateway Google client 配置，固定 Portal origin 和独立 callback；用户已确认回调登记完成。
- [x] 实现 OIDC authorization code + PKCE、nonce、浏览器绑定和单次 state port，并通过模拟 Google/workerd 测试。
- [x] 实现公开登录提示页、Google `prompt=select_account`、浏览器授权拒绝页、幂等 logout 与陈旧 callback 页面无闪烁恢复。
- [x] 实现 hashed session、`__Host-` cookie、CSRF 和逐请求成员有效性鉴权模块。
- [x] 接通 D1 state 消费、bootstrap/绑定、session family 创建与撤销、BFF logout；同一管理员可保留多个独立的 8 小时 session，重新登录不撤销其他会话，logout 只撤销当前 family，移除管理员仍撤销该成员全部会话。成功登录会清理过期 session 与无 session 的 family。
- [ ] 完成过期登录 state、session 和撤销 family 的有界清理任务。
- [x] 根据真人失败证据和用户批准，实施独立授权码登录确认时间，不伪造 Google auth_time；保持 Bearer 策略不变。
- [x] 用户已验收新策略下真实 Google 登录成功；记录本地登录确认，不声称近期密码/MFA 验证。
- [x] 通过正式 Worker adapter 暴露 document type create/list/get 三个 oRPC/OpenAPI handler，限制同源 cookie 访问并设置安全 headers。
- [x] 通过正式 Worker adapter 暴露 administrator list/get/add/remove 四个 oRPC/OpenAPI handler，涵盖 CSRF、ETag、幂等、重复邮箱冲突、成员保护和原子审计/session 撤销。
- [x] 通过正式 Worker adapter 暴露 Admin audit list handler，涵盖筛选绑定 cursor、同秒复合分页和 schema 校验。
- [x] 通过正式 Worker adapter 暴露 Document Contract append/list/get 三个 handler，涵盖严格 JSON、并发 idx、幂等和原子 registration/audit 更新。
- [x] 暴露全部 26 个 contract handler；整体 CORS/OpenAPI surface 验证仍作为 Phase 6 退出门禁。
- [x] 生成 Worker binding types 并配置结构化 observability；生产日志采集仍随部署验收。

- [ ] **退出条件**：Miniflare/Worker 集成测试覆盖两种鉴权、全部 mutation precondition、D1 migration 和 R2 round trip。

### Phase 7：Admin client 与真实 WebUI

- [ ] 完成 26-operation typed client 与 transport tests；当前覆盖 session/logout、document type create/list/get/update、Document Contract append/list/get、Type Card/View bundle upload/list/get/metadata patch、administrator list/get/add/remove 与 audit list transport。
- [x] 将 mock 视觉与交互迁移到真实数据驱动的 React 页面；六 tab 文档类型配置、Document Contract、Type Card、View bundle、Operator、管理员和 audit 均接入真实 API。
- [ ] 实现 loading、empty、error、401/session expiry、409、412、428 和上传进度状态；MVP 已有通用状态、Type Card upload/metadata mutation 状态与稳定错误展示，细粒度上传进度和全部冲突恢复待实现。
- [x] bundle 详情明确展示 interactive/thumbnail 两个入口。
- [ ] 保留键盘操作、焦点恢复、移动端无重叠和基本可访问性；MVP 已验证桌面/移动端无横向溢出及移动详情关闭控件，完整键盘/焦点验收待补。
- [x] 建立 refresh-safe 前端路由；page/detail/tab URL、Worker 鉴权 shell fallback、刷新和前进/后退已通过测试及生产浏览器验收。

- [ ] **退出条件**：组件测试覆盖主要 workflow；浏览器中可完成类型创建、contract append、bundle 上传/绑定、Operator 配置、启用、成员管理与审计查询。

### Phase 8：Stack、部署与发布门禁

- [x] 增加 Portal 认证无路由部署预检和真实打包 dry-run；校验独立 D1、配置要求与旧认证冲突，不执行线上变更。
- [x] 获取现有 Google client 的本地凭据来源，并取得用户直接切换旧后台的授权。
- [x] 部署独立 Portal D1、远端认证 migration、Google secret 与认证版 Worker，切换 `/admin`、`/admin/*`；匿名 smoke 通过。
- [x] 记录认证路由回退方式，保留 Gateway 原 OAuth 与文档 API；回退尚未实际演练。
- [x] 在 `stacks/unidocs-cloudflare` 增加 Portal 认证部署预检和边界测试；生产发布目前仍由显式 Wrangler 命令执行。
- [ ] 将 Portal migration/deploy/smoke 接入统一 stack runner，保持默认 Gateway 发布序列不误触 Portal。
- [x] 配置并部署独立 Worker 名和 D1，复用 `unidocs.shazhou.work`；未替换 Gateway Worker，独立 Portal R2 已绑定。
- [x] 配置独立 R2 与 bundle origin；bucket、binding、custom-domain trigger 和独立 hostname DNS/TLS/404 smoke 已通过，真实对象 fetch 等待首次人工上传验收。
- [x] 确认并执行 `/admin`、`/admin/*` 切换，验证主站、`/ui/` 与旧 OAuth discovery 保留。
- [ ] 实际演练旧后台路由回退；已有无数据删除的书面步骤。
- [x] smoke 覆盖匿名登录提示、显式 Google 账号选择、匿名 API 拒绝、授权拒绝 UI、幂等 logout、真实 Google 登录和 session 读取。
- [ ] smoke 覆盖一次经 client 发起的幂等 mutation、bundle fetch 和 audit correlation；workerd 已覆盖 mutation，但未用生产用户 cookie 自动写数据。
- [ ] 记录 rollback：Worker 版本回退、向前兼容 migration、不可变 R2 对象保留。

- [ ] **退出条件**：全新环境可部署、smoke 通过、旧 Gateway stack 不受影响。

## 6. 验证命令

每阶段至少运行触及包的 focused checks：

```text
pnpm --filter @unidocs/protocol-admin-portal test
pnpm --filter @unidocs/portal-service test
pnpm --filter @unidocs/portal-service typecheck
pnpm --filter @unidocs/cloudflare-portal test
pnpm --filter @unidocs/cloudflare-portal typecheck
pnpm --filter @unidocs/admin-portal-client test
pnpm --filter @unidocs/admin-portal-client typecheck
pnpm --filter @unidocs/admin-portal-webui test
pnpm --filter @unidocs/admin-portal-webui typecheck
```

合并前门禁：

```text
pnpm typecheck
pnpm test:local
pnpm check:cas-contract-docs
git diff --check
```

WebUI 完成后还需用 Playwright 在桌面与移动 viewport 验证主要 workflow、无文本溢出/遮挡，并检查浏览器 console。Cloudflare 配置与实现时重新查询当前 Workers 文档、Wrangler schema 和生成的 binding types，不依赖计划编写时的 SDK 记忆。

## 7. 完成定义

- `@unidocs/protocol-admin-portal` 的 26 个 operation 全部由 Cloudflare deployment 实现；
- Admin WebUI 不含 mock data，所有 mutation 都遵守 CSRF、idempotency 与 ETag；
- D1 是 Admin 关系状态唯一权威，R2 只存不可变 bundle 内容；
- audit 与业务 mutation 保持原子，日志和错误不泄漏 token、cookie、CSRF 或 bundle 原始内容；
- bundle URL 与内容身份稳定，View 双入口均经过上传验证并可从 ingress 获取；
- 新 Portal 可独立部署和回退，现有 Gateway、Azure、Tenant Portal 不发生行为变化。
