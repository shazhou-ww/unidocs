# Azure 部署隔离与单服务解耦设计

日期:2026-08-25
状态:已确认,待实施

## 1. 背景与目标

`docs/superpowers/specs/2026-08-22-azure-cloud-deployment-design.md`(下称**部署设计**)已经实施并部署成功:三个服务跑在 Container Apps 上,markdown 全链路在公网网关上验证通过。那一轮的产物有两个结构问题,本设计解决它们。

**问题一:Azure 的东西没有被圈起来。** 部署资产散在两处 —— 根目录的 `infra/`(名字是云中立的,内容全是 Azure)和 `scripts/azure-*.mjs`(与本地开发脚本混在一起)。同时 Azure 的集成测试挂在 `pnpm test:local` 的默认门禁里,拖慢日常开发并引入 Docker 依赖。

**问题二:三个服务无法单独部署。** `infra/main.bicep` 一次建 Postgres + Container Apps 环境 + 三个 App + 迁移 Job。改 docx 要重新部署全部。根因是网关的 `MARKDOWN_WORKER_URL` / `DOCX_WORKER_URL` 读的是同一份模板里另外两个 module 的 output(`main.bicep:186,190`),Bicep 因此要求三者在同一次部署中。

对比 Cloudflare 侧:每个 worker 有自己的 `wrangler.toml`,`wrangler deploy` 各自独立。但**它的解耦不是来自配置文件分散,而是来自 KV 注册表** —— `cloudflare-gateway/src/worker.ts:37` 运行时查 `docType:{type}`,环境变量只是兜底。Azure 侧只有环境变量那一半。

**目标**:

1. 所有 Azure 专属的非包资产收进单一目录,删掉它即失去 Azure 部署与本地栈能力,代码不受影响
2. Azure 集成测试从默认门禁移出,变成显式调用
3. 四个部署单元(bootstrap / platform / service / gateway)各自独立部署,新增一个 doc type 不需要改任何中心文件、不需要重启网关

**非目标**(本轮明确不做):

- **`makeSBlob` 补全与 CAS 后端选择** —— docx 在 Azure 上目前 `create` 即失败(`azure-docx/src/main.ts` 的 `makeSBlob` 是抛异常的桩)。补它需要先决定 CAS 后端(部署 Cloudflare CAS worker,还是做 `azure-cas`),那个前提未定,单独一轮
- **合并 `azure-markdown` / `azure-docx` 两个包** —— 两者各自只有 13 行有效代码、差 3 个值,合并的判断成立但继续推迟(见 §7)
- 删除本地 Azure 栈 —— 一度考虑过,结论是保留(见 §2.3)

## 2. 目录与门禁

### 2.1 目标结构

```
azure/
  deploy/
    bootstrap.bicep      ACR / 存储 / Key Vault / Log Analytics / 托管标识 / 3 条角色分配
    platform.bicep       Postgres + 防火墙 + 库 / Container Apps 环境 / 迁移 Job
    service.bicep        单个 doc type 的 Container App
    gateway.bicep        网关 Container App
    container-app.bicep  模块:三个 App 共用的形状
    migrate-job.bicep    模块:迁移 Job(由 platform.bicep 调用)
    Dockerfile           原根目录的 Dockerfile(只构建四个 azure-* 镜像)
    deploy.mjs           编排(原 scripts/azure-deploy.mjs)
    smoke.mjs            验收(原 scripts/azure-smoke.mjs)
  local/
    runtime.mjs          原 scripts/azure-runtime.mjs
    replica-proxy.mjs    原 scripts/replica-proxy.mjs
    ports.mjs            原 scripts/azure-ports.mjs
  README.md

packages/azure-sdk/docker-compose.yml   原根目录的 docker-compose.azure.yml
```

`packages/azure-*` 是**代码**,`azure/` 是**运维与工具**。这条分界是判断某个文件该放哪的依据。

不建 `modules/` 子目录:被复用的模板只有 `container-app.bicep` 与 `migrate-job.bicep` 两个,为两个文件建一层目录是过度组织。

