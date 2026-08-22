# UniDocs Azure 真实云部署设计

日期:2026-08-22
状态:已确认,待实施

## 1. 背景与目标

`docs/superpowers/specs/2026-08-20-azure-deployment-design.md`(下称**父设计**)规划了 0–4 五个阶段,其中阶段 1–3 已实施并合入 main。父设计第 1 章明确写着"**不写 Bicep,不碰 Azure 订阅。真实云部署是下一轮的事**",第 4.5 节的 Azure 拓扑也标注为"本轮只落地本地等价物"。

**本设计就是那一轮。** 它把父设计 §4.5 从假设变成可执行的 Bicep 与部署脚本,在真实订阅上建出资源并跑通端到端。

**目标**:把 gateway、markdown、docx 三个服务部署到 Azure Container Apps,数据落在 PostgreSQL Flexible Server 与 Blob Storage 上,通过公网网关完成 markdown 与 docx 的完整读写导出链路。

**非目标**:

- CI/CD —— 本轮只交付可重复的本地部署脚本;把它搬进 Gitea Actions 是之后的事
- `azure-cas`(父设计阶段 4)—— docx 的用户级 CAS 本轮继续指向 Cloudflare CAS worker
- `azure-markdown` / `azure-docx` 两个包的合并 —— 已确认推后(见 §11)
- 生产级网络隔离(VNet + 私有端点)、多区域、灾备
- Operator(ReAct 循环)的生产化 —— 其 `llmProvider` / `getEditorStub` 仍是抛异常的 stub

**验收终点**:`scripts/azure-deploy.mjs` 一条命令可重复执行,执行后 `scripts/azure-smoke.mjs` 对**公网网关**的全部断言通过,且再次 `what-if` 无变更。详见 §10。

## 2. 范围

本轮交付六类产物:

| 类别 | 产物 |
|---|---|
| IaC | `infra/bootstrap.bicep`、`infra/main.bicep` |
| 镜像 | 根目录 `Dockerfile`(`ARG SERVICE` 参数化)+ `.dockerignore` |
| 代码改动 | `azure-sdk` 的 Blob 客户端改身份认证;`azure-docx` 补依赖声明(§6) |
| 编排 | `scripts/azure-deploy.mjs` |
| 验证 | `scripts/azure-smoke.mjs` |
| 文档 | `README.md` 的部署章节 |

## 3. 订阅事实与约束

目标订阅 `Societas-MSIT-NonProd`(`24c9acbd-c2f5-4ef9-b9a2-486d90208b3e`,Microsoft 租户)。以下事实通过 `az` 只读查询确认,并直接约束了设计:

**a) 订阅是多项目共用,一项目一 RG。** 现有 RG 包括 `SocietasProject`、`SocietasLab`、`BizTable`、`Evaluation`、`PMStudioProject`、`rg-csicolab-auth-dev` 等。新建 `rg-unidocs-dev` 顺应既有惯例,与其他项目资源完全隔离。

**b) 三条已生效的 deny policy**(`enforcementMode: Default`):

| Policy | 对本设计的影响 |
|---|---|
| `SFI-ID4.2.1 — deny storage accounts with shared key access` | **存储账户不能用连接字符串。** 直接导致 §6 的代码改动 |
| `SFI — deny container registries with the local admin account enabled` | ACR 不能开 admin 账号;拉镜像必须走 Managed Identity + `AcrPull` |
| `SFI-ID4.2.7 — deny Azure Cache for Redis using access keys` | 与本设计无关(不使用 Redis) |

**c) `Microsoft.App` 资源提供程序未注册。** 整个订阅没有任何 Container Apps —— 现有项目全部跑在 AKS 上。部署第一步必须执行一次订阅级的 `az provider register -n Microsoft.App --wait`(已获授权)。`Microsoft.ContainerService` / `Microsoft.DBforPostgreSQL` / `Microsoft.ContainerRegistry` / `Microsoft.OperationalInsights` 均已注册。

**d) 现有 8 台 PostgreSQL Flexible Server 全部是 v17。** 本设计沿用 v17,与订阅内既有实践一致。

**e) region 选 `southeastasia`。** 与 `BizTable` 一致;Societas 主力在 `westcentralus` / `japaneast`,与本项目无关。

## 4. 目标拓扑

单个 RG `rg-unidocs-dev`,region `southeastasia`。

