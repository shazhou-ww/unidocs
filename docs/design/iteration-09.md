# Iteration 09：可靠提交结果，故障验证与结果契约

日期：2026-09-07。状态：进行中；默认关闭的 Cloudflare Markdown 实验模式已接通持久提交、独立核实／恢复和目录同步，真实提交器八个异常窗口已验证，并修复提交后异常导致旧内存正文继续被读取的问题。Azure 持久提交、实际硬崩溃验证及 WebUI 保存尚未完成。本轮未部署，线上仍为第 08 轮。

## 2026-09-08 阶段收尾

已在同步后的 `92481d7` 实现基线上复验。本轮 Cloudflare 实验后端切片告一段落，不将整个第 09 轮或跨云可靠保存标记完成。用户决定暂缓 UI 扩展，下一步先讨论 doctype 对应 editor 和 service 的动态注册、发现与加载方法，不直接实现注册接口或开放云端保存。下文各切片和“下一切片”保留历史推进记录；当前工作优先级以本节为准。

- 六包回归全部通过：web-gateway 70、protocol-doc 81、protocol-gateway 23、doctype-server-common 273、gateway-common 70、cloudflare-sdk 47，共 564 条。
- `explicit-commit.test.mjs`、`explicit-commit-faults.test.mjs`、`commit-journal.test.mjs` 串行运行，共 15 条通过，包含真实本地 DO/CAS 与八个异常窗口。
- web-gateway、doctype-server-common、cloudflare-sdk、cloudflare-gateway、azure-gateway 类型检查及 Cloudflare Gateway 构建通过。
- 首次集成运行因缺失 UniCAS 的生成 UI 资源，14 条未进入业务逻辑；执行 `pnpm --filter @unicas/service-cloudflare build` 后重跑同一组测试全部通过。没有修改业务实现或跳过用例。
- 本次未部署、未启用实验开关，未操作生产作品。生产仍按第 08 轮发布记录；本次未新增生产浏览器验收。
- Azure 持久意图与并发互斥、receipt 容量与保留、真实硬崩溃和鉴权失效验证、WebUI 保存仍是未完成门槛。动态注册必须准确描述实际能力，不能因注册了 editor 就宣称具备可靠保存或历史读取。

日志检查点已提交为 `bad1851`；下文前三个切片记录保留其当时的实现边界，第四个切片描述当前工作区新增的接入。

第四切片检查点已提交为 `d09f8f4`。下文各切片保留历史边界，第八切片为当前最新进度。

核实／恢复、目录同步、八窗口故障验证、缓存修复与计划更新已提交为 `8796700`。其后第八切片补终态候选正文清理；用户确认继续开发，暂不部署。

## 本切片结论

从 [DocumentSession.apply](../../packages/doctype-server-common/src/session.ts) 的真实写入顺序入手：条件追加 delta → CAS root-refs → 内存提交 → 缓存／快照 → 内存 opId 去重记录。

[相邻测试](../../packages/doctype-server-common/tests/session.test.ts) 新增两种确定性故障注入：

1. CAS 接收 root-refs 后响应丢失：session 报 RootRefsError 并删掉刚追加的 delta，但模拟 CAS 保留已提交的引用。同一基础版本的下一次不同操作再次使用相同的 `apply:sessionId:version` 请求 ID，载荷却不同。测试替身明确拒绝不同载荷复用 ID；这里只证明客户端请求 ID 碰撞，不宣称实测过生产 CAS 的去重行为。
2. CAS 提交期间另一个 session 从已追加的 v2 重建，并成功追加 v3：第一个操作随后报 RootRefsError，但条件补偿不能删除非 head 的 v2。新实例仍读到两个操作的正文，原 opId 重试返回版本冲突，无法据此核实原操作结果。

它们与已有“缓存写失败发生在 delta 提交后”“新实例不记得 opId”测试共同说明：异常不等于确定拒绝，head 增长不等于本次操作成功，delta 存在也不单独证明引用提交已完成。

