# unicas-packages — Unicas 包结构与边界

Unicas 是 UniDocs 的独立可部署 CAS 中间件（content-addressed storage + stack
控制面）。`unicas-packages/` 是它的物理边界：**未来独立 CAS monorepo 只需
`git mv` 整个目录，把 `workspace:*` 换成 registry 版本，import 语句零改动**。
2026-08-29 重组后，本目录内**零 `@unidocs/*` 依赖**，该承诺完全兑现。

## 命名规则

1. **目录名 = 包名**：`unicas-packages/<name>` = `@unicas/<name>`，一一对应。
   改名必须同时改目录名与 `package.json` 的 `name`（依赖 guard 强制校验，
   见 `tests/unit/workspace/package-deps.test.mjs`）。
2. **客户端按 actor 分两组**：
   - `tenant-*` — 租户数据面（内容寻址存储）
   - `admin-*` — 管理员控制面（stack 管理）
3. **编码层**：`codec` —— wire 编码，独立发布、独立测试，无 workspace 依赖。
4. **契约包**：`tenant-protocol`（数据面 HTTP 契约 + capability）/
   `admin-protocol`（控制面契约）。只放类型、路由、校验、常量——无 IO、
  无平台绑定、**不含任何编码**。两面共用的协议类型归 `tenant-protocol`；
  `admin-protocol` 可依赖 `tenant-protocol`，反向禁止。
5. **界面/入口**：`admin-webui`（管理 WebUI + OIDC BFF，迁移期双角色包）、
   `admin-cli`（管理 CLI + stdio MCP）、`tenant-client`（数据面 HTTP client）。
6. **服务端按平台分层，不按 actor 拆部署**：`service` 是 cloud-neutral 的
  tenant + admin HTTP actor 与平台端口；`service-cloudflare` 是唯一 Cloudflare
  Worker 和公网入口。`control-plane`、`server-cloudflare`、
  `control-plane-mcp` 现为迁移期内部实现包，不再独立部署。

## 客户端访问面固定结构

admin 与 tenant 两类参与者的访问面保持分离，客户端包采用同一套角色：

```
admin:  [admin-cli, admin-webui] -> admin-client -> admin-protocol
tenant: [tenant-cli, tenant-webui] -> tenant-client -> tenant-protocol
```

- `protocol` 定义该访问面的 HTTP 接口、接口依赖的 request/response 类型，
  以及配合这些类型使用的简单纯函数（如构造函数、类型判定函数）。
- 两个访问面共用的协议类型放在 `tenant-protocol`；只允许
  `admin-protocol -> tenant-protocol`，不允许反向依赖。
- `client` 对每个 HTTP API 提供简单的 `Request -> Promise<Response>` 封装；
  client 对象只收纳 base URL、credential 等公共传输参数，不承载业务抽象。
- 更高层抽象另建包装包；`tenant-blob-client -> tenant-client` 是基准模式。
- 上图是固定的角色与依赖模型；某个 CLI/WebUI 产品尚未实现时不创建空包。
  WebUI 的服务端 BFF 属于服务端梳理范围，不改变浏览器侧的依赖方向。

## 包清单（14 包）