**`migrate-job.bicep` 必须保留为独立模块,不得并入 `platform.bicep`。** 它存在的唯一理由是模块边界:Bicep 会把外层模板的表达式内联到资源属性上,由 `@secure()` 参数拼出的连接串一旦落在外层模板里,`az deployment group what-if` 对一个 Create 变更会把含明文连接串的完整资源体打印到终端,而部署脚本用 `stdio:"inherit"` 透传、计划还把输出 `tee` 进日志文件。作为模块参数传入时,编译产物是嵌套部署的 `expressionEvaluationOptions.scope: "inner"` + `securestring` 参数,明文不出现在外层。这是上一轮修掉的一个安全缺陷(部署设计的 I1),合并回去会原样重现。

**`Dockerfile` 移进 `azure/deploy/`。** 它只构建 `azure-gateway` / `azure-markdown` / `azure-docx` / `azure-sdk` 四个镜像,是纯 Azure 资产。构建上下文仍是仓库根,调用方式从 `--file Dockerfile .` 改为 `--file azure/deploy/Dockerfile .` —— `az acr build` 的 `--file` 与上下文本就可以分离,不需要把上下文也搬走(搬走会让它看不到 `packages/`)。

**`.dockerignore` 留在仓库根,不能搬。** Docker 只读取**构建上下文根目录**的那一份,而 `azure/deploy/Dockerfile` 与 `tests/treespec/Dockerfile` 的上下文都是仓库根 —— 它是两者共用的,且位置由 Docker 规定而非我们选择。这一点要写进 `azure/README.md`,否则下一个做隔离的人会想把它也搬进 `azure/`,结果是排除规则**静默失效**(Docker 不会因为找不到 `.dockerignore` 而报错,只会把 `node_modules`、`dist`、`.git` 全部塞进构建上下文)。

**`docker-compose.azure.yml` 移到 `packages/azure-sdk/docker-compose.yml`,不放进 `azure/local/`。** 它的第一消费者是 `packages/azure-sdk/tests/containers.ts:43`(端口契约测试要起 Postgres),而那套测试留在强制门禁里。放进 `azure/` 会让"删掉 `azure/` 后 `pnpm test` 仍全绿"这条验收不成立。`azure/local/runtime.mjs` 改为指向该包内的位置 —— 它是借用者,不是拥有者。

### 2.2 门禁

```json
"test:local": "vitest run --fileParallelism=false tests/unit tests/integration/cloudflare tests/integration/shared",
"test:azure": "vitest run --fileParallelism=false tests/integration/azure",
"azure:up":   "docker compose -f packages/azure-sdk/docker-compose.yml up -d",
"azure:down": "docker compose -f packages/azure-sdk/docker-compose.yml down"
```

`packages/azure-sdk/tests/` 的端口契约测试**仍留在 `pnpm test` 强制门禁里**。它对着真实 Postgres + Azurite 跑,覆盖 `PgDeltaLog` / `BlobCas` / `PgDocIndex` 与并发控制,依赖轻(一个容器 + 一个进程),而它守的是 Azure 能工作的根本前提。

`tests/integration/azure/` 三套测试**留在原地**,不搬进 `azure/`:测试的组织维度是"测什么层次",不是"测哪朵云",它们与 `tests/integration/cloudflare/`、`shared/` 同级同类。

`tests/treespec/` 本来就不在任何默认脚本里(靠 treespec + Docker 单独跑),天然非强制,Azure 断言保持原样。

### 2.3 为什么保留本地 Azure 栈

一度考虑删除整套本地 Azure 拓扑(`runtime.mjs` + 副本代理 + 端口分配),理由是本地只用 Cloudflare 调试。结论是**保留但降级为非强制**,依据是上一轮的真实数据:

那一轮抓到 8 个只在部署路径上现形的缺陷,本地 Azure 栈抓到其中 1 个(`@azure/identity` 无法被 esbuild 内联,表现为本地进程启动即死),同时**掩盖**了另 1 个(`INTERNAL_TOKEN` 跨云不同源,因为两个本地栈共用硬编码 token)。

1/8 的命中率不足以证明它必需,但那 1 个是 Cloudflare 侧完全看不见的类别 —— 跨后端行为等价只能靠两侧都能跑来保证。删掉它等于放弃"同一套行为测试在两个后端都通过"这个从阶段 1 就在维护的性质。

## 3. Bicep 拆分

### 3.1 四个部署单元

