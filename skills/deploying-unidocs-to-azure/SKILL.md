---
name: deploying-unidocs-to-azure
description: Use when deploying unidocs to Azure Container Apps, rerunning `pnpm stack:deploy unidocs-azure`, interpreting a deploy that ended with exit code 1 or a red `[7/7] smoke`, or verifying an Azure deployment afterwards (image tags, revisions, known-red smoke assertions, whether PSD setText can actually get glyphs).
---

# 发布 unidocs 到 Azure

`stacks/unidocs-azure/deploy/deploy.mjs` 与它的 README 已经把**流程**写清楚了，会读代码的人能自己查出七个步骤、参数含义和大部分坑。**本技能只装那些读代码查不出来、或者会被读代码误导的东西** —— 每一条都是实测过的。

## 一、`[7/7] smoke` 必红，这不是你的问题，也修不了「那 4 条红」

读代码最容易得出的错误结论是：「冒烟报红是因为那 4 条已知失败，修掉就绿了」。**不成立。**

```
SMOKE_ATTEMPT_TIMEOUT_MS = 30_000   deploy.mjs:73   单次尝试上限
SMOKE_RETRY_TIMEOUT_MS   = 120_000  deploy.mjs:62   总预算
完整五组冒烟实测          51 秒                      2026-09-08 实测
```

51 秒的活干不完 30 秒的班。每次尝试都在跑到一半时被 `SIGKILL`，四次重试全部如此，然后总预算耗尽。**即使 4 条断言全部修好，`[7/7]` 照样红。**

后果：`main()` 里 `runSmoke()` 抛错 → 顶层 catch → `process.exit(1)`，**`deployed: https://...` 那行永远不会打印，退出码永远是 1**。

**所以：不要用退出码判断部署成败。** 按第五节手工验收。

**反过来也一样：只修超时也不会绿。** `smoke.mjs:525-527` 是 `if (failures > 0) process.exit(1)`，那 4 条已知断言（第五节）照样让子进程非零退出，被归类成 `[assertion]`。

所以 `[7/7]` 要真绿，**两件事必须一起做**：
- 超时：`SMOKE_ATTEMPT_TIMEOUT_MS` 提到 ~90 秒，**同时**提 `SMOKE_RETRY_TIMEOUT_MS`（现在只有 120 秒，只提单次上限的话一次失败就吃光总预算，revision 接管流量那段窗口没得重试）；或按 `--only` 分组跑。
- 那 4 条断言本身。

属于改进，不是本技能范围。

## 二、三条会造成真实损害的操作

| 别做 | 会发生什么 | 该怎么做 |
| --- | --- | --- |
| `pnpm install --registry=<公司镜像>` | pnpm 把 lockfile 里 **752 条 `resolution` 全部重写**成镜像 tarball URL，integrity 从 sha512 降成 sha1，产出上千行垃圾 diff | 见下方「加新依赖」 |
| 把部署命令接 `\| tail -N` | 管道缓冲，**跑完才吐输出**，中途十几分钟完全看不到进度 | 不接管道，或重定向到文件；进度改从 Azure 侧看（第四节） |
| 漏传 `--gateway-oauth-issuer` | 它在 `parseArgs` 里可选，但 `deployGateway()` **无条件**拼 `gatewayOAuthIssuer=${...}`。不传 = 传空串 = 增量刷新把线上的 `GATEWAY_OAUTH_ISSUER` **抹掉**，且不报错 | 永远显式传，值与 `--cas-stack-issuer` 逐字相同 |

**加新依赖不能靠裸 `pnpm install`** —— 这台机器公网 registry 被 SNI 拦截，取不到新包。四步：

```bash
pnpm --filter <目标包> add <新包> --registry=https://repo.huaweicloud.com/repository/npm  # 用 CLI 参数，不要用环境变量
git checkout pnpm-lock.yaml                 # 丢掉被改写的 752 条 resolution
# 手工把新包的 importer 块补回 lockfile（依赖条目通常本来就在）
pnpm install --frozen-lockfile --offline    # 验证自洽、不再联网、不再动 resolution
```

只是复现既有依赖（比如拉完代码）用裸 `pnpm install` 即可。

## 三、PIM Owner 是**限时**的，几小时就掉

`[1/7] preflight` 的 `checkRbac()`（`deploy.mjs:589`）要 Owner 或 User Access Administrator。PIM 激活会过期 —— 2026-09-08 实测：上午激活后查到 `Owner`，同日晚上再查**返回空**。

**「我今天激活过」不算数，每次部署前现查：**

```bash
OID=$(az ad signed-in-user show --query id -o tsv)
az role assignment list --assignee "$OID" \
  --scope /subscriptions/24c9acbd-c2f5-4ef9-b9a2-486d90208b3e \
  --include-inherited --query "[].roleDefinitionName" -o tsv | sort -u
```

