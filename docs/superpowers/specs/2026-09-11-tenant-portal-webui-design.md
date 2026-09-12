# Tenant Portal WebUI 设计

状态：已评审，待实施。2026-09-11。
基线：`ca478ad`。
分支：`feat/tenant-portal-webui`。

## 1. 目标与范围

实现 `@unidocs/tenant-portal-webui` —— 普通用户使用的 Web 界面，以及它依赖的
`@unidocs/tenant-portal-client`。

### 1.1 设计依据

行为依据是 [`docs/design/platform-v0/tenant/tenant-webui-v0.md`](../../design/platform-v0/tenant/tenant-webui-v0.md)：
评论驱动、内容对人只读、选中一处进入分屏对照。协议依据是
[`docs/design/platform-v0/agent-mediated-document-collaboration.md`](../../design/platform-v0/agent-mediated-document-collaboration.md)
与 `@unidocs/protocol-platform` 的 `PlatformEndpointContracts`、`ViewRpcContracts`、
`HostRpcContracts`。

视觉语言沿用 [`docs/design/unidocs-mock.css`](../../design/unidocs-mock.css) 的低饱和
灰白工作空间，但**不 import 该文件**——它有 1592 行，其中大部分服务于 v0 已经废除的
源码编辑器与双栏编辑。样式按组件重写。

`docs/design/unidocs-mock.html` 是更早的完整原型，含 Markdown 双栏编辑、PSD 画布编辑、
「一轮反馈」批量提交和解决/重新打开按钮。`tenant-webui-v0.md` §2.1、§2.4、§2.6 明确移除
了这些路径。**冲突处一律以 `tenant-webui-v0.md` 为准**，mock 只用作视觉与工作台形态的参考。

### 1.2 本轮范围

做：

- 两个新包的脚手架与工作区接线。
- `tenant-portal-client`：`PlatformEndpointContracts` 全部 operation，可替换 transport。
- 内存假后端 transport，含脚本化 Agent（写入 ping 后延时产出 pong 与新版本）。
- 我的作品列表（`tenant-webui-v0.md` §4）。
- Markdown 分屏对照（§2.2、§2.3）与右栏四种情况。
- 评论发送、追加、本地草稿、「修改已发送的评论」（§2.6、§2.7）。
- thread 状态派生（§2.1）。

不做：

- 全屏版本回看与 base parent 链 / comment provenance（§2.5）——另起一轮。
- PSD 位置类型（§3）——另起一轮。
- 真实 iframe 隔离与独立 origin 的 View bundle（§6 列为范围外）。
- 真实后端。`portal-service` 只实现了 admin 面，tenant 数据面不在本轮。
- 编辑型 ping（§5.1 整节绕过）、子文档评论归属（§5.2）、窄屏降级（§5.3）。
- 真实登录。假后端下身份是固定样例值，不是安全实现。

### 1.3 命名

`tenant` 指组织与租户平面（`tenantId`、tenant HTTP contract）。面向普通用户的门户界面
叫 **Tenant Portal**，与 Admin Portal 对位。包名 `@unidocs/tenant-portal-webui` 来自
[`platform-v0/README.md`](../../design/platform-v0/README.md) 的「新实现包命名」，两端一致。

注：`origin/tenant-ui-thread-redesign` 上有一个未合并的提交 `1384dbf`，把
`docs/design/platform-v0/tenant/` 改名为 `portal/`。本文按当前 `main` 的路径书写；该分支
合并后本文的文档链接需要同步更新。它不影响包名——`@unidocs/tenant-portal-webui` 在两边
都稳定。

## 2. 包边界与依赖方向

```text
packages/tenant-portal-client/    @unidocs/tenant-portal-client
packages/tenant-portal-webui/     @unidocs/tenant-portal-webui

tenant-portal-webui -> tenant-portal-client -> protocol-platform
```

方向照抄 `platform-v0/README.md` 已定的分层，不反向依赖，webui 不直接 import
`protocol-platform` 之外的协议包。

### 2.1 `@unidocs/tenant-portal-client`

把 `PlatformEndpointContracts` 的 13 个 operation 变成可调用方法，参数与返回类型从
contract 推导，不手写第二份：

