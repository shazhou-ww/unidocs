# Azure psd 支持与 doc type 声明收敛 — 设计

日期:2026-08-26
分支:`feat/azure-psd`,基于 `d01afd0`

---

## 0. 核查记录:上一轮计划有一半已经作废

本设计的前身是 2026-08-25 那次对话里规划的「补齐 azure-sdk 的 SBlob + 新建
azure-psd」。在 `origin/main` 更新到 `012957b`(P0 微服务边界重构)之后重新
核查,结论是**第一半已经在 main 上做完了**,而且做法与当时的设计一致:

| 当时的设计 | main 上的现状 |
|---|---|
| `sblob-context.ts` 从 `cloudflare-sdk` 搬到 `doctype-server-common` | ✅ `packages/doctype-server-common/src/sblob-context.ts`,258 行 |
| `cloudflare-sdk` 改成 re-export | ✅ 缩成 8 行 shim |
| `runDocTypeService` 改收 `DocumentTypeFactory` | ✅ `documentTypeFactory` |
| 删掉 `as any` 与抛异常的 `makeSBlob`/`readSBlob` stub | ✅ 两个 `azure-*/src/main.ts` 都干净了 |
| 每 session 构造一次 SBlob context | ✅ `azure-sdk/src/doc-type-service.ts:108` |
| 把 `CasClient → SBlobCasAdapter` 的包装收进共享模块 | ✅ `createSBlobContext({...})` 直接收对象 |

因此 **SBlob 不在本轮范围内**。docx 在 Azure 上的图片路径已经通,回归网是
`tests/integration/azure/azure-docx-image.test.mjs`。

同时 P0 换掉了本设计原先依赖的两个前提,必须记录:

1. **运行时 doc type 注册表被删除。** 上一轮实现的
   `azure-sdk/src/registry-pg.ts`、`azure-gateway/src/resolve-worker-url.ts`、
   迁移 `0002_doc_types.sql` 及两个测试文件全部移除,替换为部署时静态
   `DOC_SERVICES_JSON`。P0 的不变式原文:*"Document-type services are
   registered at deployment time, not dynamically at runtime."* 这个方向是对
   的——运行时注册表当初是为了绕开 Bicep 模板内 `markdownApp.outputs.fqdn`
   的依赖,P0 直接砍掉了那条依赖,注册表随之不必要。
2. **`userId` → `tenantId` + `sessionId`。** Doc 服务不再认识用户,内部路由
   是 `/sessions/{sessionId}`,Gateway 独占目录表。每个服务有独立数据库
   (`unidocs_gateway` / `unidocs_markdown` / `unidocs_docx`)、独立 Blob
   容器、独立迁移 Job、独立 access key。

---

## 1. 本轮要解决的问题

### 1.1 加一个 doc type 现在要改 6 处硬编码

P0 用「部署时配置」换掉「运行时注册表」,代价是一个 doc type 的事实散落多
处;而这个代价至今没有人付过,因为从来没加过第三个 doc type。psd 是第一个。

| 位置 | 硬编码规模 |
|---|---|
| `stacks/azure/local/ports.mjs:15-18` | `AZURE_DOC_TYPE_PORT_BASE` |
| `stacks/azure/local/runtime.mjs:571` | `SUPPORTED_DOC_TYPES`——同一事实的第二份 |
| `packages/azure-*/azure.service.json` | 第三份 |
| `stacks/azure/deploy/deploy.mjs` | `markdown`/`docx` 字面量 **25 处** |
| `stacks/azure/deploy/platform.bicep` | **16 处**(3 个显式数据库 + 3 个显式迁移 Job) |
| `stacks/azure/deploy/gateway.bicep` | **10 处**(两个独立 `@secure()` key 参数 + 字面量 `docServicesJson`) |

`stacks/azure/deploy/service.bicep` 已经完全泛化(唯一的 `docx` 是注释),
`bootstrap.bicep` / `migrate-job.bicep` 是 0——所以要动的只有两个模板。

### 1.2 一个已经存在的 bug

```
$ node scripts/dev.mjs --azure          # 不带任何 doc type 参数
Unknown Azure doc type: psd. Known: markdown, docx
```