| 模板 | 建什么 | 何时部署 | 依赖 |
|---|---|---|---|
| `bootstrap.bicep` | ACR / 存储 / Key Vault / Log Analytics / 托管标识 / 角色分配 | 新环境一次 | 无 |
| `platform.bicep` | Postgres + 防火墙 + 库 / Container Apps 环境 / 迁移 Job | 改规格或环境时 | bootstrap |
| `service.bicep` | 单个 doc type 的 Container App | **每个服务各自随时** | platform |
| `gateway.bicep` | 网关 Container App | 只在网关自己改时 | platform |

四者使用**各自独立的 deployment 名**(`bootstrap` / `platform` / `service-{docType}` / `gateway`)。这既让 `az deployment operation group list` 能分辨是谁改的,也是并发部署安全的必要条件(§5.3)。

### 3.2 迁移 Job 归 platform,不归 gateway

Cloudflare 侧共享 D1 schema 放在 `cloudflare-gateway/migrations/`,其它三个 worker 用 `migrations_dir = "../cloudflare-gateway/migrations"` 指过去。**那是 wrangler 的工具约束**:`wrangler d1 migrations apply` 必须从一个带 D1 绑定的 `wrangler.toml` 执行,四个 worker 都有绑定,总得挑一个当主。它不构成"schema 属于 gateway"的语义判断。

按表的实际归属看,网关**不写任何一张表**:

| 表 | 写入方 | 读取方 |
|---|---|---|
| `deltas` | doc type 服务 | doc type 服务 |
| `doc_snapshots` | doc type 服务 | doc type 服务 |
| `docs` | doc type 服务 | 网关(列文档)+ doc type 服务 |
| `doc_types`(本轮新增) | doc type 服务 | 网关 |

更实际的理由:归 gateway 会重新制造耦合 —— "只部署 docx"将变成"需要 schema 存在"因而"需要 gateway 先部署过"。归 platform 的逻辑更直:数据库是 platform 建的,schema 是数据库的一部分,谁建库谁建表,服务与网关都只是消费者。

SQL 文件位置不变,仍在 `packages/azure-sdk/migrations/` —— 那是 `migrate-cli.js` 通过 `../migrations` 定位的,而迁移镜像从 `azure-sdk` 包构建。**Bicep 里 Job 归谁部署**与 **SQL 放在哪个包**是两件事。

### 3.3 解开那条依赖

现状(`infra/main.bicep:183-191`):

```bicep
extraEnv: [
  { name: 'MARKDOWN_WORKER_URL', value: 'https://${markdownApp.outputs.fqdn}' }
  { name: 'DOCX_WORKER_URL',     value: 'https://${docxApp.outputs.fqdn}' }
]
```

网关读另外两个 module 的 output —— 这就是拆不开的根因。

拆分后:

- 网关不再需要这些变量(改查注册表,§4)
- `service.bicep` 自己算出服务地址注给服务本身,用于自注册:

```bicep
resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: 'unidocs-env' }
var selfUrl = 'https://unidocs-${docType}.internal.${env.properties.defaultDomain}'
```

Container Apps 的内部 FQDN 是 `<app名>.internal.<环境默认域>`,由 app 名与环境确定性推出,**不需要该 App 已存在**,因此没有先有鸡还是先有蛋的问题。

- **`gateway.bicep` 不再设置任何 `{TYPE}_WORKER_URL`**。若它去算这些地址,就得知道有哪些 doc type,耦合又回来了。环境变量兜底仅保留给本地开发与临时调试。

### 3.4 服务参数下放到各包

```jsonc
// packages/azure-markdown/azure.service.json
{ "docType": "markdown", "targetPort": 8788, "minReplicas": 2, "maxReplicas": 5 }

// packages/azure-docx/azure.service.json
{ "docType": "docx", "targetPort": 8789, "minReplicas": 2, "maxReplicas": 5 }

// packages/azure-gateway/azure.service.json
{ "external": true, "targetPort": 8787, "minReplicas": 1, "maxReplicas": 3 }
```

`deploy.mjs --service docx` 读该文件,传给 `service.bicep`。**加一个新 doc type 时四个 Bicep 一个都不改。**

doc type 服务的 `minReplicas: 2` 是刻意的(部署设计 §4.2):阶段 3 证明的是多副本拓扑下的并发正确性,生产上跑单副本等于把那份保证退回未验证。

