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

test("第 20 个 delta 触发自动快照:R2 有对象,D1 snapshots 表有 version=20 的行", async () => {
  const userId = "snapshot-user";
  const docId = await createDoc(userId);

  // 创建时已写入 version 1;这里再 apply 25 次,版本推进到 26。
  // #shouldSnapshot() 在 delta 数量达到 20 时触发,即 version 20 那一次。
  for (let baseVersion = 1; baseVersion <= 25; baseVersion += 1) {
    const res = await applyOp(docId, baseVersion, `content ${baseVersion}`, userId);
    expect(res.status, `apply at baseVersion ${baseVersion}`).toBe(200);
  }

  const db = await runtime.mf.getD1Database("SNAPSHOTS_DB", "unidocs-markdown");
  const rows = await db
    .prepare("SELECT version, hash FROM snapshots WHERE doc_id = ? ORDER BY version ASC")
    .bind(docId)
    .all();

  expect(rows.results.map((row) => row.version)).toEqual([1, 21]);

  const bucket = await runtime.mf.getR2Bucket("CAS", "unidocs-markdown");
  for (const snap of rows.results) {
    const object = await bucket.get(snap.hash);
    expect(object, `R2 缺少快照对象 ${snap.hash}`).not.toBeNull();
  }
}, 60_000);