`scripts/dev.mjs:45` 在无参时取 `Object.keys(DOC_TYPES)`——那是 **Cloudflare**
的表(`stacks/cloudflare/local/doc-types.mjs`,含 psd),而 Azure 的表不含。
所以坏的不只是 `pnpm dev --azure psd`,**`pnpm dev --azure` 本身就是坏的**。

这正是「同一事实存两份」的直接后果,收敛之后自然消失。

### 1.3 psd 在 Azure 上完全不存在

`packages/azure-psd` 不存在。`packages/doctype-psd`(云中立)与
`packages/cloudflare-psd` 都在。

---

## 2. 单一事实来源

### 2.1 载体:各包的 `azure.service.json`

沿用 2026-08-25 已定的方案(参数下放到各包,而非先合并 `azure-markdown`/
`azure-docx`),新增两个字段:

```jsonc
// packages/azure-psd/azure.service.json
{
  "docType": "psd",
  "targetPort": 8790,
  "localPortBase": 41820,
  "minReplicas": 2,
  "maxReplicas": 5,
  "needsCas": true
}
```

已有两份补齐新字段:

```jsonc
// packages/azure-markdown/azure.service.json
{ "docType": "markdown", "targetPort": 8788, "localPortBase": 41800,
  "minReplicas": 2, "maxReplicas": 5, "needsCas": false }

// packages/azure-docx/azure.service.json
{ "docType": "docx", "targetPort": 8789, "localPortBase": 41810,
  "minReplicas": 2, "maxReplicas": 5, "needsCas": true }
```

`packages/azure-gateway/azure.service.json` 不变(没有 `docType` 字段,凭这
一点被排除在 doc type 表之外)。

**`targetPort: 8790` 的依据**:与 Cloudflare 侧 psd 的端口一致。
`stacks/cloudflare/local/doc-types.mjs` 里 psd 是 8790、`CAS_PORT` 是 8791
——P0 已经把两者的历史冲突修掉了,这里跟随即可,不要另起一套编号。

**`localPortBase: 41820` 的依据**:markdown 41800 / docx 41810,`AZURE_PORT_STRIDE`
是 10,顺延。端口段显式写在 JSON 里而不是按扫描顺序推导,是为了让「新增一个
包」不会平移其他 doc type 已有的端口。

**`needsCas`** 取代两处硬编码特判:`scripts/dev.mjs:53` 的
`azureDocTypes.includes("docx")`,以及 `deploy.mjs` 里冒烟的 docx 特判。
markdown 是 `false`(`doctype-markdown` 对 SBlob 的引用数为 0),docx 与 psd
是 `true`。

### 2.2 新增 `stacks/azure/doc-types.mjs`

```js
export function readAzureDocTypes(repoRoot)
```

扫描 `packages/azure-*/azure.service.json`,跳过没有 `docType` 字段的,校验
必需字段齐全且类型正确,返回按 `docType` 排序的规范化表。缺字段要**点名报
错**(「`packages/azure-psd/azure.service.json` 缺少 `localPortBase`」),
不要静默取默认值——这份文件是唯一事实来源,静默默认值会让它名存实亡。

依赖只有 `node:fs` 与 `node:path`。

### 2.3 `ports.mjs` 保持零依赖

`stacks/azure/local/ports.mjs` 的模块注释明确写了「无依赖(连 `node:` 内置
模块都不需要)是刻意的」,因为 `dev.mjs` 要在 import 任何重家伙之前算出端口
并探测占用,而纯逻辑也才能脱离 Docker 单测。**不能为了读文件破掉这一点。**

改法:把 `AZURE_DOC_TYPE_PORT_BASE` 移出该模块,签名从持有表改为收表:

```js
// 之前:azurePortLayout({ docTypes, replicas })      —— 内部查自己的常量表
// 之后:azurePortLayout({ docTypes, portBases, replicas })
```

`portBases` 由调用方(`dev.mjs` / `runtime.mjs` / 测试)从
`readAzureDocTypes()` 得到。纯逻辑与可测性不变。

### 2.4 删掉 `SUPPORTED_DOC_TYPES`