网关也给一份是为了对称 —— 它同样是 Container App,同样该自己声明形状。

**与合并包计划的关系**:这三个 json 的内容是 `{docType, port, replicas}`。将来两个 doc type 包合并时,它们自然收敛成合并包里的一张表,**内容全部存活,只是换位置**。这不是丢弃的工作。

## 4. 注册表

### 4.1 表

`packages/azure-sdk/migrations/0002_doc_types.sql`:

```sql
CREATE TABLE doc_types (
  doc_type   TEXT PRIMARY KEY,
  worker_url TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
```

选 Postgres 而非新服务的理由:网关已有 pg 连接池(`PgDocIndexQuery` 在用),doc type 服务已有 `DATABASE_URL`,零新增依赖、零新增认证、零新增 IaC。要存的是两行数据,为它引入 App Configuration(新资源 + 约 $36/月 Standard 层)或 Table Storage(新 npm 依赖 + 新角色分配 + 第二个数据存储)都不划算。

`createGatewayHandler` 收的是 `resolveWorkerUrl: (docType) => Promise<string|null>` —— 一个函数,所以这个选择不锁死,将来换实现改的是一个类。

### 4.2 一个类,两个方法

`packages/azure-sdk/src/registry-pg.ts`:

```ts
class PgDocTypeRegistry {
  register(docType: string, workerUrl: string): Promise<void>   // upsert
  resolve(docType: string): Promise<string | null>              // 带缓存
}
```

**只 upsert,永不删除。** 一个 doc type 的 N 个副本共用同一个 ingress FQDN,写的是同一行同一值,天然幂等。关停时注销是错的:一次滚动更新(旧副本退出、新副本启动)会在中间时刻把整个 doc type 从表里抹掉,而此时其它副本仍在正常服务。真要下线一个 doc type,是运维显式删行,不是进程退出的副作用。

副作用是有用的:副本重启/滚动更新会刷新 `updated_at`,该字段天然反映"这个 doc type 最近还活着"。

**缓存 30 秒 TTL,失败时用过期旧值**(stale-while-error)。地址极少变(新增 doc type 或更换 ACA 环境时才变),Postgres 短暂抖动不该让网关停摆。

### 4.3 为什么不做推送式失效

考虑过两种即时失效,都不采用:

**HTTP 通知网关**(部署脚本部完服务后调网关的重载端点)—— **在多副本下是错的**。网关是 `minReplicas: 1 / maxReplicas: 3`,Container Apps 的 ingress 负载均衡且不允许指定副本,也无法广播。一次通知只到一个副本,其余继续用旧值,且失败完全无声、随扩容变严重。

**`LISTEN` / `NOTIFY`** —— 扇出方向是对的(每个网关副本自持一条监听连接,Postgres 发一次所有在听的都收到,不需要知道副本地址或数量),但 `NOTIFY` **不持久、不重放**:连接断开期间发出的通知永久丢失,重连后不补发,而断连本身是静默的。正确做法是 `NOTIFY` 负责快乐路径 + TTL 兜底 + 重连时 re-LISTEN 并全量刷新 —— 即它**不能替代 TTL,只能叠加在 TTL 之上**。

对一张两行、一个月变一次的表,30 秒陈旧没有实际影响,而 `NOTIFY` 的成本是每个网关副本一条专用长连接(要计入 B1ms 的连接预算)、重连状态机、以及一个不报错只变错的失效模式。

**唯一在乎即时可见的消费者是部署脚本自己的冒烟测试**,而那个场景由冒烟重试解决(§5.2),不需要额外机制。

缓存失效是 `PgDocTypeRegistry` 的内部实现,将来真需要秒级一致时加 `NOTIFY` 不影响调用方。

### 4.4 接线

```
service.bicep   注入 SELF_WORKER_URL = https://unidocs-{docType}.internal.{envDomain}
                     ↓
runDocTypeService()  服务 listen 之后 → registry.register(docType, SELF_WORKER_URL)
                     ↓
                doc_types 表
                     ↓
azure-gateway/main.ts  resolveWorkerUrl = 查注册表 → 未命中回落 {TYPE}_WORKER_URL
```