```ts
export interface TenantPortalClient {
  listPublicDocumentTypes(query?: PageQuery): Promise<ListPublicDocumentTypesResponse>;
  getDocumentContract(documentType: DocumentType, idx: DocumentContractIdx): Promise<DocumentContractRecord>;
  listDocuments(query?: ListDocumentsQuery): Promise<ListDocumentsResponse>;
  createDocument(body: CreateDocumentRequest): Promise<DocumentRecord>;
  getDocument(documentId: DocumentId): Promise<DocumentRecord>;
  listVersions(documentId: DocumentId, query?: PageQuery): Promise<ListVersionsResponse>;
  getVersion(documentId: DocumentId, versionIdx: VersionIdx): Promise<VersionRecord>;
  moveCurrentVersion(documentId: DocumentId, body: MoveCurrentVersionRequest): Promise<DocumentRecord>;
  listThreads(documentId: DocumentId, query?: ListThreadsQuery): Promise<ListThreadsResponse>;
  createThread(documentId: DocumentId, key: string, body: CreateThreadRequest): Promise<ThreadDetail>;
  getThread(documentId: DocumentId, threadId: ThreadId): Promise<ThreadDetail>;
  appendPing(documentId: DocumentId, threadId: ThreadId, key: string, body: AppendPingRequest): Promise<PingRecord>;
  issueCasCapability(): Promise<CasCapabilityGrant>;
}
```

`tenantId` 在构造时固定，不出现在每个方法签名里。

client 自己不含 `fetch`。构造时注入 transport：

```ts
export interface PlatformTransport {
  (request: PlatformRequest): Promise<PlatformResponse>;
}

export function createTenantPortalClient(options: {
  tenantId: TenantId;
  transport: PlatformTransport;
}): TenantPortalClient;
```

错误：transport 返回 `ApiError` 时，client 抛 `PlatformError`，带 `code: PlatformErrorCode`、
`requestId` 与 `message`。调用方按 `code` 分支，不解析文案。

#### 两个 transport

`createHttpTransport({ baseUrl, tenantId })` —— 按 `platform.ts` 顶部注释的路径模板拼 URL，
`idempotencyKey` 走请求头。本轮写出来并做单元测试，但没有服务可连。

`createMemoryTransport({ seed })` —— 假后端，放在 client 包内 `src/memory/`。它实现的是
*contract*，webui 不该知道它存在。职责：

- 在内存里维护 documents / versions / threads / pings / pongs，用 localStorage 持久化，
  刷新不丢（node 环境下退化为纯内存）。
- 真实实现 idempotency key：同 key 同内容重放原结果，同 key 不同内容返回
  `idempotency_conflict`。
- 真实返回 `version_conflict`（`moveCurrentVersion` 的 `observedCurrentVersionIdx` 不匹配）、
  `not_found`、`invalid_request`。
- 脚本化 Agent：ping 写入后延时产出一条 pong。pong 分两种——纯 pong（只回复，
  `resultLocations` 为空，不产生新版本）与产生新版本的 pong（`respondThroughPingIdx`
  推进水位，`resultLocations` 指向新版本里的位置）。两种都要出现在样本数据里，§4 的
  右栏判定和 §5 的作品卡片都依赖这个区分。
- 延时与是否产生新版本可脚本化控制，测试里可以同步驱动、不依赖 wall clock。

样本数据至少覆盖：一篇有多处讨论的 Markdown、一处待回复、一处已回复且 pong 产生新版本、
一处基于旧版本且内容仍在、一处基于旧版本且内容已被改写、一处纯 pong。

### 2.2 `@unidocs/tenant-portal-webui`

React 19 + Vite + Vitest + `@testing-library/react`，与 `@unidocs/web-gateway` 同栈同配置
风格。`package.json` 的 `exports`、`scripts`（`build` / `dev` / `typecheck` / `test` /
`clean`）照 web-gateway 的形状，保证 `pnpm -r build`、`pnpm -r typecheck`、`pnpm -r test`
自动带上它。tsconfig 加入根 `tsconfig.json` 的 `references`。

## 3. 渲染层：本地 View adapter

View 在目标架构里是隔离 iframe（`protocol-platform/src/view.ts`）。本轮跑在同进程，但
**走同一套消息契约**，这样以后换 iframe 只替换通道实现，分屏与讨论面板不重写。

```text
ViewHost (host 侧)              ViewChannel              MarkdownView (view 侧)
  host.readBlob          <----------------------------    view.initialize
  host.listThreads                                        view.loadSnapshot
  host.getThread                                          view.setViewport
  host.createThread                                       view.setMarkers
  host.appendPing                                         view.focusLocation
  host.storeBlob                                          view.dispose
```

`ViewChannel` 是唯一的跨界接口：

```ts
export interface ViewChannel {
  callView<M extends keyof ViewRpcContracts>(
    method: M,
    request: ViewRpcContracts[M]["request"],
  ): Promise<ViewRpcContracts[M]["response"]>;
  dispose(): void;
}

export function createLocalChannel(options: {
  view: ViewImplementation;
  host: HostImplementation;
}): ViewChannel;
```

