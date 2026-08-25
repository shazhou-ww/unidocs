/**
 * `makeResolveWorkerUrl()` 的两级解析:命中注册表用注册表的值,未命中
 * 回落到 `{TYPE}_WORKER_URL` 环境变量。这是 Task 4 评审指出的第二处
 * 空白——本包此前没有任何测试文件,`main.ts` 里这段逻辑从未被跑过。
 *
 * 用一个纯内存的 `Queryable` 假体喂给真实的 `PgDocTypeRegistry`(它是
 * 带私有字段的类,没法用结构类型的字面量伪造实例,必须是真实例):这个
 * 包没有 docker-compose/Postgres 测试基础设施,`makeResolveWorkerUrl`
 * 本身也只关心"注册表命中还是没命中",不需要真实数据库来验证这一点。
 * `PgDocTypeRegistry` 自身的 SQL 契约已经在 azure-sdk 的
 * `registry.test.ts` 里对着真实 Postgres 验证过。
 *
 * `makeResolveWorkerUrl` 特意拆到独立的 `resolve-worker-url.ts` 而不是
 * 直接从 `main.ts` 导入:`main.ts` 顶层无条件跑 `main().catch(...)`,
 * 导入它会真的尝试连 Postgres、起 HTTP server、装信号处理器。
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { PgDocTypeRegistry, type Queryable } from "@unidocs/azure-sdk";
import { makeResolveWorkerUrl } from "../src/resolve-worker-url.js";

function makeFakeDocTypesTable(): Queryable {
  const rows = new Map<string, string>();
  return {
    async query(text: string, values: unknown[] = []) {
      if (text.includes("INSERT INTO doc_types")) {
        const [docType, workerUrl] = values as [string, string];
        rows.set(docType, workerUrl);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SELECT worker_url FROM doc_types")) {
        const [docType] = values as [string];
        const url = rows.get(docType);
        return url ? { rows: [{ worker_url: url }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected query in fake Queryable: ${text}`);
    },
  };
}

const ENV_KEY = "MARKDOWN_WORKER_URL";
const originalEnv = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

test("注册表命中:返回注册表里的值,忽略环境变量", async () => {
  const registry = new PgDocTypeRegistry(makeFakeDocTypesTable());
  await registry.register("markdown", "https://from-registry.internal.example");
  process.env[ENV_KEY] = "https://from-env.internal.example";

  const resolve = makeResolveWorkerUrl(registry);
  expect(await resolve("markdown")).toBe("https://from-registry.internal.example");
});

test("注册表未命中:回落到 {TYPE}_WORKER_URL 环境变量", async () => {
  const registry = new PgDocTypeRegistry(makeFakeDocTypesTable());
  process.env[ENV_KEY] = "https://from-env.internal.example";

  const resolve = makeResolveWorkerUrl(registry);
  expect(await resolve("markdown")).toBe("https://from-env.internal.example");
});

test("注册表未命中且环境变量也没设:返回 null", async () => {
  const registry = new PgDocTypeRegistry(makeFakeDocTypesTable());

  const resolve = makeResolveWorkerUrl(registry);
  expect(await resolve("markdown")).toBeNull();
});
