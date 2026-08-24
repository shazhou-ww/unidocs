/**
 * 轮询反向代理:本地扮演 ACA ingress。它只需要一条性质 —— 连续请求会
 * 轮流落到不同后端 —— 就足以把现有全部行为断言升级成多副本断言。
 */
import { afterEach, expect, test } from "vitest";
import { createServer } from "node:http";
import { startReplicaProxy } from "../../../scripts/replica-proxy.mjs";

const closers = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

function startEcho(label) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            replica: label,
            method: req.method,
            url: req.url,
            body: Buffer.concat(chunks).toString("utf8"),
            token: req.headers["x-internal-token"] ?? null,
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      closers.push(() => new Promise((r) => server.close(r)));
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test("round-robins across targets and preserves method, path, body and headers", async () => {
  const a = await startEcho("a");
  const b = await startEcho("b");
  const proxy = await startReplicaProxy({ port: 0, targets: [a, b] });
  closers.push(proxy.close);

  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`${proxy.url}/users/u1/markdown/d1/apply`, {
      method: "POST",
      headers: { Connection: "close", "X-Internal-Token": "tok" },
      body: `payload-${i}`,
    });
    const json = await res.json();
    expect(json.method).toBe("POST");
    expect(json.url).toBe("/users/u1/markdown/d1/apply");
    expect(json.body).toBe(`payload-${i}`);
    expect(json.token).toBe("tok");
    seen.push(json.replica);
  }
  expect(seen).toEqual(["a", "b", "a", "b"]);
  expect(proxy.hits()).toEqual([2, 2]);
});

// 一个副本挂了不能让代理静默把全部流量倒给另一个 —— 那会让「多副本」
// 悄悄退化成单副本，正是本轮要消灭的那类假绿。
test("an unreachable target surfaces as a 502, not as silent failover", async () => {
  const a = await startEcho("a");
  const proxy = await startReplicaProxy({ port: 0, targets: [a, "http://127.0.0.1:1"] });
  closers.push(proxy.close);

  const first = await fetch(`${proxy.url}/ping`, { headers: { Connection: "close" } });
  expect(first.status).toBe(200);
  const second = await fetch(`${proxy.url}/ping`, { headers: { Connection: "close" } });
  expect(second.status).toBe(502);
});
