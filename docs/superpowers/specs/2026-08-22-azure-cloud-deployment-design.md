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

**a) 订阅是多项目共用,一项目一 RG。** 现有 RG 包括 `SocietasProject`、`SocietasLab`、`BizTable`、`Evaluation`、`PMStudioProject`、`rg-csicolab-auth-dev` 等。新建 `Unidocs` 顺应既有惯例,与其他项目资源完全隔离。

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

单个 RG `Unidocs`,region `southeastasia`。

```
公网 → unidocs-gateway (external ingress, :8787)
            ↓ 环境内部 DNS (https, 443)
       unidocs-markdown (internal ingress, :8788)
       unidocs-docx     (internal ingress, :8789)
            ↓                      ↓
   PostgreSQL Flexible Server   Blob Storage        公网 → Cloudflare CAS worker
                                (Managed Identity)          (仅 docx + gateway)
```

### 4.1 资源清单

| 资源 | 名称 | 归属 | 关键配置 |
|---|---|---|---|
| Container Registry | `unidocsacr` | bootstrap | Basic,`adminUserEnabled: false` |
| Log Analytics | `unidocs-logs` | bootstrap | Container Apps 环境的日志接收端 |
| Key Vault | `unidocs-kv` | bootstrap | RBAC 授权模式;仅供部署脚本持久化生成的密钥(§5) |
| Storage Account | `unidocsblob` | bootstrap | StorageV2,`allowSharedKeyAccess: false` |
| User-assigned MI | `unidocs-identity` | bootstrap | 挂在三个 App 与迁移 Job 上 |
| 角色分配 ×2 | — | bootstrap | UAMI 在 ACR 上 `AcrPull`,在 Storage 上 `Storage Blob Data Contributor` |
| PostgreSQL Flexible Server | `unidocs-pg` | main | **v17**,`Standard_B1ms`,32 GB,库名 `unidocs` |
| Container Apps Env | `unidocs-env` | main | 消费型,不接自定义 VNet |
| Container App ×3 | `unidocs-gateway` / `-markdown` / `-docx` | main | 见 4.2 |
| Container Apps Job | `unidocs-migrate` | main | `manual` 触发,跑 `node dist/migrate-cli.js` |

归属划分的依据见 §5:`bootstrap` 是不消费密钥、且必须先于镜像推送与密钥播种存在的资源;`main` 是消费 `@secure()` 参数的计算与数据库资源。

ACR、Storage 两个名称需全局唯一(DNS 单标签,不能带连字符,这是它们没有 `unidocs-` 前缀连字符的原因);Key Vault、Postgres 的唯一性作用域更窄(资源组 / 各自服务)。四者现在都是字面量(`unidocsacr` / `unidocsblob` / `unidocs-kv` / `unidocs-pg`),不再靠 `uniqueString(resourceGroup().id)` 后缀 —— 同一 RG 重复部署天然得到同一名称,幂等性由命名本身的确定性保证,不依赖任何运行时求值。

Blob 容器 `cas` 与 `snapshots` **不在 Bicep 中声明** —— `ports-blob.ts` 已经 `createIfNotExists()` 懒建(`packages/azure-sdk/src/ports-blob.ts:19,21`)。`Storage Blob Data Contributor` 角色包含建容器权限,懒建路径在云上成立。

### 4.2 Container App 配置

| App | ingress | targetPort | 副本 |
|---|---|---|---|
| gateway | **external** | 8787 | min 1 / max 3 |
| markdown | internal | 8788 | **min 2** / max 5 |
| docx | internal | 8789 | **min 2** / max 5 |

doc type 的 `minReplicas = 2` 是刻意的:阶段 3 证明的是**多副本拓扑**下的并发正确性(条件写 + `(doc_type, doc_id, version)` 主键),生产上跑单副本等于把那份保证退回未验证状态。这是成本旋钮,验收完成后可下调,但下调即意味着放弃该保证的持续验证。

健康检查用 Container Apps 对 `targetPort` 的默认 TCP 探针,不新增 `/health` 端点(YAGNI —— 没有任何现有需求要求它)。

内部 FQDN 形如 `unidocs-markdown.internal.<envDefaultDomain>`,由 Bicep 输出并注入网关的 `MARKDOWN_WORKER_URL` / `DOCX_WORKER_URL`。注意走 **443/https**,不是容器端口 —— ingress 负责映射。这条路径复用 `azure-gateway/src/main.ts:39` 已有的 `{TYPE}_WORKER_URL` 解析,无需注册表服务(父设计 §4.5 的原话:"KV 的角色由平台 DNS 承担")。

