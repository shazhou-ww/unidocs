/**
 * 轮询反向代理 —— 本地扮演 Azure Container Apps 的 ingress。
 *
 * 它属于测试脚手架,不属于应用代码:生产环境里分流是平台的事,`azure-gateway`
 * 和 `azure-markdown` 都不该知道副本的存在。
 *
 * 保真度是刻意有限的:没有健康检查、没有会话粘性、没有重试。本轮只需要
 * 「连续请求会落到不同副本」这一条性质。特别是**不做故障转移** ——
 * 一个副本连不上就返回 502,因为静默把流量全倒给另一个副本会让多副本
 * 悄悄退化成单副本,那正是本轮要消灭的那类假绿。
 */
import { createServer, request as httpRequest } from "node:http";

export function startReplicaProxy({ host = "127.0.0.1", port, targets }) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("startReplicaProxy requires a non-empty targets array");
  }
  const parsed = targets.map((t) => new URL(t));
  const hits = new Array(parsed.length).fill(0);
  let next = 0;

  const server = createServer((req, res) => {
    const index = next;
    next = (next + 1) % parsed.length;
    hits[index] += 1;
    const target = parsed[index];

    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({
          error: `replica-proxy: replica ${index + 1} (${target.origin}) unreachable: ${err.message}`,
        }),
      );
    });
    req.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}`,
        hits: () => [...hits],
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
