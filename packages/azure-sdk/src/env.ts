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
