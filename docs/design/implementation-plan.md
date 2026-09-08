# UniDocs 统一 WebUI 实施计划

方向更新（2026-09-08）：下一阶段按 [Platform 与 Markdown 新协议接入计划](platform-markdown-integration-plan.md) 推进。持久化归 platform，计算 editor/operator 解耦，前端包平台托管；本文件保留旧 UI 阶段规划，不再作为新服务职责和首个闭环范围的依据。

日期：2026-09-07。状态：P0 进行中；P1 可信嵌入未启动，P2/P3 的非 iframe 早期切片已交付，完整阶段 gate 尚未通过。进度核对至 [Iteration 09 第八切片](iteration-09.md)，区分已部署能力与未部署实现。

可见交付：[Iteration 01](iteration-01.md) 已上线真实 PSD 引擎本地试验页；不代表 P1 iframe 协议或 P2 真实云端保存已完成。

本地草稿交付：[Iteration 02](iteration-02.md) 增加 IndexedDB 本地版本／草稿／未知候选恢复及多页面 revision 保护，已发布；仅验证公开样例，不视为用户隔离、完整协议 checkpoint 或云端恢复 gate 已完成。

后续小迭代：[Iteration 03](iteration-03.md) 已部署登录后的 Markdown／PSD 只读页面；API 替身与真实渲染验证通过，生产账号验收待完成，未开放云端写入或完成 iframe 协议。

目录迭代：[Iteration 04](iteration-04.md) 已部署统一云端列表、类型过滤、ID 搜索／排序及总创建入口。标题、tag、真实缩略图和服务端分页仍待实现，不视为 P3 全部完成。前三轮与设计成果已正常合并到远程 main。

创建与恢复：[Iteration 05](iteration-05.md) 至 [Iteration 07](iteration-07.md) 已部署 Markdown／PSD 导入、同请求重试、创建状态手动核实及按身份隔离的标签页跟踪。第 07 轮生产目录 23 件作品及 Markdown 抽查通过；生产 PSD 和真实创建恢复尚未完整验收。

最新线上交付：[Iteration 08](iteration-08.md) 已部署 Markdown 源码／安全预览双栏、固定基准草稿、返回预览保留草稿、确认丢弃及身份隔离的标签页恢复。不是 IndexedDB 多实例 checkpoint，不开放云端保存。

当前开发：[Iteration 09](iteration-09.md) 在默认关闭的 Cloudflare Markdown 实验模式下实现持久意图、receipt、独立核实／恢复与单调目录同步，八个异常窗口验证通过并修复提交后旧缓存问题；未部署。Azure 持久提交、实际硬崩溃与容量／保留策略、WebUI 保存仍未完成。

依据：[产品与 mock 约定](README.md)、[Editor Host Protocol v0](editor-host-protocol-v0.md)、[交互原型](unidocs-mock.html)。实施时按阶段推进，完成验收后再扩大范围。

部署更新：用户已授权用新 WebUI 直接覆盖 `https://unidocs.shazhou.work` 的旧界面，不要求保留旧页面或双入口灰度。授权不包含删除作品数据、清空存储或重置 OAuth/API。Iteration 01 已通过本机 `cfg` 注入部署凭据后发布，凭据未打印、未写入仓库或前端 bundle，部署后已清理终端环境；发布证据见本轮记录。

迭代更新：每次只交付一个小的可验收流程。第一批可见效果是基于真实 PSD 引擎与草稿适配器的试验页面，不必等待完整 P0/P7；明确区分本地模拟提交和真实后端写入。首个可运行界面通过构建、浏览器与资源检查后即可覆盖发布，历史版本和未知提交等缺口用禁用状态表达，不伪装成功。

## 1. 实施目标与范围

第一目标不是把静态 mock 改成 React，而是完成一条真实、可靠的创作流程：

用户创建 Markdown → 外部 Agent 修改 → 用户预览并批注 → Agent 读取已提交反馈、修改并回复 → 用户验收；同一宿主能够打开 PSD，并将其固定版本渲染图引用到 Markdown。

### 本轮建议范围