### 4.3 环境变量

| App | 变量 |
|---|---|
| gateway | `PORT=8787`、`DATABASE_URL`(secret)、`INTERNAL_TOKEN`(secret)、`MARKDOWN_WORKER_URL`、`DOCX_WORKER_URL`、`CAS_BASE_URL` |
| markdown | `PORT=8788`、`DATABASE_URL`(secret)、`INTERNAL_TOKEN`(secret)、`BLOB_ACCOUNT_URL`、`AZURE_CLIENT_ID` |
| docx | `PORT=8789`、同上 + `CAS_BASE_URL` |
| migrate Job | `DATABASE_URL`(secret)**仅此一个** |

迁移 Job 不需要任何 Blob 变量:`migrate-cli.ts` 只调用 `createPool()` 与 `runMigrations(pool)`,不构造 `BlobServiceClient`。它现有的 `blobConnectionString: process.env.BLOB_CONNECTION_STRING ?? ""` 是残留参数,实施时随 §6.1 一并去掉(`AzureConfig` 的两个 blob 字段都改为可选)。

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

**有两个密钥,但性质不同 —— 这个区别是本节的要点**:

| 密钥 | 性质 | 谁产生它 |
|---|---|---|
| Postgres 管理员密码 | **本轮生成**的新密钥 | 部署脚本 `crypto.randomBytes(48)`,写进 Key Vault,存在则读回 |
| `INTERNAL_TOKEN` | **既有密钥,本轮必须对齐** —— 它已经存在于已部署的 Cloudflare CAS worker(`packages/cloudflare-cas`)上 | 由人从 Cloudflare 侧取得,经 `--internal-token` 传入并写进 Key Vault;**绝不现场生成** |

Blob 与 ACR 都因 §3(b) 的 policy 改成了身份认证,不再产生密钥 —— 所以密钥总数是二不是四。

`INTERNAL_TOKEN` 为什么不能像 Postgres 密码那样生成:`packages/cloudflare-cas/src/worker.ts` 对**每个**请求校验 `X-Internal-Token !== env.INTERNAL_TOKEN` 就返回 401,而 docx 的图片路径经 `packages/server-core/src/cas-client.ts` 发出去的是 **Azure 侧**的这个值。两侧不同源 = 所有跨云 CAS 请求 401,也就是 §10 第 5 条第三项那条专门用来证明跨云接线的断言必然失败。本地测试看不出来:`scripts/doc-types.mjs` 硬编码的 `INTERNAL_TOKEN = "unidocs-dev-token"` 被 Miniflare 与本地 Azure 栈共用,掩盖了这个不变量。

部署脚本因此对这个 secret 走的是「Key Vault 里有则读用;没有且给了 `--internal-token` 则写入后使用;没有也没给则**报错中止**」——不生成、不猜。

**Key Vault 的角色是给部署脚本提供幂等性**,不是给运行时读取。流程:

1. `bootstrap.bicep` 建出 Key Vault(RBAC 模式)、UAMI、ACR、Storage、Log Analytics,并做两条角色分配:UAMI 在 ACR 上 `AcrPull`,在 Storage 上 `Storage Blob Data Contributor`
2. 部署脚本对两个 secret 都执行"存在则读回" —— 这使得重复执行部署不会重置它们。不存在时两者分道:`pg-admin-password` 用 `crypto.randomBytes` 生成并写入;`internal-token` 只接受 `--internal-token` 传入的值(缺失即中止),理由见上表
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

**四个镜像都在 ACR 里构建(`az acr build --platform linux/amd64`),不在本机 `docker build`**。Azure Container Apps 只接受 `linux/amd64`,而开发机是 Apple Silicon:本机 `docker build` 产出 `linux/arm64`,镜像会推送成功、`main.bicep` 会部署成功,然后副本 `exec format error` —— 而部署脚本报出来的错误是"迁移 Job 超时",发生在四次镜像构建 + Postgres + ACA 环境全部创建之后,完全指不到根因。本机加 `--platform linux/amd64` 交叉构建同样不行:在 arm64 上用 QEMU 模拟跑四遍完整的 `pnpm install` + `pnpm -r build` 慢到不可用。`az acr build` 在 ACR 中原生 amd64 构建,并且**取代**了 `az acr login` + `docker push`(产物直接落在 registry 里)。`Dockerfile` 不需要改,它是平台无关的。

