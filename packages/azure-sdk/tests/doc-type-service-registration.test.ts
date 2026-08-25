/**
 * `registerSelfIfConfigured()` —— Task 4 评审指出的空白:`SELF_WORKER_URL`
 * 设置后真的把值写进 `doc_types` 表这条路径,以前没有任何测试跑过它
 * (`pnpm test:azure` 里本地栈从来不设这个变量,只走"跳过"分支;
 * `doc-type-service.test.ts` 只测 `startDocTypeService()`,不碰注册)。
 *
 * `registerSelfIfConfigured()` 是从 `runDocTypeService()` 里拆出来的独立
 * 函数(见 `doc-type-service.ts` 上的注释):不读 `process.env`、不装信号
 * 处理器,输入输出都是显式参数/Promise,可以直接对着这个文件已有的真实
 * Postgres(`containers.ts` 的 `globalSetup`)调用并查 `doc_types` 表验证。
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPool } from "../src/pool.js";
import { runMigrations } from "../src/migrate.js";
import { registerSelfIfConfigured } from "../src/doc-type-service.js";
import { DATABASE_URL } from "./containers.js";

const pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });

beforeEach(async () => {
  await runMigrations(pool);
  await pool.query("DELETE FROM doc_types");
});

afterEach(async () => {
  await pool.query("DELETE FROM doc_types");
});

test("SELF_WORKER_URL 设置时,把值 upsert 进 doc_types 表", async () => {
  await registerSelfIfConfigured({
    docType: "markdown",
    databaseUrl: DATABASE_URL,
    selfWorkerUrl: "https://unidocs-markdown.internal.example",
  });

  const { rows } = await pool.query("SELECT worker_url FROM doc_types WHERE doc_type = $1", [
    "markdown",
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0].worker_url).toBe("https://unidocs-markdown.internal.example");
});

test("SELF_WORKER_URL 未设置时,跳过注册,doc_types 表不受影响", async () => {
  await registerSelfIfConfigured({
    docType: "markdown",
    databaseUrl: DATABASE_URL,
    selfWorkerUrl: undefined,
  });

  const { rows } = await pool.query("SELECT worker_url FROM doc_types WHERE doc_type = $1", [
    "markdown",
  ]);
  expect(rows).toHaveLength(0);
});

// 一次注册表写入失败(这里用一个连不上的地址模拟 Postgres 抖动)不该让
// 调用方——也就是已经 listen 成功的服务——被这次失败拖垮。见
// `doc-type-service.ts` 上 `registerSelfIfConfigured()` 的注释:健康进程
// 不该因为注册表暂时写不进去而崩溃重启。
test("注册失败(连不上库)不抛错", async () => {
  const unreachableDatabaseUrl = "postgres://unidocs:unidocs@127.0.0.1:1/unidocs";
  await expect(
    registerSelfIfConfigured({
      docType: "markdown",
      databaseUrl: unreachableDatabaseUrl,
      selfWorkerUrl: "https://unreachable.internal.example",
    }),
  ).resolves.toBeUndefined();
});
