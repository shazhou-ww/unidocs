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
3. **契约包**：`tenant-protocol`（数据面契约）/ `admin-protocol`（控制面契约）。
   只放类型、路由、编解码、校验、常量——无 IO、无平台绑定。
4. **界面/入口**：`admin-webui`（管理 WebUI + OIDC BFF，双角色包）、
   `admin-cli`（管理 CLI + stdio MCP）、`tenant-client`（数据面 HTTP client）。
5. **服务标记**：`control-*` = 控制面服务（`control-plane`、`control-auth`、
   `control-plane-mcp`）；`server-*` = 数据面服务端部署
   （`server-cloudflare`）；`edge` = 公共入口（不属任何 actor 组）。

## 包清单（11 包）

```
unicas-packages/                    @unicas org
│
├── ■ 契约层（cloud-neutral、无 IO、冻结契约）
│   ├── tenant-protocol/   @unicas/tenant-protocol   tenant 组 · 数据面
│   │     HTTP 类型/路由（types/http/routes）+ 规范节点编解码（binary/digest/
│   │     canonical-stream/validation）+ capability 词汇（capability）+ blob index
│   └── admin-protocol/    @unicas/admin-protocol    admin 组 · 控制面
│         控制面契约：类型、路由、错误码、并发/ETag、authz、威胁模型
│
├── ■ 内核/库层（cloud-neutral）
│   ├── control-plane/     @unicas/control-plane     admin 组
│   │     控制面服务库：ControlPlaneService（CAS_CONTROL_DB 唯一写入路径）、
│   │     AuthorityRepository、sessions、jwks、possession、audit、cursor、ids
│   └── control-auth/      @unicas/control-auth      admin 组
│         OIDC 认证库：discovery、PKCE、id_token 校验（admin-webui 与
│         control-plane-mcp 共用）
│
├── ■ 部署层（Cloudflare Workers）
│   ├── server-cloudflare/ @unicas/server-cloudflare  tenant 组 · 数据面服务端
│   │     worker、tenant-do、domain-do、auth、nodes、root-refs、audit-reads
│   ├── edge/              @unicas/edge              共用入口
│   │     /stacks /admin /mcp /health 精确转发 + header 隔离
│   ├── control-plane-mcp/ @unicas/control-plane-mcp  admin 组 · 控制面 MCP 入口
│   │     OAuth + MCP Streamable HTTP，工具经 ControlPlaneService
│   └── admin-webui/       @unicas/admin-webui        admin 组 · 双角色
│         src/ui（管理界面）+ src/server（OIDC BFF）
│
└── ■ 界面层（client）
    ├── admin-cli/         @unicas/admin-cli          admin 组
    │     CLI + stdio MCP（bin `unicas`），走 MCP over HTTP 通道，
    │     工具结果类型对齐 @unicas/admin-protocol 冻结契约
    └── tenant-client/     @unicas/tenant-client      tenant 组
          数据面 HTTP client，仅依赖 tenant-protocol
```

## 依赖规则（分层单向，guard + boundary 测试强制）

```
契约层(tenant-protocol, admin-protocol)
  ← 内核层(control-plane, control-auth)
    ← 部署层(server-cloudflare, edge, control-plane-mcp, admin-webui)
契约层 ← 界面层(tenant-client, admin-cli)
```

- 契约层零 workspace 依赖（`tenant-protocol` 仅外部 `cborg` + `jose`）。
- 内核层只依赖契约层（`control-plane` → `admin-protocol`）。
- 部署层只依赖内核层 + 契约层，**部署层之间零依赖**（`admin-webui` 与
  `control-plane-mcp` 各自独立绑定 D1，业务写入全部收敛到
  `ControlPlaneService`）。
- 数据面 / 控制面**跨组 import 禁止**：tenant 组包不得依赖 admin 组包，
  反之亦然（`admin-protocol/tests/cross-plane.test.ts` 与各包
  `tests/boundary.test.ts` 断言）。
- **零 `@unidocs/*` 依赖**：unicas-packages 是独立中间件。`server-cloudflare`
  唯一允许的应用栈 devDependency 是测试用的 `@unidocs/service-auth`
  （签发器），生产代码不引用。
- `admin-cli` 零运行时 workspace 依赖：它通过 MCP 通道访问控制面，只在
  类型层依赖 `admin-protocol`，保持独立可发布。

## 存储编码边界（2026-08-29 决策）

```
CAS 感知的编码 = 只有 1 种：规范 CAS 节点格式（tenant-protocol/binary.ts）
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

## 能力（capability）词汇归属

CAS 中立租户能力契约（claims / permissions / errors —— `iss, aud, sub, iat,
nbf?, exp, jti, tenantId, permissions[], refDomain?`）**归属
`tenant-protocol/src/capability.ts`**（单一事实源）。`@unidocs/service-auth`
（应用栈签发/校验实现）re-export 同一批符号，公共 API 不变，消费者零改动。

## 本轮重组记录（2026-08-29）

| 变更 | 说明 |
|---|---|
| `protocol` → `tenant-protocol` | 改名对齐 actor 前缀；内容并入数据面 codec 与 capability |
| `protocol-admin` → `admin-protocol` | 改名对齐 actor 前缀 |
| `server-common` 删除 | binary/digest/canonical-stream/validation 并入 `tenant-protocol`；`tenant-client` 与应用栈不再依赖 "server" 包 |
| capability 词汇迁入 | 从 `@unidocs/service-auth` 迁入 `tenant-protocol`，service-auth 变 re-export 薄壳 |
| SValue 专属逻辑移除 | `server-cloudflare` 不再解析 SValue；`@unidocs` 生产依赖清零 |
| `admin-cli` → 依赖 `admin-protocol` | 工具结果用冻结契约类型标注，防 schema 漂移 |

## 未来拆分计划（暂缓，README 定方向）

1. **独立 codec 包**：把 `tenant-protocol` 内的规范节点编解码
   （binary/digest/canonical-stream/validation，可能含 blob index）抽成
   独立包（如 `@unicas/codec`），独立发布、独立测试。届时
   `tenant-protocol` 聚焦 HTTP 服务的 request/response 类型与构造/工具函数。
2. **capability 归属复查**：如未来出现第二个消费方，可独立成包或并入 codec 包。

## 维护约定

- 依赖 guard：`tests/unit/workspace/package-deps.test.mjs`（目录名=包名、声明与
  import 一致、composite tsconfig references 恰好覆盖 dependencies）。
- 边界测试：每个包的 `tests/boundary.test.ts` 断言允许的依赖集与跨组禁止项。
- 改名流程：`git mv` 目录 → 同步 `package.json` `name` → 更新所有 import /
  tsconfig references / workspace aliases / 当前文档 → guard 与 boundary 测试兜底。
- 历史 plan/spec 文档（`docs/superpowers/`）是决策记录，**不改名**。