查不到 `Owner` 就去 Portal → PIM 激活，别直接跑部署 —— preflight 会在任何写操作之前拦下，那是好事，但白等一轮。

还有一条 preflight：`checkHostBuild()`（`:637`）只查 `unicas-packages/codec/dist/index.js`。所以部署前必须 `pnpm install && pnpm build`。

## 四、看进度只能从 Azure 侧看

部署脚本自己的输出很稀疏，而且 **`az containerapp logs show` 在这个订阅上是 Forbidden**（缺 `Microsoft.App/containerApps/getAuthToken/action`，实测报 `AuthorizationFailed`）—— 别在它上面浪费时间。

**能用的是 Log Analytics**（`bootstrap.bicep` 建了 workspace `unidocs-logs`，`platform.bicep` 把环境的 `appLogsConfiguration.destination` 指向它）。2026-09-09 实测可用，**且不需要 PIM，Reader 就够**：

```bash
WS=$(az monitor log-analytics workspace show -g Unidocs -n unidocs-logs --query customerId -o tsv)

# 平台侧：为什么起不来（探针失败、拉镜像、OOM、崩溃重启）
az monitor log-analytics query -w "$WS" --analytics-query \
  "ContainerAppSystemLogs_CL | where ContainerAppName_s startswith 'unidocs-psd' | top 50 by TimeGenerated desc | project TimeGenerated, Reason_s, Log_s" -o table

# 应用侧：容器自己的 stdout/stderr（服务打的是结构化 JSON）
az monitor log-analytics query -w "$WS" --analytics-query \
  "ContainerAppConsoleLogs_CL | where ContainerAppName_s contains 'psd' | top 50 by TimeGenerated desc | project TimeGenerated, RevisionName_s, Log_s" -o table
```

**日志有几十秒到几分钟的摄取延迟** —— 刚重启就查可能是空的，等一会儿再查，别当成「没日志」。

```bash
az acr task list-runs -r unidocsacr --top 8 -o table          # 6 个镜像，并发 2，每个约 4 分钟
az deployment group list -g Unidocs \
  --query "[].{name:name,state:properties.provisioningState}" -o table   # 全量应有 12 条 Succeeded
az containerapp list -g Unidocs \
  --query "[].{n:name,img:properties.template.containers[0].image}" -o table
```

## 五、验收（退出码不可信，逐条手工做）

1. **四个容器的镜像 tag 都等于 `git rev-parse --short HEAD`**
2. **14 条 bicep 部署全部 `Succeeded`**（实测计数，2026-09-08 全量冷启动那批）：

```
bootstrap · platform
{docx,markdown,psd,gateway}-migrate-job          4 条
{docx,markdown,psd}-app + service-{docx,markdown,psd}   6 条
gateway-app + gateway                            2 条
```

网关是 `gateway-app` + `gateway` **两条**，容易按「四组各一条」数成 12。
3. **四个 revision `Running` 且副本就绪**
4. **手工跑完整冒烟**（不带部署脚本那层 30 秒包装器）：

```bash
node stacks/unidocs-azure/deploy/smoke.mjs --gateway https://<网关 FQDN>
```

期望**恰好 4 条 FAIL**，多一条少一条都要查：

| 冒烟输出 | 根因 | 是部署问题吗 |
| --- | --- | --- |
| `apply insertImage` → `openSBlob requires a branded SBlob` | 冒烟脚本用 `application/json` 发 `payload.hash`，而 op 要 `payload.blob: SBlob`，**JSON 表达不了 SBlob**（CBOR tag 65536） | 否，脚本缺陷 |
| `query getImages` 空数组 | 上一条的连锁 | 否 |
| `[5/5] body.version === 3` | 上一条的连锁 | 否 |
| `export` → 500 `Invalid document size` | `doctype-psd` 的 `init` 建 **0×0 画布**，ag-psd 拒绝导出 | 否，产品边界 |

**`CAS upload → ready === true` 是跨云 CAS 接线的唯一证明**，它变红是真问题，不要因为它和 docx 图片那三条挨着就一起忽略。

## 六、字体链的验收配方（冒烟覆盖不到，只能这么验）

`smoke.mjs` 里有一大段注释说明为什么不给内置字体加断言：`set_text` 是**纯 op**，字体只在 setText **effect** 里被读，而 effect 没有 HTTP 入口，只在 agent 的 ReAct 循环里跑。

**结论是对的，但别据此以为「Azure 上没法验」。** 从公网走 agent 的 `/run` 就能验，三个请求：

