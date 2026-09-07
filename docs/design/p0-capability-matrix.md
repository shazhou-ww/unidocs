# P0 能力矩阵与兼容性结论

日期：2026-09-07。状态：第一批代码核实与特征测试完成；P0 未全部完成，P1/P2 未启动。

依据：[实施计划](implementation-plan.md)、[协议草案](editor-host-protocol-v0.md)。本文将运行过的测试、静态代码证据、目标设计与未验证项分开。测试锁定的是当前行为，不表示这些行为都满足未来协议；修复已知限制时应同步改为目标语义断言。

## 1. 本批结论

1. 真实 PSD 引擎可以独立构造本地草稿，不必依赖 DocSession 自动写入。嵌入编辑建议复用引擎与渲染接口，独立建立宿主管理的候选／提交状态；不把现有 DocSession 的 fetch 换成“假成功”来压制网络。
2. 当前 DocSession pending 队列仅驻留实例内存，没有跨实例恢复。现有注释中的“durable queue”不能作为 IndexedDB 持久化已完成的证据。
3. 服务端 opId 仅做实例内有界去重，未绑定载荷且不持久。Azure 每请求重建共享 DocumentSession，这个限制尤其直接；Cloudflare SValue 实现也有内存 recentOps，但持久化路径不同。
4. 共享 session 在持久 delta 写入后，快照缓存失败会导致 apply 抛错且没有记住 opId。因此网络错误和服务端 5xx 都不能简单等同于“未提交”。
5. 当前 IR 读取没有历史版本参数语义。向共享 handler 发送 `?version=1` 可以成功返回当前 v2；bridge 必须核对返回版本，不能根据自己的请求参数推断内容版本。
6. 当前静态 doctype 注册只保存 serviceId/url/audience，不含 editor descriptor；Markdown 文档本体只有 content 字符串，没有稳定 blockId。

## 2. 能力矩阵

状态含义：supported 为已有能力；needs adapter 为已有基础但须适配；missing 为已检查契约／owner 中缺失；incompatible 为已有行为与 v0 冲突。这里的 supported 不等于所有云环境都已端到端验证。

