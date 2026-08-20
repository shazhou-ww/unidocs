import { afterAll, beforeAll, expect, test } from "vitest";
import { startLocalRuntime } from "./local-runtime.mjs";

let runtime;
const GW = () => runtime.urls.gateway;

/**
 * Miniflare 的 unsafeDirectSockets 在 keep-alive 连接上偶发挂起,
 * 既有的 e2e 测试统一加 Connection: close,这里沿用。
 */
function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

async function createDoc(userId) {
  const res = await closeFetch(`${GW()}/users/${userId}/docs/markdown/`, {
    method: "POST",
  });
  const body = await res.json();
  expect(body.success, JSON.stringify(body)).toBe(true);
  return body.docId;
}

function applyOp(docId, baseVersion, content, userId) {
  return closeFetch(`${GW()}/users/${userId}/docs/markdown/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion,
      description: `set ${content}`,
      operations: [{ kind: "setContent", payload: { content } }],
    }),
  });
}

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: { gateway: 31787, markdown: 31788 },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

test("并发的两个同 baseVersion apply:恰好一个成功,另一个 409 且带当前版本", async () => {
  const docId = await createDoc("concurrent-user");

  const [a, b] = await Promise.all([
    applyOp(docId, 1, "A", "concurrent-user"),
    applyOp(docId, 1, "B", "concurrent-user"),
  ]);

  expect([a.status, b.status].sort()).toEqual([200, 409]);

  const conflict = a.status === 409 ? a : b;
  await expect(conflict.json()).resolves.toMatchObject({
    success: false,
    version: 2,
  });

  // 只有一条 delta 落地:创建时的 version 1,加上胜出的那个 version 2
  const history = await closeFetch(
    `${GW()}/users/concurrent-user/docs/markdown/${docId}/history`,
  );
  const { data } = await history.json();
  expect(data.map((entry) => entry.version)).toEqual([1, 2]);
});