`packages/azure-markdown/src/main.ts` 与 `packages/azure-docx/src/main.ts` **一行都不改** —— 注册发生在 `runDocTypeService()` 内,与连接池、Blob 客户端、优雅关停同属 SDK 的生命周期职责。这两个文件的头注释本来就写着"任何在两边都要改一遍的东西都该往 SDK 里搬"。

### 4.5 本地栈不引入这一层

本地没有 Container Apps,拿不到内部 FQDN。规则:**`SELF_WORKER_URL` 未设时跳过注册**并打一行日志说明。本地栈继续走 `{TYPE}_WORKER_URL` 环境变量的兜底路径 —— **本地行为完全不变**,`azure/local/runtime.mjs` 无需改动。

注册表因此是云上专属机制,本地不承担这层复杂度。

## 5. 部署脚本

### 5.1 选择器

```bash
node azure/deploy/deploy.mjs                        # 冷启动全量
node azure/deploy/deploy.mjs --bootstrap            # 只 bootstrap
node azure/deploy/deploy.mjs --platform             # 只 Postgres / ACA 环境 / 迁移
node azure/deploy/deploy.mjs --service docx         # 只构建 docx 镜像 + 只部它
node azure/deploy/deploy.mjs --service docx,markdown  # 多选,镜像并发构建
node azure/deploy/deploy.mjs --gateway              # 只网关
```

`--service docx` 的冒烟**只测 docx**,不碰 markdown。

### 5.2 冒烟必须重试

新 revision 接管流量要几十秒,注册表 TTL 还有 30 秒。冒烟改为在超时窗口内重试:

```js
await retryUntil(() => smoke(gatewayUrl), { timeout: 120_000, interval: 5_000 });
```

这条重试**本来就该有** —— 没有它,新 revision 尚未就绪时冒烟就会失败,与注册表无关。

### 5.3 并发

**镜像构建有界并发**,默认 2,可用 `--build-concurrency` 覆盖。全量部署也走同一条路径(四个镜像)。上一轮全量部署最慢的一步就是四个镜像串行各跑一遍完整的 `pnpm install` + `pnpm -r build`。

**多个独立进程并行也安全**:

```bash
node azure/deploy/deploy.mjs --service docx &
node azure/deploy/deploy.mjs --service markdown &
```

不同镜像仓库、不同 deployment 名、不同 Container App、不同注册表行(主键是 `doc_type`);对 ACA 环境 / 身份 / ACR 的 `existing` 引用是只读的。前提是 §3.1 定的独立 deployment 名。这一条写进 `azure/README.md`,属于"可以这么用"而非"脚本保证"。

**ACR Tasks 的并发构建数受 SKU 限制,而我们用 Basic,该限制未经实测。** 超出限制的构建会排队(不是失败),所以并发不会出错,但可能不会更快。首次全量部署时实测一次(`az acr task list-runs` 看几个 `Running`、几个 `Queued`),结论回写本设计。若 Basic 只允许 1 个并发,把默认并发降到 1 并把"升 Standard SKU 换更快部署"记入风险表。

## 6. 测试

| 测试 | 变化 |
|---|---|
| `tests/unit/scripts/azure-deploy.test.mjs` | 路径改动;新增 `--service` 解析、多选解析、读 `azure.service.json` 的用例 |
| `packages/azure-sdk/tests/registry.test.ts` | **新增** —— 对现有 Postgres 容器测 upsert 幂等、TTL 缓存命中/过期、stale-on-error |
| `tests/integration/azure/*` | 留在原地,只改对 `azure/local/runtime.mjs` 的路径引用 |
| `tests/treespec/**/spec.yaml`(16 个) | 改硬编码的 `scripts/azure-runtime.mjs` 路径 |

那 16 个 treespec 文件是本次搬迁最容易漏的一批 —— 它们在 shell 命令字符串里硬编码路径,不会被类型检查或 import 解析捕获。

## 7. 与合并包计划的关系

`packages/azure-markdown/src/main.ts` 与 `packages/azure-docx/src/main.ts` 目前各有 13 行有效代码,差异是 3 个值(doc type 名、工厂函数、默认端口),连两个 SBlob 桩都是逐字复制的。合并成一个 `DOC_TYPE` 参数化的包的判断依然成立,但**继续推迟**。

