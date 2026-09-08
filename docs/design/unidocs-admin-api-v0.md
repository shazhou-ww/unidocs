# UniDocs 管理服务 API v0

当前落地：[Iteration 14](iteration-14.md) 已部署 admin 自身闭环，主站消费按用户决定推迟。enabled 只存目标状态，不再要求 editor 已提供才能保存；主站是否可用仍需后续能力与权限校验。发现请求仅通过固定一方 service binding，不允许通用公网 URL 访问；首版只批准 `https://unidocs-markdown.shazhou.workers.dev/`。GET /audit-events 返回最近 100 条及 presentationLimit=100，GET /changes/{key} 当前只核实本人类型命令。下文涉及主站立即启停的语义是后续目标，不是本轮行为。

最新进度：[Iteration 12](iteration-12.md) 已完成可选目录后端切片，尚未注入生产管理 DO。当前 URL 验证同步返回 200，只保存成功短时记录；与下文 202 异步任务目标的差异、安全及用户面接入门槛见该记录。不得将未上线目录 enabled 当作主站开关已经生效。

日期：2026-09-08。状态：精简后的设计草案，尚未实现或部署。配套 [后台设计](unidocs-admin-webui-v0.md) 与 [HTML 原型](unidocs-admin-mock.html)。本文取代此前 service/editor/release 分别注册的方案。

实现更新：[Iteration 10](iteration-10.md) 已完成管理员核心、SQLite 和部分独立名单 HTTP handler，未接 Google callback 或生产路由。本文其余 API 仍是目标设计，实际覆盖和限制以该实现记录为准。

最新实现：[Iteration 11](iteration-11.md) 已部署共享 Google 登录、GET /session、POST /session/logout 和管理员名单 API。额外 POST `/admin/auth/session` 用于共享 Google 身份换取管理上下文，同源 Origin 与 X-UniDocs-Admin 头必需；GET `/admin/auth/login` 转入同一个 Google 回调流程。URL 目录、审计和 changes 查询仍是目标接口，未上线。当前审计/命令记录硬上限各 100,000 条，无自动过期清理，达到容量即拒绝写入。

## 1. 职责

管理后台只负责一方文档类型的目录配置：一个 base URL，以及是否在 UniDocs 主站开放创建、编辑。不做 UGC 注册，也不负责微服务部署、版本选择、发布、回滚、存储迁移或 editor build 管理。这些由每个 doctype 微服务自己负责。

运营人员输入 base URL，服务端发现类型身份和描述，验证后登记。API 与 editor WebUI 均从该目录型 URL 解析，不手动分别填写地址。后台只有文档类型、管理员、审计三个业务模块。

管理面属于 UniDocs，不属于 UniCAS；管理员身份不授予用户文档或 CAS 内容读取权限。按用户决定，首版复用 UniDocs 的 Google client、登录入口、callback 和服务端已验证的 Google 登录身份，后台部署在主站同源 `/admin/`。管理 API 与名单授权仍独立，不新增一套 Google OAuth 配置，也不把普通 tenant access token 当管理员资格。

## 2. 单一注册模型

```ts
interface DocumentTypeRegistration {
  docType: string;
  baseUrl: string;
  enabled: boolean;
  discovered: {
    displayName: string;
    description: string;
    serviceId: string;
    formats: string[];
    capabilities: Record<string, boolean>;
  };
  checkedAt: string;
  updatedAt: string;
}
```

`discovered` 为经服务端验证的描述快照，不是客户端可写字段。内部仍需保存服务鉴权 audience、协议兼容信息、描述摘要和配置 ETag，但它们不构成独立服务/编辑器管理资源。serviceId 是既有作品绑定的稳定身份，不是版本。

`enabled` 是单一主站开关，不再拆 creationEnabled、editEnabled 和 visible。建议语义：

- true：主站显示该类型的新建入口；编辑操作还必须满足实际服务能力、宿主能力及用户作品权限，不因启用就获得可靠保存能力。
- false：从可选类型目录隐藏，停止该类型新建和编辑授权。已经存在的作品仍保留在“我的作品”，原有读取/预览/导出权限不因此撤销；显示类型暂不可编辑。若用户希望同时禁止读取，应另行确认，不能把关闭入口当删除内容。
- 在途已接纳的提交仍可核实/恢复原意图，不新建意图或改载荷。停用不是取消已提交事务；尚未提交的草稿保留。
- 主站开关在 Gateway/宿主授权时强制执行，不能只隐藏按钮。微服务直接访问有其独立鉴权；此开关不是关闭微服务部署或全局撤销全部凭据。

首版不提供删除类型接口。停用不会删记录，不破坏旧作品身份、状态核实和审计。

