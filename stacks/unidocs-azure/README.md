# stacks/unidocs-azure/

Azure 部署与本地栈的运维资产。**代码在别处**——这个目录只放编排脚本、
Bicep 模板和 Dockerfile,不放业务逻辑。目录分界与 `stacks/` 的总体约定见
`stacks/README.md`。

- `deploy/` —— 真实云部署:`deploy.mjs`(编排脚本)、`smoke.mjs`
  (部署后冒烟)、`bootstrap.bicep`/`platform.bicep`/`service.bicep`/
  `gateway.bicep`/`container-app.bicep`/`migrate-job.bicep`(四个可独立
  部署的 target + 两个被 module 引用的公共模板)、`Dockerfile`
  (四个 Azure 服务共用的构建产物镜像)。
- `local/` —— 本地开发/测试用的 Azure 栈:`runtime.mjs`
  (`startAzureRuntime()`,`pnpm dev unidocs-azure` 和 `tests/integration/azure/`
  都靠它起服务)、`ports.mjs`(端口布局,无依赖)、`replica-proxy.mjs`
  (本地扮演 Container Apps 的多副本 ingress)。

删掉整个 `stacks/unidocs-azure/`,`pnpm build`/`pnpm typecheck`/`pnpm test` 依然
全绿——代码不依赖它。反过来,`packages/azure-*` 一旦被删,这里的脚本会
立刻在运行时炸掉(找不到要打包/部署的源码),这不是巧合,是刻意的单向依赖。

## `.dockerignore` 为什么留在仓库根,不要搬进 `stacks/unidocs-azure/deploy/`

Docker 只读**构建上下文根目录**那一份 `.dockerignore`,不会去构建上下文之外
的目录找。`stacks/unidocs-azure/deploy/Dockerfile` 和 `tests/treespec/Dockerfile` 的构建
上下文都是仓库根(`.`)——`az acr build --file stacks/unidocs-azure/deploy/Dockerfile .`
和本地 `docker build -f stacks/unidocs-azure/deploy/Dockerfile .` 都是这么调的,`--file`
与构建上下文本就可以分离。

把 `.dockerignore` 搬进 `stacks/unidocs-azure/deploy/` **不会报错**——docker 会安安静静地
在仓库根找不到它,排除规则就悄悄失效了:`node_modules`、`dist`、`.git` 全部
进入构建上下文。表现是"构建突然变慢"(context 从几十 MB 涨到几百 MB 甚至
上 GB),没人会第一时间联想到"是不是 dockerignore 挪了地方"。所以:
`.dockerignore` 必须留在仓库根,这不是遗漏,是刻意的。

## `docker-compose.yml` 为什么在 `packages/azure-sdk/`,不在 `stacks/unidocs-azure/local/`

它的第一消费者是 `packages/azure-sdk/tests/containers.ts`——`@unidocs/azure-sdk`
包自己的 Vitest `globalSetup`,而这套端口契约测试在**强制门禁**里
(`pnpm test` → `pnpm -r test`)。如果把 `docker-compose.yml` 放进
`stacks/unidocs-azure/local/`,"删掉 `unidocs-azure/` 之后 `pnpm test` 仍然全绿"这条不变式就不成立
了——它会立刻找不到 compose 文件。

`stacks/unidocs-azure/local/runtime.mjs`(`pnpm dev unidocs-azure` 用的本地栈)和
`tests/integration/azure/`(Vitest `test:azure` 门禁)都是这份 compose 文件的
**借用者**,不是第一消费者:它们各自 `docker compose -f
packages/azure-sdk/docker-compose.yml up -d` 起同一个 Postgres 容器,复用
`packages/azure-sdk` 已经在维护的那一份定义,而不是维护第二份。

## 相关命令

```bash
pnpm dev unidocs-azure    # 本地 Azure 栈(stacks/unidocs-azure/local/runtime.mjs)
pnpm dev unidocs-azure --cas local
pnpm test:local           # 默认门禁,不含任何 Azure 集成测试
pnpm test:azure           # Azure 集成测试(tests/integration/azure/),需要 Docker
pnpm azure:up             # docker compose -f packages/azure-sdk/docker-compose.yml up -d
pnpm azure:down           # docker compose -f packages/azure-sdk/docker-compose.yml down
pnpm run deploy unidocs-azure \
  --cas-base-url https://unicas.shazhou.work \
  --cas-stack-id cas_XXXXXXXXXXXX \
  --cas-stack-issuer https://unicas.shazhou.work/cas/issuer/azure \
  --cas-stack-key-id az-rotate-1 \
  --capability-key-id ...
```

### Stack 身份参数

`--internal-auth-mode` 只接受 `stack`。部署 `gateway` 或 `services` 目标时,
下面这组必填 —— 缺任何一个不是"降级运行",而是容器起不来
(`azure-gateway/src/main.ts` 与 `resolveDocAuthConfig()` 都是 `requireEnv`),
所以 `parseArgs()` 在第一时间就响亮失败,而不是让你等 15 分钟部署完再看崩溃日志。