```
unicas-packages/                    @unicas org
│
├── ■ 编码层（cloud-neutral、无 IO、独立发布独立测试）
│   └── codec/             @unicas/codec              数据面 wire 编码
│         规范节点二进制格式（binary）、SHA-256 摘要（digest）、流式节点解析
│         （canonical-stream）、限额/校验（validation）——不含 blob 分片
│
├── ■ 契约层（cloud-neutral、无 IO、冻结契约）
│   ├── tenant-protocol/   @unicas/tenant-protocol    tenant 组 · 数据面
│   │     HTTP request/response 类型（types/http）+ 路由（routes）
│   │     + capability 词汇（capability）；不 re-export 编码符号
│   └── admin-protocol/    @unicas/admin-protocol     admin 组 · 控制面
│         控制面契约：类型、路由、错误码、并发/ETag、authz、威胁模型
│
├── ■ 内核/库层（cloud-neutral）
│   ├── service/           @unicas/service            tenant + admin HTTP actor
│   │     精确匹配两套 protocol；定义 control/tenant SQL、blob、按 key 串行
│   │     actor 等平台端口；内置 stack capability 校验、权限矩阵与有界 authority
│   │     cache，以及 Root Ref 校验/幂等/投影/revision/retry 业务内核；不依赖
│   │     Cloudflare 类型或 control-plane 实现；node GC 的候选复核、删除顺序与
│   │     回收统计同样通过 semantic repository port 执行
│   ├── control-plane/     @unicas/control-plane      admin 组
│   │     控制面服务库：ControlPlaneService（CAS_CONTROL_DB 唯一写入路径）、
│   │     AuthorityRepository、sessions、jwks、possession、audit、cursor、ids
│   └── control-auth/      @unicas/control-auth       admin 组
│         OIDC 认证库：discovery、PKCE、id_token 校验（admin-webui 与
│         control-plane-mcp 共用）
│
├── ■ Cloudflare 适配与迁移实现
│   ├── service-cloudflare/@unicas/service-cloudflare  唯一 Worker 部署单元
│   │     D1/R2/KV/DO bindings、统一公网路由、credential 隔离、BFF/UI、MCP
│   ├── server-cloudflare/ @unicas/server-cloudflare   迁移期 tenant 存储/审计 adapter
│   ├── control-plane-mcp/ @unicas/control-plane-mcp   迁移期 MCP/OAuth ingress
│   └── admin-webui/       @unicas/admin-webui         WebUI + 迁移期 BFF
│
└── ■ client 层
    ├── tenant-client/     @unicas/tenant-client       tenant 组 · 传输层
    │     纯 HTTP 封装，每个路由一个函数（readMetadata/readContent/
    │     leaseNode/updateRootRefs/usage/gc），factory 绑定 tenantId/JWT；
    │     无编码、无业务封装，仅组装层使用
    ├── tenant-blob-client/@unicas/tenant-blob-client  tenant 组 · 业务面
    │     业务方唯一入口：storeBlob / openBlob(含元数据的句柄式随机读) /
    │     retain / release；底层能力统一经 unicasClient 访问
    │     + 节点写辅助（storeNodeContent/leaseNodeContent）
    │     + blob index CBOR（client 侧 manifest，服务端不解析）
    ├── admin-client/      @unicas/admin-client        admin 组 · 控制面 HTTP client
    │     纯函数传输层（对标 tenant-client）：每操作一函数，类型直接来自
    │     @unicas/admin-protocol；session cookie + CSRF 由 session provider 提供
    ├── admin-cli/         @unicas/admin-cli           admin 组
    │     CLI + stdio MCP（bin `unicas`），走 /admin HTTP API（admin-client）；
    │     登录 = 自行 Google OIDC → BFF /admin/auth/exchange 换 session；
    │     `unicas mcp` 是 admin-client 之上的薄 MCP 呈现层（无 MCP 转 MCP）
    └── admin-webui/       @unicas/admin-webui         admin 组 · 双角色（部署层）
          src/ui（管理界面）+ src/server（OIDC BFF）
```

## 依赖规则（分层单向，guard + boundary 测试强制）

```
编码层(codec) + 契约层(tenant-protocol, admin-protocol)
  ← service（cloud-neutral actor + platform ports）
    ← service-cloudflare（唯一 Worker）
契约层 + 编码层 ← tenant-client（纯函数传输层，仅组装）
                    ← tenant-blob-client（业务方唯一入口）
契约层 ← admin-client（控制面 HTTP 传输，仅组装/CLI 用）
        ← admin-cli（走 admin-client + control-auth 登录）
```

- **codec 是最底层**：无 workspace 依赖，仅外部 `cborg`；`tenant-protocol`
  不 re-export codec 符号（强制迁移，2026-08-29 决策）。
- **tenant-client 是纯函数传输层**：与 HTTP 路由一一对应，factory 只绑定
  tenantId/JWT 等公共参数，无编码、无业务封装、无对象模式（`node()` 已移除）。
- **业务方只用 tenant-blob-client**：其接口覆盖完整数据面
  （blob 写/随机读 + 节点元数据/续租/root-refs + usage/gc），应用栈不再直接
  依赖 tenant-client；`createTenantCasClient` 只在组装点喂给
  `createCasBlobClient`。
- 契约层：`tenant-protocol` 仅外部 `jose`；`admin-protocol` 当前无依赖，
  未来只可为复用两面共用协议类型而依赖 `tenant-protocol`。
- `service` 同时依赖 tenant/admin protocol，统一两套服务端 HTTP surface；
  平台 context 显式提供 control/tenant SQL、blob 与 keyed actor 端口。tenant
  capability 校验属于该 cloud-neutral actor：authority 只经只读 resolver port
  注入，D1 `AuthorityRepository` 仍由 Cloudflare adapter 构造。