## Cloudflare 恢复验证

在 [SValue 恢复集成测试](../../tests/integration/cloudflare/svalue-recovery.test.mjs) 增加“CAS 已提交但响应丢失后重启”场景，使用现有本地 Miniflare、真实 SValue DO 与 CAS middleware 实现，不连接生产。

- [本地故障代理](../../stacks/unidocs-cloudflare/local/doc-types.mjs) 增加 `casFault: "after-commit"` 模式：等待上游 CAS 成功并消费响应后，向文档 Worker 返回注入的 503。原 `casFault: true` 仍在请求到达 CAS 前失败。这里模拟响应丢失结果，不是实际断网或进程硬崩溃。
- apply 返回 502／v1 时，CAS 已有 v2 roots 请求记录，当前 delta 和 snapshot 各保留一次。
- 使用同一持久目录与同一鉴权 fixture 优雅关闭并重启运行时，重试原 apply 先恢复 pending 到 v2，随后因原 baseVersion 返回 409。查询可读到原操作正文，再次重试仍为 409。
- 恢复前后保留的根集合与计数完全一致，原 roots 请求只记录一次；说明原 pending 可以幂等完成，但客户端 opId 不随它持久恢复。

此证据补齐了 Cloudflare 路径的一种故障／重建场景，不等于完整崩溃点覆盖，也不代表生产或 Azure 已验收。

## 已实现的契约工具

- [结果契约](../../packages/protocol-doc/src/commit-receipt.ts) 导出 `CommitRequestIdentity`、`CommitReceipt` 和运行时解析器。状态为 pending、committed、rejected、unknown；committed 必须满足 `version = baseVersion + 1`。not_found、expired、unavailable 都属于 unknown，不能作为确定拒绝。
- 新契约的 opId 限定为 1–128 个 ASCII 字母、数字、下划线或连字符；requestDigest 是 64 位小写十六进制字符串；baseVersion 必须是有后继版本的正安全整数。它仅用于新的显式提交契约，不改变旧 apply 的 opId 接受范围。
- 解析器拒绝缺失版本、矛盾状态字段及无效版本，返回字段白名单，不携带正文或令牌。解析通过只代表格式有效，不证明服务端已持久提交；调用方仍须验证授权、预期 opId／摘要／基准及可信持久结果来源。
- [载荷摘要](../../packages/doctype-server-common/src/commit-request.ts) 使用规范 SValue 编码和完整 SHA-256，域标识为 `unidocs.commit.v1`，覆盖 tenantId、docType、不可变 sessionId、baseVersion、description、operations。对象字段顺序不影响摘要；操作顺序、SBlob 身份和任一载荷字段变化都会改变摘要。
- 摘要不包含令牌、时间戳或 opId；未来存储以 session+opId 定位，再校验此摘要。同一规范载荷可在不同意图下得到相同摘要，不意味着可以重复提交。
- 编码在第一个 await 之前完成，随后修改调用方对象不会改变在途摘要。此工具不持久保存候选，后续提交意图层仍需将同一份候选与摘要一起可靠保存，不能哈希后再读取可变对象作为实际提交载荷。

这些工具已导出，但未注册新 HTTP 路由、未增加数据库字段、未接入旧 apply 或 WebUI，也不是可用的端到端保存功能。

## Receipt 集成进度

### 第三个切片：独立 SQLite 提交意图日志

[SqliteCommitJournal](../../packages/cloudflare-sdk/src/commit-journal.ts) 是尚未接入生产入口的存储组件；构造时在传入 SQLite 中创建 `doc_commit_intents_v1` 表及唯一索引。它没有被现有 EditorDO 导入，也没有在本次部署中执行 schema 变更。

