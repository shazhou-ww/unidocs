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

test("重启运行时后从快照 + replay 恢复,版本与内容一致", async () => {
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

    // 21 次 apply 让版本走到 22,跨过 version 21 的快照点,
    // 恢复时才会真正经历"加载快照 + replay 其后的 delta"。
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