```
公网 → ca-unidocs-gateway (external ingress, :8787)
            ↓ 环境内部 DNS (https, 443)
       ca-unidocs-markdown (internal ingress, :8788)
       ca-unidocs-docx     (internal ingress, :8789)
            ↓                      ↓
   PostgreSQL Flexible Server   Blob Storage        公网 → Cloudflare CAS worker
                                (Managed Identity)          (仅 docx + gateway)
```

### 4.1 资源清单

| 资源 | 名称 | 归属 | 关键配置 |
|---|---|---|---|
| Container Registry | `crunidocs{uniqueString}` | bootstrap | Basic,`adminUserEnabled: false` |
| Log Analytics | `log-unidocs-dev` | bootstrap | Container Apps 环境的日志接收端 |
| Key Vault | `kv-unidocs-{uniqueString}` | bootstrap | RBAC 授权模式;仅供部署脚本持久化生成的密钥(§5) |
| Storage Account | `stunidocs{uniqueString}` | bootstrap | StorageV2,`allowSharedKeyAccess: false` |
| User-assigned MI | `id-unidocs-dev` | bootstrap | 挂在三个 App 与迁移 Job 上 |
| 角色分配 ×2 | — | bootstrap | UAMI 在 ACR 上 `AcrPull`,在 Storage 上 `Storage Blob Data Contributor` |
| PostgreSQL Flexible Server | `psql-unidocs-{uniqueString}` | main | **v17**,`Standard_B1ms`,32 GB,库名 `unidocs` |
| Container Apps Env | `cae-unidocs-dev` | main | 消费型,不接自定义 VNet |
| Container App ×3 | `ca-unidocs-gateway` / `-markdown` / `-docx` | main | 见 4.2 |
| Container Apps Job | `caj-unidocs-migrate` | main | `manual` 触发,跑 `node dist/migrate-cli.js` |

归属划分的依据见 §5:`bootstrap` 是不消费密钥、且必须先于镜像推送与密钥播种存在的资源;`main` 是消费 `@secure()` 参数的计算与数据库资源。

ACR、Key Vault、Storage、Postgres 四个名称需全局唯一,统一用 `uniqueString(resourceGroup().id)` 后缀,保证同一 RG 重复部署得到同一名称(幂等)。

Blob 容器 `cas` 与 `snapshots` **不在 Bicep 中声明** —— `ports-blob.ts` 已经 `createIfNotExists()` 懒建(`packages/azure-sdk/src/ports-blob.ts:19,21`)。`Storage Blob Data Contributor` 角色包含建容器权限,懒建路径在云上成立。

### 4.2 Container App 配置

| App | ingress | targetPort | 副本 |
|---|---|---|---|
| gateway | **external** | 8787 | min 1 / max 3 |
| markdown | internal | 8788 | **min 2** / max 5 |
| docx | internal | 8789 | **min 2** / max 5 |

doc type 的 `minReplicas = 2` 是刻意的:阶段 3 证明的是**多副本拓扑**下的并发正确性(条件写 + `(doc_type, doc_id, version)` 主键),生产上跑单副本等于把那份保证退回未验证状态。这是成本旋钮,验收完成后可下调,但下调即意味着放弃该保证的持续验证。

健康检查用 Container Apps 对 `targetPort` 的默认 TCP 探针,不新增 `/health` 端点(YAGNI —— 没有任何现有需求要求它)。

内部 FQDN 形如 `ca-unidocs-markdown.internal.<envDefaultDomain>`,由 Bicep 输出并注入网关的 `MARKDOWN_WORKER_URL` / `DOCX_WORKER_URL`。注意走 **443/https**,不是容器端口 —— ingress 负责映射。这条路径复用 `azure-gateway/src/main.ts:39` 已有的 `{TYPE}_WORKER_URL` 解析,无需注册表服务(父设计 §4.5 的原话:"KV 的角色由平台 DNS 承担")。

### 4.3 环境变量

| App | 变量 |
|---|---|
| gateway | `PORT=8787`、`DATABASE_URL`(secret)、`INTERNAL_TOKEN`(secret)、`MARKDOWN_WORKER_URL`、`DOCX_WORKER_URL`、`CAS_BASE_URL` |
| markdown | `PORT=8788`、`DATABASE_URL`(secret)、`INTERNAL_TOKEN`(secret)、`BLOB_ACCOUNT_URL`、`AZURE_CLIENT_ID` |
| docx | `PORT=8789`、同上 + `CAS_BASE_URL` |
| migrate Job | `DATABASE_URL`(secret)、`BLOB_ACCOUNT_URL`、`AZURE_CLIENT_ID` |