| 用例／能力 | 状态 | 证据 | 实施结论 |
| --- | --- | --- | --- |
| UC-01 当前 PSD 读取 | supported | [doc-source.ts](../../packages/psd-client/src/doc-source.ts)：loadDoc 请求当前 `/ir` 并解码 SValue | 可复用解码与 materialize；需要受限读取 transport 与返回版本校验 |
| UC-01 确切历史读取 | missing（公开只读契约） | [session-handler.ts](../../packages/doctype-server-common/src/session-handler.ts)、[routes.ts](../../packages/protocol-doc/src/routes.ts)、新增 HTTP 特征测试 | 不可把 querystring 加到当前 IR 当作历史能力；新增只读版本入口／参数及两端适配 |
| 历史重建基础 | needs adapter | [共享 session rollback](../../packages/doctype-server-common/src/session.ts)、[CF SValue rollback/reconstruct](../../packages/cloudflare-sdk/src/editor-do-svalue.ts) | 已有 snapshot+replay 思路；不能用会产生新版本的 rollback 实现预览。需要独立只读重建，并验证 restore/clone/import 历史 |
| UC-02 PSD 本地草稿计算 | supported（最小引擎探针） | [doc-session.test.ts](../../packages/psd-client/tests/doc-session.test.ts)：两次 applyOne 不修改基线，RenderLike 收到相同操作 | 可绕开提交器复用引擎。真实 Worker／资源读取与候选提交仍待验证 |
| UC-03 PSD 自动提交 | incompatible | [doc-session.ts](../../packages/psd-client/src/doc-session.ts)：applyLocal 自动 drain，409 后 rebase；现有回归测试 | 嵌入模式必须只由 H 提交；独立页面保持旧行为 |
| UC-02/05 PSD 草稿恢复 | missing | 同文件 pending 为数组；新增“重建实例不恢复队列”测试 | 新建宿主 IndexedDB checkpoint，不把内存队列称为持久草稿 |
| UC-03 基础版本冲突 | supported | [共享 apply](../../packages/doctype-server-common/src/session.ts)、[DeltaLog.append 契约](../../packages/doctype-server-common/src/ports.ts)、已有冲突测试 | 继续使用服务端条件写入，不用 UI 版本检查替代 |
| UC-03 同实例重复 opId | supported（有限） | 共享 session 原有去重测试；CF SValue apply 静态代码 | 仅实例存活与缓存未淘汰时可用，不能用于完整 unknown 恢复 |
| UC-03 opId 绑定载荷 | incompatible | 新增同 ID 不同操作／description/baseVersion 测试返回旧版本 | 新协议需要持久 request digest 与明确载荷冲突错误；兼容旧 PSD rebase 行为须单独设计 |
| UC-03 opId 持久核实 | missing | recentOps 是 Map；Delta 不含 opId；公开路由无操作结果查询；新增重建测试 | 必须新增持久操作结果，不以 head 增长证明提交成功 |
| UC-03 post-commit 失败 | incompatible（若将异常视为拒绝） | 新增 cache failure 测试：delta=head2，文档已改，但调用抛错、同 ID 再次调用冲突 | 协议适配器需区分确定拒绝与未知；后端明确提交点及恢复状态 |
| UC-04 外部更新 | needs adapter | [DocSession.reconcile](../../packages/psd-client/src/doc-session.ts)、现有 query/status 契约 | 嵌入 dirty 草稿不能自动 rebase；H 可轮询核实 head，完整 Gateway status 新鲜度待测试 |
| UC-06/07 评论存储与 Agent API | missing（所检查公共协议） | [protocol-doc routes](../../packages/protocol-doc/src/routes.ts)、[protocol-gateway](../../packages/protocol-gateway/src/index.ts) 中未定义评论／反馈契约 | 不能将 mock localStorage 当服务；本地草稿和已发布反馈分开建设 |
| Markdown 锚点身份 | needs adapter | [types.ts](../../packages/doctype-markdown/src/types.ts)：MDoc={content}；query 有 headings/section，无 blockId | v0 使用确切版本的源码／文本范围 schema，不声称稳定跨版本节点身份 |
| UC-08 图片／字体资源 | needs adapter | PSD loadDoc 依赖 BlobStore；共享 snapshot pins TDoc SBlob | SBlob 基础可复用；引用版本授权、只读资源句柄、字体和 rendererBuild 固定仍待集成 |
| 历史资源保留 | needs adapter（部分证据） | [session.ts #writeSnapshot](../../packages/doctype-server-common/src/session.ts) pin SBlob 后 recordSnapshot；CF 实现有独立 root/pending 逻辑 | 尚未证明跨作品引用、删除、GC 的完整生命周期，不能承诺永久可读 |
| 类型注册与 UI 发现 | needs adapter | [StaticDocServiceRegistry](../../packages/gateway-common/src/doc-service-registry.ts) 只复制 serviceId/url/audience | 可先扩展部署期受批准配置，增加公开 editor descriptor；不需要先做动态注册管理系统 |
| UC-09 身份和权限 | needs adapter | [Gateway handler](../../packages/gateway-common/src/gateway-handler.ts) 校验 identity.tenantId；[PSD 控制器](../../packages/web-psd/src/doc-controller.ts) 固定 USER/API_BASE_URL | 嵌入模式必须由宿主传公开文档身份并代理读取；不能复用硬编码 u1 或注入用户 JWT |

### 云路径不能混为一谈

- [Azure local-editor](../../packages/azure-sdk/src/local-editor.ts) 每个请求创建共享 DocumentSession。共享 session 的内存去重不能跨请求生效；本轮用“重建实例”单测验证基础事实，未启动 Azure 服务。
- [Cloudflare editor-do-svalue](../../packages/cloudflare-sdk/src/editor-do-svalue.ts) 有自己的 SQL、pending commit 和重建逻辑；opId 仍在 recentOps Map 中，但不能把共享 session 的缓存失败测试直接外推到该实现。
- 两条路径的 readonly historical API、opId receipt 和恢复语义都必须达到同一公开契约。当前单测不是部署一致性证明。

## 3. 新增特征测试与实测结果

### PSD 客户端

[测试文件](../../packages/psd-client/tests/doc-session.test.ts) 新增：

- `can derive and paint a local draft without constructing a submitting DocSession`：真实 applyOne 产生草稿、基线不变，mock RenderLike 收到操作；未验证真实 Worker。
- `does not recover an unacknowledged queue when a session is reconstructed`：第一个实例请求未 ACK 时重建，新实例 pending=0、内容为原基线，不恢复前一个实例的未提交状态。

原有用例继续覆盖自动提交、连续三条操作、409 重放、相同 opId 重试、reconcile/drain 并发和 flush。

### 共享服务端

[测试文件](../../packages/doctype-server-common/tests/session.test.ts) 新增：

- 同 ID、不同载荷仍返回旧成功，未应用新操作。
- 重建 session 后原操作实际已提交，但原 ID＋旧 baseVersion 返回 VersionConflictError。
- 快照缓存失败时 delta 和内容已经提交，但调用失败且未留下去重记录。
- HTTP `/_internal/ir?version=1` 返回当前 v2 内容及 X-Doc-Version=2，不执行历史选择。

执行结果：

```sh
pnpm --filter @unidocs/psd-client test -- tests/doc-session.test.ts
# 13 passed
pnpm --filter @unidocs/doctype-server-common test -- tests/session.test.ts
# 49 passed
```

共新增 6 条测试，两套相关测试共 62 条通过。原有 PSD 故障路径测试产生预期 warning，不是测试失败。本轮没有修改生产运行逻辑，也没有开始 iframe/UI 实现。

## 4. 本轮确定的实施边界

### 4.1 PSD 单一提交负责人

嵌入模式使用 `applyOne + RenderLike` 管理局部预览，基线和 operations 形成 checkpoint；宿主完成 prepareCommit 后提交候选。直接复用自动 drain 的 DocSession 不满足协议。

第二次小迭代已新增 [EditorDraft](../../packages/psd-client/src/editor-draft.ts) 与 [7 条测试](../../packages/psd-client/tests/editor-draft.test.ts)：串行本地编辑、prepare 时立即冻结新输入、稳定候选、拒绝后保留原基线、unknown 冻结直到明确结果、迟到重复结果不清理新草稿、渲染失败时恢复原内容。它不持有 fetch 或后端地址，由宿主消费候选。

已运行 `pnpm --filter @unidocs/psd-client test -- tests/editor-draft.test.ts tests/doc-session.test.ts`，20 条通过，原 DocSession 行为未改。宿主提交使用测试替身，尚未接真实 RenderClient/Worker、bridge、IndexedDB 或后端；候选载荷所有权、跨重载持久恢复仍需后续验证。当前不是完整可部署编辑器，也尚未导出为稳定公共 API。

不能用“fetchImpl 返回伪造成功”阻断网络：那会让 DocSession 错误推进版本并清空 pending。也不能简单把 applyLocal 改成不 drain，而保留 reconcile 自动重放／flush 自动提交的旁路。

### 4.2 私有草稿

采用计划中的 v0 默认方案：未提交评论和编辑 checkpoint 在宿主本地 IndexedDB，按授权身份／tenant/doc/draftId 隔离。集中提交后才进入服务端可被 Agent 查询的反馈接口。尚未实现 IndexedDB。

不新增“共享用户 JWT 但服务端凭空知道调用者是人还是 Agent”的权限假设。未来需要跨设备私有草稿时再引入明确的 scope／端点隔离方案；本地保留同样要执行退出登录、共享设备与存储配额策略。

### 4.3 只读历史重建补丁（待实现）

Owner：protocol-doc、doctype-server-common、Cloudflare SValue session、Gateway 转发及资源授权。

- 先定义一个确切版本的 readonly state 契约，再决定 IR 参数或独立路由。验证参数必须为正安全整数；未知版本返回明确错误。
- 复用 snapshot+replay 的必要逻辑，但不调用 rollback，不修改 head、当前 session doc 或快照缓存标签。
- 处理 create/import/clone/restore 的历史语义。当前 history 对部分非 apply 事件返回空 operations，不能仅依靠公开 operations 重放；共享 rollback 的合成空 delta 同样要求仔细核实。
- 必须测试跨 snapshot threshold、rollback 后版本、上传初始内容、cache 丢失、引用 SBlob 缺失和当前写入并发。
- 资源访问随目标版本授权，不能因为拿到 snapshot hash 就放宽访问。标题与 tag 历史也不能从文档正文版本凭空推导。

### 4.4 持久提交结果补丁（待实现）

Owner：两个 session 实现及其持久端口、protocol-doc、Gateway 权限策略和公共转发。

- receipt key 按不可变 tenant/session 和 opId 隔离；绑定原 baseVersion、operations、description 的规范化摘要，以及最终版本。
- 同一 ID 相同请求返回原结果；不同请求拒绝。保留期限与过期后查询状态必须明确，未知／过期不自动解释为 rejected。
- receipt 与实际提交事实需要事务或可恢复日志关联；不能在 apply 完成后单独 best-effort 写一张表。CAS root 提交、delta 条件写、缓存失败和崩溃窗口都需定义。
- 核实接口区分 committed、确定拒绝和 unknown/pending；head 增长和载荷相似不能证明本次操作成功。
- 不直接改变现有 opId 的全部行为：旧 DocSession 409 后会沿用 ID、改 baseVersion。严格载荷绑定启用时需兼容策略，不能破坏 standalone 重放。
- 新嵌入客户端在 receipt 未可用前，只能在不确定结果时保留候选并禁止盲写；不应将这种降级宣称为完整 P2 完成。

## 5. 尚未完成的 P0 Gate

第 09 轮第四切片更新：Cloudflare Markdown 已在默认关闭的实验开关后将 journal 与真实 pending／delta／snapshot 完成事务关联。CAS 确认前后故障、跨重启原 receipt、旧写互斥、快照阈值恢复的 5 条本地集成测试通过；共享适配器明确拒绝未支持的实验字段。独立核实 API、全部崩溃窗口、Azure 持久实现及生产验收仍缺失，不勾选跨云保存 gate。当前能力以 [第 09 轮最新记录](iteration-09.md) 为准，以下切片说明为历史进度。

第 09 轮第二切片更新：本地 Miniflare 已验证 CAS 成功后注入响应丢失、持久目录重启、pending 恢复及 roots 幂等；原 opId 仍返回 409。新增 receipt 状态校验和完整 SHA-256／规范 SValue 载荷摘要工具，尚未接持久端口或 HTTP 路由。协议包 77 条、共享核心 267 条、相关 Cloudflare 集成 5 条通过；详见 [第 09 轮记录](iteration-09.md)。不勾选跨云持久核实 gate 完成。

2026-09-07 第 09 轮补充：[首个故障测试切片](iteration-09.md) 新增 2 条共享 session 测试，51 条 session 测试通过。CAS 响应丢失后补偿可能复用相同 root-ref 请求 ID；并发推进 head 时，返回 RootRefsError 的 delta 可能仍被保留并重放。receipt 不能仅以 delta 存在或异常类型判断终态。该结果来自内存／CAS 替身，不代表 Cloudflare SValue 或生产 CAS 已验证。

- [ ] 真正的 embedded draft adapter 探针：本地编辑零 apply，用户保存一个批次一次 apply，未知结果不重试；覆盖真实 RenderClient／Worker 资源边界。
- [ ] Cloudflare SValue session 对应故障注入与重建测试；Azure 请求级适配测试，不仅是共享内存端口测试。
- [ ] 历史重建在 restore/import/clone 上的完整正确性，引用依赖和 GC 生命周期，固定字体／渲染资源的策略。
- [ ] editor descriptor 的具体公共 schema、批准入口／origin/build 配置与部署验证。
- [ ] protocol v0 尚抽象的 initialize/leave/cancel/commit 核实 schema 收敛为可执行校验。
- [ ] IndexedDB checkpoint／提交意图与身份清理策略的契约测试，以及 Agent 已发布反馈接口 owner 的确定。

不勾选 P0 全部完成。按用户要求小步迭代，下一批优先把 EditorDraft 接到可见的真实引擎试验页面，明确标注模拟提交；只读历史重建和持久 receipt 继续作为真实服务集成 gate，不阻塞只读／本地编辑体验的早期展示。已授权新界面直接替换线上旧页面，但本轮未部署。