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

test("初始快照 version 1 + 阈值快照 version 21:两次快照的 R2 对象都存在,D1 记录完整", async () => {
  const userId = "snapshot-user";
  const docId = await createDoc(userId);

  // POST /_internal/create 时 version 1 的 delta 被立即快照到 R2 + D1。
  // 之后 apply 25 次,版本推进到 26。#shouldSnapshot() 检查 version > lastSnapshotVersion 的 delta 数:
  // 由于 lastSnapshotVersion = 1,当 version 21 被创建时已累积 20 个新 delta,达到阈值 DELTA_THRESHOLD = 20,触发第二次快照。
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

test("rollback 到旧版本:内容回退,版本向前推进,历史保留全部 delta", async () => {
  const userId = "rollback-user";
  const docId = await createDoc(userId);

  expect((await applyOp(docId, 1, "A", userId)).status).toBe(200); // v2
  expect((await applyOp(docId, 2, "B", userId)).status).toBe(200); // v3

  const rollback = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}/rollback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 2 }),
    },
  );
  await expect(rollback.json()).resolves.toMatchObject({
    success: true,
    version: 4,
  });

  const query = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getContent" }),
    },
  );
  const body = await query.json();
  expect(body.data).toBe("A");
  expect(body.version).toBe(4);

  // rollback 是一条合成 delta,不删除任何历史
  const history = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}/history`,
  );
  const { data } = await history.json();
  expect(data.map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
  expect(data[3].description).toBe("Rollback to version 2");
  expect(data[3].operations).toEqual([]);
});

test("clone 走 snapshot hash + init_from_hash:新文档内容相同,版本从 1 开始", async () => {
  const userId = "clone-user";
  const sourceId = await createDoc(userId);
  expect((await applyOp(sourceId, 1, "cloned content", userId)).status).toBe(200);

  const snapshot = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${sourceId}/snapshot`,
  );
  const snap = await snapshot.json();
  expect(snap.success, JSON.stringify(snap)).toBe(true);
  expect(snap.hash).toEqual(expect.any(String));

  const targetId = `${sourceId}-clone`;
  const adopt = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${targetId}/init_from_hash`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: snap.hash, sourceVersion: snap.version }),
    },
  );
  await expect(adopt.json()).resolves.toMatchObject({
    success: true,
    docId: targetId,
  });

  const query = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${targetId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getContent" }),
    },
  );
  const body = await query.json();
  expect(body.data).toBe("cloned content");
  expect(body.version).toBe(1);
});

test("export 的字节导入成新文档后内容一致", async () => {
  const userId = "export-user";
  const docId = await createDoc(userId);
  expect((await applyOp(docId, 1, "# Round Trip", userId)).status).toBe(200);

  const exported = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}/export`,
  );
  expect(exported.ok).toBe(true);
  const bytes = new Uint8Array(await exported.arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);

  const form = new FormData();
  form.append("file", new File([bytes], "exported.md", { type: "text/markdown" }));

  const imported = await closeFetch(`${GW()}/users/${userId}/docs/markdown/`, {
    method: "POST",
    headers: { "X-Doc-Id": `${docId}-imported` },
    body: form,
  });
  const importedBody = await imported.json();
  expect(importedBody.success, JSON.stringify(importedBody)).toBe(true);

  const query = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}-imported/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getContent" }),
    },
  );
  const body = await query.json();
  expect(body.data).toBe("# Round Trip");
});