`CAS_BASE_URL` 指向**已部署的 Cloudflare CAS worker 自身的 base URL**,不是网关的 —— 这条约束在阶段 3 的设计 §6 中确立,`packages/azure-sdk/src/doc-type-service.ts` 的 `httpCasFetcher` 与 `azure-gateway/src/main.ts:56-73` 两侧都依赖它。

`AZURE_CLIENT_ID` 必须显式注入 UAMI 的 clientId。使用**用户分配**的托管标识时,`DefaultAzureCredential` 无法自行判断该用哪个身份;缺了它容器能启动但取不到 token,失败点会推迟到第一次 Blob 操作。

### 4.4 网络与数据库可达性

Container Apps 用消费型环境、不接自定义 VNet,Postgres Flexible Server 开公网端点。这两个选择合起来必须回答一个问题:防火墙放行谁?

**本设计刻意不依赖"消费型环境有稳定的出口 IP"这个前提。** 该前提未经验证,且消费型 Container Apps 环境并不保证出站 IP 稳定 —— `managedEnvironments` 上的 `staticIp` 是给**入站**用的,不是一个可枚举、可写进防火墙的出站集合。把它当既成事实写进设计,等于把整个连通性模型架在一个可能不成立的假设上。

因此本轮采用**显式的 dev 期妥协**:在 Flexible Server 上建一条 `0.0.0.0 - 0.0.0.0` 的防火墙规则(即门户里的"允许 Azure 服务和资源访问此服务器")。它的真实含义必须写清楚,不能含糊过去:

- 放行的是**整个 Azure 平台**的出站流量 —— 不只是本订阅,更不只是本环境
- 唯一的实际屏障是 Postgres 凭据(§5 生成的强随机管理员密码)
- 它**不**放行公网任意来源

要真正做到按 IP 限制,路径不是"以后再加固",而是换环境形态:工作负载配置文件型环境 + 自定义 VNet + NAT 网关(固定出口),或直接上私有端点。换句话说,**如果 IP 级限制是硬要求,它就是前置条件而不是延后项**。本轮明确选择不把它当硬要求,理由是 dev 环境且凭据强随机;这个选择连同其后果记在 §11。

实施时若发现该防火墙规则被订阅策略拒绝(§3 列出的三条 policy 均与 Postgres 无关,但策略集可能变化),则本节的结论翻转 —— VNet + 私有端点变成前置条件,须回到设计层重新决定,而不是在脚本里找绕过办法。

## 5. 密钥与身份

**只有两个真密钥**:Postgres 管理员密码,以及 `INTERNAL_TOKEN`。Blob 与 ACR 都因 §3(b) 的 policy 改成了身份认证,不再产生密钥。

**Key Vault 的角色是给部署脚本提供幂等性**,不是给运行时读取。流程:

1. `bootstrap.bicep` 建出 Key Vault(RBAC 模式)、UAMI、ACR、Storage、Log Analytics,并做两条角色分配:UAMI 在 ACR 上 `AcrPull`,在 Storage 上 `Storage Blob Data Contributor`
2. 部署脚本对 `pg-admin-password` 与 `internal-token` 两个 secret 执行"存在则读,不存在则用 `crypto.randomBytes` 生成并写入" —— 这使得重复执行部署不会重置密码
3. 脚本把两个值作为 `@secure()` 参数传给 `main.bicep`。`@secure()` 参数**不进入部署历史**,这正是它存在的目的
4. `main.bicep` 用密码拼出 `DATABASE_URL`(含 `sslmode=require`),连同 `INTERNAL_TOKEN` 一起设为 Container App 的 **secret**,再由 `env` 以 `secretRef` 引用

这样运行时不需要访问 Key Vault,UAMI 的角色分配只有 `AcrPull` 和 `Storage Blob Data Contributor` 两条;执行部署的人类身份需要 `Key Vault Secrets Officer`。

两阶段拆分(`bootstrap` / `main`)是被密钥的先后依赖**逼出来**的,不是为了分层而分层:ACR 必须先于镜像推送存在,Key Vault 必须先于 secret 播种存在,而 `main` 消费的正是这两者的产物。