`stacks/azure/local/runtime.mjs:571` 的
`const SUPPORTED_DOC_TYPES = ["markdown", "docx"]` 删除,`assertDocTypesSupported()`
改为对着 `readAzureDocTypes()` 的键校验。报错信息保留现有的可操作性
(「建一个 `packages/azure-{name}` 入口」),但不再要求「并加进
`SUPPORTED_DOC_TYPES`」——那一步消失了。

### 2.5 `dev.mjs` 的无参默认值

`dev.mjs:45` 的 `Object.keys(DOC_TYPES)` 改为 `readAzureDocTypes()` 的键。
这修掉 §1.2 的 bug:Azure 无参默认值从此取自 Azure 自己的表,而不是
Cloudflare 的。

---

## 3. Bicep 去硬编码

### 3.1 `platform.bicep`

新增 `param docTypes array`,三个显式数据库与三个显式迁移 Job 各收成一个循环:

```bicep
param docTypes array   // ['markdown','docx','psd']

resource docDatabases 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = [for dt in docTypes: {
  parent: pg
  name: 'unidocs_${dt}'
}]

module docMigrateJobs 'migrate-job.bicep' = [for dt in docTypes: {
  name: '${dt}-migrate-job'
  params: {
    name: 'caj-unidocs-${dt}-migrate'
    location: location
    environmentId: containerEnv.id
    identityId: identity.id
    acrLoginServer: acr.properties.loginServer
    image: '${acr.properties.loginServer}/unidocs/azure-migrate:${imageTag}'
    databaseUrl: '${databaseOrigin}/unidocs_${dt}?sslmode=require'
  }
}]

output migrateJobNames array = union(
  [gatewayMigrateJob.outputs.name],
  [for (dt, i) in docTypes: docMigrateJobs[i].outputs.name]
)
```

**网关那套不进循环。** `gatewayDatabase` + `gatewayMigrateJob` 用的是
`unidocs/azure-gateway-migrate` 镜像(网关自己的目录 schema),而 doc service
共用 `unidocs/azure-migrate`(azure-sdk 的会话 schema)。它们是真的不一样,
硬塞进同一个循环需要加一个 `dt == 'gateway' ? A : B` 的分支,那比保留两段更
难读。

**`migrate-job.bicep` 仍必须是独立 module。** 理由不变:`databaseUrl` 由
`@secure() pgAdminPassword` 拼出,直接落在外层模板的资源属性上会让
`az deployment group what-if` 对 Create 变更打印明文连接串,而部署脚本用
`stdio:"inherit"` 透传并 `tee` 进日志。跨 module 边界的编译产物是嵌套部署的
`expressionEvaluationOptions.scope: "inner"` + `securestring`。

### 3.2 `gateway.bicep`

两个独立 `@secure()` 参数与字面量对象改为:

```bicep
param docTypes array
@secure()
param docAccessKeysJson string    // {"markdown":"…","docx":"…","psd":"…"}

var keys = json(docAccessKeysJson)
var docServicesJson = string(toObject(docTypes, dt => dt, dt => {
  serviceId: dt
  url: 'https://unidocs-${dt}.internal.${containerEnv.properties.defaultDomain}'
  accessKey: keys[dt]
}))
```

`toObject` 的三参 lambda 形式需要 Bicep ≥ 0.16;本机 `az bicep version` 是
**0.46.1**,满足。

### 3.3 必须验证:securestring 传播不能断

上一轮踩过一次同类缺陷(部署设计的 I1):`@secure()` 派生的表达式一旦内联进
外层模板,`what-if` 在 Create 时会原样打印。现在多了 `json()` → `toObject()`
→ `string()` 这一串往返,securestring 的标记会不会在中途丢失,**不能凭推理
下结论**。

`az deployment group what-if` 需要写权限(当前 PIM 只有 Reader),验不了。
替代验证不需要任何 Azure 权限:

```bash
az bicep build --file stacks/azure/deploy/gateway.bicep --stdout
```

检查编译产物里 `docServicesJson` 的最终去向:

- 落在 `Microsoft.Resources/deployments` 的嵌套模板 `properties.parameters`
  且对应参数声明为 `"type": "securestring"` → **安全**
- 被内联进外层模板的 `variables` 或资源属性 → **泄漏,方案作废**

