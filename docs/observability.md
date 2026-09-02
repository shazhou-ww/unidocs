# 调用可观测性

每一次 HTTP 调用产出一条 `http_call` 事件到 stdout。Azure 上由 Container Apps
收进 Log Analytics 的 `ContainerAppConsoleLogs_CL`;Cloudflare 上进 `wrangler tail`;
本地 `pnpm dev` 另外落一份 JSONL 到 `.dev-cloudflare.log`(见文末「本地日志文件」)。

## 事件形状

```jsonc
{
  "event": "http_call",
  "dir": "in" | "out",        // in = 我们对外提供的接口;out = 我们调用别人的
  "target": "gateway" | "cas" | "doc:psd",
  "op": "createDocument",     // 逻辑操作名,按接口聚合用
  "method": "POST",
  "status": 200,              // 0 = 根本没拿到响应(超时/连接断/抛异常)
  "durationMs": 137,
  "ok": true,
  "tenantId": "u1",
  "docType": "psd",

  // 以下仅在非 2xx 时出现
  "url": "…",
  "requestHeaders": { "content-type": "…" },

  // 仅出站非 2xx:上游给的错误信息,512 字节封顶
  "responseBody": "{\"error\":\"… the same object. (10058)\"}",
  "truncated": true,

  // 仅 status 0:异常与完整栈(含 cause)
  "error": "TypeError: fetch failed (cause: Error: connect ECONNREFUSED …)",
  "stack": "TypeError: fetch failed\n    at … \ncaused by: Error: connect ECONNREFUSED\n    at …"
}
```

**详略分级 —— 有栈的地方打栈,没栈的地方留关键信息:**

| 情况 | 有没有异常 | 记什么 |
|---|---|---|
| 2xx | 无 | 只记简报 |
| 出站 4xx/5xx | **无**(fetch 成功了,只是对方回了错误码) | 上游的错误信息(512 字节封顶)+ url + 请求头 |
| 入站 4xx/5xx | 无 | 只记 url + 请求头。响应体是我们自己合成的,成因已由对应的出站事件记下,不重复 |
| `status: 0` | **有** | 完整异常栈(4096 字符封顶),并展开 `cause` |

`cause` 必须展开:undici 把真正的 `ECONNRESET` / `ETIMEDOUT` 藏在
`TypeError: fetch failed` 的 cause 里,只看外层那句话什么都看不出来。

`status: 0` 是排查的关键——浏览器侧的 `Failed to fetch` 在服务端就长这样。它和
"拿到一个 502" 是两件事:网关在上游连不上时会**合成**一个 502 交给调用方,只看
响应码会把真正的连接失败误记成一次正常的 502 响应。

**安全**:请求头走白名单(content-type / content-length / accept /
accept-encoding / user-agent),`Authorization`、`X-UniDocs-CAS-Capability`、
`X-Internal-Token`、Cookie 永远不记。响应体只在出站且 ≥400 时从
`response.clone()` 读,成功响应(可能是几十 MB 的文档)一个字节都不碰。

## 埋点位置

| 位置 | 覆盖 |
|---|---|
| `gateway-common/src/gateway-handler.ts` 的 `handle()` | 所有对外接口(网关是唯一外部入口) |
| 同文件的 CAS 转发分支 | 网关 → CAS |
| 同文件的 `forwardToWorker()` | 网关 → doc worker |
| `azure-sdk/src/doc-type-service.ts` 的 `httpCasFetcher` | doc service → CAS |

sink 由适配器注入(`observe: consoleObserver`),`gateway-common` 本身保持
cloud-neutral、可测——测试注入一个收集器即可断言事件序列,见
`packages/gateway-common/tests/observe.test.ts`。

## KQL

工作区 `unidocs-logs`(`az monitor log-analytics workspace show -g Unidocs -n unidocs-logs --query customerId -o tsv`)。
先把 JSON 解出来:

```kusto
let calls =
  ContainerAppConsoleLogs_CL
  | where Log_s startswith '{"event":"http_call"'
  | extend e = parse_json(Log_s)
  | extend dir = tostring(e.dir), target = tostring(e.target), op = tostring(e.op),
           status = toint(e.status), durationMs = toint(e.durationMs),
           ok = tobool(e.ok), tenantId = tostring(e.tenantId), docType = tostring(e.docType),
           err = tostring(e.error), body = tostring(e.responseBody), url = tostring(e.url);
```

**对外接口的耗时分布(P50/P95/P99)**

```kusto
calls
| where dir == "in" and TimeGenerated > ago(24h)
| summarize count(), p50=percentile(durationMs,50), p95=percentile(durationMs,95),
            p99=percentile(durationMs,99), errors=countif(not(ok))
  by op
| order by p95 desc
```

