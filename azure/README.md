# azure/

Azure 部署与本地栈的运维资产。**代码在别处**——这个目录只放编排脚本、
Bicep 模板和 Dockerfile,不放业务逻辑。

## 目录约定

- `packages/azure-*` 是**代码**:`azure-gateway`/`azure-markdown`/`azure-docx`/
  `azure-sdk` 各自的 `src/`,是被部署、被跑单测的东西。
- `azure/` 是**运维与工具**:如何把上面那些代码构建成镜像、部署到 Azure、
  或者在本机起一套等价的 Postgres + Azurite 栈跑集成测试。

推论:删掉整个 `azure/` 目录,`pnpm build`/`pnpm typecheck`/`pnpm test` 依然
全绿——代码不依赖它。丢失的只是"怎么部署"和"怎么在本机跑 Azure 栈"这两项
能力。反过来,`packages/azure-*` 一旦被删,`azure/` 下的脚本会立刻在运行时
炸掉(找不到要打包/部署的源码),这不是巧合,是刻意的单向依赖。

- `azure/deploy/` —— 真实云部署:`deploy.mjs`(编排脚本)、`smoke.mjs`
  (部署后冒烟)、`bootstrap.bicep`/`platform.bicep`/`service.bicep`/
  `gateway.bicep`/`container-app.bicep`/`migrate-job.bicep`(Bicep 模板,
  四个可独立部署的 target + 两个被 module 引用的公共模板)、`Dockerfile`
  (四个 Azure 服务共用的构建产物镜像)。
- `azure/local/` —— 本地开发/测试用的 Azure 栈:`runtime.mjs`
  (`startAzureRuntime()`,`pnpm dev --azure` 和 `tests/integration/azure/`
  都靠它起服务)、`ports.mjs`(端口布局,无依赖)、`replica-proxy.mjs`
  (本地扮演 Container Apps 的多副本 ingress)。

## `.dockerignore` 为什么留在仓库根,不要搬进 `azure/deploy/`

Docker 只读**构建上下文根目录**那一份 `.dockerignore`,不会去构建上下文之外
的目录找。`azure/deploy/Dockerfile` 和 `tests/treespec/Dockerfile` 的构建
上下文都是仓库根(`.`)——`az acr build --file azure/deploy/Dockerfile .`
和本地 `docker build -f azure/deploy/Dockerfile .` 都是这么调的,`--file`
与构建上下文本就可以分离。

把 `.dockerignore` 搬进 `azure/deploy/` **不会报错**——docker 会安安静静地
在仓库根找不到它,排除规则就悄悄失效了:`node_modules`、`dist`、`.git` 全部
进入构建上下文。表现是"构建突然变慢"(context 从几十 MB 涨到几百 MB 甚至
上 GB),没人会第一时间联想到"是不是 dockerignore 挪了地方"。所以:
`.dockerignore` 必须留在仓库根,这不是遗漏,是刻意的。

## `docker-compose.yml` 为什么在 `packages/azure-sdk/`,不在 `azure/local/`

它的第一消费者是 `packages/azure-sdk/tests/containers.ts`——`@unidocs/azure-sdk`
包自己的 Vitest `globalSetup`,而这套端口契约测试在**强制门禁**里
(`pnpm test` → `pnpm -r test`)。如果把 `docker-compose.yml` 放进
`azure/local/`,"删掉 `azure/` 之后 `pnpm test` 仍然全绿"这条不变式就不成立
了——它会立刻找不到 compose 文件。

`azure/local/runtime.mjs`(`pnpm dev --azure` 用的本地栈)和
`tests/integration/azure/`(Vitest `test:azure` 门禁)都是这份 compose 文件的
**借用者**,不是第一消费者:它们各自 `docker compose -f
packages/azure-sdk/docker-compose.yml up -d` 起同一个 Postgres 容器,复用
`packages/azure-sdk` 已经在维护的那一份定义,而不是维护第二份。

## 相关命令

```bash
pnpm dev --azure          # 本地 Azure 栈(azure/local/runtime.mjs)
pnpm test:local           # 默认门禁,不含任何 Azure 集成测试
pnpm test:azure           # Azure 集成测试(tests/integration/azure/),需要 Docker
pnpm azure:up             # docker compose -f packages/azure-sdk/docker-compose.yml up -d
pnpm azure:down           # docker compose -f packages/azure-sdk/docker-compose.yml down
node azure/deploy/deploy.mjs --cas-base-url ... --internal-token ...   # 真实云部署(全量)
```

## `deploy.mjs` 的选择器

`azure/deploy/deploy.mjs` 部署四个独立单元:`bootstrap.bicep`(ACR / Key
Vault / 存储 / 身份 / Log Analytics)、`platform.bicep`(Postgres / ACA
环境 / 迁移 Job)、`service.bicep`(单个 doc type 的 Container App)、
`gateway.bicep`(网关 Container App)。不带任何选择器时四个按依赖顺序
(bootstrap → platform → services → gateway)全量部署一遍;带了选择器时
只跑被选中的那些:

```bash
node azure/deploy/deploy.mjs                          # 冷启动全量
node azure/deploy/deploy.mjs --bootstrap               # 只 bootstrap
node azure/deploy/deploy.mjs --platform                # 只 Postgres / ACA 环境 / 迁移
node azure/deploy/deploy.mjs --service docx             # 只构建 docx 镜像 + 只部它
node azure/deploy/deploy.mjs --service docx,markdown    # 多选,逗号分隔,镜像并发构建
node azure/deploy/deploy.mjs --gateway                  # 只网关
node azure/deploy/deploy.mjs --service docx --build-concurrency 1   # 覆盖镜像构建并发(默认 2)
```

`--service docx` 的冒烟只测 docx(`smoke.mjs --only docx`),不碰 markdown;
`--service docx,markdown`(或不带选择器的全量部署)冒烟测全部。冒烟本身会
在 2 分钟窗口内每 5 秒重试一次——新 revision 接管流量要几十秒,这与
Postgres 注册表的 30 秒 TTL 无关,没有注册表也需要这条重试。

**多个独立的 `--service` 进程并行跑是可以这么用的,但这是使用方式,不是
脚本对并发本身的保证**:各 target 用各自独立的 deployment 名
(`bootstrap`/`platform`/`service-{docType}`/`gateway`,并发安全的前提)、
各 doc type 有各自独立的镜像仓库(`unidocs/azure-{docType}`)与 Container
App(`unidocs-{docType}`)、Postgres 注册表按 `doc_type` 主键分行——不同
`--service` 进程之间没有共享的可变状态会被互相踩。对 ACA 环境 / 托管身份 /
ACR 的引用都是只读的 `existing` 声明。

```bash
node azure/deploy/deploy.mjs --service docx &
node azure/deploy/deploy.mjs --service markdown &
wait
```