- `service-cloudflare` 是唯一部署包，持有 D1/R2/KV/DO 和公网 route；生产及
  本地 Miniflare 均不再通过 tenant/admin/MCP service bindings 拆分 UniCAS。
- `server-cloudflare`、`admin-webui` server 和 `control-plane-mcp` 暂由
  `service-cloudflare` 作为内部策略组合，迁移完成后其服务端实现将归入
  `service` 或 `service-cloudflare`，对应旧部署包删除。`server-cloudflare`
  已不再拥有 capability verifier 或 Root Ref 业务规则，只保留迁移中的
  D1/R2 repository、DO 生命周期、node lease/read/usage 存储实现与 audit RPC。
- 数据面不得依赖 admin 组包；admin 实现包不得依赖 tenant 实现包。
  唯一协议级单向例外是 `admin-protocol -> tenant-protocol`，用于复用两面
  公共协议类型，反向禁止（由 `admin-protocol/tests/cross-plane.test.ts` 与
  各包 `tests/boundary.test.ts` 断言）。
- **零 `@unidocs/*` 依赖**：unicas-packages 是独立中间件。`server-cloudflare`
  唯一允许的应用栈 devDependency 是测试用的 `@unidocs/service-auth`
  （签发器），生产代码不引用。
- `admin-cli` 走 `/admin` HTTP API（经 `@unicas/admin-client`），运行时依赖
  `admin-protocol`（契约类型）+ `admin-client`（传输）+ `control-auth`
  （PKCE/state 辅助）；`unicas mcp` 是同一 `admin-client` 之上的 stdio MCP
  呈现层，不引入 MCP 转 MCP。

## 存储编码边界（2026-08-29 决策）

```
CAS 感知的编码 = 只有 1 种：规范 CAS 节点格式（codec/binary.ts）
  ├─ header：digest / contentType / size / refs
  └─ content：不透明字节

CAS 对 content 的立场：
  ✗ 不解析任何内容格式（SValue / SBlob / JSON / 任意未来格式）
  ✓ refs 由调用方在 lease/upload 时声明（CasRefsHeader），CAS 只做通用校验：
      规范节点结构合法、摘要/尺寸一致（re-lease 不可变性）、refs 有界、
      child 就绪、通用大小上限（MAX_CANONICAL_NODE_BYTES）
  ✗ 不校验「声明的 refs 与内容内部引用一致」——所有格式一视同仁
```

SValue 是 unidocs（应用栈）的文档内容模型，**unicas 不感知**。2026-08-29 已
从 `server-cloudflare` 移除 SValue 专属逻辑（16MB 上限 + refs 一致性校验）；
SValue/SBlob 类型族与 codec 全部留在 `@unidocs/protocol` + `@unidocs/svalue-codec`。
refs 一致性若需兜底，由应用栈侧在写入前自检（`refsFromSValue`），不污染 unicas。

**大 blob 分片也是 client 侧概念**：`blob-index` manifest 的编码/解码归属
`tenant-blob-client`（CAS 服务端只把它当不透明 contentType，从不解析——与
2026-08-28 流式 blob 设计一致：「CAS 服务端无需理解 blob-index 的内容语义」）。

## 能力（capability）词汇归属

CAS 中立租户能力契约（claims / permissions / errors —— `iss, aud, sub, iat,
nbf?, exp, jti, tenantId, permissions[], refDomain?`）**归属
`tenant-protocol/src/capability.ts`**（单一事实源）。`@unidocs/service-auth`
（应用栈签发/校验实现）re-export 同一批符号，公共 API 不变，消费者零改动。
capability 是 JWT claim 词汇而非编码，故不进 `codec` 包。

## 本轮重组记录（2026-08-29）