这条检查要固化成一条单元测试(`tests/unit/scripts/` 下,与
`azure-deploy.test.mjs` 同级),而不是只在实施时手工看一次。若结果是泄漏,
退路是保留每个 doc type 一个独立 `@secure()` 参数、由 `deploy.mjs` 动态生成
参数名——放弃 `gateway.bicep` 的完全泛化,换回安全性。**这条不接受折中。**

---

## 4. `deploy.mjs` 去硬编码

25 处字面量全部从 `readAzureDocTypes()` 展开:

| 现在 | 改成 |
|---|---|
| `MARKDOWN_ACCESS_KEY_SECRET` / `DOCX_ACCESS_KEY_SECRET` 两个常量 | `` `${docType}-access-key` `` |
| `markdownAccessKey` / `docxAccessKey` 两个变量 | `accessKeys: Record<docType, string>` |
| `args.services ?? ["markdown", "docx"]` | 表的键 |
| `IMAGES` 里两条 doc type 镜像 | 从表展开 |
| 冒烟的 docx 特判(`deploy.mjs` 两处) | 表上的 `needsCas` |
| `--target gateway` 传给 bicep 的两个 key 参数 | `docTypes` 数组 + `docAccessKeysJson` |

`smoke.mjs` 里「目前只有两个可冒烟的 doc type」那份列表同样改为收表。

`stacks/azure/deploy/Dockerfile` **不需要改**——它已经是 `ARG SERVICE` /
`ARG ENTRY` 的泛型形态,`--build-arg SERVICE=azure-psd` 直接可用。

---

## 5. `packages/azure-psd`

照 `packages/azure-docx` 的形状建,四个文件加一处 tsconfig 登记:

**`src/main.ts`** —— 与 markdown/docx 的入口同形,只有两个值不同:

```ts
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createPsdDocumentType } from "@unidocs/doctype-psd";

runDocTypeService({
  docType: "psd",
  documentTypeFactory: createPsdDocumentType,
  defaultPort: 41820,
}).catch((err) => {
  console.error("azure-psd failed to start:", err);
  process.exit(1);
});
```

**`package.json`** —— 复制 azure-docx 的,把 `@unidocs/doctype-docx` 换成
`@unidocs/doctype-psd`。**不声明 `ag-psd` / `fast-png`**:它们是纯 JS,不在
`EXTERNAL_NPM_PACKAGES`(`["pg", "@azure/storage-blob", "@azure/identity"]`)
里,会被 esbuild 内联进 bundle;只有留作 external 的依赖才必须在
`package.json` 里声明(这正是上一轮 azure-docx 漏声明 `pg` 导致镜像起不来的
那条教训)。`tests/unit/workspace/package-deps.test.mjs` 会守住这条。

**`scripts/bundle.mjs`** —— 复制 azure-docx 的(用显式
`external: EXTERNAL_NPM_PACKAGES`,不是 `packages: "external"`)。

**`tsconfig.json`** —— references 指向 `../azure-sdk` 与 `../doctype-psd`。

**根 `tsconfig.json`** —— 在 `packages/azure-docx` 之后加一条
`packages/azure-psd`。

### 5.1 psd 在 Azure 上跑得起来吗

`doctype-psd` 的运行时依赖只有 `ag-psd` 与 `fast-png`,都是纯 JS、无原生
canvas。它们已经跑在 workerd 上——workerd 的 API 面比 Node 窄,能在 workerd
上跑的必然能在 Node 上跑。所以不存在运行时可行性问题。

### 5.2 psd 的 Operator 在 Azure 上不可用

`packages/cloudflare-psd/src/worker.ts` 给 psd 挂了真 Operator
(`createPsdDocumentAgent` + Anthropic provider,`maxIterations: 25`);而
`azure-sdk/src/local-editor.ts` 的 `createStubOperatorNamespace()` 让 Azure
侧**所有** doc type 的 `/run` 与 `/reset` 一律 501。

也就是说 azure-psd 的 chatbox 不工作。这不是 psd 特有的缺口,接真 Operator
会同时影响 markdown/docx/psd 三家,是独立一轮的事。**本轮范围外**,但要在
`packages/azure-psd/src/main.ts` 的文件注释里写明,免得下一个人以为是漏掉了。