## 6. 必须的代码改动

真实部署不只是 IaC。有三处代码非改不可,它们是本轮的前置任务。

### 6.1 Blob 客户端改身份认证(policy 强制)

`packages/azure-sdk/src/pool.ts:66` 当前是:

```ts
export function createBlobService(cfg: AzureConfig): BlobServiceClient {
  return BlobServiceClient.fromConnectionString(cfg.blobConnectionString);
}
```

连接字符串即 shared key。在这个订阅里建出的存储账户 `allowSharedKeyAccess` 被强制为 `false`,这条路径在云上是死的。改为双分支:

```ts
export function createBlobService(cfg: AzureConfig): BlobServiceClient {
  if (cfg.blobConnectionString)
    return BlobServiceClient.fromConnectionString(cfg.blobConnectionString);
  if (cfg.blobAccountUrl)
    return new BlobServiceClient(cfg.blobAccountUrl, new DefaultAzureCredential());
  throw new Error("neither BLOB_CONNECTION_STRING nor BLOB_ACCOUNT_URL is set");
}
```

- `AzureConfig` 增加 `blobAccountUrl?: string`
- `azure-sdk` 增加依赖 `@azure/identity`
- `packages/azure-sdk/src/doc-type-service.ts:152` 与 `packages/azure-sdk/src/migrate-cli.ts:35` 的 `requireEnv("BLOB_CONNECTION_STRING")` 改为二选一,且**两者同时提供时报错** —— 静默优先某一个会让配置错误潜伏到运行时
- `ports-blob.ts` 无需改动:它的两个类都接收已构造好的 `BlobServiceClient`,`pool.ts:66` 是唯一构造点

**配置契约(判定点在进程启动,不在第一次 Blob 操作)**

`BLOB_CONNECTION_STRING` 与 `BLOB_ACCOUNT_URL` 是互斥的两种模式:

| 情形 | 行为 |
|---|---|
| 只有 `BLOB_CONNECTION_STRING` | 本地 / Azurite 模式 |
| 只有 `BLOB_ACCOUNT_URL` | 云上托管标识模式;**此时 `AZURE_CLIENT_ID` 必须同时存在** |
| 两者都有 | **启动失败** |
| 两者都无 | **启动失败** |
| 有 `BLOB_ACCOUNT_URL` 但无 `AZURE_CLIENT_ID` | **启动失败** |

最后一行是关键的一条,原先只在 §4.3 写成了提示:用**用户分配**的托管标识时,`DefaultAzureCredential` 缺了 `AZURE_CLIENT_ID` 照样能构造成功,失败会推迟到第一次 Blob 操作 —— 那时容器已经通过健康检查、已经开始接流量。因此它必须和另外两个变量一样,进 `doc-type-service.ts` 与 `migrate-cli.ts` 的启动检查,而不是作为一句注释。

保留连接字符串分支是必需的:Azurite 不支持托管标识,`scripts/azure-runtime.mjs` 与 `tests/bootstrap/` 的 e2e 树都走连接字符串。因此 `pnpm test:local` 与 e2e 树不受本改动影响 —— 这是验收的一部分。

### 6.2 `azure-docx` 补依赖声明(部署阻塞)

`packages/azure-docx/dist/main.js` 含裸导入 `pg` 与 `@azure/storage-blob`,而 `packages/azure-docx/package.json` 两者都没声明。monorepo 里靠提升能解析,生产安装会 `ERR_MODULE_NOT_FOUND`。

根因是两份 `scripts/bundle.mjs` 的漂移:markdown 那份用 `packages: "external"`(全部外部化,故其 package.json 正确声明了这两个包),docx 那份用 `external: EXTERNAL_NPM_PACKAGES`(因为 `@ariadng/office` 必须打进产物),同样把这两个包留在外面却漏了声明。

修复是给 `azure-docx/package.json` 补上这两条 `dependencies`。§7 的镜像方案让这类错误从"生产期失败"变成"构建期失败"。

### 6.3 TLS 连接串(需实施时验证)

`createPool`(`pool.ts:49`)直接把 `databaseUrl` 交给 `pg`,不设 `ssl` 选项,因此 TLS 行为完全由连接串里的 `sslmode` 决定。Flexible Server 强制 TLS,而本地 Postgres 不用。`DATABASE_URL` 因此带 `?sslmode=require`。