本轮 `createLocalChannel` 是直接函数调用（仍走 `Promise`，保持异步语义，避免以后换
`postMessage` 时暴露出同步假设）。换 iframe 时新增 `createPostMessageChannel`，上层不动。

`MarkdownView` 实现 view 侧六个方法：`loadSnapshot` 用 marked 解析、DOMPurify 清理并渲染；
`setMarkers` 按 marker 在正文里套高亮；`focusLocation` 解析
`unidocs.markdown.text-range/v1` 的 payload，返回 `{ located, reason }`。

**分屏左右两栏是两个独立 View 实例**，各自 `initialize` 一个 `ViewContext`（`viewVersion`
不同）、各自 `loadSnapshot`、各自 `setMarkers`。

### 3.1 两个评论入口的归属

按协议划分，不是按视觉位置划分：

- **新评论**（选中正文 → 选区上方浮出「添加评论」）归 View。只有 View 拿得到选区并能把它
  编码成 `DocumentLocation`，所以它调 `host.createThread`。
- **追加回复**（讨论面板里某一处的「回复」按钮）归 host。host 已经知道 `threadId`，直接调
  client 的 `appendPing`。

这与 `tenant-webui-v0.md` §2.6 描述的两个入口正好对上。两处输入框都由动作触发，不常驻；
面板上没有常驻输入区，也没有底部批次提交条。

### 3.2 marker role：本轮的临时类型

`ViewSetMarkersRequest.markers` 当前形状是 `{ threadId, pingIdx, open, location }`，区分不了
「这是 ping」「这是 pong 结果」「这是已过时的 ping」。§4 的四种右栏渲染需要这个区分。

**本轮不改 `protocol-platform`。** webui 内部定义自己的类型顶着：

```ts
// tenant-portal-webui 本地类型，待协议补齐后移除
export type MarkerRole = "ping" | "pong-result" | "stale-ping";

/** `ViewSetMarkersRequest["markers"][number]` 目前是 view.ts 里的内联类型，没有导出名。 */
export type ProtocolMarker = ViewSetMarkersRequest["markers"][number];

export interface RoledMarker extends ProtocolMarker {
  readonly role: MarkerRole;
}
```

集中在一个文件里，文件头注明这是等待协议补齐的临时定义，以便协议定稿后一处替换。

### 3.3 讨论计数：本轮的 N+1

`ListThreadsResponse` 是 `Page<ThreadRef>`，`ThreadRef` 只有 `threadId`；`DocumentRecord` 里
没有讨论计数。而 §5 的作品卡片要显示「N 处待回复 / Agent 已回复 N 处」。

**本轮不改 `protocol-platform`。** 列表页对每个 thread 发一次 `getThread` 来算计数。假后端
下没有性能问题。这个 N+1 集中在一个 `loadDocumentDiscussionSummary` 函数里，协议补齐后
只改这一个函数。

§3.2 与 §3.3 两处缺口写入 `docs/design/platform-v0/tenant/TODO.md`，等协议设计定稿后回来做。

## 4. 分屏对照

### 4.1 布局

无选中时：current 单栏只读 + 讨论面板列出全部 thread。

选中一处时（§2.2）：左栏渲染该 ping 的基版（灰底、只读徽标、绿色高亮 ping location），
右栏渲染 current，最右是 316px 讨论面板。不做浮窗方案。

选中一处内的某一条具体评论时（§2.3）：左栏切到那条评论的基版和它的高亮。评论卡片上标出
各自的版本号，落后 current 时另标「基于 vN · 已过 N 版」。

### 4.2 右栏四种渲染

按顺序判定，命中即停：

| 条件 | 右栏 |
| --- | --- |
| 存在 pong 且 `respondThroughPingIdx >= pingIdx` | 金色高亮该 pong 的 `resultLocations` |
| `ping.baseVersionIdx === currentVersionIdx` | 不重复高亮，标「暂无改动 · 与左栏同一版本」 |
| 基于旧版本、无覆盖的 pong，且 `view.focusLocation` 返回 `located: true` | 灰底虚线标出对应位置，并明说这不是 Agent 的改动 |
| 同上但 `located: false` | 不高亮，改为一条说明 |

第三、四种的区分**由 View 回答**，host 不猜。`ViewFocusLocationResponse` 的
`{ located, reason }` 契约里已经有了，这正是它的用途。平台不做语义迁移，也不因为 current
前移就作废旧版本上的评论（§2.2 / 协议 §5.4、§8.2）。