## 3. Base URL 接入约定

以下是目标契约，现有微服务仍需适配，不能假定当前部署已经提供：

| 相对路径 | 用途 |
| --- | --- |
| `./.well-known/unidocs-doctype` | 类型身份、显示信息、格式、协议及实际能力描述 |
| `./api/` | 文档服务 API 根路径 |
| `./editor/` | editor WebUI 入口，由微服务选择兼容实现 |
| `./health` | 有界健康探测，不读取真实用户文档 |

base URL 规范化为以 `/` 结尾的目录。例：`https://types.example.com/markdown/` 对应 `https://types.example.com/markdown/api/`，不能把 `/api/` 当相对路径而丢失目录前缀。禁止 userinfo、query、fragment，使用 URL 解析器，不拼接不可信字符串。注册描述不能覆盖 API/editor 到其他 origin；同源资源的具体构建路径可由微服务控制。

描述必须提供稳定 docType、serviceId、存储身份连续性声明，以及 runtime 需要的协议、schema 和鉴权信息。版本号仅可作为微服务提供的诊断/握手信息，平台不登记、选择或激活它。editor 启动后遵循 [宿主协议](editor-host-protocol-v0.md) 的来源校验、MessageChannel 和上下文隔离，不把管理 cookie 或用户 JWT 交给 iframe。

同 URL 下的升级、资源缓存和旧会话兼容由微服务负责。宿主不能假定固定 editor 路径内容不变；每次建立会话重新握手并验证能力，当前会话不被管理后台热替换。URL 切换后新会话使用新 URL，旧会话不能混用新地址继续写入；要求重连、保留草稿，原 pending 由宿主按稳定意图身份核实。

## 4. 精简管理 API

业务根路径建议 `/admin/api/v1`；以下表格除 auth 外均相对于此路径。没有 `/services`、`/editor-builds`、`/releases`、`/activation`、独立 lifecycle 或版本回退 API。

| 方法与路径 | 请求/结果 |
| --- | --- |
| GET /document-types | 分页目录，支持 q 和 enabled 筛选 |
| GET /document-types/{docType} | 当前配置、发现摘要、最近检查时间，附 ETag |
| POST /url-validations | `{baseUrl, expectedDocType?, expectedConfigEtag?}`，202 返回 validationId 与 Location；指定已有类型时两项 expected 必须一起提供 |
| GET /url-validations/{validationId} | queued/running/passed/failed/expired，规范 URL、发现描述、检查结果、expiresAt；不改变生效配置 |
| POST /document-types | `{baseUrl, enabled, validationId}`，使用同一规范 URL 的有效验证登记；docType 从验证结果取得，重复 409 |
| PATCH /document-types/{docType} | `{enabled?, baseUrl?, validationId?, reason}`；至少一项配置变化，If-Match 必填，成功 200 返回新配置与 ETag |
| GET /audit-events | 分页变更审计，按操作者、类型和时间筛选 |
| GET /changes/{idempotencyKey} | 当前管理员的原命令结果；404 只表示找不到记录，不证明未执行 |

PATCH 规则：

- 只关闭 enabled 不需要 URL 验证，服务不可达时仍能停用入口。
- URL 改变必须携带对应的有效 validationId；同一请求可同时改变 enabled，原子保存。
- 重新启用要求当前 URL 的有效验证，防止旧注册长期失效后盲目开放。URL 未变且已经启用时不需要重复“发布”。
- 验证绑定操作者、规范 URL、预期类型、当前配置 ETag、检查策略摘要及发现描述摘要，建议 15 分钟有效。改输入、配置并发变化或过期必须重新验证，不能复用旧通过状态。
- ETag 只是防并发覆盖的技术标识，不是平台管理微服务版本。UI 不提供修订列表、选择旧版本或发布操作。

### URL 切换例子

```http
POST /admin/api/v1/url-validations
Content-Type: application/json

{"baseUrl":"https://markdown-next.example.com/","expectedDocType":"markdown","expectedConfigEtag":"cfg-12"}
```

该请求及下述请求均需有效管理会话、精确 Origin、CSRF token 和 Idempotency-Key，示例省略安全头。验证 passed 后：

```http
PATCH /admin/api/v1/document-types/markdown
If-Match: "cfg-12"
Idempotency-Key: 2f5a8b0e-2e25-470a-a10b-75ae417c36b1
Content-Type: application/json

{"baseUrl":"https://markdown-next.example.com/","validationId":"validation_7","reason":"更换服务入口"}
```

## 5. URL 验证与切换的真实边界

