import { Pool } from "pg";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * Connection configuration for the local/Azure storage stack.
 *
 * `databaseUrl` is a standard `postgres://` connection string.
 *
 * The two blob fields are mutually exclusive and pick the auth mode
 * (`createBlobService()` / `resolveBlobConfig()`):
 * - `blobConnectionString` — **local only** (Azurite / docker-compose), consumed by
 *   `BlobServiceClient.fromConnectionString`. In the cloud this is always empty:
 *   the subscription policy disables shared-key access on the storage account.
 * - `blobAccountUrl` — the cloud path: the account endpoint plus the user-assigned
 *   managed identity (which also needs `AZURE_CLIENT_ID` in the environment for
 *   `DefaultAzureCredential` to pick the right identity).
 */
export interface AzureConfig {
  databaseUrl: string;
  /** 本地/Azurite 模式。与 `blobAccountUrl` 互斥，见 `resolveBlobConfig()`。 */
  blobConnectionString?: string;
  /** 云上模式：账户端点 URL，配合用户分配的托管标识。 */
  blobAccountUrl?: string;
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

/**
 * 每副本的连接池上限。node-postgres 的默认值是 10，而云上的形态是
 * `Standard_B1ms` / Burstable 的 Flexible Server —— 该规格 `max_connections`
 * 约 35，常驻副本 5 个（markdown 2 + docx 2 + gateway 1）。10 × 5 = 50 已经
 * 越界，`maxReplicas` 满载时 13 × 10 = 130。
 *
 * 这个越界**不会**被冒烟测试发现：冒烟是串行的，每副本只开 1–2 条连接。
 * 它只在并发上来时以 `FATAL: sorry, too many clients already` 出现 —— 也就是
 * 设计 §4.2 把 `minReplicas: 2` 的理由写成"让多副本并发正确性在生产上持续
 * 被验证"的那个场景。
 *
 * 5 × 5 = 25 < 35，留出余量给迁移 Job 与人工 psql 会话。
 */
const PG_POOL_MAX_DEFAULT = 5;

/**
 * 一个打错的环境变量必须响亮失败，而不是静默退回默认值 —— 这类配置只在
 * 事故当天才会被验证。`PG_POOL_MAX` 与四个超时共用这套校验。
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

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
    max: positiveIntFromEnv("PG_POOL_MAX", PG_POOL_MAX_DEFAULT),
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
  if (cfg.blobConnectionString) {
    return BlobServiceClient.fromConnectionString(cfg.blobConnectionString);
  }
  if (cfg.blobAccountUrl) {
    return new BlobServiceClient(cfg.blobAccountUrl, new DefaultAzureCredential());
  }
  throw new Error("neither blobConnectionString nor blobAccountUrl is set");
}