第三、四种的常见成因不是用户自己改的，而是 Agent 处理**别的**一处评论时顺带改掉了这段
内容。文案要说清这一点，不能让用户以为是对自己那条评论的回应。

`tenant-webui-v0.md` §5.4 留了一个未决项：ping 就写在 current 上时左右两栏同版、信息量为零，
是否自动收成单栏。**本轮的选择是不自动收**——保持两栏，右栏给出「暂无改动 · 与左栏同一版本」
的说明。理由是切换评论时布局不跳动，用户不会因为版本关系变化而丢失空间参照。此项记入
未决，可按实际体验推翻。

## 5. 页面与组件分解

```text
WorkbenchPage  /
├── AgentLatestReplyStrip              顶部「Agent 最新回复」
├── DocumentFilters                    关键词 + 类型
└── DocumentCard[]                     讨论状态 + 未发送条数

DocumentPage   /d/:documentId
├── DocumentTopBar                     标题 + 「只读 · 内容由 Agent 编辑」徽标
├── ComparePane                        无选中 = current 单栏；选中一处 = 分屏
│   ├── VersionPane(base)              ViewHost + 灰底 + 只读徽标 + 绿色高亮
│   └── VersionPane(current)           ViewHost + 四种情况之一
└── ThreadPanel (316px)
    ├── ThreadFilter                   全部 / 待回复 / 已回复 / 未发送
    └── ThreadCard[]
        ├── PingCard[]                 vN 徽标 +「基于 vN · 已过 N 版」+「修改」
        ├── PongCard[]                 中性色
        ├── DraftBlock                 黄色虚线块
        └── ReplyButton → ReplyComposer
```

顶栏是一枚「只读 · 内容由 Agent 编辑」标识（§2.4）。没有源码编辑器、没有双栏编辑、没有
用户自己推新版本的路径。

`AgentLatestReplyStrip` 与 `PongCard` 的文案必须明确 **pong 只表示已处理，不表示你已接受**；
不同意就在原处追加一条评论。纯 pong（只回复、没有产生新版本）用中性色标识，**不能穿版本号
的衣服**（§4）。

版本下拉与全屏回看（§2.5）不在本轮，`DocumentTopBar` 为它留出位置但不渲染入口。

## 6. 状态与草稿

### 6.1 thread 状态纯派生

不存标志位：

```ts
// createThread 必带第一条 ping，所以 pings 非空是协议不变量；仍给出显式下界。
const acknowledged = Math.max(-1, ...pongs.map((p) => p.respondThroughPingIdx));
const latestPingIdx = Math.max(-1, ...pings.map((p) => p.pingIdx));
const open = latestPingIdx > acknowledged;
```

所以界面上没有「解决 / 重新打开」按钮（§2.1）。追加一条 ping 自动让该处从「已回复」变回
「待回复」——这不是一个可切换的标志，是水位关系的结果。

### 6.2 草稿

`useDrafts(documentId)` 存 localStorage。按 `documentId` + 锚点分组，**同一锚点可以并存多份**
（§2.7）：写到一半切去看别处不会丢。

- 面板顶部显示「N 条未发送」，筛选里有「未发送」一档。
- 收起的草稿在该处卡片底部留一块黄色虚线块。
- 作品列表的卡片上也标出未发送条数。
- 草稿只在本地，Agent 看不到。

每份草稿在**创建时**就生成并持久化 `idempotencyKey`。发送失败后重试复用同一个 key，真后端
接上时幂等语义天然成立，不会因为重试产生两条 ping。

### 6.3 已发送的评论不可改

已发送的评论不可编辑也不可删除——协议里 ping 追加即存在，而且它可能已经在被 Agent 处理。
「修改」是这样一条路径（§2.7）：

1. 原文留在原地，并标出此刻状态：水位未覆盖它 = **正在执行**，已覆盖 = 已处理；
2. 你改的那份压回草稿，注明「改自评论 N」；
3. 发送时作为同一处的**新一条**追加，于是它落在水位之后，该处自动从「已回复」变回「待回复」。

不做撤回。协议层没有定义「撤回」是什么。

## 7. 错误与空状态

| 情形 | 处理 |
| --- | --- |
| `currentVersionIdx === null` | 文档初始化中的独立空态，不渲染分屏 |
| 作品列表为空 | 引导创建，不伪造样例卡片 |
| 文档无讨论 | 「暂无讨论」空态 + 提示选中正文可添加评论 |
| 发送失败（任何 code） | **一律保留草稿**，面板上就地重试，复用原 `idempotencyKey` |
| `version_conflict` / `pong_watermark_conflict` / `idempotency_conflict` | 映射为中文文案，不把错误码弹给用户 |
| `unauthorized` / `forbidden` | 回登录态。假后端下不触发 |
| `not_found` | 文档或一处已不存在的说明页 |
| View `loadSnapshot` 失败 | 该栏单独降级为错误块，另一栏与讨论面板继续可用 |