推迟的理由不是它不值得,而是**它与本轮改动撞在同一批文件上**:包结构、`tsconfig` references、打包脚本、`Dockerfile` 的 `SERVICE` 参数、镜像名、部署脚本、`workspace-aliases`。上一轮反复被这一类问题咬过(打包器外部化策略漂移、`files` 漏 `migrations`、未声明依赖、`tsbuildinfo` 让容器内构建空转)。在同一批文件上同时做两件事是那些缺陷的温床。

本轮做完之后再合并,收益仍在(镜像从 4 个减到 2 个、ACR 构建时间减半),而 §3.4 的三个 json 收敛成一张表的迁移是十分钟的事。

## 8. 现有环境的过渡

线上那套由 `infra/main.bicep` 一次部出,网关**靠环境变量**找服务。切换后网关改查注册表,而注册表初始为空(现有服务进程是旧镜像,不会注册)。

**上线顺序不能错**:

```
1. platform.bicep      加 doc_types 表(迁移 Job)
2. service.bicep ×2    新镜像启动 → 自注册 → 表里有数据
3. gateway.bicep       最后换网关,此时它一查即中
```

反序会产生一段 404 窗口。

ARM 增量模式不删除模板里没有的资源,因此拆分本身对现有资源是安全的,全部是 update-in-place。资源名不变(上一轮已改为 `Unidocs` / `unidocsacr` / `unidocs-pg` 等),本轮不再改名。

## 9. 验收标准

1. `pnpm build` / `pnpm typecheck` / `pnpm test` 全绿
2. `pnpm test:local` 全绿,且**不再包含任何 Azure 集成测试**
3. `pnpm test:azure` 单独可跑,三套集成测试通过
4. `tests/treespec/` 的 16 个 spec 仍能找到本地 Azure 栈(路径已更新)
5. 根目录不再有 `infra/`、`Dockerfile`、`docker-compose.azure.yml`、`scripts/azure-*.mjs`、`scripts/replica-proxy.mjs`;`.dockerignore` **仍在根目录**(Docker 规定,且与 `tests/treespec/Dockerfile` 共用)
6. `az bicep build` 对 `azure/deploy/` 下**六个**模板全部通过且无 warning
6b. 从 `platform.bicep` 的编译产物核实:含 `pgAdminPassword` 的 `format(...)` 表达式**只出现在** `migrate-job` 嵌套部署的 `properties.parameters` 里,不落在任何资源自身的 `properties` 上(上一轮 I1 的回归检查)
7. 按 §8 的顺序对现有环境完成过渡后:
   - `node azure/deploy/deploy.mjs --service markdown` 只更新 markdown 的 Container App,`az deployment operation group list` 显示 docx 与 gateway 未被触碰
   - 网关在**未重启**的情况下能解析到 markdown(证明注册表生效)
   - 冒烟的 markdown 全链路(create → apply → query → export)通过公网网关全绿
8. 删除 `azure/` 目录后 `pnpm build` / `pnpm test` 仍全绿(证明代码不依赖运维资产)

## 10. 风险与未决事项

| 项 | 状态 | 说明 |
|---|---|---|
| ACR Basic 的并发构建上限未知 | **待首次部署实测** | 见 §5.3。超限会排队不会失败,所以是性能问题不是正确性问题 |
| 过渡期的 404 窗口 | **靠顺序规避** | §8 的三步顺序必须遵守;若中途失败需回滚到"网关仍用环境变量"的状态 |
| 注册表 30 秒陈旧 | **已接受** | 唯一在乎的消费者是冒烟,由重试解决。`LISTEN`/`NOTIFY` 的正确做法见 §4.3,留待真有秒级需求时 |
| docx 在 Azure 上仍不可用 | **本轮非目标** | `makeSBlob` 是抛异常的桩,且补它需要先定 CAS 后端。本轮的冒烟验收只覆盖 markdown |
| 本地 Azure 栈的维护成本 | **已接受** | 它抓到过 1 个 Cloudflare 侧看不见的缺陷,也掩盖过 1 个。降级为非强制后不再拖慢日常开发 |
| 两个 doc type 包未合并 | **推迟** | 见 §7。代价是 4 个镜像而非 2 个、ACR 构建时间翻倍 |