`pg` 各版本对 `sslmode=require` 的证书校验行为不完全一致,**实施时必须实测确认连接成功**,而不是假定。若 `require` 不足以建立连接,退路是在 `createPool` 中按 `sslmode` 显式构造 `ssl` 选项。收紧到 `verify-full` 属于后续加固,不在本轮(见 §11)。

## 7. 镜像与构建

**一份**根目录 `Dockerfile`,`ARG SERVICE` 取四个值之一:`azure-gateway`、`azure-markdown`、`azure-docx`、`azure-sdk`。

第四个是迁移 Job 的镜像 —— `azure-sdk` 已经有自己的 `scripts/bundle-migrate-cli.mjs` 产出 `dist/migrate-cli.js`,且其 `package.json` 正确声明了 `pg` 与 `@azure/storage-blob`。复用同一个 Dockerfile 而不是为迁移单开一份。

多阶段:

1. **builder**:`node:24-alpine`,corepack 启用 pnpm 11.22.0,`pnpm install --frozen-lockfile --registry=https://repo.huaweicloud.com/repository/npm`(公网 npm 源在本机被 SNI 拦截),`pnpm -r build`
2. **prune**:`pnpm deploy --filter @unidocs/${SERVICE} --prod /out` —— 产出**真实(非软链)**的 `node_modules`
3. **runtime**:`node:24-alpine`,只拷 `/out`,`CMD ["node", "dist/main.js"]`(迁移镜像覆盖为 `dist/migrate-cli.js`)

选 `pnpm deploy` 而不是手工拷 `node_modules` 的关键理由:它**严格按 package.json 的声明裁剪**。§6.2 里 azure-docx 漏声明的两个包会被裁掉,容器直接起不来 —— 也就是说这个方案把那一整类"声明与产物不一致"的 bug 提前到构建期暴露,而不是等到生产。这是选它的主要原因,不是副作用。

镜像 tag 用 git short sha,不用 `latest` —— Container Apps 的 revision 需要镜像引用变化才会滚动。

## 8. 部署编排与迁移

Bicep 不负责跑数据库迁移(基础设施变更与数据变更分离)。`scripts/azure-deploy.mjs` 按序编排:

1. **预检**:`az account show` 确认订阅;确认 `Microsoft.App` 已注册,未注册则执行 `az provider register -n Microsoft.App --wait`
2. **bootstrap**:`az deployment group create -f infra/bootstrap.bicep`(先 `what-if` 打印差异)
3. **播种密钥**:Key Vault 中两个 secret 存在则读、不存在则生成(§5)
4. **构建与推送**:四个镜像,tag = git short sha;`az acr login`(走 az 身份,**不是** admin 密码,policy 禁止)
5. **main**:`what-if` → `create`,传入 `@secure()` 参数与镜像 tag
6. **迁移**:`az containerapp job start` 触发 `caj-unidocs-migrate`,轮询至成功;失败则中止并打印 Job 日志
7. **冒烟**:`scripts/azure-smoke.mjs` 打公网网关 FQDN

首轮部署时三个 App 会先于迁移完成而存在,其副本会因表不存在而反复重启;迁移成功后自愈。这是可接受的:Container Apps 的重启退避会覆盖迁移耗时,且首轮之后不再发生。脚本在第 6 步失败时中止,不会把一个连不上库的部署当成成功。

## 9. 对父设计 §4.5 的偏离

父设计的 Azure 拓扑写于实施之前。本设计有三处刻意偏离,逐条记录理由,以便审阅:

| 父设计 §4.5 | 本设计 | 理由 |
|---|---|---|
| "三个 Container App 均可 `minReplicas = 0`" | doc type `minReplicas = 2` | 阶段 3 证明的多副本正确性需要在生产拓扑上持续成立;跑单副本(更不用说零)会使该保证退回未验证。成本代价见 §11 |
| "`INTERNAL_TOKEN` 存 Key Vault,经 ACA secret 引用 + Managed Identity 读取" | Key Vault 只作部署脚本的幂等存储,运行时经 `@secure()` 参数 → ACA secret | 两种方式都不把密钥暴露在部署历史里,后者少一条运行时角色分配与一次启动期 Key Vault 往返。若将来需要密钥轮换而不重新部署,再切回运行时引用 |
| "数据库与存储账号的访问统一走 Managed Identity,不下发连接字符串密码" | 存储走 MI(policy 强制);**Postgres 仍用密码** | Entra 认证要求给 `pg` 加 token 刷新回调(约 1 小时过期)、配置 Flexible Server 的 Entra 管理员、并以 Entra 会话执行 `CREATE ROLE ... WITH LOGIN`。这是独立一块工作,见 §11 |

