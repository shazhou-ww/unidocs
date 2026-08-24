import type { Pool } from "pg";

/** 缺失的必填环境变量必须在启动时就报出名字，而不是在第一个请求时才炸。 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * `pg-pool` 会在空闲连接出问题时（连接被掐、数据库重启）发 `error` 事件。
 * EventEmitter 把没有监听器的 `error` 当作未捕获异常处理 —— 没有这个
 * 监听器，一次例行的数据库抖动会带走整个进程，而不是只让持有那条连接的
 * 那一个请求失败。这不是可选的日志美化。
 */
export function attachPoolErrorLogger(pool: Pool, label: string): void {
  pool.on("error", (err) => {
    console.error(`${label}: pg pool error`, err);
  });
}

/**
 * Blob 存储的两种互斥配置模式，判定点在**进程启动**。
 *
 * 云上因订阅策略（deny storage accounts with shared key access）不能用
 * 连接字符串，只能用账户 URL + 托管标识；本地 Azurite 不支持托管标识，
 * 只能用连接字符串。两者同时给出是配置错误，静默优先某一个会让它潜伏
 * 到运行时。
 *
 * `AZURE_CLIENT_ID` 在账户 URL 模式下是必填的，不是可选优化：用
 * **用户分配**的托管标识时，`DefaultAzureCredential` 缺了它照样能构造
 * 成功，失败会推迟到第一次 Blob 操作 —— 那时容器已经通过健康检查并
 * 开始接流量。
 */
export interface BlobEnvConfig {
  blobConnectionString: string;
  blobAccountUrl: string;
}

export function resolveBlobConfig(env: NodeJS.ProcessEnv = process.env): BlobEnvConfig {
  const blobConnectionString = env.BLOB_CONNECTION_STRING ?? "";
  const blobAccountUrl = env.BLOB_ACCOUNT_URL ?? "";

  if (blobConnectionString && blobAccountUrl) {
    throw new Error(
      "BLOB_CONNECTION_STRING and BLOB_ACCOUNT_URL are mutually exclusive; set exactly one",
    );
  }
  if (!blobConnectionString && !blobAccountUrl) {
    throw new Error("Set either BLOB_CONNECTION_STRING (local/Azurite) or BLOB_ACCOUNT_URL (Azure)");
  }
  if (blobAccountUrl && !env.AZURE_CLIENT_ID) {
    throw new Error(
      "BLOB_ACCOUNT_URL requires AZURE_CLIENT_ID (the user-assigned managed identity's client id)",
    );
  }

  return { blobConnectionString, blobAccountUrl };
}