- 统一作品入口、类型创建、关键词／类型／tag 筛选，不引入文件夹、作品集或作品级审阅状态。
- 统一宿主与 doctype iframe；Markdown 双栏、PSD 画布／图层保持各自编辑体验。
- 固定版本预览、乐观锁保存、草稿恢复、Agent 更新提示与有条件自动刷新。
- 版本锚定批注、私有草稿、集中提交、回复、解决状态和定位链接。
- Markdown→Markdown 链接／摘要、PSD→Markdown 固定版本图片引用及主动更新。
- PSD 先复用已有渲染和图层能力，开放经过 bridge 验证的文本、位置、显隐编辑；不扩展特效或绘图工具。
- 桌面、平板；手机先提示使用电脑或平板。
- 单个用户自己的作品，不新增外部分享。外部 Agent 通过已有用户授权入口访问，不内置 Agent 聊天或执行引擎。

### 暂不包含

字符级多人协同、跨端实时草稿同步、自动合并冲突、第三方插件市场、任意外部编辑器注册、全局语义检索引擎、图谱页面、Office／视频新类型、完整 PSD 兼容改造。

PSD 在正式 MVP 中的最小开放能力以 P0 兼容性结论为准。若编辑桥接成本超出本轮范围，可先开放 PSD 预览／分层查看／批注／引用，编辑仍留在原页面；这是需要确认的范围变更，不能默认悄悄降级。

## 2. 已有代码与复用边界

