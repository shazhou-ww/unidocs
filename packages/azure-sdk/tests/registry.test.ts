/**
 * `PgDocTypeRegistry` 的契约。三条不变量:
 *   1. upsert 幂等 —— N 个副本写同一行同一值,不能报错也不能产生多行
 *   2. TTL 内不打库 —— 网关每个请求都要 resolve,不能每次往返
 *   3. 查库失败时用过期旧值 —— 地址极少变,Postgres 抖动不该让网关停摆
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createPool } from "../src/pool.js";
import { runMigrations } from "../src/migrate.js";
import { PgDocTypeRegistry } from "../src/registry-pg.js";
import { DATABASE_URL } from "./containers.js";

const pool = createPool({ databaseUrl: DATABASE_URL });

beforeEach(async () => {
  await runMigrations(pool);
  await pool.query("DELETE FROM doc_types");
});

afterEach(async () => {
  await pool.query("DELETE FROM doc_types");
});

describe("PgDocTypeRegistry", () => {
  test("register 之后 resolve 拿得到", async () => {
    const r = new PgDocTypeRegistry(pool);
    await r.register("markdown", "https://md.internal.example");
    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
  });

  test("未注册的 doc type 返回 null", async () => {
    const r = new PgDocTypeRegistry(pool);
    expect(await r.resolve("nope")).toBeNull();
  });

  // N 个副本共用同一 FQDN,会重复写同一行同一值。
  test("重复 register 同一值:幂等,只有一行", async () => {
    const r = new PgDocTypeRegistry(pool);
    await r.register("markdown", "https://md.internal.example");
    await r.register("markdown", "https://md.internal.example");
    await r.register("markdown", "https://md.internal.example");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM doc_types WHERE doc_type = $1", ["markdown"]);
    expect(rows[0].n).toBe(1);
  });

  test("register 新值:覆盖旧值", async () => {
    const r = new PgDocTypeRegistry(pool);
    await r.register("markdown", "https://old.internal.example");
    await r.register("markdown", "https://new.internal.example");
    expect(await r.resolve("markdown")).toBe("https://new.internal.example");
  });

  // 网关每个请求都 resolve,不能每次往返数据库。
  test("TTL 内不再打库", async () => {
    let queries = 0;
    const counting = {
      query: (text: string, values?: unknown[]) => { queries++; return pool.query(text, values); },
    };
    await pool.query(
      "INSERT INTO doc_types (doc_type, worker_url, updated_at) VALUES ($1, $2, $3)",
      ["markdown", "https://md.internal.example", Date.now()],
    );
    let clock = 1_000;
    const r = new PgDocTypeRegistry(counting, { ttlMs: 30_000, now: () => clock });

    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
    expect(queries).toBe(1);
    clock += 29_000;
    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
    expect(queries).toBe(1);          // 仍在 TTL 内,没有第二次查询
    clock += 2_000;
    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
    expect(queries).toBe(2);          // 过期了,重新查
  });

  // 地址极少变,Postgres 短暂不可用时网关仍应能转发。
  test("查库失败时返回过期的旧值", async () => {
    let failing = false;
    const flaky = {
      query: (text: string, values?: unknown[]) => {
        if (failing) return Promise.reject(new Error("connection terminated"));
        return pool.query(text, values);
      },
    };
    await pool.query(
      "INSERT INTO doc_types (doc_type, worker_url, updated_at) VALUES ($1, $2, $3)",
      ["markdown", "https://md.internal.example", Date.now()],
    );
    let clock = 1_000;
    const r = new PgDocTypeRegistry(flaky, { ttlMs: 30_000, now: () => clock });

    expect(await r.resolve("markdown")).toBe("https://md.internal.example");
    failing = true;
    clock += 60_000;                  // 缓存已过期
    expect(await r.resolve("markdown")).toBe("https://md.internal.example");  // 仍拿到旧值
  });

  // 没有旧值可用时不能假装成功,必须把错误抛出去。
  test("查库失败且没有缓存过的值:抛错", async () => {
    const broken = { query: () => Promise.reject(new Error("connection terminated")) };
    const r = new PgDocTypeRegistry(broken);
    await expect(r.resolve("markdown")).rejects.toThrow(/connection terminated/);
  });
});
