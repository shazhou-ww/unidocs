/**
 * 跨副本场景 —— 只有两个真实副本共享同一个 Postgres/Blob 才制造得出来的
 * 情况。行为测试套经代理后已经把每个请求打到不同副本；这里直连副本，
 * 制造**真正的同时性**。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { startAzureRuntime } from "./azure-runtime.mjs";

let runtime;

// No explicit `replicas` here, deliberately: this suite exists to guard
// `startAzureRuntime()`'s *default* replica count (`scripts/azure-runtime.mjs`),
// the same default `scripts/azure-behavior.test.mjs` runs its 49 behaviour
// assertions against. Passing `replicas: 2` here would only prove the
// function honours its own argument — the default could regress to 1 and
// every suite would stay green while the whole point of this branch (two
// real replicas sharing one Postgres) quietly reverted.
beforeAll(async () => {
  runtime = await startAzureRuntime();
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
}, 60_000);

function closeFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

// 这条闸的存在理由与 treespec 选 A 的理由相同：能只跑一边，就一定有人
// 只跑一边。配成单副本时这组场景必须响亮失败，而不是「跑过了但什么都
// 没验」。
test("the runtime really gave us at least two replicas", () => {
  expect(runtime.urls.markdownReplicas.length).toBeGreaterThanOrEqual(2);
});

async function createDoc(userId) {
  const res = await closeFetch(`${runtime.urls.gateway}/users/${userId}/docs/markdown/`, {
    method: "POST",
  });
  const body = await res.json();
  expect(body.success, JSON.stringify(body)).toBe(true);
  return body.docId;
}

function applyVia(replicaUrl, userId, docId, baseVersion, content) {
  return closeFetch(`${replicaUrl}/users/${userId}/${docId}/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": "unidocs-dev-token",
      "X-User-Id": userId,
      "X-Doc-Type": "markdown",
    },
    body: JSON.stringify({
      baseVersion,
      description: `set ${content}`,
      operations: [{ kind: "setContent", payload: { content } }],
    }),
  });
}

test("two replicas applying the same baseVersion: exactly one wins", async () => {
  const userId = "multi-1";
  const docId = await createDoc(userId);
  const [a, b] = runtime.urls.markdownReplicas;

  const [resA, resB] = await Promise.all([
    applyVia(a, userId, docId, 1, "from-a"),
    applyVia(b, userId, docId, 1, "from-b"),
  ]);
  const bodies = await Promise.all([resA.json(), resB.json()]);

  const winners = bodies.filter((x) => x.success === true);
  const losers = bodies.filter((x) => x.success !== true);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(winners[0].version).toBe(2);

  // 409 的 body 里必须是服务端当前版本，不是调用方那个过期的 baseVersion。
  // 客户端靠这个数字重新同步；照抄 baseVersion 会让它永远重试同一个陈旧版本。
  const loserStatus = resA.status === 409 ? resA.status : resB.status;
  expect(loserStatus).toBe(409);
  expect(losers[0].version).toBe(2);
});

test("a write on one replica is immediately visible on the other", async () => {
  const userId = "multi-2";
  const docId = await createDoc(userId);
  const [a, b] = runtime.urls.markdownReplicas;

  const applied = await applyVia(a, userId, docId, 1, "written-on-a");
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await closeFetch(`${b}/users/${userId}/${docId}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": "unidocs-dev-token",
      "X-User-Id": userId,
      "X-Doc-Type": "markdown",
    },
    body: JSON.stringify({ kind: "getContent" }),
  });
  // 副本 B 从没见过这个文档，只能从 Postgres/Blob 读 —— 这正是
  // BlobSnapshotCache.get() 的 ETag 一致读要保证的事。
  expect(await queried.json()).toMatchObject({
    success: true,
    version: 2,
    data: "written-on-a",
  });
});

test("alternating replicas advance the version with no holes", async () => {
  const userId = "multi-3";
  const docId = await createDoc(userId);
  const replicas = runtime.urls.markdownReplicas;

  for (let v = 1; v <= 6; v += 1) {
    const replica = replicas[(v - 1) % replicas.length];
    const res = await applyVia(replica, userId, docId, v, `step-${v}`);
    expect(await res.json()).toMatchObject({ success: true, version: v + 1 });
  }

  const history = await closeFetch(
    `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/history`,
  );
  const body = await history.json();
  expect(body.success).toBe(true);
  const versions = body.data.map((d) => d.version);
  expect(versions).toEqual([...versions].sort((x, y) => x - y));
  expect(new Set(versions).size).toBe(versions.length);
});

// Finding 1 (fix round 1): every scenario above sends its "which replica"
// traffic *directly* to a replica URL, bypassing the proxy entirely. None
// of them — nor `azure-behavior.test.mjs`, which never sees a proxy at all
// — actually proves that traffic arriving through the gateway (the only
// path a real client ever uses) gets spread across replicas rather than
// pinned to one. `markdown: proxy.url` is the one line of wiring that
// makes that true; this test is what would catch it if that line silently
// became `markdown: replicaUrls[0]` again. Counts are read before and
// after rather than assumed to start at zero, since earlier tests in this
// file already sent gateway-routed create/history requests against the
// same shared `runtime`.
test("gateway traffic actually reaches at least two replicas", async () => {
  const before = runtime.replicaHits();
  for (let i = 0; i < 8; i += 1) {
    await createDoc(`multi-hits-${i}`);
  }
  const after = runtime.replicaHits();
  const delta = after.map((count, i) => count - before[i]);
  const replicasHit = delta.filter((count) => count > 0).length;
  expect(replicasHit, `hit deltas per replica were ${JSON.stringify(delta)}`).toBeGreaterThanOrEqual(
    2,
  );
});
