import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalRuntime } from "./local-runtime.mjs";

const PORTS = { gateway: 31790, markdown: 31791 };

function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

test("优雅重启后从持久化存储恢复,版本与内容保持不变", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-restart-"));
  const userId = "restart-user";

  let runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: PORTS,
    persistPath,
  });

  let docId;
  try {
    const create = await closeFetch(
      `${runtime.urls.gateway}/users/${userId}/docs/markdown/`,
      { method: "POST" },
    );
    ({ docId } = await create.json());

    // 21 次 apply 让版本走到 22。#saveSnapshotKV() 在每次 apply 后都无条件刷新 KV 快照,
    // 因此优雅重启后 KV 快照的 version 等于当前版本,不会有任何 delta 可重放。
    // 这个测试验证的是持久化状态的完整性:优雅重启后版本与内容原样恢复。
    for (let baseVersion = 1; baseVersion <= 21; baseVersion += 1) {
      const res = await closeFetch(
        `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseVersion,
            description: `set ${baseVersion}`,
            operations: [
              { kind: "setContent", payload: { content: `# v${baseVersion}` } },
            ],
          }),
        },
      );
      expect(res.status, `apply at baseVersion ${baseVersion}`).toBe(200);
    }
  } finally {
    await runtime.dispose();
  }

  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: PORTS,
    persistPath,
  });

  try {
    const query = await closeFetch(
      `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "getContent" }),
      },
    );
    const body = await query.json();
    expect(body.success, JSON.stringify(body)).toBe(true);
    expect(body.version).toBe(22);
    expect(body.data).toBe("# v21");
  } finally {
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  }
}, 180_000);

test("rollback 到阈值快照之后的版本:从 R2 快照加载并 replay 其后的 delta", async () => {
  const userId = "replay-user";
  const runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: PORTS,
  });

  try {
    const create = await closeFetch(
      `${runtime.urls.gateway}/users/${userId}/docs/markdown/`,
      { method: "POST" },
    );
    const { docId } = await create.json();

    // apply 22 次,版本推进到 23;R2/D1 的阈值快照落在 version 21。
    for (let baseVersion = 1; baseVersion <= 22; baseVersion += 1) {
      const res = await closeFetch(
        `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseVersion,
            description: `set ${baseVersion}`,
            operations: [
              { kind: "setContent", payload: { content: `# v${baseVersion}` } },
            ],
          }),
        },
      );
      expect(res.status, `apply at baseVersion ${baseVersion}`).toBe(200);
    }

    // 先确认 R2 快照真的存在,否则 rollback 会退化成 init + 全量 replay
    const db = await runtime.mf.getD1Database("SNAPSHOTS_DB", "unidocs-markdown");
    const snapshots = await db
      .prepare("SELECT version FROM snapshots WHERE doc_id = ? ORDER BY version ASC")
      .bind(docId)
      .all();
    expect(snapshots.results.map((row) => row.version)).toEqual([1, 21]);

    // 回滚到 22:最近的快照是 21,因此必须加载它并 replay version 22 这一条 delta
    const rollback = await closeFetch(
      `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/rollback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 22 }),
      },
    );
    await expect(rollback.json()).resolves.toMatchObject({
      success: true,
      version: 24,
    });

    const query = await closeFetch(
      `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "getContent" }),
      },
    );
    const body = await query.json();
    expect(body.success, JSON.stringify(body)).toBe(true);
    expect(body.data).toBe("# v21");
    expect(body.version).toBe(24);
  } finally {
    await runtime.dispose();
  }
}, 180_000);
