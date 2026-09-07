# Iteration 09：可靠提交结果，首个故障测试切片

日期：2026-09-07。状态：已启动；首个共享 session 故障测试切片通过。持久 receipt、核实 API 和 WebUI 显式云端保存尚未实现，本轮测试不改变生产运行逻辑。

## 本切片结论

从 [DocumentSession.apply](../../packages/doctype-server-common/src/session.ts) 的真实写入顺序入手：条件追加 delta → CAS root-refs → 内存提交 → 缓存／快照 → 内存 opId 去重记录。

[相邻测试](../../packages/doctype-server-common/tests/session.test.ts) 新增两种确定性故障注入：

1. CAS 接收 root-refs 后响应丢失：session 报 RootRefsError 并删掉刚追加的 delta，但模拟 CAS 保留已提交的引用。同一基础版本的下一次不同操作再次使用相同的 `apply:sessionId:version` 请求 ID，载荷却不同。测试替身明确拒绝不同载荷复用 ID；这里只证明客户端请求 ID 碰撞，不宣称实测过生产 CAS 的去重行为。
2. CAS 提交期间另一个 session 从已追加的 v2 重建，并成功追加 v3：第一个操作随后报 RootRefsError，但条件补偿不能删除非 head 的 v2。新实例仍读到两个操作的正文，原 opId 重试返回版本冲突，无法据此核实原操作结果。

它们与已有“缓存写失败发生在 delta 提交后”“新实例不记得 opId”测试共同说明：异常不等于确定拒绝，head 增长不等于本次操作成功，delta 存在也不单独证明引用提交已完成。

## Receipt 边界约定（待实现）

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
```

本次使用内存 DeltaLog 和可控 CAS 替身，未运行真实 Azure、Cloudflare DO 或 CAS 故障注入。没有修改公共 API、存储 schema 或生产作品；不将这组测试描述为持久提交结果已落地。

## 下一切片

先在 Cloudflare SValue DO 的现有 pending commit／重建路径补对应故障证据，然后收敛可执行 receipt 契约及持久端口。只有两条云适配路径具备可核实结果后，再开放 WebUI 显式保存；冲突与 unknown 都保留第 08 轮原基准草稿。