原则：任何失败都不吞掉用户写的字。

## 8. 测试策略

TDD。先写测试，再写实现。

`tenant-portal-client`（vitest，node 环境）：

- 13 个 operation 的请求构造与响应解码。
- idempotency：同 key 同内容重放原结果；同 key 不同内容返回 `idempotency_conflict`。
- `moveCurrentVersion` 的 `observedCurrentVersionIdx` 不匹配时返回 `version_conflict`。
- `ApiError` 到 `PlatformError` 的映射保留 `code` 与 `requestId`。
- 脚本化 Agent 可同步驱动，不依赖 wall clock。

`tenant-portal-webui`（vitest + jsdom + testing-library），按 `tenant-webui-v0.md` 的用户
路径写：

- 打开文档默认单栏 current；选中一处后左栏渲染的是该 ping 的基版。
- 点某一条具体评论，左栏切到那条的基版（§2.3）。
- 选中正文 → 浮出「添加评论」 → 发送 → 该处出现在「待回复」。
- Agent pong 到达 → 该处变「已回复」，右栏金色高亮 result location。
- 追加一条评论 → 该处自动变回「待回复」（§2.1，验证是派生不是标志位）。
- 右栏四种情况各一例，含 `located: false` 的说明文案。
- 纯 pong 不显示版本号，用中性色（§4）。
- 「修改」已发送评论 → 内容压回草稿并标注「改自评论 N」 → 发送成为同一处新一条。
- 草稿跨 thread 切换、跨页面刷新不丢；同一锚点可并存多份。
- 发送失败后草稿保留，重试复用同一 `idempotencyKey`。
- 界面上不存在「解决」「重新打开」按钮，也不存在批量提交条。

## 9. 交付切分

六个 PR，每个独立可验收：

1. 两个包脚手架 + 工作区接线 + `tenant-portal-client` + `createMemoryTransport`（含脚本化
   Agent 与样本数据）+ `createHttpTransport`。
2. `ViewChannel` + `createLocalChannel` + `MarkdownView`（`loadSnapshot` / `setMarkers` /
   `focusLocation`）。
3. 我的作品列表（`WorkbenchPage`、卡片讨论状态、筛选、Agent 最新回复条）。
4. 文档页单栏 + 讨论面板只读（thread 状态派生、筛选、ping/pong 卡片）。
5. 分屏对照与右栏四种情况。
6. 评论发送 / 追加 / 草稿 / 「改自评论 N」/ 错误与重试。

## 10. 验证

```text
pnpm --filter @unidocs/tenant-portal-client test
pnpm --filter @unidocs/tenant-portal-webui test
pnpm typecheck
git diff --check
```

## 11. 未决

- `ViewSetMarkersRequest` 的 marker role（§3.2）与 thread 列表的讨论计数（§3.3），等协议
  设计定稿后回来做。本轮用 webui 本地类型与 N+1 顶着。
- ping 就写在 current 上时是否自动收成单栏（§4.2）。本轮选择不收，可按体验推翻。
- 全屏版本回看、PSD 位置类型、真实 iframe 隔离、真实后端与登录，均另起轮次。
- 窄屏与移动端降级未定（`tenant-webui-v0.md` §5.3）。本轮沿用 mock 的做法：窄于 760px
  显示「请在电脑或平板上查看」。
- §4.2 说右栏第三、四种（灰底虚线 / 不高亮只给说明）的区分应该**由 View 回答**——host 不猜，
  这正是 `ViewFocusLocationResponse` 的 `{ located, reason }` 存在的原因。实现里
  `model/compare.ts` 没有走这条路：它直接在 host 侧调 `resolveMarkdownTextRange(ping.location,
  currentContent)` 来做这个判断，是本轮对 spec 的偏离，没有当时记下来。后果是 `view.focusLocation`
  与 `view.setViewport` 虽然实现了、也有单测覆盖，但没有任何 host 代码真的调用它们。把这个判断
  路由回 channel、真正问 View，是一次不小的改造（不能塞进一个 `useMemo` 里），本轮没有做；
  PSD 位置类型落地之前必须先做——因为只有 View 自己认识它拥有的那个位置类型，host 侧猜不出来。
  过渡期内 `model/compare.ts` 已经加了一层保护：`locationType` 不是它认识的 Markdown 文本区间时，
  不会被误判成「已经不在当前版本里」，而是给一条诚实的「判断不出来」。