| 变更 | 说明 |
|---|---|
| `protocol` → `tenant-protocol` | 改名对齐 actor 前缀 |
| `protocol-admin` → `admin-protocol` | 改名对齐 actor 前缀 |
| `server-common` 删除 | binary/digest/canonical-stream/validation 先并入 `tenant-protocol` |
| capability 词汇迁入 | 从 `@unidocs/service-auth` 迁入 `tenant-protocol`，service-auth 变 re-export 薄壳 |
| SValue 专属逻辑移除 | `server-cloudflare` 不再解析 SValue；`@unidocs` 生产依赖清零 |
| `admin-cli` → 依赖 `admin-protocol` | 工具结果用冻结契约类型标注，防 schema 漂移 |
| **codec 拆分（强制迁移）** | `binary/digest/canonical-stream/validation` 从 `tenant-protocol` 抽为 `@unicas/codec`；`tenant-protocol` 不再 re-export 编码符号；纯编码消费者直接依赖 codec |
| **blob 分层（tenant-blob-client）** | `blob index` 从 codec 迁入新包 `@unicas/tenant-blob-client`；tenant-client 收窄为与 HTTP 一一对应的薄传输；blob 层提供完整接口（句柄式随机读对标 SBlobHandler、usage/gc 透传），业务方不再触碰底层 client |
| **权限改名** | tenant 数据面 `cas:admin` → `cas:manage`（消除与「admin 面/控制面」的术语撞车） |
| **tenant-client 下沉纯函数** | 移除 `node()` 对象模式，改 `readMetadata`/`readContent` 直接函数；业务面全部收敛到 `tenant-blob-client`（补 `readMetadata`/`leaseNode`/`updateRootRefs` 透传），应用栈不再直接依赖传输层 |
| **admin-client + CLI 改通道** | 新建 `@unicas/admin-client`（/admin HTTP 纯函数 client，类型直接来自 admin-protocol，消除 MCP 工具 schema 双份手写）；admin-cli 从 MCP 通道改为走 /admin HTTP：登录 = 自行 Google OIDC → BFF 新端点 `/admin/auth/exchange`（id_token 换 session cookie + CSRF）|
| **tenant auth 下沉 service** | stack capability verifier、操作权限矩阵、authority resolver port 与 30s/60s 有界缓存迁入 `@unicas/service`；Cloudflare 层只负责用 D1 repository 注入 authority 数据与记录事件 |
| **Root Ref 内核下沉 service** | 请求 canonicalization、幂等、节点/aggregate 校验、domain projection、revision transition plan 与 bounded retry 迁入 `@unicas/service`；D1/R2 adapter 只负责语义化读取与原子提交 |
| **node GC 内核下沉 service** | 过期无引用候选、删除前复核、content-before-metadata 顺序与回收统计迁入 `@unicas/service`；D1/R2 adapter 保留候选 SQL、对象删除和 multiplicity-aware edge cascade |

## 待办（README 定方向）

1. **capability 归属复查**：如未来出现第二个消费方，可独立成包或并入
   `codec` 包（目前它是 JWT claim 词汇，留在 `tenant-protocol` 合理）。
2. **服务实现下沉**：tenant authorization 与 Root Ref command 内核已迁入
  `service`，node GC 也已下沉；下一步把 `server-cloudflare` 的 node
  lease/read/usage 规则与
  `control-plane` 的业务逻辑迁入 `service` 的平台无关 handlers，使其只通过语义化
  store/blob/keyed-actor 端口工作；D1 SQL、R2 与 DO wrapper 留在
  `service-cloudflare`。
3. **入口收尾**：把 `admin-webui/src/server` 与 `control-plane-mcp` 的
  Cloudflare ingress 并入 `service-cloudflare` 后删除三个迁移实现包；
  `admin-webui` 最终只保留浏览器 UI，并恢复 `webui -> client -> protocol`。

## 维护约定

- 依赖 guard：`tests/unit/workspace/package-deps.test.mjs`（目录名=包名、声明与
  import 一致、composite tsconfig references 恰好覆盖 dependencies）。
- 边界测试：`service`、`service-cloudflare` 以及迁移实现包（`admin-webui`、
  `control-plane`、`control-plane-mcp`、`server-cloudflare`）各自有
  `tests/boundary.test.ts`，断言允许的依赖集与跨组禁止项；**client 层与
  契约/编码层包**（`tenant-client`、`tenant-blob-client`、`admin-client`、
  `admin-protocol`、`tenant-protocol`、`codec`、`control-auth`）的依赖边界
  由 package-deps guard（声明与 import 一致）加
  `admin-protocol/tests/cross-plane.test.ts`（只放行
  `admin-protocol -> tenant-protocol`，其余跨面实现依赖禁止）兜底。
- 改名流程：`git mv` 目录 → 同步 `package.json` `name` → 更新所有 import /
  tsconfig references / workspace aliases / 当前文档 → guard 与 boundary 测试兜底。
- 历史 plan/spec 文档（`docs/superpowers/`）是决策记录，**不改名**。
