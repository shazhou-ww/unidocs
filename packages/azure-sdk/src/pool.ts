import { Pool } from "pg";
import { BlobServiceClient } from "@azure/storage-blob";

/**
 * Connection configuration for the local/Azure storage stack.
 *
 * `databaseUrl` is a standard `postgres://` connection string; `blobConnectionString`
 * is the Azure Storage (or Azurite) connection string consumed by
 * `BlobServiceClient.fromConnectionString`.
 */
export interface AzureConfig {
  databaseUrl: string;
  blobConnectionString: string;
}

/**
 * 连接池超时。四个值全部留空曾经是一个真实的挂起风险:锁等待期间连接
 * 被占住不放,池满之后没有任何自愈路径。三个会话级参数通过启动 `options`
 * 下发,保证每条借出的连接都带着,而不依赖服务端默认值。
 *
 * `lock_timeout` 刻意短于 `statement_timeout`:锁等待先失败,错误信息
 * 更能指出真实原因(在锁上等,而不是语句本身慢)。
 */
const TIMEOUT_DEFAULTS = {
  PG_CONNECTION_TIMEOUT_MS: 5_000,
  PG_LOCK_TIMEOUT_MS: 5_000,
  PG_STATEMENT_TIMEOUT_MS: 15_000,
  PG_IDLE_TX_TIMEOUT_MS: 10_000,
} as const;

function timeoutFromEnv(name: keyof typeof TIMEOUT_DEFAULTS): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return TIMEOUT_DEFAULTS[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Creates a `pg` connection pool for the Postgres-backed ports. Callers own the
 * pool's lifecycle (including calling `.end()`).
 *
 * Note: if `databaseUrl` already contains `?options=`, it will be overridden by
 * the timeout options passed here.
 */
export function createPool(cfg: AzureConfig): Pool {
  return new Pool({
    connectionString: cfg.databaseUrl,
    connectionTimeoutMillis: timeoutFromEnv("PG_CONNECTION_TIMEOUT_MS"),
    options: [
      `-c lock_timeout=${timeoutFromEnv("PG_LOCK_TIMEOUT_MS")}`,
      `-c statement_timeout=${timeoutFromEnv("PG_STATEMENT_TIMEOUT_MS")}`,
      `-c idle_in_transaction_session_timeout=${timeoutFromEnv("PG_IDLE_TX_TIMEOUT_MS")}`,
    ].join(" "),
  });
}

/**
 * Creates a Blob Storage client for the CAS / snapshot ports. Works against both
 * a real Azure Storage account and a local Azurite instance.
 */
export function createBlobService(cfg: AzureConfig): BlobServiceClient {
  return BlobServiceClient.fromConnectionString(cfg.blobConnectionString);
}
