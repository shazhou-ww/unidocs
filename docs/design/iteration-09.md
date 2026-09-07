# Iteration 09：可靠提交结果，故障验证与结果契约

日期：2026-09-07。状态：进行中；共享 session 与 Cloudflare pending 恢复故障测试通过，结果解析、规范载荷摘要及独立 SQLite 提交意图日志已实现。日志尚未接入文档提交器，核实 API 和 WebUI 显式云端保存尚未实现，旧 apply 路由与生产运行逻辑未改。

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

## Receipt 集成边界（待实现）

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

### 尚待接入的约束

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
```

首个切片使用内存 DeltaLog 和可控 CAS 替身；第二个切片使用本地 Miniflare 执行真实 Cloudflare DO／CAS 实现，并在服务绑定代理注入故障。未运行 Azure 或生产端到端。没有修改 HTTP API、存储 schema 或生产作品，不将这些测试与独立工具描述为持久提交结果已落地。

## 下一切片

下一切片将独立日志与 Cloudflare SValue pending／delta 完成路径关联，明确旧写路径互斥及 CAS 已确认的终态提交点，再接受鉴权保护的核实入口。共享 Azure 路径仍须解决上文的并发补偿边界。只有两条云适配路径具备可核实结果后，再开放 WebUI 显式保存；冲突与 unknown 都保留第 08 轮原基准草稿。