Cloudflare 的 `/_internal/resolve_blob` 与 `/_internal/read_blob` 只被
`cloudflare-sdk/src/operator-do-agent.ts` 使用,Azure 侧因此也不需要它们。

---

## 6. web-psd 与本地 Azure 栈

**这一项基本是免费的。** `scripts/dev.mjs:230-240` 的前端启动循环已经写成
两个后端共用:

```js
// Runs on both backends: the proxy only needs a gateway URL, and `runtime.urls`
// has the same shape either way.
for (const name of docTypes) {
  const web = DOC_TYPES[name].web;
  if (!web) continue;
  spawn("npx", ["vite", ...], { env: { ...process.env, GATEWAY_URL: runtime.urls.gateway } });
}
```

psd 一旦成为 Azure 支持的 doc type,`pnpm dev --azure psd` 就会同时拉起 Vite
并把 `GATEWAY_URL` 指向 Azure 网关(41787)。**不需要新代码。**

唯一要处理的是端口冲突:`web` 的端口写死在 CF 表里(5173),而 docx/psd 的
CAS 过渡形态**要求两套栈同时跑**——那时两个 Vite 都想要 5173,第二个会因
`--strictPort` 直接失败。

方案:`dev.mjs` 在 Azure 分支给 web 端口加一个固定偏移(`5173 + 1000 = 6173`),
和端口段分离的做法一致(Azure 41787 对 Miniflare 8787)。偏移量与 doc type
无关,只与后端有关,所以放在 `dev.mjs` 而不是 `azure.service.json` 里。

---

## 7. 明确的范围外

| 项 | 为什么不在本轮 |
|---|---|
| **azure-cas** | `cloudflare-cas/src/cas/do.ts` 有 838 行,其中约 500 行的核心是租约 / 引用计数 / GC 的并发语义,而它们全部建立在「每个 tenant 一个 Durable Object 单线程串行化」之上(`routes.ts:183`)。Azure 是 N 个无状态副本共享一个 Postgres,每一处读-改-写都要重新设计;GC 尤其难(遍历图判不可达期间不能有新 lease 插入)。这是独立子系统,规模与「部署隔离」那一轮相当或更大,值得单独出 spec。 |
| **部署 Cloudflare CAS worker** | `packages/cloudflare-cas/wrangler.toml` 的 `database_id` 至今是 `REPLACE_WITH_CAS_D1_ID`,该 worker 从未部署过。部署它本身很小(建 D1、填 id、`wrangler secret put`、`wrangler deploy`),但**现在做的收益会被打折**:`capability auth` 计划要彻底删除 `INTERNAL_TOKEN` 换成 JWT capability,鉴权配置要重配一遍。而且 PIM 当前只有 Reader,Azure 侧无法端到端验证,所以现在部署也证明不了什么。建议等 PIM 恢复后与 Azure 真部署一起做。 |
| **Azure Operator / LLM** | 见 §5.2,影响三个 doc type,独立一轮。 |
| **合并 `azure-markdown` / `azure-docx` / `azure-psd`** | 继续推迟(2026-08-25 已决)。本轮的收敛反而降低了合并的收益。 |

---

## 8. 验收标准

不需要 Azure 权限的部分(全部必须通过):

1. `pnpm build` / `pnpm typecheck` / `pnpm test` 全绿
2. `pnpm test:local` 全绿
3. `node scripts/dev.mjs --azure` **不带参数**不再报 `Unknown Azure doc type: psd`
   (§1.2 的 bug 修复)
4. `pnpm dev --azure psd` 起得来,`POST /users/{u}/docs/psd/` 能建文档,
   `query` 能读回;Vite 前端在偏移后的端口上起来且 `GATEWAY_URL` 指向 41787
5. `tests/integration/azure/` 新增一条 psd 的端到端(create → apply → query),
   CAS 走过渡形态(`CAS_BASE_URL` 指 Miniflare 的 8791),`pnpm test:azure` 通过
6. `az bicep build` 对 `stacks/azure/deploy/` 下六个模板全部通过且无 warning
7. **§3.3 的 securestring 检查通过**,且已固化为单测
8. 新增单测:`readAzureDocTypes()` 的字段校验与点名报错;`azurePortLayout()`
   收表后的行为(含未知 doc type 的报错信息)