```js
const GW = "https://<网关 FQDN>", USER = "u1", DOC = `fontcheck-${Date.now().toString(36)}`;

// 1) 建文档
await fetch(`${GW}/tenants/${USER}/docs/psd/`, { method: "POST", headers: { "X-Doc-Id": DOC } });

// 2) 加一个中英混排文字层。请求拉丁那套 —— 它不覆盖 CJK，
//    汉字必须靠回退链落到内置的中文子集上。parentId 必须显式给 null。
await fetch(`${GW}/tenants/${USER}/docs/psd/${DOC}/apply`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ baseVersion: 1, description: "add text layer", operations: [{
    kind: "add_layer",
    payload: { parentId: null, layer: {
      id: "title", type: "text", name: "title", bounds: [0, 0, 200, 1200],
      opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
      text: { content: "你好 UniDocs",
        style: { font: "NotoSans-Regular", size: 64, color: { r: 0, g: 0, b: 0 } },
        paragraphStyle: { justification: "left" } },
    } },
  }] }),
});

// 3) 走 agent —— 唯一能触发 setText effect 的路径
await fetch(`${GW}/tenants/${USER}/docs/psd/${DOC}/run`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ instruction: "把 title 图层的文字改成「字体已就绪 Ready」" }),
});
// 然后 query getLayers 回读
```

**三条证据，缺一不可：**

1. agent 的回复里点名 **`NotoSansSC-Regular`** 顶替了 `NotoSans-Regular` —— 那是随包发行的中文子集，而 Azure 上没人灌过字体、`PSD_FONT_FALLBACKS` 也没设，所以回退链只可能来自 `BUILTIN_FALLBACKS`
2. 替换被**显式上报**（`glyphFallbacks` 经 `summarize()` 出来），不是悄悄换
3. **`getLayers` 的 `bounds` 变了**（如 `[0,0,200,1200]` → `[0,0,70,517]`）—— 版面是按真实字形度量重算的。取不到字形根本走不到这一步

第 3 条最硬。只看第 1 条会被「agent 嘴上说得好听」骗过去 —— 那句回复是模型自己生成的，不是系统事实；第 2 条是 effect 真写进 delta 的字段；第 3 条是版面层面的物理后果。

**`/run` 是非确定性的**（要真花一次 LLM 调用，模型可能压根不去调 `set_text`）。指令写得越具体越好；失败先换措辞重试，**不要据此判定字体链坏了**。想在花这一趟之前先自查，仓库里有等价的确定性断言：`tests/integration/cloudflare/psd-fonts-e2e.test.mjs` —— 但它跑在本地 workerd，**不能替代**对 Azure 镜像的验收。

**`PSD_FONT_FALLBACKS` 不要传。** 未设 = 取内置那两套；显式空串是**逃生口**（一个候选都不试），会让中文层整层画不出来。`--psd-font-fallbacks` 缺省就是空串且 bicep 对空值不注入，所以**不传即正确**。

## 七、参数从线上读，不要从测试夹具读

`tests/unit/scripts/azure-deploy.test.mjs` 里的 `STACK_ARGS` 会过期。每次现读：

```bash
az containerapp show -g Unidocs -n unidocs-gateway \
  --query "properties.template.containers[0].env" -o json
```

2026-09-08 实测值（**会漂，用前核对**）：

```bash
ISSUER=https://unidocs-gateway.politewave-5b44572b.southeastasia.azurecontainerapps.io/issuer/azure
pnpm stack:deploy unidocs-azure \
  --capability-key-id key-azure-cap-dev \
  --cas-stack-id cas_EM1_egj6I-ea \
  --cas-stack-issuer "$ISSUER" \
  --gateway-oauth-issuer "$ISSUER" \
  --cas-stack-key-id key-azure-cas-dev \
  --cas-capability-audience https://unicas.shazhou.work/stacks/cas_EM1_egj6I-ea \
  --cas-base-url https://unicas.shazhou.work \
  --cas-ref-domain doc \
  --llm-api-key-secret llm-api-key \
  --llm-model claude-opus-4-6 \
  --image-edit-api-key-secret image-edit-api-key
```

`--capability-issuer`（`unidocs-gateway:azure-dev`）、`--resource-group`、`--location`、`--cas-ref-domain` 与脚本默认值相同，可省。`--image-edit-model` 线上没设，别传 —— 传了会新增一个当前不存在的环境变量。

## 八、真问题的信号（与第五节那 4 条区分开）

- `[1/7]` 报 RBAC → PIM 没激活（第三节）
- `[1/7]` 报 `codec/dist/index.js is missing` → 没跑 `pnpm build`
- `[3/7]` 报 Key Vault 缺 secret → 走平台密钥流程补，别用命令行绕
- `[6/7] migration job did not finish` → 多半是镜像架构不对（ACA 只吃 `linux/amd64`）
- 冒烟 FAIL 内容**不在第五节那张表里** → 功能坏了
- 任一 bicep 部署 `Failed`，或 revision `active=false` / 非 `Healthy`

## 增补本技能

发现新坑就往对应小节加一条，并写清**实测依据**（跑了什么、看到什么、日期）。这个仓库把文档当事实读 —— 一条没核实过的断言比没有更糟。