## 10. 验收标准

1. `pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm test:local` 全绿 —— §6.1 的改动**不得**影响本地栈与 e2e 树
2. `tests/bootstrap/` e2e 树全绿(Cloudflare 与本地 Azure 两侧断言均通过)
3. `scripts/azure-deploy.mjs` 从空 RG 执行成功,建出 §4.1 的全部资源
4. 迁移 Job 成功,`unidocs` 库中 `deltas` / `doc_snapshots` / `docs` 三张表存在且结构与父设计 §5.1 一致
5. `scripts/azure-smoke.mjs` 对**公网网关 FQDN** 的全部断言通过:
   - markdown:create → apply → query → export
   - docx:create → apply → query → export
   - docx 图片路径:上传到 Cloudflare CAS → `insertImage` → `getImages` → `export` 得到合法 zip。**这一条专门证明跨云 HTTP 接线在真实网络下成立**
   - 至少一次 `apply` 使用过期的 `baseVersion`,断言返回 409 且响应体带当前 `version`
   **为什么这几条断言足以验证托管标识的 Blob 通路**:`apply` 每次都经 `#saveSnapshotCache()` 写一次 Blob 快照,走的是**严格**版本 —— 失败直接冒泡(`packages/server-core/src/session.ts:689,751`)。因此上面任何一次成功的 `apply` 都证明了托管标识写 Blob 成立,不需要为此另加测试。反过来必须注意:`create` 走的是**尽力而为**版本(`session.ts:464,546` → `#saveSnapshotCacheBestEffort`,会吞掉 Blob 失败),所以**只做 create 的冒烟不能验证托管标识** —— 冒烟必须包含 apply,这是上述断言的必要成分而非顺带。

6. **幂等**:紧接着再次执行 `scripts/azure-deploy.mjs`,两次 `what-if` 均无变更,冒烟仍然全绿,且 Postgres 密码未被重置
7. ACR 的 `adminUserEnabled` 为 `false`、存储账户的 `allowSharedKeyAccess` 为 `false` —— 即部署未因绕开 §3(b) 的 policy 而成功

## 11. 风险与未决事项

| 项 | 状态 | 说明 |
|---|---|---|
| Postgres 公网端点 + `0.0.0.0` 防火墙规则(放行整个 Azure 平台) | **本轮接受** | 见 §4.4。**不**依赖"消费型环境出口 IP 稳定"这一未验证前提;唯一屏障是强随机凭据。若 IP 级限制成为硬要求,它是前置条件(需换成工作负载配置文件 + VNet + NAT 网关或私有端点),不是延后加固 |
| Postgres 用密码认证而非 Entra ID | **本轮接受** | 路径明确(§9 第三行),但属独立工作量 |
| `sslmode=require` 的证书校验强度 | **待实施时确认** | 见 §6.3。收紧到 `verify-full` 是后续加固 |
| docx 依赖 Cloudflare CAS worker | **本轮接受** | 已确认的范围决定。**后果:本轮的部署形态不可私有化交付**,阶段 4 的 `azure-cas` 落地后才可 |
| 无 CI | **本轮接受** | 已确认的范围决定。部署脚本本身即将来 CI 调用的对象 |
| `azure-markdown` / `azure-docx` 未合并 | **推后** | 已确认。代价:3 份服务镜像,以及两份已经漂移过一次的 `bundle.mjs`(§6.2 的 bug 正源于此)仍然并存。合并成单一 `DOC_TYPE` 参数化镜像可一次性消除该漂移面 |
| 常驻副本成本 | **已知** | 粗估 $85–105/月(Container Apps 5 个常驻副本占大头,Postgres B1ms 约 $13,ACR Basic $5)。`minReplicas` 是旋钮,下调的含义见 §4.2 |
| 部署者的 RBAC 权限未只读验证 | **待第一步确认** | `az role assignment list` 对本账号返回空(权限疑似经组继承,命令查不到)。首次 `az group create` 会给出确定答案 |