9. 隔离性不回退:移走 `stacks/azure/` 后 `pnpm build` / `typecheck` / `test`
   仍全绿。注意 `test:local` 已有 4 个直接 import `stacks/azure/` 的单测
   (`azure-deploy` / `azure-ports` / `azure-smoke` / `replica-proxy`),本轮
   §8.7、§8.8 新增的测试会让这个数字继续增长——「`test:local` 不含 Azure」
   这条性质本来就不成立,本轮不试图修复它,但也要记明白:上一轮 spec 写的
   不变式针对的是 `pnpm test`,那条至今成立。把这 4+ 个纯逻辑单测挪进
   `test:azure` 是个独立的待决项(代价是它们不需要 Docker 却要跟需要
   Docker 的集测一起跑)。

需要 Azure 权限、PIM 恢复后补做(不阻塞本轮合并):

10. `node stacks/azure/deploy/deploy.mjs --platform` 建出 `unidocs_psd` 数据库
    与 `caj-unidocs-psd-migrate` 迁移 Job
11. `--service psd` 只更新 psd 的 Container App;`service-markdown`、
    `service-docx`、`gateway` 的部署时间戳不变、revision 不递增
12. 网关的 `DOC_SERVICES_JSON` 含三个 doc type,`--gateway` 重部后
    `/users/{u}/docs/psd/` 可达

---

## 9. 风险

**R1 — `toObject` 破坏 securestring(高影响,可提前验)。** 处置见 §3.3:
先用 `az bicep build` 验,失败就退回每 doc type 一个独立 `@secure()` 参数。
这条在实施顺序上必须**排在 gateway.bicep 改造之前**,不能改完再验。

**R2 — `capability auth` 会重扫本轮产物(中,不可避免)。** 那份计划
(`docs/superpowers/plans/2026-08-25-gateway-issued-capability-authorization.md`)
状态是 Deferred,前置条件「P0 完成每一道 gate」现已满足,随时可能启动。它的
Task 4 是 *"Make every current Doc type tenant-aware and contract-identical"*
——新建的 `azure-psd` 必然被扫到。但它是照现有形状抄的,增量成本很小;而本轮
的收敛反而**减少**了那轮要改的面。不构成阻塞。

**R3 — 端口偏移与既有测试。** `tests/integration/` 下每个测试文件都自带专用
端口(18787 / 28787 / 29787 / 31787 / 32787)。新增的 psd e2e 必须照办,尤其
因为它需要同时起 Miniflare(供 CAS)与 Azure 两套栈。用默认端口会与
「另开终端跑 `pnpm dev`」的开发流程互斥。

**R4 — 迁移 Job 循环的 output 索引。** `platform.bicep` 里
`docMigrateJobs[i].outputs.name` 依赖循环资源的索引访问。上一轮有过一次同类
教训:`migrateJob.name` 写成了嵌套部署名而不是资源名,**能编译但值是错的**,
只在真部署时表现为「job not found」。本轮要在 `az bicep build` 的产物里直接
核对 `migrateJobNames` 的每一项是不是 `caj-unidocs-{docType}-migrate`,不能
只看编译通过。

---

## 10. 任务划分(供实施计划展开)

1. **`readAzureDocTypes()` + `azure.service.json` 补字段** —— 新模块与单测,
   三份 JSON 加 `localPortBase` / `needsCas`。不改任何消费方。
2. **本地栈收敛** —— `ports.mjs` 改收表、删 `SUPPORTED_DOC_TYPES`、
   `dev.mjs` 的无参默认值与 `needsCas` 特判。§1.2 的 bug 在此修复。
3. **§3.3 的 securestring 验证** —— 先验后改,结果决定 Task 4 的形态。
4. **Bicep 泛化** —— `platform.bicep` 与 `gateway.bicep` 收成循环。
5. **`deploy.mjs` / `smoke.mjs` 泛化** —— 25 处字面量展开。
6. **`packages/azure-psd`** —— 建包、tsconfig 登记、`azure.service.json`。
7. **psd e2e + web 端口偏移** —— `tests/integration/azure/` 新增一条,
   `dev.mjs` 的 Azure 分支给 web 端口加偏移。

Task 3 必须在 Task 4 之前。Task 6 依赖 Task 1、2、5。其余可按序推进。
