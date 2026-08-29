# unicas-packages — Unicas 包结构与边界

Unicas 是 UniDocs 的独立可部署 CAS 中间件（content-addressed storage + stack
控制面）。`unicas-packages/` 是它的物理边界：**未来独立 CAS monorepo 只需
`git mv` 整个目录，把 `workspace:*` 换成 registry 版本，import 语句零改动**。
2026-08-29 重组后，本目录内**零 `@unidocs/*` 依赖**，该承诺完全兑现。

## 命名规则

1. **目录名 = 包名**：`unicas-packages/<name>` = `@unicas/<name>`，一一对应。
   改名必须同时改目录名与 `package.json` 的 `name`（依赖 guard 强制校验，
   见 `tests/unit/workspace/package-deps.test.mjs`）。
2. **按 actor 分两组**（与 client 侧规则一致）：
   - `tenant-*` — 租户数据面（内容寻址存储）
   - `admin-*` — 管理员控制面（stack 管理）
3. **编码层**：`codec` —— wire 编码，独立发布、独立测试，无 workspace 依赖。
4. **契约包**：`tenant-protocol`（数据面 HTTP 契约 + capability）/
   `admin-protocol`（控制面契约）。只放类型、路由、校验、常量——无 IO、
   无平台绑定、**不含任何编码**。
5. **界面/入口**：`admin-webui`（管理 WebUI + OIDC BFF，双角色包）、
   `admin-cli`（管理 CLI + stdio MCP）、`tenant-client`（数据面 HTTP client）。
6. **服务标记**：`control-*` = 控制面服务（`control-plane`、`control-auth`、
   `control-plane-mcp`）；`server-*` = 数据面服务端部署
   （`server-cloudflare`）；`edge` = 公共入口（不属任何 actor 组）。

## 包清单（13 包）

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
│   ├── control-plane/     @unicas/control-plane      admin 组
│   │     控制面服务库：ControlPlaneService（CAS_CONTROL_DB 唯一写入路径）、
│   │     AuthorityRepository、sessions、jwks、possession、audit、cursor、ids
│   └── control-auth/      @unicas/control-auth       admin 组
│         OIDC 认证库：discovery、PKCE、id_token 校验（admin-webui 与
│         control-plane-mcp 共用）
│
├── ■ 部署层（Cloudflare Workers）
│   ├── server-cloudflare/ @unicas/server-cloudflare   tenant 组 · 数据面服务端
│   │     worker、tenant-do、domain-do、auth、nodes、root-refs、audit-reads
│   ├── edge/              @unicas/edge               共用入口
│   │     /stacks /admin /mcp /health 精确转发 + header 隔离
│   ├── control-plane-mcp/ @unicas/control-plane-mcp   admin 组 · 控制面 MCP 入口
│   │     OAuth + MCP Streamable HTTP，工具经 ControlPlaneService
│   └── admin-webui/       @unicas/admin-webui         admin 组 · 双角色
│         src/ui（管理界面）+ src/server（OIDC BFF）
│
└── ■ client 层
    ├── tenant-client/     @unicas/tenant-client       tenant 组 · 传输层
    │     纯 HTTP 封装，每个路由一个函数（readMetadata/readContent/
    │     leaseNode/updateRootRefs/usage/gc），factory 绑定 tenantId/JWT；
    │     无编码、无业务封装，仅组装层使用
    ├── tenant-blob-client/@unicas/tenant-blob-client  tenant 组 · 业务面
    │     业务方唯一入口：storeBlob / openBlob(句柄式随机读) / statBlob /
    │     readMetadata / leaseNode / updateRootRefs / usage / gc
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
编码层(codec)
  ← 契约层(tenant-protocol, admin-protocol)
    ← 内核层(control-plane, control-auth)
      ← 部署层(server-cloudflare, edge, control-plane-mcp, admin-webui)
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
- 契约层：`tenant-protocol` 仅外部 `jose`；`admin-protocol` 零依赖。
- 内核层只依赖契约层（`control-plane` → `admin-protocol`）。
- 部署层只依赖内核层 + 契约层 +（数据面所需）编码层，**部署层之间零依赖**
  （`admin-webui` 与 `control-plane-mcp` 各自独立绑定 D1，业务写入全部收敛到
  `ControlPlaneService`）。
- 数据面 / 控制面**跨组 import 禁止**：tenant 组包不得依赖 admin 组包，
  反之亦然（`admin-protocol/tests/cross-plane.test.ts` 把 `codec` 也列入
  tenant 实现包，admin 侧不得依赖；各包 `tests/boundary.test.ts` 断言）。
- **零 `@unidocs/*` 依赖**：unicas-packages 是独立中间件。`server-cloudflare`
  唯一允许的应用栈 devDependency 是测试用的 `@unidocs/service-auth`
  （签发器），生产代码不引用。
- `admin-cli` 零运行时 workspace 依赖：它通过 MCP 通道访问控制面，只在
  类型层依赖 `admin-protocol`，保持独立可发布。

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

## 待办（README 定方向）

1. **capability 归属复查**：如未来出现第二个消费方，可独立成包或并入
   `codec` 包（目前它是 JWT claim 词汇，留在 `tenant-protocol` 合理）。

## 维护约定

- 依赖 guard：`tests/unit/workspace/package-deps.test.mjs`（目录名=包名、声明与
  import 一致、composite tsconfig references 恰好覆盖 dependencies）。
- 边界测试：每个包的 `tests/boundary.test.ts` 断言允许的依赖集与跨组禁止项。
- 改名流程：`git mv` 目录 → 同步 `package.json` `name` → 更新所有 import /
  tsconfig references / workspace aliases / 当前文档 → guard 与 boundary 测试兜底。
- 历史 plan/spec 文档（`docs/superpowers/`）是决策记录，**不改名**。
