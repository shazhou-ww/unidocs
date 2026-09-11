/**
 * Simplified Chinese overlay for the generated Tenant API document.
 *
 * The oRPC contract stays English: it is the source of truth, and the English
 * OpenAPI document is generated from it unchanged. This table is keyed by the
 * exact English string so a reworded contract shows up as a missing
 * translation rather than silently shipping stale Chinese, and so one entry
 * covers every place oRPC inlines that string.
 *
 * Regenerate the documents with `pnpm --filter @unidocs/protocol-tenant-portal docs:generate`.
 */
/** Tag names double as the reference's navigation headings. */
export const zhTenantApiTagNames: Readonly<Record<string, string>> = {
  "Document types": "文档类型",
  Documents: "文档",
  Versions: "版本",
  // Thread, ping and pong stay in English throughout the prose as well: they
  // are protocol words, and the product UI deliberately never shows them.
  Threads: "Thread",
  Audit: "审计",
  CAS: "CAS",
};

export const zhTenantApiStrings: Readonly<Record<string, string>> = {
  ["End-user data-plane API for the UniDocs Platform.\n\nThe Platform is the single persistent authority for documents, immutable versions, the current pointer, position-anchored threads, and content references. People contribute comments; only an Operator Agent produces versions, so this API has no operation that edits document content.\n\nA thread's open state is derived, never stored: a thread is open while its latest ping is beyond the cumulative pong watermark. There is therefore no resolve or reopen operation, and pings are immutable — a correction is a new ping on the same thread.\n\nEvery request supports either a Bearer token or the same-origin tenant session cookie. If an `Authorization: Bearer` header is present, the server uses only that token and must not fall back to cookie authentication when token authentication fails; this is how an Operator Agent reads the same authoritative data as a user, with `documents:read`, `comments:read`, and `cas:read` scopes. Mutations authenticated by cookie additionally require `X-CSRF-Token`; Bearer-authenticated mutations do not. Creating a document, a thread, or a ping requires `Idempotency-Key`; moving the current pointer does not, because `observedCurrentVersionIdx` is already an equality lock.\n\nThe Platform never proxies UniCAS node traffic. Rich message bodies, attachments, and large binary values inside a snapshot are `CasBlobRef` / `SBlob` references that the caller reads directly from UniCAS with a short-lived tenant capability."]:
    "UniDocs Platform 面向最终用户的数据面 API。\n\nPlatform 是文档、不可变版本、current 指针、位置锚定 thread 和内容引用的唯一持久权威。人只产出评论，版本只由 Operator Agent 生成，因此本 API 没有任何编辑文档内容的 operation。\n\nthread 的 open 状态是推导出来的，不是存储的：最新 ping 超过累计 pong 水位时该 thread 即为 open。所以这里没有「解决」或「重新打开」操作；ping 也不可变——改正的做法是在同一处追加一条新 ping。\n\n每个请求支持 Bearer token 或同源 tenant session cookie 两种鉴权。带 `Authorization: Bearer` 时服务端只验这个 token，验证失败也不得回落到 cookie；Operator Agent 正是以此读取与用户相同的权威数据，使用 `documents:read`、`comments:read` 和 `cas:read` scope。用 cookie 鉴权的 mutation 额外要求 `X-CSRF-Token`，Bearer 鉴权则不需要。创建文档、thread 和 ping 要求 `Idempotency-Key`；移动 current 指针不要求，因为 `observedCurrentVersionIdx` 本身就是等值锁。\n\nPlatform 从不代理 UniCAS 的 node 流量。富文本正文、附件以及 snapshot 内的大块二进制都是 `CasBlobRef` / `SBlob` 引用，由调用方持短期 tenant capability 直接从 UniCAS 读取。",
  ["The catalog of enabled document types and the immutable paired contract revisions that validate their snapshots and locations."]:
    "已启用文档类型的目录，以及校验其 snapshot 与 location 的不可变配对 contract revision。",
  ["Document identity, the current version pointer, and the audited move of that pointer. Creating a document notifies its Operator, which commits the first snapshot."]:
    "文档身份、current 版本指针，以及对该指针的受审计移动。创建文档会通知其 Operator，由 Operator 提交首个 snapshot。",
  ["Immutable versions in birth order. Metadata carries both graphs — the base parent forest and comment provenance — while snapshot bytes are read one version at a time."]:
    "按出生顺序排列的不可变版本。元数据同时承载两张图——base parent forest 与 comment provenance——snapshot 字节则逐个版本单独读取。",
  ["Position-anchored discussions holding an append-only user ping sequence and an append-only Agent pong sequence."]:
    "位置锚定的讨论，持有只追加的用户 ping 序列和只追加的 Agent pong 序列。",
  ["Immutable document-level events, recorded because moving the current pointer changes the baseline later versions and submissions are built on."]:
    "不可变的文档级事件。移动 current 指针会改变后续版本与 submission 所依据的基线，因此必须审计。",
  ["Short-lived tenant capabilities for reading and writing UniCAS content directly, without routing bytes through the Platform."]:
    "用于直接读写 UniCAS 内容的短期 tenant capability，字节不经过 Platform 中转。",
  ["Platform OAuth access token. Its presence selects Bearer authentication exclusively; an invalid token never falls back to the session cookie. Agent scopes are `documents:read`, `cas:read`, `cas:lease`, `comments:read`, `comments:pong`, and `versions:submit`; this API uses the read scopes, and `versions:submit` belongs to the separate Agent submission API."]:
    "Platform OAuth access token。只要存在就只走 Bearer 鉴权；token 无效时绝不回落到 session cookie。Agent 的 scope 为 `documents:read`、`cas:read`、`cas:lease`、`comments:read`、`comments:pong` 和 `versions:submit`；本 API 使用其中的读 scope，`versions:submit` 属于独立的 Agent submission API。",
  ["HttpOnly same-origin end-user session cookie"]:
    "HttpOnly 同源最终用户 session cookie",
  ["CSRF token required for mutations authenticated with the session cookie"]:
    "使用 session cookie 鉴权的 mutation 所需的 CSRF token",
  ["List document types available for creation"]:
    "列出可创建的文档类型",
  ["Returns the cursor-paginated catalog of enabled document types. Every entry has a current Type Card bundle, a current View bundle, and a non-empty set of contract revisions the View and built-in Operator both support. Type Card asset paths are already resolved to absolute bundle-origin URLs; the caller performs RFC 4647 locale lookup over `typeCard.locales` and finally falls back to `en`."]:
    "返回已启用文档类型的 cursor 分页目录。每一项都有当前 Type Card bundle、当前 View bundle，以及 View 与内建 Operator 共同支持的非空 contract revision 集合。Type Card 的资源路径已解析为 bundle origin 下的绝对 URL；调用方对 `typeCard.locales` 做 RFC 4647 locale lookup，最终回退到 `en`。",
  ["Tenant that owns the addressed resources."]:
    "拥有所寻址资源的 tenant。",
  ["Opaque cursor returned by the previous page."]:
    "上一页返回的不透明 cursor。",
  ["Maximum number of records to return, from 1 through 100."]:
    "单次返回的最大记录数，取值 1 到 100。",
  ["Stable document type identifier."]:
    "稳定的文档类型标识符。",
  ["Currently selected Type Card bundle identity."]:
    "当前选中的 Type Card bundle 身份。",
  ["Localized document type display name."]:
    "本地化的文档类型显示名称。",
  ["Localized document type description."]:
    "本地化的文档类型描述。",
  ["Localized accessible text for the sample thumbnail."]:
    "sample thumbnail 的本地化无障碍替代文本。",
  ["Localized card content keyed by BCP 47 tag; the `en` fallback is required."]:
    "按 BCP 47 标签索引的本地化卡片文案；必须包含 `en` 回退项。",
  ["Absolute bundle-origin URL of the size-independent SVG icon."]:
    "与尺寸无关的 SVG 图标在 bundle origin 下的绝对 URL。",
  ["Absolute bundle-origin PNG URLs for every required raster size."]:
    "每个必需栅格尺寸的 PNG 在 bundle origin 下的绝对 URL。",
  ["SVG or complete predefined-size PNG icon set."]:
    "SVG 图标，或一整套预定义尺寸的 PNG 图标。",
  ["Absolute bundle-origin URL of the sample thumbnail."]:
    "sample thumbnail 在 bundle origin 下的绝对 URL。",
  ["User-facing creation card projected from the current manifest."]:
    "由当前 manifest 投影出的用户侧创建卡片。",
  ["Currently selected View bundle identity."]:
    "当前选中的 View bundle 身份。",
  ["Zero-based paired Document Contract revision within one document type."]:
    "文档类型内从 0 开始的配对 Document Contract revision。",
  ["Revisions the current View and built-in Operator both support; not chosen by index order."]:
    "当前 View 与内建 Operator 共同支持的 revision；不按 idx 大小隐式选择。",
  ["Read one paired Document Contract revision"]:
    "读取一个配对 Document Contract revision",
  ["Returns the immutable revision that validates a given snapshot and its locations, including both schemas, their canonical hashes, and the derived snapshot and location media types. The highest index is not privileged; any revision named by a version or location can be read."]:
    "返回校验某个 snapshot 及其 location 的不可变 revision，包含两份 schema、它们的规范哈希，以及派生出的 snapshot 与 location 媒体类型。最大 idx 不享有特殊地位；任何被版本或 location 指名的 revision 都可读取。",
  ["MIME-safe document type identifier."]:
    "MIME 安全的文档类型标识符。",
  ["Document type owning this revision."]:
    "拥有该 revision 的文档类型。",
  ["Assigned paired contract revision."]:
    "已分配的配对 contract revision。",
  ["Wire encoding version; it is independent from the schema revision."]:
    "线编码版本；与 schema revision 相互独立。",
  ["Snapshot media type derived from documentType and formatVersion."]:
    "由 documentType 与 formatVersion 派生的 snapshot 媒体类型。",
  ["UniDocs SValue JSON Schema dialect identifier."]:
    "UniDocs SValue JSON Schema dialect 标识符。",
  ["When true, this schema node matches an atomic SBlob reference."]:
    "为 true 时，该 schema 节点匹配一个原子 SBlob 引用。",
  ["Allowed media types for an SBlob matched at this schema node."]:
    "该 schema 节点所匹配 SBlob 允许的媒体类型。",
  ["Schema validating the document SValue."]:
    "校验文档 SValue 的 schema。",
  ["Canonical digest of the snapshot schema."]:
    "snapshot schema 的规范摘要。",
  ["Location media type derived from documentType and formatVersion."]:
    "由 documentType 与 formatVersion 派生的 location 媒体类型。",
  ["Schema validating the locationType and payload projection."]:
    "校验 locationType 与 payload 投影的 schema。",
  ["Canonical digest of the location schema."]:
    "location schema 的规范摘要。",
  ["Digest of the canonical paired contract."]:
    "规范配对 contract 的摘要。",
  ["Time at which the revision was appended."]:
    "该 revision 被追加的时间。",
  ["List documents visible to the caller"]:
    "列出调用方可见的文档",
  ["Returns cursor-paginated documents, optionally restricted to one document type. A document whose `currentVersionIdx` is null has not been initialized by its Operator yet and cannot be opened."]:
    "返回 cursor 分页的文档列表，可按文档类型过滤。`currentVersionIdx` 为 null 的文档尚未被其 Operator 初始化，无法打开。",
  ["Restrict results to one document type."]:
    "只返回该文档类型的结果。",
  ["Stable document identity within the tenant."]:
    "tenant 内稳定的文档身份。",
  ["User-visible document name."]:
    "用户可见的文档名称。",
  ["Document type of every version in this document."]:
    "本文档中每个版本的文档类型。",
  ["Zero-based version record identity within one document."]:
    "文档内从 0 开始的版本记录身份。",
  ["Current pointer, or null until the Operator commits the first version."]:
    "current 指针；Operator 提交首个版本之前为 null。",
  ["Time at which the document was created."]:
    "文档创建时间。",
  ["Create a document"]:
    "创建文档",
  ["Required for session-cookie authentication; omit when authenticating with a Bearer token."]:
    "使用 session cookie 鉴权时必需；使用 Bearer token 时省略。",
  ["Retry identity; reusing a key with a different request is a conflict."]:
    "重试身份；同一个 key 配不同请求体即为冲突。",
  ["Enabled document type to create."]:
    "要创建的已启用文档类型。",
  ["Read a document and its current pointer"]:
    "读取文档及其 current 指针",
  ["Returns document identity, name, document type, and the current version pointer. This is the starting point for both the Web Host and an Agent: read `currentVersionIdx`, then query the exact version and open threads."]:
    "返回文档身份、名称、文档类型和 current 版本指针。这是 Web Host 和 Agent 共同的起点：先读 `currentVersionIdx`，再查询确切版本和 open thread。",
  ["Document within the tenant."]:
    "tenant 内的文档。",
  ["Move the current version pointer"]:
    "移动 current 版本指针",
  ["Points current at an existing version under an equality lock: `observedCurrentVersionIdx` must equal the pointer at commit, otherwise the operation returns `409` with the current value in error details. The move writes a document audit event in the same transaction and notifies the Operator with `current_version.moved`. It needs no idempotency key, because the equality lock already makes a retry safe."]:
    "在等值锁下把 current 指向一个已有版本：`observedCurrentVersionIdx` 必须等于提交时的指针，否则返回 `409`，错误 details 里带上当前值。该移动在同一事务内写入文档审计事件，并以 `current_version.moved` 通知 Operator。它不需要 idempotency key——等值锁本身已经让重试安全。",
  ["Equality lock: must equal the current pointer at commit; null means no version yet."]:
    "等值锁：必须等于提交时的 current 指针；null 表示尚无版本。",
  ["Version to point current at."]:
    "要让 current 指向的版本。",
  ["Audit reason recorded with the move."]:
    "随本次移动记入审计的原因。",
  ["List document audit events"]:
    "列出文档审计事件",
  ["Returns immutable document-level audit events in reverse chronological order. Moving the current pointer is auditable because it changes the base of later versions, the resolution of indirect references, and the optimistic-locking baseline for Agent submissions."]:
    "按时间倒序返回不可变的文档级审计事件。移动 current 指针之所以要审计，是因为它会改变后续版本的 base、间接引用的解析结果，以及 Agent submission 的乐观锁基线。",
  ["Stable audit event identity."]:
    "稳定的审计事件身份。",
  ["Principal that initiated the operation."]:
    "发起该操作的 principal。",
  ["Stable machine-readable audit action."]:
    "稳定的、机器可读的审计动作。",
  ["Current pointer before the event, or null when there was none."]:
    "事件发生前的 current 指针；此前没有则为 null。",
  ["Current pointer after the event, or null when there is none."]:
    "事件发生后的 current 指针；没有则为 null。",
  ["Actor-supplied reason, when the action requires one."]:
    "该动作要求原因时，由操作者填写的原因。",
  ["Correlation identity for the originating request."]:
    "用于关联原始请求的 correlation 身份。",
  ["Time at which the event occurred."]:
    "事件发生时间。",
  ["List version metadata in birth order"]:
    "按出生顺序列出版本元数据",
  ["Version identity and birth order within the document."]:
    "文档内的版本身份与出生顺序。",
  ["Current pointer observed at commit; null only for the first version."]:
    "提交时观察到的 current 指针；只有首个版本为 null。",
  ["Paired revision validating this snapshot and its result locations."]:
    "校验本 snapshot 及其 result location 的配对 revision。",
  ["Agent identity that committed this version."]:
    "提交本版本的 Agent 身份。",
  ["Time at which the version was committed."]:
    "本版本提交的时间。",
  ["Read one version's metadata"]:
    "读取一个版本的元数据",
  ["Returns one immutable version record: its parent, the paired contract revision validating it, the committing Agent and submission, and its comment provenance. The snapshot is not embedded, because an SValue carries atomic SBlob references that have no JSON representation."]:
    "返回一条不可变的版本记录：它的父版本、校验它的配对 contract revision、提交它的 Agent 与 submission，以及它的 comment provenance。snapshot 不内嵌，因为 SValue 携带的原子 SBlob 引用没有 JSON 表示。",
  ["Read one version's snapshot"]:
    "读取一个版本的 snapshot",
  ["Returns the canonical SValue CBOR encoding of the version snapshot as `application/vnd.unidocs.{documentType}.snapshot+cbor;version=1`, the media type recorded on the version's Document Contract revision. Large binary values inside the SValue stay as SBlob references; the caller reads those from UniCAS with a tenant capability."]:
    "以 `application/vnd.unidocs.{documentType}.snapshot+cbor;version=1` 返回版本 snapshot 的规范 SValue CBOR 编码，该媒体类型记录在这一版本的 Document Contract revision 上。SValue 内的大块二进制仍是 SBlob 引用，由调用方持 tenant capability 从 UniCAS 读取。",
  ["List thread identities"]:
    "列出 thread 身份",
  ["Stable thread identity."]:
    "稳定的 thread 身份。",
  ["Plain-text message body, or null."]:
    "纯文本正文，或 null。",
  ["UniCAS blob root hash."]:
    "UniCAS blob root 哈希。",
  ["Logical byte length of the complete blob."]:
    "完整 blob 的逻辑字节长度。",
  ["Media type of the complete logical blob."]:
    "完整逻辑 blob 的媒体类型。",
  ["Rich message body stored in UniCAS, or null."]:
    "存于 UniCAS 的富文本正文，或 null。",
  ["Attachments; they never replace the body."]:
    "附件；它们不能替代正文。",
  ["Paired contract revision whose location schema validates this payload."]:
    "其 location schema 校验本 payload 的配对 contract revision。",
  ["Document-type-specific location kind, for example unidocs.markdown.text-range/v1."]:
    "文档类型专用的 location 种类，例如 unidocs.markdown.text-range/v1。",
  ["Opaque location payload validated by the location schema."]:
    "由 location schema 校验的不透明 location payload。",
  ["Anchor relative to baseVersionIdx, or null for a document-level thread."]:
    "相对于 baseVersionIdx 的锚点；文档级 thread 为 null。",
  ["User message body and attachments."]:
    "用户消息正文与附件。",
  ["Anchor relative to baseVersionIdx, or null for a document-level comment."]:
    "相对于 baseVersionIdx 的锚点；文档级评论为 null。",
  ["Agent message body and attachments."]:
    "Agent 消息正文与附件。",
  ["Read both message sequences of a thread"]:
    "读取 thread 的两条消息序列",
  ["Thread within the document."]:
    "文档内的 thread。",
  ["Issue a short-lived direct-UniCAS capability"]:
    "签发直连 UniCAS 的短期 capability",
  ["Returns connection details and a short-lived tenant JWT with `cas:read` and `cas:write` only. The Platform does not proxy CAS node traffic; the caller builds a tenant blob client and reads or writes UniCAS directly. The token is not a Platform API credential, is held in caller memory only, and is never passed into a sandboxed View iframe, which uses Host RPC instead."]:
    "返回连接信息和一个只含 `cas:read` 与 `cas:write` 的短期 tenant JWT。Platform 不代理 CAS node 流量；调用方自行构造 tenant blob client 直接读写 UniCAS。该 token 不是 Platform API 凭据，只保存在调用方内存中，且绝不传入隔离的 View iframe——后者改用 Host RPC。",
  ["UniCAS tenant data-plane base URL."]:
    "UniCAS tenant 数据面 base URL。",
  ["UniCAS stack identity."]:
    "UniCAS stack 身份。",
  ["Tenant the capability is scoped to."]:
    "该 capability 所限定的 tenant。",
  ["Short-lived tenant JWT; it is not a Platform API credential."]:
    "短期 tenant JWT；它不是 Platform API 凭据。",
  ["Expiry as a Unix timestamp in seconds."]:
    "以 Unix 秒时间戳表示的过期时刻。",
  ["Tenant-scoped permissions; never cas:manage or refDomain."]:
    "tenant 级权限；绝不包含 cas:manage 或 refDomain。",
  ["Atomically creates a named document with `currentVersionIdx = null`, then notifies the built-in Operator with `document.created`. No thread or comment is created. The document becomes openable once the Operator commits its first snapshot. Replaying the same idempotency key returns the original `201` result instead of creating a second document."]:
    "原子地创建一份 `currentVersionIdx = null` 的具名文档，随后以 `document.created` 通知内建 Operator。不创建任何 thread 或评论。Operator 提交首个 snapshot 后文档才可打开。重放同一个 idempotency key 会返回原始的 `201` 结果，而不是再创建一份文档。",
  ["Returns cursor-paginated version metadata without snapshots, which is what a version history panel needs: `parentVersionIdx` draws the base parent forest, and `addressedComments` draws the comment provenance graph. Snapshot bytes are read separately, one version at a time."]:
    "返回 cursor 分页的版本元数据，不含 snapshot——这正是版本历史面板需要的：`parentVersionIdx` 画出 base parent forest，`addressedComments` 画出 comment provenance 图。snapshot 字节单独读取，一次一个版本。",
  ["Submission that atomically created this version and its replies."]:
    "原子创建本版本及其回复的 submission。",
  ["Thread containing the addressed comment."]:
    "包含被回应评论的 thread。",
  ["Addressed comment within that thread."]:
    "该 thread 内被回应的评论。",
  ["Version the addressed comment was written against."]:
    "被回应的评论所基于的版本。",
  ["Comment provenance: comments this version responded to; empty for the first version."]:
    "comment provenance：本版本回应了哪些评论；首个版本为空。",
  ["Returns cursor-paginated thread references only. `open` is derived server-side by the same rule the caller would use, `latestCommentIdx > acknowledgedCommentIdx`; it is not a stored, togglable flag, so there is no resolve or reopen operation anywhere in this API. Full comment and reply sequences come from the item GET operation."]:
    "只返回 cursor 分页的 thread 引用。`open` 由服务端按调用方同样的规则推导：`latestCommentIdx > acknowledgedCommentIdx`；它不是可切换的存储标志，因此本 API 任何地方都没有「解决」或「重新打开」操作。完整的评论与回复序列由单项 GET 返回。",
  ["Filter by derived open state: latest comment beyond the reply watermark."]:
    "按推导出的 open 状态过滤：最新评论超过回复水位。",
  ["Restrict to threads whose comments are anchored to this version."]:
    "只返回评论锚定在该版本上的 thread。",
  ["Create a thread with its first comment"]:
    "创建 thread 及其首条评论",
  ["Creates a position-anchored thread containing one comment. `baseVersionIdx` must name an existing version of this document, and any location is relative to that version and must carry its `documentContractIdx` and pass that revision's location schema. A comment does not have to be based on current; the Operator decides whether an older comment still applies."]:
    "创建一个位置锚定的 thread，内含一条评论。`baseVersionIdx` 必须指向本文档中已有的版本；location 相对于该版本，必须携带它的 `documentContractIdx` 并通过该 revision 的 location schema。评论不必基于 current；旧评论是否仍然适用由 Operator 判断。",
  ["Existing version the first comment is written against."]:
    "首条评论所基于的已有版本。",
  ["First comment body and attachments."]:
    "首条评论的正文与附件。",
  ["Comment identity within its thread."]:
    "thread 内的评论身份。",
  ["Version this comment was written against."]:
    "本条评论所基于的版本。",
  ["User principal that wrote the comment."]:
    "写下该评论的用户 principal。",
  ["Time at which the comment was appended."]:
    "该评论被追加的时间。",
  ["Append-only user comment sequence."]:
    "只追加的用户评论序列。",
  ["Reply identity within its thread."]:
    "thread 内的回复身份。",
  ["Cumulative acknowledgement watermark: this reply answers every comment through this index, so one reply commonly covers several comments."]:
    "累计确认水位：本条回复确认到该序号为止的每一条评论，因此一条回复通常一次覆盖多条评论。",
  ["Locations in the version created by the same submission; empty for a pure reply."]:
    "同一次 submission 所创建版本内的位置；纯回复为空。",
  ["Agent identity that produced the reply."]:
    "产出该回复的 Agent 身份。",
  ["Submission that committed this reply."]:
    "提交该回复的 submission。",
  ["Time at which the reply was committed."]:
    "该回复提交的时间。",
  ["Append-only Agent reply sequence; each reply acknowledges a run of comments rather than exactly one."]:
    "只追加的 Agent 回复序列；每条回复确认的是一段连续评论，而不是恰好一条。",
  ["Returns the complete append-only comment and reply sequences. One reply acknowledges every comment through `respondThroughCommentIdx`, so the thread's open state and each comment's handled state are computed from these two sequences rather than stored."]:
    "返回完整的只追加评论与回复序列。一条回复通过 `respondThroughCommentIdx` 累计确认到某条评论，因此 thread 的 open 状态和每条评论的处理状态都由这两条序列算出，而不是存储。",
  ["Append a comment to a thread"]:
    "向 thread 追加一条评论",
  ["Appends one user message to an existing thread and returns the stored record with its assigned `commentIdx`. Appending past the reply watermark re-opens the thread, which is the only way a discussion is reopened. Comments are immutable: there is no edit, delete, or withdraw operation, so a correction is a new comment on the same thread."]:
    "向已有 thread 追加一条用户消息，返回带服务端分配的 `commentIdx` 的存储记录。追加到回复水位之后会让该 thread 重新变为 open——这是讨论被重新打开的唯一途径。评论不可变：没有编辑、删除或撤回操作，改正的做法是在同一处追加一条新评论。",
  ["Existing version this comment is written against."]:
    "本条评论所基于的已有版本。",
  ["Comment body and attachments."]:
    "评论正文与附件。",
};

export const zhTenantApiTranslation = {
  prose: zhTenantApiStrings,
  tagNames: zhTenantApiTagNames,
} as const;
