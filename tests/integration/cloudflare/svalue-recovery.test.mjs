import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

let runtime;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

function request(path, init = {}) {
  return fetch(`${runtime.urls.gateway}${path}`, {
    ...init,
    headers: {
      Connection: "close",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

/**
 * 响应丢失恢复:version 2 的 root-refs 写入被注入失败后,重试 apply
 * (写能力)先触发 pending 恢复,再报告版本已推进。断言恢复后的保留集
 * 与请求幂等记录:恰好一个当前 delta + 一个当前 snapshot,requestId
 * 恰好记录一次(无重复计数)。
 */
test("response-loss recovery re-settles idempotently without leaking roots", async () => {
  const ports = { gateway: 34787, markdown: 34788, cas: 34791, admin: 34792, mockOidc: 34793 };
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports,
    casFault: true,
  });
  const userId = "recovery-user";
  const stackId = runtime.stackFixture.stackId;

  const create = await request(`/tenants/${userId}/docs/markdown/`, { method: "POST" });
  const created = await create.json();
  expect(create.ok, JSON.stringify(created)).toBe(true);
  const { docId } = created;

  const applyBody = {
    baseVersion: 1,
    description: "set content",
    opId: "recovery-set-1",
    operations: [{ kind: "setContent", payload: { content: "# Durable" } }],
  };
  const apply = await request(`/tenants/${userId}/docs/markdown/${docId}/apply`, {
    method: "POST",
    body: JSON.stringify(applyBody),
  });
  const applied = await apply.json();
  expect(apply.status, JSON.stringify(applied)).toBe(502);
  expect(applied.success).toBe(false);
  expect(applied.error).toContain("CAS updateRootRefs failed");
  expect(applied.version).toBe(1);

  // 故障只注入一次:version 1 已提交,version 2 从未到达真实 CAS。
  const identity = await runtime.storage.sessionIdentity("markdown", docId, userId);
  const { sessionId } = identity;
  let requestIds = await runtime.storage.middlewareRootRefRequestIds(stackId, userId);
  expect(requestIds).toEqual([`session:${sessionId}:version:1:roots`]);

  // 重试 apply:恢复 pending(version 2 落地),再因 baseVersion 落后返回 409。
  const retry = await request(`/tenants/${userId}/docs/markdown/${docId}/apply`, {
    method: "POST",
    body: JSON.stringify(applyBody),
  });
  const retried = await retry.json();
  expect(retry.status, JSON.stringify(retried)).toBe(409);
  expect(retried).toMatchObject({ success: false, version: 2 });

  const query = await request(`/tenants/${userId}/docs/markdown/${docId}/query`, {
    method: "POST",
    body: JSON.stringify({ kind: "getContent" }),
  });
  const result = await query.json();
  expect(query.ok, JSON.stringify(result)).toBe(true);
  expect(result).toMatchObject({ success: true, data: "# Durable", version: 2 });

  // 恢复后的保留集:一个当前 delta(v2)+ 一个当前 snapshot(v1),各计 1。
  const retained = await runtime.storage.middlewareRetainedRoots(stackId, userId);
  expect(retained).toHaveLength(2);
  expect(retained.every((row) => row.count === 1)).toBe(true);

  const snapshots = await runtime.storage.snapshotIndex("markdown", docId);
  expect(snapshots.map((row) => row.version)).toEqual([1]);
  for (const row of snapshots) {
    expect(retained.map((entry) => entry.hash)).toContain(row.hash);
  }

  // version 2 的 root-refs 请求在恢复路径上恰好记录一次(无重复计数)。
  requestIds = await runtime.storage.middlewareRootRefRequestIds(stackId, userId);
  expect(requestIds.filter((id) => id.endsWith(":version:2:roots"))).toEqual([
    `session:${sessionId}:version:2:roots`,
  ]);
  expect(requestIds.filter((id) => id.endsWith(":version:1:roots"))).toHaveLength(1);
}, 60_000);

test("committed CAS roots survive response loss and restart without becoming an opId receipt", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-pending-restart-"));
  const ports = { gateway: 34787, markdown: 34788, cas: 34791, admin: 34792, mockOidc: 34793 };
  try {
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, persistPath, casFault: "after-commit" });
    const userId = "pending-restart-user";
    const { stackFixture, capabilityFixture } = runtime;
    const create = await request(`/tenants/${userId}/docs/markdown/`, { method: "POST" });
    const created = await create.json();
    expect(create.status, JSON.stringify(created)).toBe(200);
    const { docId } = created;
    const { sessionId } = await runtime.storage.sessionIdentity("markdown", docId, userId);
    const path = `/tenants/${userId}/docs/markdown/${docId}`;
    const applyBody = {
      baseVersion: 1,
      description: "pending before restart",
      opId: "pending-restart-op",
      operations: [{ kind: "setContent", payload: { content: "# Recovered original" } }],
    };
    const apply = await request(`${path}/apply`, { method: "POST", body: JSON.stringify(applyBody) });
    expect(apply.status, await apply.clone().text()).toBe(502);
    expect(await apply.json()).toMatchObject({ success: false, version: 1 });
    const rootRequestId = `session:${sessionId}:version:2:roots`;
    expect(await runtime.storage.middlewareRootRefRequestIds(stackFixture.stackId, userId)).toContain(rootRequestId);
    const retainedBefore = await runtime.storage.middlewareRetainedRoots(stackFixture.stackId, userId);
    expect(retainedBefore).toHaveLength(2);
    expect(retainedBefore.every(row => row.count === 1)).toBe(true);

    await runtime.dispose();
    runtime = undefined;
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, persistPath, stackFixture, capabilityFixture });
    const retry = await request(`${path}/apply`, { method: "POST", body: JSON.stringify(applyBody) });
    expect(retry.status, await retry.clone().text()).toBe(409);
    expect(await retry.json()).toMatchObject({ success: false, version: 2 });
    const query = await request(`${path}/query`, { method: "POST", body: JSON.stringify({ kind: "getContent" }) });
    expect(await query.json()).toMatchObject({ success: true, data: "# Recovered original", version: 2 });
    const repeated = await request(`${path}/apply`, { method: "POST", body: JSON.stringify(applyBody) });
    expect(repeated.status).toBe(409);
    await repeated.arrayBuffer();
    const requestIds = await runtime.storage.middlewareRootRefRequestIds(stackFixture.stackId, userId);
    expect(requestIds.filter(requestId => requestId === rootRequestId)).toHaveLength(1);
    const retainedAfter = await runtime.storage.middlewareRetainedRoots(stackFixture.stackId, userId);
    expect(retainedAfter).toHaveLength(retainedBefore.length);
    expect(retainedAfter).toEqual(expect.arrayContaining(retainedBefore));
  } finally {
    await runtime?.dispose();
    runtime = undefined;
    await rm(persistPath, { recursive: true, force: true });
  }
}, 120_000);