| 已检查入口 | 事实及实施含义 |
| --- | --- |
| [web-gateway/package.json](../../packages/web-gateway/package.json) | React 19、Vite、Vitest、Testing Library、lucide-react；优先在现有 WebUI 上承载宿主，不新建平行主产品 |
| [web-gateway/src/ui](../../packages/web-gateway/src/ui) | 已有 api、oauth、router、app 和 views；实施前逐个确认可复用点，不假设当前导航结构已符合 mock |
| [web-psd/package.json](../../packages/web-psd/package.json) | React 19、Vite、Vitest，依赖 psd-client；复用真实能力，不把 mock 的 JSON 图层渲染器搬进生产 |
| [PSD 控制器](../../packages/web-psd/src/doc-controller.ts) | 使用本地 Worker 增量渲染；DocSession 管理自动提交队列和 rebase。与 v0 显式保存存在实质差异，需单独适配 |
| 同一 PSD 控制器 | 当前入口包含固定 USER/API_BASE_URL 与浏览器 CAS 读取构造；嵌入模式必须从宿主获取身份上下文与受限 transport，不能沿用硬编码身份或直连方式 |
| [protocol-doc HTTP 契约](../../packages/protocol-doc/src/http.ts) | 可复用 apply/baseVersion/opId、history、snapshot 的契约基础；历史读取与持久去重不能仅凭字段存在认定可用 |
| [pnpm workspace](../../pnpm-workspace.yaml) | packages/* 自动纳入 workspace；不需要另建仓库 |
| [mock](unidocs-mock.html) | 作为交互和视觉验收参照，保留其独立性；localStorage 样例数据不是迁移到生产的数据源 |

以上是局部证据，不是全面代码审计。P0 必须补充注册实现、Markdown 操作、PSD DocSession、两种部署适配器和对应测试的证据。

### 建议包划分

下面的新包名为建议，P0 检查命名后确定，暂不创建：

- `packages/protocol-editor`：消息 schema、类型、能力及版本规则。纯协议，不依赖 React 或 DOM。
- `packages/editor-bridge`：宿主／编辑器两侧 MessageChannel runtime、超时、上下文检查、受限 transport 接口；不理解 Markdown 或 PSD 数据结构。
- `packages/web-gateway`：宿主状态机、UI、授权、草稿／提交记录、doctype 加载、批注与引用选择器。
- `packages/web-markdown`：新增类型专用 WebUI，或在 P0 找到合适的现有 Markdown UI 后复用；不重复实现 Markdown 解析器。
- `packages/web-psd` 与 `packages/psd-client`：独立／嵌入入口适配，按需拆出提交 transport 和草稿模式，保留现有独立模式兼容性。
- `packages/protocol-gateway`、`packages/protocol-doc` 及其 owner 实现：承载新增服务端契约；通用评论元数据不散落到每个编辑器中。

不提前建立大型插件 SDK。两种编辑器出现的实际共性再进入 bridge；类型专用 operations、selector、资源解析留在 doctype adapter。

## 3. 阶段与依赖

| 阶段 | 可见产物 | 依赖 |
| --- | --- | --- |
| P0 契约与兼容性验证 | 后端能力矩阵、PSD 提交适配结论、收敛后的协议 | 无 |
| P1 可信嵌入基础 | 双 origin 宿主与测试编辑器，可靠消息和草稿状态机 | P0 的边界决定 |
| P2 Markdown 真实闭环 | 登录→创建→编辑→保存→Agent 更新→冲突恢复 | P1 + P0 的读取／提交能力 |
| P3 跨类型作品工作台 | 已确认的首页、真实元数据与类型发现 | P2；UI 可在 P1 后先开发但不能以样例冒充完成 |
| P4 审阅与 Agent 反馈 | 批注草稿→批量提交→Agent 回复→原版本定位 | P2 + 评论权限／历史读取 |
| P5 PSD 嵌入适配 | 真实 PSD 预览、分层查看、批注与最小编辑 | P1/P2；批注验收依赖 P4 |
| P6 跨类型引用 | 固定版本 PSD 图片插入 Markdown，提示并确认更新 | P3/P5 + 版本资源保留／授权 |
| P7 试用与发布 | 部署验证、兼容入口、可恢复灰度发布 | P3–P6 |

关键路径：可信 bridge → 真实 Markdown 写入与恢复 → 版本锚定反馈／PSD 适配 → 固定版本跨类型引用 → 内部试用。

允许独立开发的内容：P0 后，服务端能力补齐与 P1 测试宿主可以分开推进；P2 稳定后，P4 评论服务与 P5 PSD 可分别实现。此处只描述任务依赖，不自动启动并行代理或多人任务。

## 4. 分阶段工作与验收

勾选规则：`[x]` 表示条目所述范围已有实现／验证，或明确属于已完成的设计决定；不自动代表已部署或整个阶段验收通过。混合条目拆开已完成与待完成部分，部分完成项仍为 `[ ]`，证据与限制见对应迭代记录。

### P0：消除会改变架构的未知项

- [x] 将 protocol v0 用例映射到真实入口及已有测试，记录 supported / needs adapter / missing / incompatible，附文件与测试证据。见 [P0 能力矩阵](p0-capability-matrix.md)；初始矩阵的历史状态由后续迭代更新补充，不等于所列缺口已补齐。
- [ ] 验证指定版本内容、图片资源与标题摘要能否读取；若依赖重放历史，明确复杂度与一致性，不能拿最新内容替代。
- [x] 验证 opId 去重范围、持久化、相同 ID 不同载荷、超时结果核实；提出缺失能力的最小后端补丁与测试。共享 session 特征测试及 [第 09 轮](iteration-09.md) Cloudflare 实验实现／故障测试已有证据；本条完成的是能力核实与补丁方案，不是跨云上线。
- [ ] 补齐跨云持久 receipt 实现与发布验收。Cloudflare Markdown 实验路径已接通；Azure 当前明确拒绝新模式，尚未实现持久提交。
- [ ] 明确预览与引用依赖版本的保留／清理规则。已有 CAS 能力优先复用，不在本轮重构 UniCAS；需要改动其边界时另审设计。
- [ ] 检查 PSD DocSession 的自动提交、队列恢复、rebase 与渲染依赖。做最小验证：嵌入草稿编辑不触发网络 apply，显式保存仅提交一次。
- [x] 确定宿主是嵌入模式唯一提交负责人；不得同时启用 DocSession 后台写入和 H 的 prepareCommit/apply。独立模式行为保留并有回归测试。见 [P0 提交负责人结论](p0-capability-matrix.md#41-psd-单一提交负责人) 与 EditorDraft／DocSession 测试；这是已选设计及本地适配证据，真实 iframe bridge 仍待实现。
- [x] 明确评论草稿存储：MVP 私有未提交意见放宿主本地持久库，集中提交后才进入服务端反馈。此为已选实施边界，存储尚未实现；若要求服务端草稿，需要区分用户与 Agent 的 endpoint/scope，不能仅靠共享 JWT 的 sub 隔离。
- [ ] 草稿本地持久化建议使用 IndexedDB，按真实身份、文档和 draftId 分区；提交意图写入成功后才允许 apply。跨设备恢复不在本期承诺内。

P0 部分进度：PSD 本地 EditorDraft 已绕开自动提交器，真实引擎本地 studio 已交付；但真实 Worker／bridge／云端显式单次提交的组合验证仍缺失。第 08 轮 Markdown 草稿仅使用 sessionStorage，第 09 轮 SQLite journal 是服务端意图日志，两者都不能替代上述宿主 IndexedDB checkpoint。
- [ ] 检查现有注册与部署，定义受批准 editor descriptor 的写入权、读接口、origin 与 build 版本约束。
- [ ] 收敛 protocol v0 仍抽象的 schema：initialize/leave/access、取消选择、资源分块、pending 恢复与候选去重；以可执行 schema 取代仅靠文字解释。

完成标准：历史读取、提交核实、PSD 单一写入 owner 和评论草稿隐私都有可执行决定。先列明不支持的能力及用户可见降级，再决定是否调整范围；不得以“后面再补”带入 P2。

### P1：协议、bridge 与独立 origin 验证

- [ ] 创建协议模块、运行时 schema 及方向权限表，复用现有 SValue 编码，不随意 JSON 化二进制。
- [ ] 实现 hello/connect/initialize、MessagePort 绑定、origin/source/nonce 校验、instance/context/request ID 生命周期。
- [ ] 实现读取 handle 注册表、范围校验、超时／取消、payload 上限、销毁及迟到消息处理；bridge 不提供任意 URL 代理。
- [ ] 实现宿主 head/view/baseVersion 与 dirty/pending 状态机、编辑器 checkpoint/candidate 状态机。
- [ ] 用不同 localhost 端口运行宿主与测试 iframe，以 fake backend 注入冲突、延迟、断线、权限失效；开发 proxy 不把信任边界抹成同源。
- [ ] 实现 IndexedDB checkpoint／提交意图适配器及配额失败、序号倒序与恢复测试。

完成标准：通过握手拒绝、旧消息隔离、保存候选幂等、ACK 前不显示已保存、iframe 崩溃恢复、unknown 状态不重复提交等测试。测试替身只证明 bridge，不代表真实服务已通过。

### P2：第一条真实 Markdown 创作闭环

- [x] 在 web-gateway 接入作品列表与预览路由，替换旧页面入口；公开链接使用 docId，不暴露 sessionId，保留现有 API/OAuth 路由。见 [第 03–04 轮](iteration-04.md)。
- [ ] 将作品内容区接入受控 iframe，按获批准的 descriptor 加载编辑器；用户 JWT、内部 token 和 CAS 广域凭据不进入 iframe。
- [x] 接入既有登录／tenant 上下文、刷新会话与失效返回登录，按真实身份隔离创建跟踪与 Markdown 草稿。见 [第 05 轮](iteration-05.md)、[第 07 轮](iteration-07.md)、[第 08 轮](iteration-08.md)；iframe 鉴权代理未实现。
- [x] Markdown 默认预览，进入编辑后使用源码／安全预览双栏，复用 Marked／DOMPurify。第 08 轮已部署，当前源码输入为 textarea，不是完整 embedded editor。
- [ ] 建立 Markdown embedded entry，完成成熟编辑器选型、中文输入法和选区锚定验证。
- [x] 在非 iframe Markdown 页面固定编辑基准正文／版本，返回云端预览保留草稿，支持确认丢弃、标签页刷新恢复、身份隔离、退出清理和存储失败提示；云端新版本不覆盖原草稿基准。见 [第 08 轮](iteration-08.md)。
- [ ] 实现确切版本读取、实际渲染 ACK、进入编辑、显式保存、操作候选到 doctype operations 的转换。
- [ ] 接入真实 baseVersion/opId；冲突保留草稿；超时核实原操作，不通过生成新 opId 盲重试。
- [ ] 外部更新先通过可取消的 status 轮询实现：页面可见时约 3–5 秒、退避与恢复核实，后续再接已有推送或 SSE。dirty、固定版本、批注交互中不自动替换。
- [ ] 验证导航保护、刷新恢复、重新认证、只读降级、下载当前确切版本。

P2 部分进度：第 09 轮后端已实现默认关闭的 Cloudflare Markdown receipt、核实／恢复、旧写互斥与目录同步；WebUI 尚未发起云端保存。当前读取只保证响应自带的实际版本，不提供任意历史版本。完整导航保护、重新认证后的 pending 接续、iframe ACK 与自动更新仍待完成。

完成标准：外部 Agent/API 修改真实文档，宿主能发现更新；人在旧 baseVersion 上提交被拒绝且草稿可恢复。服务端已提交但客户端断线后，恢复不会重复 apply。

这是第一个可演示里程碑。它只有最小作品入口，不等待首页所有视觉细节完成。

### P3：统一作品工作台与真实发现

- [ ] 将 mock 的布局、圆章笔尖 logo、类型标签、纯色缩略图背景、MD 叠页和 PSD 阴影转为产品组件／静态资源；不依赖公共 CDN 运行生产代码。
- [x] 使用真实跨类型目录列表，支持类型过滤、已加载目录的 ID 搜索、排序及空／错误／加载状态；提供统一新建入口和 ready／creating 反馈。见 [第 04 轮](iteration-04.md)。
- [x] 支持 Markdown／PSD 导入、同请求重试及幂等键、手动核实创建状态、按身份隔离的标签页待完成跟踪；恢复不自动创建或查询。见 [第 05–07 轮](iteration-07.md)。
- [ ] 补齐标题／tag 元数据、服务端分页及完整检索能力。
- [x] 按 docType 请求目录元数据并在工作台聚合，列表筛选不读取每件作品正文。见 [第 04 轮](iteration-04.md) 与 workspace-documents 测试。
- [ ] 定义服务端跨类型聚合与分页语义，保证分页不漏项／重复；当前客户端聚合已返回结果不等于完整分页实现。
- [x] 明确并展示当前搜索仅为已加载目录 ID 搜索，不声称支持标题／tag／正文全文搜索。见 [第 04 轮边界](iteration-04.md)。
- [ ] 建立标题／tag 搜索及全文索引的权限过滤、更新／删除策略，再开放对应搜索能力。
- [ ] 建立按 docId+version+rendererBuild 缓存的缩略图读取；鉴权先于缓存返回，旧缩略图不得混到最新版本。首屏只加载可见项目。
- [ ] 创建入口由有效能力描述驱动；不硬编码 Markdown 主入口，不显示尚不支持的类型为可创建。
- [x] 定义云端作品列表／预览统一导航链接，不携带 token；手机初始提示页不加载编辑器正文或云端内容资源。见 [第 04 轮](iteration-04.md)、[第 08 轮](iteration-08.md) 的路由及手机测试；批注／版本引用定位链接尚属 P4/P6。

P3 部分进度：已沿用圆章 logo、侧栏、类型色标及紧凑工具栏；MD 叠页／真实缩略图卡片尚未实现，不勾选完整视觉条目。创建类型仍来自现有配置，不是动态有效能力 descriptor，因此能力驱动创建条目仍未完成。

完成标准：有真实 Markdown／PSD 时可混合浏览与筛选，分页不漏项／重复；加载列表不读取每件作品全文。按所发布的搜索范围验收，不能用样例数据代替后端验证。

### P4：版本锚定反馈与外部 Agent

- [ ] 定义反馈模型：FeedbackBatch、CommentThread、Reply、Anchor、解决状态；不新增作品业务状态。
- [ ] 实现已提交反馈的服务端存储与 Gateway 公开接口；确定本地私有草稿或服务端隔离方案后落实批量幂等发布。
- [ ] 集中提交必须是整体发布或具备可核实的提交事务，不允许前半批可见、后半批丢失。
- [ ] 完成 Markdown selector schema，验证 UTF-16 范围、中文、emoji、渲染文本与源码映射；无稳定 blockId 时使用诚实的版本内定位策略。
- [ ] 实现 compose/set/focus/activated；选区开始即阻止自动刷新，显示 marker 必须与 viewVersion 一致。
- [ ] 实现反馈和单条批注链接、回复／解决／过滤、跨版本定位、无法定位时的明确状态。
- [ ] 在现有 API/MCP 的合适入口提供读取已提交反馈和回复能力；若暂无相关 MCP owner，先形成独立小任务，不把协议方法当作 Agent API。

完成标准：真人写三条私有草稿，Agent 不能读取；一次提交后 Agent 可读取并逐条回复，用户可定位原版本。401/403 与越权文档、重复批量提交均有测试。

### P5：真实 PSD 嵌入与最小编辑

- [ ] web-psd 增加 embedded entry，不重复宿主头栏、身份入口和讨论列表；独立入口仍正常运行。
- [ ] 复用 Worker 渲染、图层模型和视口；替换固定 USER/API_BASE_URL 依赖，提供宿主 handle 驱动的资源读取适配器。
- [ ] 解决 Worker 与主线程资源请求、传输大小、取消和缓存；不通过 bridge 反复传输完整 PSD 或每次改动的整张渲染图。
- [ ] 按 P0 方案实现本地草稿模式和 prepareCommit，保留原 baseVersion；嵌入模式不运行自动提交和自动 rebase。
- [ ] 接入图层预览显隐、solo、原始显示恢复；只影响 viewState。验证不置 dirty、不改变导出／引用内容。
- [ ] 开放已验证的文本、位置、图层显隐编辑；保存期间冻结内容输入，保留视口与阅读能力。
- [ ] PSD 区域锚点使用真实文档像素和图层身份，捕获 visibleLayerIds；将批注对象 layerIds 与可见集合分开。
- [ ] 确切版本 PNG／PSD 导出的支持范围以真实服务能力为准；没有历史导出能力不得下载最新文件冒充指定版本。

完成标准：同一宿主无需理解 PSD 内部数据即可完成预览、编辑、冲突、批注定位；网络测试证明编辑时没有后台 apply，显式保存只有一次提交；原 standalone DocSession 流程回归通过。

### P6：固定版本跨类型引用

- [ ] 确定 Markdown 引用持久编码与 occurrence 身份，复用已有结构／AST 能力；不照搬 mock 的整篇字符串替换，也不插入只有本地 hash 能解析的地址。
- [ ] 接入统一选择器、插入书签、expectedDraftSequence 检查；取消、书签失效不修改内容。
- [ ] 实现 Markdown→Markdown 的标题摘要、PSD→Markdown 的图片呈现；title、summary、图片均来自相同目标版本。
- [ ] 固定版本渲染需固定所依赖的图片、字体和渲染器身份，不能只固定正文后继续引用可变外链。
- [ ] 对被引用目标独立鉴权，资源 handle 绑定范围及期限；目标撤权／版本不可用明确显示，不给 iframe 广域凭据。
- [ ] 更新源作品只提示；用户选择后精确替换一个 occurrence，保存当前作品后才生效。
- [ ] 落实引用依赖登记与历史资源保留策略，避免活跃引用被 GC 清理；跨作品依赖是网状关系，不引入目录归属。

完成标准：PSD v1 插入 Markdown 后，PSD 更新至 v2，原图和元数据保持 v1；用户比较并确认后 Markdown 新版本引用 v2。多个相同目标的引用只更新指定一处，旧 Markdown 仍可回看。

### P7：集成、可观测性与内部试用

已完成的早期验证：第 01–08 轮的本地 UI／桌面平板截图、PSD 本地画布和第 08 轮生产发布资源检查见各轮记录；第 07 轮已有生产目录只读验收。第 09 轮八个提交异常窗口及缓存修复属于本地后端验证。这些都不替代以下完整 P7 gate，尤其不是双 origin、真人创作闭环或跨云发布验收。

- [ ] 同时验证 localhost 双 origin 与目标部署真实 origin 的 CSP、frame-ancestors、资源访问和入口注册。
- [ ] 共用服务契约变更必须覆盖 Cloudflare 和 Azure 适配器；先选已有可运行环境作为日常主验证线，不因此悄悄改变另一平台的语义。
- [ ] 记录 instance/context/request/opId、阶段耗时与错误码；日志不得包含用户 JWT、完整正文、批注文本或持久资源凭据。
- [ ] 测量 Markdown 加载、PSD 首帧、增量编辑、批注定位、列表缩略图延迟；以真实样例基线设预算，不能只测 mock。
- [ ] 执行桌面和平板截图、PSD canvas 非空／资源完整检查、键盘与输入法、焦点、跨 origin 弹窗回焦和断网恢复测试。
- [ ] editorBuild 与协议版本同时管理；新界面直接覆盖旧界面，不要求双入口灰度；保留可部署构建产物用于故障恢复，数据变更优先可兼容的加法迁移。
- [ ] 制定发布恢复：修复或重新部署已验证构建，保留 pending 提交核实和草稿恢复，不通过清空草稿或整库回退“恢复 UI”。
- [ ] 用户和同事用真实 Markdown+PSD 创作任务试用，记录问题后再确定下一种 doctype 或完整 PSD 编辑范围。

完成标准：本计划主流程全部使用真实鉴权与数据验证；未支持项在 UI 和发布说明明确列出。界面替换不破坏 API、OAuth 或已提交作品。

## 5. 建议 PR 切分

PR 应对应可独立验证的能力，而不是一次提交所有层：

1. 能力矩阵与协议收敛、PSD 模式兼容性验证测试。
2. protocol-editor schema、方法方向和异常测试。
3. editor-bridge handshake／RPC／context、双 origin 测试宿主。
4. IndexedDB checkpoint、持久提交意图与故障恢复状态机。
5. 服务端确切版本读取／opId 核实补齐；按实际 owner 拆分，不能把不相干后端变更塞进 UI PR。
6. web-gateway 宿主加载器与 Markdown iframe 的真实保存闭环。
7. 统一首页／创建／搜索元数据及缩略图。
8. 评论服务、批量发布与 Agent API；随后接线程 UI、marker 和 focus。
9. PSD 受限 transport 与草稿提交 adapter；随后接嵌入 UI 和分层预览／批注。
10. 跨类型引用编码、版本资源、插入和主动更新。
11. 部署约束、完整端到端验证与灰度入口。

顺序可随证据调整，但先后约束不变：有读取不等于有历史读取，有 opId 字段不等于已确认幂等，有 iframe 页面不等于已解决提交 owner。

## 6. 验证策略与执行命令

当前已存在的命令，按触及模块选择运行：

```sh
pnpm --filter @unidocs/web-gateway test
pnpm --filter @unidocs/web-gateway typecheck
pnpm --filter @unidocs/web-gateway build
pnpm --filter @unidocs/web-psd test
pnpm --filter @unidocs/web-psd typecheck
pnpm --filter @unidocs/web-psd build
pnpm check:cas-contract-docs
pnpm test:local
pnpm test:azure
```

- 新包建立后提供同样的 test/typecheck/build 入口；不要在包未创建时把预期命令写成已通过。
- 每次改动先跑能否定当前假设的最小测试，再按公共契约与部署影响扩大范围。不把全仓库失败当作本轮无限修复授权。
- bridge 的时序／故障测试用 Vitest；UI 用 Testing Library；跨 origin、安全策略、真实资源、输入法和截图使用浏览器端到端测试。P1 建立可复跑脚本，不能只靠临时控制台操作。
- 新宿主草稿、评论和引用版本要有针对多标签页／多实例、迟到响应和权限变化的负向测试。
- 上线前跑真实服务端到端：创建、Agent apply、冲突、批注发布／回复、PSD 编辑、引用更新、重载恢复、退出登录。Cloudflare/Azure 需要环境时如实报告未运行的 gate。

## 7. 范围与进度管理

P0 能力核实与单一提交负责人设计已形成证据，尚缺完整历史读取／资源保留、跨云持久提交和可信嵌入契约。P2/P3 已提前交付非 iframe 的目录、创建恢复、云端预览和 Markdown 本地草稿；第 09 轮 Cloudflare 后端实验已接通，但未部署。不能再概括为“其余阶段尚未开始”，也不能把这些切片视为完整 P1/P2/P3 已通过。

当前阶段状态：P0 进行中；P1 可信 bridge 未实现；P2 云端保存 UI 未接；P3 元数据／分页／能力发现部分未完成；P4 审阅、P5 正式嵌入编辑、P6 版本引用尚未落地；P7 只有早期部署和局部验证。各项部署、测试与未覆盖风险以 [设计入口](README.md) 和 [第 09 轮记录](iteration-09.md) 为准。Gateway 原上传测试的网络等待依赖已修复，最新 Gateway 70 条全部通过；这是相关包验证，不是全仓库或跨云生产验收。

每阶段结束记录：完成的用例、真实验证证据、未覆盖风险、下一阶段依赖；偏离 protocol v0 时同步修改用例／时序／schema，而不是让实现与文档各自演进。

下一步继续补齐共享 Azure 的持久意图、并发互斥与 receipt，收敛候选保留／容量策略；历史只读重建、PSD 真实嵌入适配和 P1 bridge 仍为后续依赖。保留小步交付方式，不以继续添加测试或单云实验代替跨云和用户流程 gate。