- 按 tenantId、docType、不可变 sessionId 和 opId 定位。`begin` 在 await 前编码字段白名单候选，再从相同字节计算摘要；正文与摘要一起登记，不保存令牌或调用方额外顶层字段。SBlob 使用 SValue 编码保留身份。
- 同一 opId、同摘要返回原 pending／终态；同 opId 异载荷抛出 payload_mismatch，不能覆盖原记录。每个 scope 最多一个 pending，由 SQLite 部分唯一索引及同步事务保证；不同意图抢占返回 pending_exists。
- `recoverPending` 返回原候选并重新验证摘要，损坏记录报错且不清理。它是读取快照，不是执行权租约；调用方必须串行协调恢复与提交，不能由多个恢复任务同时触发 CAS 写入。
- `lookup` 仅返回结果元数据；未登记记录为 unknown/not_found，摘要不匹配报错。存储错误直接抛出，不解释为拒绝或未提交。
- `settle` 用 `transactionSync` 将同步本地完成回调与终态更新放在同一事务，回调失败或 receipt SQL 写入失败都回滚。重复相同终态直接返回，不再次执行回调；矛盾终态拒绝。确定终态释放 pending 槽位。
- 本地完成回调必须同步，不得发起异步任务或网络请求。CAS 网络结果须由上层事先确认；该组件不验证 CAS 事实，也不能代替提交器。后续必须在回调中一起完成真实 delta／snapshot／pending 清理，不能先独立写 committed 再写文档。
- 当前候选编码上限 1 MiB；未实现过期、删除或 GC，终态暂保留原候选字节。长期数据保留、容量策略及载荷清理待接入前设计，不能把它视作无限容量的生产存储。
- 当前唯一约束只覆盖该日志，不拦截旧 apply 或其他写入入口。与现有 SValue pending 关联、旧写路径互斥、请求鉴权及跨云实现仍是接入 gate。

[9 条 SQLite 单测](../../packages/cloudflare-sdk/tests/commit-journal.test.ts) 覆盖真实磁盘关闭重开、调用方对象变更、同请求并发登记、异载荷与 pending 冲突、身份隔离、事务回滚、receipt 写失败、重复终态、确定拒绝与损坏／超限记录。测试使用 Node 内置 SQLite，测试运行会有其 experimental warning。

[workerd 集成测试](../../tests/integration/cloudflare/commit-journal.test.mjs) 将同一实现传入真实 `ctx.storage`，通过仅测试的 [DO 探针](../../tests/integration/cloudflare/commit-journal-probe.ts) 验证 pending／终态在两次 Miniflare 重启后恢复、事务回滚和重复完成不再执行本地写入。探针未加入部署入口，使用的本地版本表不是真实 SValue delta 提交。

### 第四个切片：Cloudflare Markdown 实验提交闭环

[SValue EditorDO](../../packages/cloudflare-sdk/src/editor-do-svalue.ts) 在 `DOC_EXPLICIT_COMMITS="1"` 且 doctype 为 Markdown 时，接受 apply 请求中的实验字段 `commitMode: "receipt-v1"`。未开启、类型不支持或模式未知都返回 400，不执行旧 apply。生产 Wrangler 配置没有启用该开关，也没有部署本次代码；该字段不是已发布的跨云能力协商契约，客户端不得向旧版本后端盲发它。

