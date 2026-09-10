# UniDocs Glossary

This file is the repository-wide naming and boundary index. It standardizes how
terms are written and used; linked design documents and protocol packages remain
the authority for behavior and wire contracts.

## Maintenance rules

- Preserve the canonical spelling and capitalization shown in the **Term** column.
- Preserve code identifiers such as `docId`, `sessionId`, and `tenantId` exactly.
- Use **CAS** for the storage model and **UniCAS** for the independently deployable
  CAS middleware product.
- Capitalize named platform roles and resources such as **Admin**, **Agent**,
  **Operator**, **Type Card**, and **View**. Use lowercase only for generic usage.
- Update this file in the same change that introduces or materially redefines a
  repository-wide term. Keep package-local implementation details in package
  documentation instead.
- When this glossary conflicts with a linked specification or exported protocol
  type, the specification or protocol type wins; update this file to match it.

## Product and platform

| Term | 中文定义 | Usage and boundary |
|---|---|---|
| **UniDocs** | 面向 AI Agent 的通用文档编辑平台。 | Product name. Do not write “Unidocs” or “Uni Docs”. |
| **UniCAS** | 可独立部署的内容寻址存储中间件，包含 tenant 数据面和 stack 管理控制面。 | Product name. Source lives under [`unicas-packages/`](unicas-packages/README.md). Do not use this name for every generic CAS implementation. |
| **Platform** | 持久化文档、版本、thread、current pointer 与 submission 的平台服务。 | The persistence authority in the Platform v0 model; a View or Operator is not a second persistence authority. |
| **Gateway** | 面向最终用户的服务入口，负责认证、租户成员关系、文档目录与路由。 | Owns public `docId` to private `sessionId` routing. It does not own document-format behavior. |
| **Doc service** | 承载某一种文档类型会话和格式逻辑的服务。 | One independently deployable service per document type. It receives an opaque `sessionId`, not end-user identity. |
| **Admin** | 管理文档类型、bundle、Operator 和 UniCAS stack 的控制面角色或界面。 | Capitalize when naming the product role or surface. “Admin” does not mean the tenant data-plane `cas:manage` permission. |
| **Agent** | 代表用户读取、推理并提出文档变更的 AI 参与者。 | Uses the Platform Agent API in the target model. An Agent may call an Operator but is not synonymous with one. |
| **Host** | 装载 View、提供用户界面外壳并代理 Host RPC 的运行环境。 | A View receives capabilities through the Host; it does not directly become the Platform authority. |
| **Operator** | 面向 Agent 的文档能力服务，执行领域查询并生成原子 submission。 | Capitalized platform role. An Operator endpoint declares supported document types and Snapshot Contract revisions. |
| **View** | 由 Host 装载的文档交互界面。 | Capitalized platform resource. A View bundle declares compatible Snapshot Contract revisions and location types. |
| **Type Card** | 在创建或选择文档类型时展示的多语言名称、说明、图标与示例缩略图。 | Distributed as an immutable Type Card bundle. It is presentation metadata, not a document schema. |
| **bundle** | 带 manifest 的不可变、内容寻址发布物。 | Keep the qualified form when ambiguity is possible: **Type Card bundle** or **View bundle**. Admin-only name and description are mutable metadata, not bundle content. |

See [Platform v0 design context](docs/design/platform-v0/README.md) and
[Microservice Architecture](docs/microservice-architecture.md) for the platform
roles and deployment boundaries.

## Documents and collaboration

| Term | 中文定义 | Usage and boundary |
|---|---|---|
| **document type** | 定义文档格式、Snapshot Contract、View 与 Operator 兼容性的注册类型。 | Identified in code by `documentType`. Do not use it to mean one document instance. |
| **document** | 用户可识别和协作的文档实例。 | Publicly addressed by `docId`; its internal service session is separate. |
| **`docId`** | Gateway 分配的公开文档标识。 | Tenant-scoped routing identity. Never substitute a snapshot hash as a public document capability. |
| **`sessionId`** | Doc service 使用的私有、不可变会话标识。 | Resolved and forwarded by the Gateway. It is not a user-facing document ID. |
| **version** | 文档状态历史中的一个编号状态或节点。 | In the current delta model, versions are monotonically increasing integers. Platform v0 additionally models version relationships as a graph. |
| **delta** | 原子应用的一批文档操作。 | Either the entire batch applies or none of it does. Retained delta roots are distinct from standalone snapshots. |
| **snapshot** | 可独立读取和保留的完整文档状态。 | A snapshot is data at a point in history; it is not the schema that describes that data. |
| **Snapshot Contract** | 某文档类型 snapshot 的版本化 SValue schema 契约。 | Revisions are append-only. `SnapshotContractIdx` identifies a revision; the highest revision is the only writable revision in Platform v0. |
| **submission** | Agent 或 Operator 提交给 Platform 的原子协作变更。 | May contain coordinated document and collaboration operations. Platform validates and persists it atomically. |
| **thread** | 锚定到文档位置、用于人与 Agent 协作的讨论串。 | Thread state belongs to Platform. Typed locations are interpreted with the document type and View contract. |
| **current pointer** | 指向当前文档版本的持久化引用。 | Platform owns it; it is distinct from retaining a CAS root. |

