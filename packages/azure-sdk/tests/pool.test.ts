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
