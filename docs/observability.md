# 调用可观测性

每一次 HTTP 调用产出一条 `http_call` 事件到 stdout。Azure 上由 Container Apps
收进 Log Analytics 的 `ContainerAppConsoleLogs_CL`;Cloudflare 上进 `wrangler tail`。

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

## 成本

每次请求至少产出 3 条事件(入站 1 + 出站 N)。在此之前工作区一天只有几百行,
量级会跳一个数量级。30 天保留 + 按量计费,流量起来之后需要考虑对成功事件采样,
失败事件全量保留。