## 8. 部署编排与迁移

Bicep 不负责跑数据库迁移(基础设施变更与数据变更分离)。`scripts/azure-deploy.mjs` 按序编排:

1. **预检**:`az account show` 确认订阅;两条只读自检排在任何写操作之前 —— (a) `az role assignment list --include-groups --include-inherited` 断言执行者有 `Owner` 或 `User Access Administrator`(§11),(b) `packages/cas/dist/index.js` 存在(第 7 步的冒烟脚本从它 import CAS 哈希算法,而本脚本全程不在宿主机跑 `pnpm build`);随后确认 `Microsoft.App` 已注册,未注册则执行 `az provider register -n Microsoft.App --wait`
2. **bootstrap**:`az deployment group create -f infra/bootstrap.bicep`(先 `what-if` 打印差异)
3. **播种密钥**:Key Vault 中两个 secret 存在则读、不存在则生成(§5)
4. **构建**:`az acr build --platform linux/amd64`,四个镜像,tag = git short sha(走 az 身份,**不是** admin 密码,policy 禁止;构建发生在 ACR 里,见 §7)
5. **main**:`what-if` → `create`,传入 `@secure()` 参数与镜像 tag
6. **迁移**:`az containerapp job start` 触发 `unidocs-migrate`,轮询至成功;失败则中止并打印 Job 日志
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

6. **幂等**:紧接着再次执行 `scripts/azure-deploy.mjs`,冒烟仍然全绿,Postgres 密码未被重置,且两次 `what-if` 输出里:

   - **没有** `Create`、**没有** `Delete`
   - `Modify` **仅允许**出现在下面两个 **write-only** 属性上;出现在其余任何属性上都要查清:
     - `Microsoft.App/containerApps` 的 `configuration.secrets[].value`
     - `Microsoft.DBforPostgreSQL/flexibleServers` 的 `administratorLoginPassword`

   这两个属性上的 `Modify` **不是模板写错**:RP 的 GET 不回传它们的值,what-if 拿不到当前值,只能把"模板里有、当前读不到"报成差异。要求它们也干净等于要求把密钥从模板里挪走 —— 那会把一个正确的模板改坏。
7. ACR 的 `adminUserEnabled` 为 `false`、存储账户的 `allowSharedKeyAccess` 为 `false` —— 即部署未因绕开 §3(b) 的 policy 而成功

## 11. 风险与未决事项

