/**
 * `createPool()` 的超时配置。前三个是**会话级** Postgres 参数,只能通过
 * 启动参数 `options` 下发,保证每条从池里借出的连接都带着它们,而不依赖
 * 服务端默认值;`connectionTimeoutMillis` 是 `pg` 客户端侧的。
 */
import { afterEach, describe, expect, test } from "vitest";
import { createPool } from "../src/pool.js";
import { DATABASE_URL, BLOB_CONNECTION_STRING } from "./containers.js";

const CFG = { databaseUrl: DATABASE_URL, blobConnectionString: BLOB_CONNECTION_STRING };
const ENV_KEYS = [
  "PG_POOL_MAX",
  "PG_CONNECTION_TIMEOUT_MS",
  "PG_LOCK_TIMEOUT_MS",
  "PG_STATEMENT_TIMEOUT_MS",
  "PG_IDLE_TX_TIMEOUT_MS",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("createPool timeouts", () => {
  test("defaults are set on the pool options", async () => {
    const pool = createPool(CFG);
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(5_000);
      expect(pool.options.options).toContain("-c lock_timeout=5000");
      expect(pool.options.options).toContain("-c statement_timeout=15000");
      expect(pool.options.options).toContain("-c idle_in_transaction_session_timeout=10000");
    } finally {
      await pool.end();
    }
  });

  test("each env var overrides its own default", async () => {
    process.env.PG_CONNECTION_TIMEOUT_MS = "1234";
    process.env.PG_LOCK_TIMEOUT_MS = "2345";
    process.env.PG_STATEMENT_TIMEOUT_MS = "3456";
    process.env.PG_IDLE_TX_TIMEOUT_MS = "4567";
    const pool = createPool(CFG);
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(1234);
      expect(pool.options.options).toContain("-c lock_timeout=2345");
      expect(pool.options.options).toContain("-c statement_timeout=3456");
      expect(pool.options.options).toContain("-c idle_in_transaction_session_timeout=4567");
    } finally {
      await pool.end();
    }
  });

  // 一个打错的环境变量必须响亮失败。静默退回默认值意味着运维以为自己
  // 调高了超时、实际没有,而这类配置只在事故当天才会被验证。
  test("a non-positive-integer env value throws, naming the variable", () => {
    process.env.PG_STATEMENT_TIMEOUT_MS = "15s";
    expect(() => createPool(CFG)).toThrow(/PG_STATEMENT_TIMEOUT_MS/);
  });

  // 上面三条只证明「配置传进去了」。这条证明它**在真实会话里生效**:
  // 参数是通过启动 options 下发的,所以任何一条借出的连接都能读回来。
  test("the session actually carries the settings", async () => {
    const pool = createPool(CFG);
    try {
      const { rows } = await pool.query(
        "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS stmt, current_setting('idle_in_transaction_session_timeout') AS idle",
      );
      expect(rows[0]).toEqual({ lock: "5s", stmt: "15s", idle: "10s" });
    } finally {
      await pool.end();
    }
  });
});

/**
 * 池上限。node-postgres 的默认 10 在云上会打爆 Postgres:`Standard_B1ms` /
 * Burstable 的 `max_connections` 约 35,常驻副本 5 个 → 50 条。串行的冒烟
 * 测试每副本只开 1–2 条连接,发现不了它;并发一上来就是
 * `FATAL: sorry, too many clients already`。
 */
describe("createPool max", () => {
  test("默认 5 —— 5 副本 × 5 = 25,低于 B1ms 的 ~35", async () => {
    const pool = createPool(CFG);
    try {
      expect(pool.options.max).toBe(5);
    } finally {
      await pool.end();
    }
  });

  test("PG_POOL_MAX 覆盖默认值", async () => {
    process.env.PG_POOL_MAX = "3";
    const pool = createPool(CFG);
    try {
      expect(pool.options.max).toBe(3);
    } finally {
      await pool.end();
    }
  });

  // 与四个超时同样的校验风格:打错必须响亮失败,不能静默退回默认值。
  test("非正整数响亮失败,点名变量", () => {
    process.env.PG_POOL_MAX = "many";
    expect(() => createPool(CFG)).toThrow(/PG_POOL_MAX/);
    process.env.PG_POOL_MAX = "0";
    expect(() => createPool(CFG)).toThrow(/PG_POOL_MAX/);
  });

  // 上面三条只证明配置传进去了。这条证明它**约束了真实的并发连接数**:
  // 借出 max+1 条连接时,最后一条必须等待,而不是新开一条打到服务端。
  test("池真的不会同时借出超过 max 条连接", async () => {
    process.env.PG_POOL_MAX = "2";
    const pool = createPool(CFG);
    try {
      const a = await pool.connect();
      const b = await pool.connect();
      expect(pool.totalCount).toBe(2);

      let thirdAcquired = false;
      const third = pool.connect().then((client) => {
        thirdAcquired = true;
        return client;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(thirdAcquired).toBe(false);
      expect(pool.totalCount).toBe(2);

      a.release();
      const c = await third;
      expect(thirdAcquired).toBe(true);
      expect(pool.totalCount).toBe(2);
      b.release();
      c.release();
    } finally {
      await pool.end();
    }
  });
});