**第三方调用的耗时(CAS 按操作分)**

```kusto
calls
| where dir == "out" and TimeGenerated > ago(24h)
| summarize count(), p50=percentile(durationMs,50), p95=percentile(durationMs,95),
            failures=countif(not(ok)), noResponse=countif(status == 0)
  by target, op
| order by p95 desc
```

**错误率时间线(画图用)**

```kusto
calls
| where TimeGenerated > ago(24h)
| summarize total=count(), failed=countif(not(ok)) by bin(TimeGenerated, 5m), target
| extend errorRate = todouble(failed) / total
| render timechart
```

**耗时时间线**

```kusto
calls
| where TimeGenerated > ago(24h)
| summarize p95=percentile(durationMs,95) by bin(TimeGenerated, 5m), target
| render timechart
```

**最近的失败详情(排错入口)**

```kusto
calls
| where not(ok) and TimeGenerated > ago(2h)
| project TimeGenerated, dir, target, op, status, durationMs, tenantId, url, err, body
| order by TimeGenerated desc
| take 50
```

**只看拿不到响应的(超时/连接断)**

```kusto
calls
| where status == 0 and TimeGenerated > ago(24h)
| summarize count() by target, op, err
| order by count_ desc
```

**看某次失败的完整栈**

```kusto
calls
| where status == 0 and TimeGenerated > ago(2h)
| project TimeGenerated, target, op, durationMs, err, stack = tostring(e.stack)
| order by TimeGenerated desc
| take 10
```

## 本地日志文件

`pnpm dev`(Cloudflare 栈)默认把 Miniflare 运行时的输出再写一份到仓库根的
`.dev-cloudflare.log`,终端里看到的一个字节都不少。目的是让 agent 能直接查,
不必先请人手动 tee 一份。

覆盖的是 **Miniflare 这一路**:网关和各 doc type worker 的全部输出。`pnpm dev`
另外拉起的 Vite 子进程(各 web 前端、CAS admin 控制台)是 `stdio: "inherit"`,
只进终端,不进这个文件。

格式是 **JSONL**,一行一条记录 —— 不是终端那份的原样拷贝:

```jsonc
{"t":"2026-09-02T08:43:03.637Z","src":"worker","level":"log",
 "event":"http_call","dir":"in","target":"gateway","op":"listDocuments","status":200,"durationMs":1,"ok":true}
{"t":"2026-09-02T08:43:03.640Z","src":"miniflare",
 "msg":"[mf:info] GET /tenants/u1/docs/markdown/ 200 OK (5ms)"}
```

- `src` 分两路:`"worker"` 是 Worker 自己 `console.*` 打的(`http_call`、
  `doc_authentication`、`gateway_capability_issued` 都在这里),`"miniflare"`
  是 Miniflare 运行时那几行(请求行、启动就绪、内部告警)。
- 本身就是 JSON 的行**摊平**进信封,所以一条 `jq` 就能筛,不用先切前缀。
  载荷万一自带 `t`/`src`/`level`/`msg`/`json` 中任一个键,就嵌到 `.json` 下
  而不是摊平——摊平会用载荷的值顶掉信封的时间戳。
- 多行的异常栈被转义成一行,**行与记录始终一一对应**,grep 不会把一条栈
  切成几十条互不相干的"日志"。
- 每次 `pnpm dev` 从头写,文件里永远只有本次这一趟。写是同步的,所以跑着的
  时候另开一个终端 grep 就能看到最新的行。

```bash
jq 'select(.event == "http_call" and .ok == false)' .dev-cloudflare.log
jq -s 'map(select(.op == "lease").durationMs) | sort' .dev-cloudflare.log
jq 'select(.src == "worker" and .event == null)' .dev-cloudflare.log   # 非结构化的 worker 输出
```

`UNIDOCS_DEV_LOG=off` 关掉;给别的值就当路径用(相对仓库根,也接受绝对路径)。
默认文件名命中 `.gitignore` 的 `.dev-*.log` —— 本地日志带着网关签发的凭据元
数据,**永远不要提交**,换名字时必须让它继续落在那条规则里。

`pnpm dev unidocs-azure` 目前不落盘(它的服务是独立子进程,走的是另一条转发
路径),需要的话自己 `2>&1 | tee`。

## 成本

每次请求至少产出 3 条事件(入站 1 + 出站 N)。在此之前工作区一天只有几百行,
量级会跳一个数量级。30 天保留 + 按量计费,流量起来之后需要考虑对成功事件采样,
失败事件全量保留。