| 参数 | 目标 | 说明 |
| --- | --- | --- |
| `--cas-stack-id` | gateway + services | 控制面**生成**的不透明 id,形如 `cas_XXXXXXXX`。不可自选:CAS 校验器拿 issuer 反查注册表得到 stackId,再与请求路径里的 stackId 比对,对不上就是 `resource_scope_mismatch`。脚本按 `/^cas_[A-Za-z0-9_-]{8,64}$/` 校验格式,`unidocs-azure` 这类本地 fixture 名会被直接拒掉 |
| `--cas-stack-issuer` | gateway + services | 该 stack 在控制面注册的 issuer |
| `--cas-stack-key-id` | 仅 gateway | 该 stack 下 `active` 状态的签名密钥 kid。doc service 不签发,只验签,所以不需要 |
| `--cas-ref-domain` | gateway | Root Refs 写入的业务域,默认 `doc`。必须已在该 stack 注册且 `active`,否则 `updateRootRefs` 被 CAS 拒 |

两个 stack 密钥从 Key Vault 读既有值,**不由脚本生成**(私钥的另一半在控制面
注册 issuer 密钥时就定下了),按非对称原则分发:

| Key Vault secret | 发给谁 | 对应环境变量 |
| --- | --- | --- |
| `cas-stack-private-key-pkcs8` | 只有网关 | `CAS_STACK_PRIVATE_KEY_PKCS8` |
| `cas-stack-trusted-jwks` | 只有 doc service | `CAS_STACK_TRUSTED_JWKS` |

`tests/unit/scripts/azure-stack-env.test.mjs` 是这条边界的穷尽性守卫:入口点
stack 模式下要的每个环境变量,bicep 模板都必须有注入点。这层网存在的原因是
真踩过一次 —— 脚本强制 stack 模式,bicep 却一个 `CAS_STACK_*` 都没接,编译与
what-if 全绿,只在容器起来时崩。

<!-- cas-contract-docs: migration-start -->
Capability rollout also accepts `--capability-issuer`; stack mode requires an
active key ID. Private PKCS8 and trusted JWKS values are read
from pre-provisioned Key Vault secrets and are never accepted as CLI arguments
or printed in deployment output. `--cas-access-key` is rollout-only while a
legacy CAS dependency remains mounted; it is not the target authentication
model.
<!-- cas-contract-docs: migration-end -->

Deploy validator JWKS to Doc/CAS revisions before switching Gateway to the
matching private key. Gateway alone receives `CAPABILITY_PRIVATE_KEY_PKCS8`;
validators receive public-only `CAPABILITY_TRUSTED_JWKS`; issuer, audience, and
lifetime policy are non-secret environment values. Run capability-authenticated
create/read/write and CAS smoke probes after each revision change. During the
bounded rollout window rollback is a forward deployment of the retained `dual`
artifact with an explicitly controlled legacy secret. After secret destruction,
recover with a capability-aware release and key rotation rather than restoring a
permanent bypass. See `docs/capability-key-operations.md`.

## `deploy.mjs` 的选择器

`stacks/unidocs-azure/deploy/deploy.mjs` 部署四个独立单元:`bootstrap.bicep`(ACR / Key
Vault / 存储 / 身份 / Log Analytics)、`platform.bicep`(Postgres / ACA
环境 / 迁移 Job)、`service.bicep`(单个 doc type 的 Container App)、
`gateway.bicep`(网关 Container App)。不带任何选择器时四个按依赖顺序
(bootstrap → platform → services → gateway)全量部署一遍;带了选择器时
只跑被选中的那些:

```bash
pnpm run deploy unidocs-azure                          # 冷启动全量
pnpm run deploy unidocs-azure --bootstrap               # 只 bootstrap
pnpm run deploy unidocs-azure --platform                # 只 Postgres / ACA 环境 / 迁移
pnpm run deploy unidocs-azure --service docx             # 只构建 docx 镜像 + 只部它
pnpm run deploy unidocs-azure --service docx,markdown    # 多选,逗号分隔,镜像并发构建
pnpm run deploy unidocs-azure --gateway                  # 只网关
pnpm run deploy unidocs-azure --service docx --build-concurrency 1   # 覆盖镜像构建并发(默认 2)
```

`--service docx` 的冒烟只测 docx(`smoke.mjs --only docx`),不碰 markdown;
`--service docx,markdown`(或不带选择器的全量部署)冒烟测全部。冒烟本身会
在 2 分钟窗口内每 5 秒重试一次——新 revision 接管流量要几十秒。

**多个独立的 `--service` 进程并行跑是可以这么用的,但这是使用方式,不是
脚本对并发本身的保证**:各 target 用各自独立的 deployment 名
(`bootstrap`/`platform`/`service-{docType}`/`gateway`,并发安全的前提)、
各 doc type 有各自独立的镜像仓库(`unidocs/azure-{docType}`)与 Container
App(`unidocs-{docType}`)、各自独立的数据库(`unidocs_{docType}`)——不同
`--service` 进程之间没有共享的可变状态会被互相踩。对 ACA 环境 / 托管身份 /
ACR 的引用都是只读的 `existing` 声明。

```bash
pnpm run deploy unidocs-azure --service docx &
pnpm run deploy unidocs-azure --service markdown &
wait
```