- 继续经既有 Gateway 与 Doc capability 鉴权进入；在恢复写入前检查 DO 的 tenant／session 身份。共享 [session-handler](../../packages/doctype-server-common/src/session-handler.ts) 也明确拒绝任何带 commitMode 的 apply，避免 Azure 当前实现忽略字段后执行旧写入。
- 先用 journal 登记固定候选，重试同 opId 同载荷返回原记录，异载荷或不同 pending 意图返回 409。新模式不使用旧 recentOps 缓存，也不改变无 commitMode 请求原有的内存去重语义。
- 有 journal pending 时，旧 apply／rollback 等带 CAS 写权限的入口返回 409，不自动恢复或推进该意图；query／ir／export／history 等只读路径仍查看已完成版本。关闭实验开关后，已有 pending 也不允许旧写入口绕过，恢复必须重新启用新模式并使用原请求。
- 对被提前拒绝且尚未读取请求体的写请求，流式消费请求体后返回，避免本地 Gateway 流式转发连接被中断；不执行原写操作，也不把正文缓冲到内存。
- 在原候选基准上计算 Markdown，成功得到待提交根后，将 svalue_pending 与原 opId 关联。恢复验证 journal 摘要、baseVersion、description 及 delta 字节一致性，不拿最新 head 重新解释旧候选。
- 新 CAS roots 请求身份为 `session:{sessionId}:commit:{opId}:roots`，不使用可能被重用的版本号作为唯一意图身份。原普通 apply 保留旧请求身份。
- CAS 确认后，在同一 SQLite transactionSync 中写入 delta／必要的 snapshot、删除 svalue_pending 并将 receipt 标记 committed。恢复与提交阶段的失败保留 pending；内存版本在重建成功后才更新，不把旧正文标成新版本。
- 同请求重试若已 committed，即使文档后来推进了版本，也返回原 receipt 与原提交版本，不再次执行操作。确定的基准冲突和 Markdown 计算拒绝写入 rejected，后续相同请求返回同一终态。
- 成功返回 200 与 `{ success: true, version, receipt }`；未确定的持久意图返回 503 与 pending receipt；确定拒绝返回 409 与 rejected receipt。普通输入错误／未登记时的存储失败可能没有 receipt，不能据此推断请求曾经或从未持久提交。

[5 条新集成测试](../../tests/integration/cloudflare/explicit-commit.test.mjs) 使用本地 Gateway、Markdown Worker、真实 SValue DO 和 CAS middleware：CAS 确认前失败、确认后响应丢失、并发相同请求、不同载荷／意图冲突、旧 apply／rollback 互斥、跨租户拒绝、开关关闭与重新启用、确定拒绝、终态跨重启重试，以及 v21 同时产生 delta／snapshot 的恢复。原 roots 请求只记一次，恢复后根计数各为 1；旧客户端在新意图完成后仍可正常写入。

这里用重复提交原请求来驱动恢复，只是后端实验协议，不是 WebUI 的最终 unknown 核实交互。独立只读 receipt 查询与受控恢复 API 尚未提供；不允许前端拿旧 apply 重试猜结果。本轮没有生产故障注入，没有覆盖 journal 登记到 pending 根写入之间的全部硬崩溃窗口，也未完成容量、保留期与候选 GC 策略。实验模式暂不支持 PSD／DOCX，Azure 持久事务和结果核实也仍是发布 gate。

### 跨云后续约束

### 第五个切片：独立核实与受控恢复