See [Agent-Mediated Document Collaboration](docs/design/platform-v0/agent-mediated-document-collaboration.md),
[Platform, View, and Operator API v0](docs/design/platform-v0/platform-view-operator-api-v0.md),
and [Doc Service HTTP Protocol](docs/doc-service-http-protocol.md) for the full
contracts.

## Data model and storage

| Term | 中文定义 | Usage and boundary |
|---|---|---|
| **CAS** | Content-addressed storage；按内容摘要寻址不可变数据的存储模型。 | Generic architecture term. In this repository, UniCAS is the standalone CAS middleware implementation. |
| **SValue** | UniDocs 的结构化值与文档内容模型。 | Application-layer model owned by `@unidocs/protocol` and `@unidocs/svalue-codec`. UniCAS treats SValue content as opaque bytes. |
| **SBlob** | 在 SValue 中表示原子二进制内容的值类型。 | Described by the SValue schema dialect. Do not confuse it with arbitrary object-store blobs or client-side blob-index manifests. |
| **TDoc** | Doc service 在内存中应用操作的不可变文档表示。 | Format-specific implementations derive and snapshot TDoc state through SValue roots. |
| **Merkle DAG** | 节点以摘要互相引用形成的有向无环图。 | Enables structural sharing and content verification. Ordered duplicate child references are significant in CAS node identity and accounting. |
| **node** | 由规范逻辑字节的 SHA-256 摘要标识的不可变 CAS 节点。 | Contains immutable metadata, ordered child refs, and own content; lease and reference counts are mutable state outside node identity. |
| **digest** | 对规范逻辑节点字节计算的完整 256-bit SHA-256 值。 | Raw form is 32 bytes. The external CAS key is its 64-character lowercase hexadecimal encoding; use **hash** only where an API or type already does. |
| **own content** | 直接属于某个 CAS node 的内容字节。 | Excludes child node content. UniCAS stores it separately from immutable metadata. |
| **child ref** | node 不可变元数据中的一个有序子节点摘要引用。 | Each occurrence contributes to `childRefCount`; duplicates are meaningful. |
| **ready node** | 不可变元数据与已验证 own content 都存在的 node。 | Only ready nodes may be read, receive a Root Ref, or be referenced by a newly inserted node. |
| **lease** | 在指定截止时间前保护 node 不被 GC 删除的临时声明。 | A lease does not imply readiness or durable business ownership. |
| **Root Ref** | 由文档 delta、snapshot 或其他业务根持有的持久 CAS 根引用。 | Contributes to `rootRefCount` and protects a root independently of a lease. Preserve this capitalization in UniCAS documentation. |
| **GC** | Garbage collection；回收租约已过期且 child/root 引用计数均为零的节点。 | Tenant-scoped operation. Expiry makes a node eligible; it does not promise immediate deletion. |

See [CAS Architecture](docs/cas-architecture.md),
[CAS Binary Format](docs/cas-binary-format.md), and
[UniCAS package boundaries](unicas-packages/README.md) for normative storage
semantics.

## Identity and access

| Term | 中文定义 | Usage and boundary |
|---|---|---|
| **stack** | 顶层部署、信任与数据命名空间。 | Identified by `stackId`. A trusted issuer maps to one stable stack. |
| **tenant** | stack 内的数据所有权与隔离边界。 | Identified by `tenantId`. Storage, usage, and GC are partitioned by stack and tenant. |
| **control plane** | 管理 stack、成员、邀请、issuer、密钥与审计的管理面。 | Served through UniCAS Admin APIs and clients. Do not call tenant content operations “admin APIs”. |
| **data plane** | 租户内容寻址存储的读写与生命周期操作面。 | Served through UniCAS tenant APIs and clients. The `cas:manage` permission is a data-plane permission. |
| **capability** | 对调用者、租户、权限和可选 Root Ref domain 进行约束的已签名授权声明。 | UniCAS tenant capabilities use JWT claims. A capability authorizes an operation; it is not a public document identifier. |
| **issuer** | 签发并可被验证信任令牌的身份提供方。 | A registered trusted JWT issuer is associated with one stack; verified claims must agree with request path identity. |
| **`refDomain`** | Root Ref 的正交审计和授权维度。 | It does not replace `stackId` or `tenantId` and is not a storage partition by itself. |

See [Capability Key Operations](docs/capability-key-operations.md) and
[UniCAS OAuth Discovery and Issuer Migration](docs/cas-oauth-discovery-and-issuer-migration.md)
for key and issuer operations.