1. 先验证一方域名/端口 allowlist、HTTPS 和标准路径，禁止任意互联网代理。普通后台不能修改 allowlist。DNS 与实际连接目标一致，阻止 SSRF、rebinding、回环、link-local、metadata 地址；默认拒绝重定向。私有 service binding 由部署配置映射，不让管理员输入任意私网地址。
2. 服务端读取受限大小描述，核实 docType/serviceId/鉴权 audience 与协议。校验 API 可达、editor 入口与宿主协议兼容、安全响应头；不在管理 origin 执行 editor，不携带用户正文或广域 CAS 权限。
3. 切换已有类型时，稳定服务身份必须匹配原注册及既有作品。仅 JSON 声称相同 serviceId 不足以证明存储连续；要有一方部署控制与受认证的存储身份检查证据。不能证明则失败关闭，不提供“强制切换”。旧地址故障时也不能降级为只测新地址 HTTP 200。
4. 验证只做观察，不迁移或修改作品。它不是未来持续可用性的保证；最近检查显示时间，不冒充实时监控。保存前核实验证摘要/有效期，发现内容已经变化则重新验证。
5. 在事务内重查管理员、If-Match、验证绑定，原子更换目录配置、记录审计与幂等结果。网络检查在事务前做，不能在锁内等网络。校验/保存失败时继续使用原 URL。
6. 保存是后续请求的路由切换，不是作品迁移。已接纳的请求固定原路由上下文完成；新请求取权威配置。宿主不凭缓存 UI 授权新写入。可靠核实必须保留原 session/opId；新的 URL 必须能访问同一持久结果。

服务更新协议或存储的兼容与迁移流程由微服务负责。若不兼容，平台显示不可用，不帮它选择旧 build 或猜测迁移路径。安全配置的 CSP frame-src 必须支持批准的一方 doctype origin，不能为“动态”使用不受限通配来源。

## 6. Google 管理身份

复用 UniDocs Google 登录，加后台邮箱名单授权；管理员权限相同，可添加/删除其他管理员，不可删除自己。已在 UniDocs 登录且上游身份信息满足要求时，进入后台不再要求第二次 Google 登录；未登录时回到现有登录流程并返回 `/admin/`。普通用户登录不自动获得管理资格，也不自动 provision 管理 tenant。

- 复用现有服务端 OIDC 验证，仍需核实签名、issuer、audience、有效期、nonce、PKCE 和 email_verified=true；不信任浏览器上报的 email。管理接入前补验现有 state 的一次性消费、浏览器绑定和 continue 限制，不将目标安全要求描述为现有实现已具备。
- 邮箱 trim、ASCII 小写规范化，不合并点号或 + 后缀；保留显示值并唯一约束。首版国际化邮箱支持范围实现前明确，不能悄悄改写。
- 首次名单登录原子绑定 issuer/sub；同邮箱不同 sub 拒绝并人工核查。删除后重新添加产生新的 adminId/generation，旧会话不能复活。
- 可由共享 Google 登录身份换取独立的管理会话上下文，绑定不可复用的 adminId 和 CSRF，不再发起第二套 Google OAuth。管理会话不超过上游登录有效期，Google token 不进页面存储。高风险操作要求最近 15 分钟完成过受浏览器绑定、一次消费的 Google 授权码登录确认，不以新建管理会话延长该窗口。
- Google auth_time 为可选字段，当前不依赖它，也不承诺强制密码/MFA 重认证。已有 token 签名验证后，检查 iat 对应本次登录窗口且 exp 有效，记录服务端交换完成时间，并在 sealed cookie 标记 authorization-code-v1。该时间不是 Google 的密码认证时间；旧 cookie 缺少确认标记时重新走同一个 Google 登录流程。删除再添加同邮箱不得自动把旧管理会话映射到新 adminId。
- 每个请求查实时名单，存储不可用失败关闭。变更提交点重查操作者，不沿用事务外旧资格；删除 A/B 互相并发删除时最多一个成功。检查自身、至少一名剩余管理员、删除、审计和幂等结果在同一串行事务完成。
- Cloudflare 可用控制 DO SQLite、PostgreSQL 可用固定控制行锁实现同一个原子端口；不得用进程锁替代跨实例约束。已发出读取不能撤回，删除之后新请求拒绝。
- 初始名单由部署者一次性非 HTTP 引导，空表+未初始化条件原子执行；不允许首个登录者抢占，不每次重启重灌。账号不可用时有受控、有审计的运维恢复途径。