| 项 | 状态 | 说明 |
|---|---|---|
| Postgres 公网端点 + `0.0.0.0` 防火墙规则(放行整个 Azure 平台) | **本轮接受** | 见 §4.4。**不**依赖"消费型环境出口 IP 稳定"这一未验证前提;唯一屏障是强随机凭据。若 IP 级限制成为硬要求,它是前置条件(需换成工作负载配置文件 + VNet + NAT 网关或私有端点),不是延后加固 |
| Postgres 用密码认证而非 Entra ID | **本轮接受** | 路径明确(§9 第三行),但属独立工作量 |
| `sslmode=require` 的证书校验强度 | **待实施时确认** | 见 §6.3。收紧到 `verify-full` 是后续加固 |
| docx 依赖 Cloudflare CAS worker | **本轮接受** | 已确认的范围决定。**后果:本轮的部署形态不可私有化交付**,阶段 4 的 `azure-cas` 落地后才可 |
| 跨云 CAS 要求两侧 `INTERNAL_TOKEN` 相同 | **本轮接受(有操作约束)** | 上一行的直接推论,原先漏登记。CAS worker 对每个请求校验该 token,不同源即 401,而本地栈共用 `unidocs-dev-token` 会掩盖它。约束:Azure 侧的值必须由人从 Cloudflare 侧取得并经 `--internal-token` 传入(§5),脚本不生成。代价:轮换该 token 必须**两侧同时**做 |
| 无 CI | **本轮接受** | 已确认的范围决定。部署脚本本身即将来 CI 调用的对象 |
| `azure-markdown` / `azure-docx` 未合并 | **推后** | 已确认。代价:3 份服务镜像,以及两份已经漂移过一次的 `bundle.mjs`(§6.2 的 bug 正源于此)仍然并存。合并成单一 `DOC_TYPE` 参数化镜像可一次性消除该漂移面 |
| Key Vault 软删除会挡住「删掉资源组再重建」 | **已知,未解决** | `unidocs-kv` 是固定字面量,而 Key Vault 开了软删除(保留 7 天)。按 §10/计划 Task 8 写的拆除方式 `az group delete -n Unidocs --yes` 删掉之后,7 天内重新部署会在 Key Vault 上报 `ConflictError: Vault name 'unidocs-kv' is already in use`,而且发生在 bootstrap 部署到一半时。人工出路是 `az keyvault recover` 或 `az keyvault purge`,但没人会预料到。**这个风险与是否用 `uniqueString` 后缀无关** —— 后缀是按资源组 ID 算的,同名资源组重建后后缀相同,名字照样撞。彻底的解法是 preflight 里 `az keyvault list-deleted` 命中则打印具体的 recover/purge 命令后中止 |
| 镜像引用有两个真相来源,无测试绑定 | **已知,未解决** | 脚本用 `IMAGES` 数组生成 `az acr build --image` 的仓库路径,而 `infra/main.bicep` 里四处独立手写 `'${acr.properties.loginServer}/unidocs/<name>:${imageTag}'` 字面量。当前四个名字一致(已由编译产物核实),但没有任何测试读 Bicep 去比对 —— 改了 `IMAGES` 里的 `name` 而忘了同步 Bicep,测试全绿,要到真实部署「拉不到镜像」才暴露。非本轮引入,本轮也未加剧 |
| RBAC 预检按角色**名字**白名单,会误伤自定义角色 | **已知,可接受** | `checkRbac()` 断言存在内置的 `Owner` 或 `User Access Administrator`。任何包含 `Microsoft.Authorization/roleAssignments/write`(即 bootstrap.bicep 实际所需权限)但不叫这两个名字的自定义角色,会被误判为无权限而拦下,尽管它真能跑通。按实际操作权限判断需要 `az provider operation` 展开角色定义,复杂度远高于收益。刻意不留 `--skip-rbac-check` 逃生口 —— 留了等于把这道墙拆掉 |
| 连接池上限只保证常驻形态,不保证满载 | **已知,未解决** | `PG_POOL_MAX` 默认 5 让 5 个常驻副本(5×5=25)安全落在 B1ms 的 `max_connections`(约 35)之下。但 `maxReplicas` 满载是 13 个副本,13×5=65,仍然超。**一旦真的扩容,`FATAL: sorry, too many clients already` 会以同样的方式回来**,且冒烟测试(串行)照样通过、只有并发才暴露。彻底的解法是按副本数下发 `PG_POOL_MAX`,或把 Postgres 升到更大规格 —— 两者都不在本轮 |
| `az acr build` 的构建机能否访问华为云镜像源 | **待首次部署确认** | C1 的修复把镜像构建从本机挪到了 ACR Tasks(Azure 东南亚),而 `Dockerfile` 里的 `pnpm install --registry=https://repo.huaweicloud.com/...` 是为**本机**被 SNI 拦截的网络写的。那台构建机能否访问该镜像源没人验证过。失败会发生在第 4 步(比 C1 原来的失败点早得多、也好诊断)。退路:该源不可达时改用默认 registry —— 从 Azure 出网大概率不受本机那条拦截影响 |
| 常驻副本成本 | **已知** | 粗估 $85–105/月(Container Apps 5 个常驻副本占大头,Postgres B1ms 约 $13,ACR Basic $5)。`minReplicas` 是旋钮,下调的含义见 §4.2 |
| 部署者的 RBAC 权限 | **preflight 已自检** | 早先记的"`az role assignment list` 对本账号返回空"是**查询写错了**:缺 `--include-groups`,而本账号的权限正是经组继承的。`scripts/azure-deploy.mjs` 的 preflight 现在用 `az role assignment list --include-groups --include-inherited` 断言存在 `Owner` 或 `User Access Administrator`(订阅级或资源组级均可)。`Contributor` 不够 —— 它的 `notActions` 含 `Microsoft.Authorization/*/Write`,建不了 bootstrap 里那两条角色分配,失败会发生在 ACR/Storage/KV/LAW 已经建出来之后,留下部分创建的资源组 |