新增 `POST /tenants/{tenantId}/docs/{docType}/{docId}/commit-status` 和 `commit-recover`，沿现有 Gateway／Doc 路由转发。公共类型为 DocCommitControlRequest／Response 和 GatewayCommitControlRequest／Response，完整边界见 [HTTP 协议](../doc-service-http-protocol.md#experimental-commit-controls)。

- 核实要求文档读权限，无 delegated CAS 权限；Doc 边缘拒绝附带 CAS 能力的核实请求。DO 只读取身份与 journal 元数据，不初始化 schema、重建正文、访问 CAS 或完成 pending，冷启动也遵守这一边界。
- 恢复要求文档写权限及精确的 CAS 读写能力。只读文档能力、缺失或不完整的 delegated CAS 能力都在 DO 查找前拒绝。恢复不再要求客户端重新发送完整 apply 载荷。
- 两个入口只接受 opId、requestDigest、baseVersion。错误摘要／基准返回 409；无效身份或夹带正文／operations 返回 400。最多保留 4 KiB 输入，超限流式丢弃剩余输入并返回 413。
- 不存在的意图返回 unknown/not_found，恢复也不调用 journal.begin，不会创建新意图；完成／拒绝的记录直接返回原终态，不重放操作。匹配 pending 的恢复才加载正文并继续原候选。
- 接口成功查到 pending、终态或 unknown/not_found 都返回 200 和 `{ receipt }`；200 不等于云端已保存。恢复仍 pending 或 journal 不可用返回 503；不可用不解释为 rejected。receipt 响应为 JSON，并设置 no-store。
- 新核实／恢复入口仍受默认关闭的实验开关与 Markdown 类型限制。共享 Azure handler 返回 501，不加载或更改 session。未增加 Gateway 目录 touch：查询不更新时间，重复核实／恢复终态也不伪造新的作品更新时间；真实恢复后的目录版本／时间同步仍待后续明确处理。

新增权限测试验证核实与恢复的最小权限及越权拒绝；SQLite 测试验证核实不创建表。6 条显式提交集成测试现已通过独立控制入口验证跨重启 pending 核实、原候选恢复、终态重复查询、未知意图不登记、错误摘要与夹带正文不触发 CAS、超限请求和跨租户拒绝。原候选 CAS 确认前失败时，核实前后正文仍为 v1 且没有新增 roots 请求记录。

这些是本地真实实现与测试凭据驱动的验证，不是生产真人只读 OAuth 会话验收。新 HTTP 接口尚未部署，旧版本后端不保证识别实验 apply 字段。journal 登记后／根上传前、本地完成事务故障等完整提交器崩溃矩阵仍待补齐。

### 第六个切片：恢复完成后的目录同步

Gateway 的目录是可修复的版本缓存，不是提交结果的权威。本轮为 [目录端口](../../packages/gateway-common/src/document-directory.ts) 增加 advanceVersion，内存、[D1](../../packages/cloudflare-gateway/src/document-directory.ts) 和 [PostgreSQL](../../packages/azure-gateway/src/document-directory.ts) 都按同一语义实现：

- 只更新同一 tenant／docId 的 ready 记录，且观测版本必须严格高于目录版本；缺失、非 ready、重复或更低版本不改变记录。不需要 schema 迁移。
- SQL 用单条条件 UPDATE 防止并发迟到结果覆盖较高版本，更新时间取现有值和观测时间的较大值，不倒退。时间代表 Gateway 首次成功同步较高版本时的观测时间，不是服务端精确提交时间。
- 成功 apply／rollback 的有效版本及 commit-recover 的 committed receipt 会推进目录；旧普通 apply／rollback 也同步版本，避免其后迟到的显式 receipt 把目录错误覆盖。run／reset 仍保持原 touch 逻辑，不声称其版本缓存已同步。
- commit-status 永远不更新目录；pending、unknown、rejected receipt 不更新目录。重复恢复或重试已完成 apply 不刷新时间，迟到的旧结果不会覆盖新版本。目录初始版本落后时，首次看到旧 receipt 只能推进到该已确认版本，不把它当作当前最新 head。
- commit-recover 必须携带可解析的 committed receipt，不能只凭通用 success/version 更新。结果解析最多保留 16 KiB 元数据，超限或损坏不改变目录，原上游响应仍完整转发。
- 目录同步失败不改变原 HTTP 状态、receipt 或内容，响应额外带 `X-UniDocs-Directory-Sync: pending`。这里的 pending 只指目录尚未同步，不是内容提交变回 pending。客户端可以重新调用原意图的恢复接口：已完成意图不会再次 apply，但 Gateway 会再次尝试修复目录。只读核实不承担这项写修复。
- 当前无后台目录修复任务，未接入 WebUI 同步告警；目录失败后必须再次经过写结果或显式恢复路径才会修复。Azure 仅实现了目录更新语句，并没有因此获得持久 receipt 或恢复能力。

新增 [9 条 Gateway 同步测试](../../packages/gateway-common/tests/commit-directory-sync.test.ts) 覆盖高版本推进、重复与迟到结果、只读核实、失败后原成功响应保留、后续恢复修复以及非 committed／损坏／超限结果。另补内存目录单调性测试，真实 D1 条件更新验证，以及 [2 条 PostgreSQL 语句契约测试](../../packages/azure-gateway/tests/document-directory.test.ts)。PostgreSQL 使用查询替身，未连接真实 Azure/PostgreSQL。

6 条显式提交集成测试通过，其中真实恢复流程新增目录断言：pending 核实前后目录相同，恢复后为 v2，重复核实／恢复／原 apply 重试都不改变目录记录。

### 尚待完成的跨云约束

### 第七个切片：真实提交器异常窗口与缓存修复

[故障集成测试](../../tests/integration/cloudflare/explicit-commit-faults.test.mjs) 通过 [测试专用 Markdown Worker](../../tests/integration/cloudflare/explicit-commit-fault-worker.ts) 包装生产 MarkdownEditor 的存储对象；其余 Gateway、Doc 鉴权、Markdown 引擎和 CAS middleware 使用真实本地实现。[本地 runtime](../../stacks/unidocs-cloudflare/local/runtime.mjs) 新增默认空的 bundleEntryOverrides，仅测试显式替换打包入口，正常开发和生产入口不包含故障控制端点。

测试包装器有 arm／inspect 接口，只用于本地测试。它在指定存储调用处注入一次异常，并只检查版本、意图状态、pending 关联等元数据，不返回正文或令牌。每个用例结束后清理其临时持久目录；没有生产故障开关、部署配置变更或生产作品操作。

八个窗口及其断言：

1. 意图已登记，进入恢复检查时、尚未计算／上传新根：journal 保留原候选，svalue_pending 不存在。
2. 根上传后、写入 svalue_pending 前：journal 仍 pending，无新 delta；未完成的 roots 不冒充提交。
3. svalue_pending 已写入、尚未 CAS roots 提交：原 opId 和版本关联跨重启保留。
4. 本地完成事务中写入 delta 后失败：delta 回滚，pending 和 receipt 均维持待完成。
5. v21 阈值提交在写入 snapshot 后失败：新 delta 和 snapshot 一起回滚，旧 snapshot 保留。
6. 本地事务清除 svalue_pending 后失败：删除回滚，恢复所需 pending 不丢失。
7. 本地事务更新 committed receipt 后失败：receipt 与 delta／snapshot／pending 清理全部回滚，不留下伪成功记录。
8. 本地事务已经成功返回、内存刷新前异常：receipt 保持 committed，随后读取必须使用新版本正文，跨重启重复恢复不再应用操作。

前七个窗口分别验证失败现场与持久目录重启后状态一致、旧 apply 被互斥、只读核实不改变 pending，再经独立恢复入口完成原意图。测试使用 appendSection 而非 setContent，重复应用会在正文中产生重复章节，因此能检测实际重复操作。恢复后只有一个新版本，CAS 原 roots 请求只记录一次，保留根计数均为 1。

第八个窗口先发现并复现缺陷：事务成功后异常路径返回 committed receipt，但内存仍是旧 v1，随后 query 返回空正文。修复位于 [SValue EditorDO](../../packages/cloudflare-sdk/src/editor-do-svalue.ts) 的显式恢复异常处理：从 journal 确认 committed 后使已加载状态和正文缓存失效，下次需要正文的请求从持久状态重建。仍返回原 committed 结果，不回滚、不重发 apply；修复后当前实例读取与重启读取均为新版本。

这些用例是存储调用前后的异常注入加优雅关闭／重启，不是强杀 workerd、断电或磁盘持久化丢失测试，不证明全部硬崩溃窗口。CAS 网络分区、长期配额耗尽、恢复鉴权过期与候选保留／GC 也不在本切片结论内。生产请求体／并发／延迟行为仍需后续验收。

### 跨云发布前约束

### 第八个切片：终态候选正文清理

[SqliteCommitJournal](../../packages/cloudflare-sdk/src/commit-journal.ts) 的 settle 在确认 committed 或确定 rejected 的同一事务中将 payload 置为空 BLOB，保留 scope、opId、requestDigest、baseVersion、state 和 receipt。无需修改现有 NOT NULL schema；完成后只用元数据核实与去重，不再需要候选副本。

- pending 候选不清理；本地完成事务失败时，终态、文档写入及 payload 清理一起回滚，原候选仍可恢复。
- 同 opId 同摘要重试继续返回原终态，不重复提交；异载荷仍拒绝，不能因正文已清空就重新接受请求。
- 新增 committed／rejected 两种终态的磁盘关闭重开测试，同时验证另一个 pending 候选仍存在。真实八窗口探针检查 pending 的 payload 非空、终态为零字节，回滚与跨重启恢复正常。
- 这里只清理新终态转换的 journal 候选副本，不删除文档正文、CAS 版本或 receipt 元数据；不承诺 SQLite 历史页、日志或备份的安全擦除。已有旧终态候选不做批量迁移或自动清理，生产数据未操作。
- receipt 元数据仍不自动过期，数量上限、保留期限、旧记录回收与跨云策略尚未收敛，不能宣称所有容量／保留 gate 已完成。

验证：SDK 47 条（journal 12 条）、真实显式提交与八窗口测试共 14 条通过，SDK 类型检查通过。本轮未部署。

### 后续跨云约束

- 新显式提交语义与旧 DocSession 的自动 rebase／同 opId 重放分开协商，不直接改变旧接口的去重语义。
- 持久记录以不可变 session 身份与客户端 opId 定位，绑定原 baseVersion、operations、description 的规范化载荷摘要。摘要必须沿用 SValue 编码处理二进制／SBlob，不使用普通 JSON 冒充协议摘要。
- 提交意图与操作载荷需要先持久记录；提交阶段至少区分 pending、committed 和确定 rejected。记录不存在、过期、网络错误或补偿结果无法确认时统一按 unknown 处理，不允许客户端换 opId 猜结果。
- 每个持久提交意图拥有稳定的 CAS 请求身份，不能只使用可能被补偿后复用的版本号。重试同一意图重用原身份，不同载荷不能沿用它。
- 只有日志与所需引用提交均有可恢复的成功证据后，才将 receipt 标成 committed。缓存属于可重建派生状态，不应倒置已确认的提交事实。
- pending 恢复必须核实并继续原意图，不能另发一份 apply。并发写入能否观察未完成版本、补偿可否执行，必须由持久事务／串行化约束解决，而不是依赖前端版本检查。
- 核实接口只返回结果元数据，不泄露正文或令牌；必须沿用 Gateway 的 tenant／文档权限校验。共享 Azure 路径与 Cloudflare SValue DO 路径都要满足同一公开约定，不能互相代替验收。

## 验证

```sh
pnpm --filter @unidocs/doctype-server-common exec vitest run tests/session.test.ts
# 51 passed，新增 2 条
pnpm --filter @unidocs/protocol-doc test
# 77 passed，包括新增 receipt 校验 31 条
pnpm --filter @unidocs/doctype-server-common test -- --silent
# 267 passed，包括新增摘要工具 11 条
pnpm --filter @unidocs/doctype-server-common typecheck
# passed
pnpm exec vitest run tests/integration/cloudflare/svalue-recovery.test.mjs tests/integration/cloudflare/cas-rollback.test.mjs tests/integration/cloudflare/svalue-editor-e2e.test.mjs --fileParallelism=false --silent
# 5 passed，包括新增响应丢失后重启 1 条
pnpm --filter @unidocs/cloudflare-sdk test -- --silent
# 44 passed，包括提交意图日志 9 条
pnpm --filter @unidocs/cloudflare-sdk typecheck
# passed
pnpm exec vitest run tests/integration/cloudflare/commit-journal.test.mjs --fileParallelism=false --silent
# 1 passed，真实 workerd SQLite 事务及持久目录重启
pnpm exec vitest run tests/integration/cloudflare/explicit-commit.test.mjs --fileParallelism=false --silent
# 5 passed，新增实验提交端到端
pnpm --filter @unidocs/doctype-server-common test -- --silent
# 第四切片回归：268 passed（新增共享适配器失败关闭 1 条）
pnpm --filter @unidocs/protocol-doc --filter @unidocs/protocol-gateway --filter @unidocs/gateway-common --filter @unidocs/doctype-server-common --filter @unidocs/cloudflare-sdk test -- --silent
# 第五切片：协议 Doc 81、协议 Gateway 23、共享核心 273、SDK 45 通过
# Gateway 59 通过、1 条原上传测试超时，单独复跑仍超时
pnpm --filter @unidocs/cloudflare-gateway --filter @unidocs/cloudflare-sdk typecheck
# passed
pnpm exec vitest run tests/integration/cloudflare/explicit-commit.test.mjs tests/integration/cloudflare/commit-journal.test.mjs tests/integration/cloudflare/svalue-recovery.test.mjs --fileParallelism=false --silent
# 9 passed
pnpm --filter @unidocs/gateway-common test -- --silent
# 第六切片：69 passed，1 条原上传测试仍因不可达上游超时
pnpm --filter @unidocs/cloudflare-gateway exec vitest run tests/migration.test.ts --silent
# 1 passed，含真实 D1 单调版本／时间验证
pnpm --filter @unidocs/azure-gateway exec vitest run tests/document-directory.test.ts --silent
# 2 passed，查询替身，非真实 PostgreSQL 集成
pnpm --filter @unidocs/cloudflare-gateway --filter @unidocs/azure-gateway typecheck
# passed
pnpm exec vitest run tests/integration/cloudflare/explicit-commit.test.mjs --fileParallelism=false --silent
# 6 passed，含恢复后目录同步与重复恢复不刷新时间
pnpm exec vitest run tests/integration/cloudflare/explicit-commit-faults.test.mjs tests/integration/cloudflare/explicit-commit.test.mjs --fileParallelism=false --silent
# 第七切片：14 passed，含新增八个异常窗口
pnpm exec vitest run tests/integration/cloudflare/explicit-commit.test.mjs tests/integration/cloudflare/local-runtime.test.mjs --fileParallelism=false --silent
# 13 passed，含默认本地入口回归 7 条
pnpm --filter @unidocs/cloudflare-sdk test -- --silent
# 45 passed
pnpm --filter @unidocs/cloudflare-sdk typecheck
# passed
```

首个切片使用内存 DeltaLog 和可控 CAS 替身；第二个及第四个切片使用本地 Miniflare 执行真实 Cloudflare DO／CAS 实现，并在服务绑定代理注入故障。第四个切片新增实验请求模式及 svalue_pending 的可空 commit_op_id 列，现有 DO 加载时按需补列；日志表按需创建。未运行 Azure 或生产端到端，也未将本轮 schema 或代码部署到生产，不将局部实验闭环描述为跨云可靠保存已完成。

## 下一切片

提交前验证更新：已修复 Gateway 的 `tests/upload-size.test.ts` 对 `http://doc.invalid` 的真实 DNS／网络等待依赖。测试现在注入确定性的上游失败，额外断言请求确实被转发，未延长超时或跳过测试，未修改生产上传逻辑。此前第五／六切片的超时记录是历史结果；最新 Gateway 70 条全部通过。

本次提交前五个相关包回归：protocol-doc 81、protocol-gateway 23、doctype-server-common 273、gateway-common 70、cloudflare-sdk 45，共 492 条通过；Cloudflare Gateway 构建通过。用户确认先提交、不部署，线上保持第 08 轮，前端尚无云端保存按钮。

Cloudflare 的上述八个异常窗口已形成可回归证据；后续补共享 Azure 路径的持久意图、并发写互斥及提交点设计，不直接复制 DO 单实例假设。发布前仍需收敛候选保留与容量策略，并补真实硬崩溃和鉴权失效验证。只有两条云适配路径具备可核实结果后，再开放 WebUI 显式保存；冲突与 unknown 都保留第 08 轮原基准草稿。