| 方法与路径 | 行为 |
| --- | --- |
| GET /admin/auth/login | 复用有效 UniDocs Google 身份，或转入已有 Google 登录入口；名单校验后建立管理上下文 |
| GET /session | 本人身份、csrfToken 和会话到期信息 |
| POST /session/logout | 撤销本管理会话；名单已撤销的用户仍能退出 |
| GET /administrators | 管理员邮箱、绑定状态、添加人/时间与 ETag |
| POST /administrators | `{email}`，201；重复 409 |
| DELETE /administrators/{adminId} | If-Match；自身/最后一名 409，其余 204 |

不新增 `/admin/auth/callback`，复用 UniDocs 当前已配置的回调。管理员邮箱不直接 PATCH，按添加新身份后由另一管理员删除旧身份处理。“退出管理”仅撤销管理上下文，不清共享 Google 登录或普通工作台草稿；再次进入仍重新校验名单。切换 Google 账号通过现有登录流程完成。

## 7. 通用约定与审计

JSON 输入白名单，默认 64 KiB；单资源 `{data}` + ETag；列表 `{items,nextCursor}`，limit 默认 50、最多 100。错误 `{error:{code,message,requestId}}`；管理响应 no-store，不开放跨 origin CORS。

写请求要求精确 Origin、X-CSRF-Token 和 Idempotency-Key；配置 PATCH/管理员 DELETE 要求 If-Match，缺少 428、过期 412。相同主体/key/动作/请求摘要返回原结果；异载荷 409。重试先重新鉴权。幂等结果建议保留至少 7 天，返回 expiresAt；不确定时先核实原 key 并读当前资源，不自动生成新 key 重发。

配置修改与成功审计原子提交；审计不可用时不静默执行配置写入。事件包括登记类型、URL 验证结果、URL 更换、启用/停用、管理员增删，记录稳定操作者、脱敏前后配置、时间与请求 ID，不含 token、正文或秘密 URL。后台无审计删除入口；归档、容量与保留策略作为生产启用前 gate。

认证失败 401、名单无资格/越权 403、资源不存在 404、状态冲突 409、并发冲突 412、超限 413、验证不通过 422、限流 429、依赖不可用 503。不把 200 健康检查或找不到幂等结果当作写入成功/失败证据。

## 8. 用户面与现有代码衔接

用户面建议 `GET /tenants/{tenantId}/document-types` 返回启用类型、公开描述、有效能力；与管理员名单/配置 API 分离。已有作品的 editor-context 按作品授权、注册开关和微服务当前兼容握手返回，不选择平台 release。

[静态注册表](../../packages/gateway-common/src/doc-service-registry.ts) 与 [Gateway](../../packages/gateway-common/src/gateway-handler.ts) 当前按 doctype 找服务再核对 serviceId。动态实现保留既有 serviceId，URL 切换只允许同身份；停用仍能列出旧作品和授权读取，禁止用 enabled=false 直接返回类型不存在。首次导入静态配置只做显式迁移，不重置管理员配置。

[普通 OAuth 身份](../../packages/gateway-oauth/src/ports.ts) 的邮箱可缺省，不能直接作为管理授权；复用 [Google 登录适配](../../packages/cloudflare-gateway/src/oauth-identity.ts) 的同一个 client/登录/callback，要求管理入口取得已验证邮箱与可信认证上下文后，再进行独立名单校验。没有这些字段则拒绝提升权限。

作品 describe/thumbnail 是微服务的内容查询契约，不属于管理目录字段；版本精确性仍需内容服务保证，本文不实现它。统一路径和描述接口、动态用户发现、通用 iframe 宿主尚未实现，需分步适配现有 Markdown/PSD。

## 9. 验收与落地

先实现管理身份与名单，再实现 URL 验证/目录 API 和后台，最后接主站动态发现与运行时授权。建议 admin-protocol/client/service/webui 的职责分层，具体包结构在实施时确定。

必要验收：只有 URL 即可发现登记；错误类型/服务身份/存储连续性不能切换；校验后改 URL 失效；旧 ETag/过期验证不能提交；服务失败旧配置不变；原子切换且无隐式迁移；停用同时拒绝新建和新编辑而保留旧内容及原意图核实；微服务自行升级不需在后台选版本；SSRF、CSRF、管理员并发删除、撤销会话和幂等审计回归。

部署准备更新：首版建议沿用 Cloudflare 的 `unidocs-gateway`，入口 `https://unidocs.shazhou.work/admin/`，复用主站 origin 和现有 Google client/callback。用户指定初始管理员为 `shazhou.ww@gmail.com`，尚未写入生产名单；必须通过一次性初始化流程，而不是每次启动重灌。cfg token 已经只读验证为 active，尚未实际部署管理功能。

待部署参数：allowlist、存储连续性验证机制、日志保留及管理存储绑定/初始化流程。没有这些运行验证前，不得宣称 URL 验证已保证生产迁移安全。