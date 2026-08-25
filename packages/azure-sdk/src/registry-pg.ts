import type { Queryable } from "./ports-pg.js";

/**
 * doc type → 内部 worker URL 的注册表,取代网关对 `{TYPE}_WORKER_URL`
 * 环境变量的依赖。写入方是 doc type 服务自己(启动时 upsert),读取方是
 * 网关。这是 Cloudflare 侧 KV 注册表(`cloudflare-gateway/src/worker.ts`
 * 查 `docType:{type}`)在 Azure 上的对应物。
 *
 * 缓存策略是本类的内部实现:调用方只看到 `resolve()`。将来若真需要秒级
 * 一致,可在此加 Postgres 的 LISTEN/NOTIFY —— 但注意 NOTIFY 不持久也不
 * 重放,断连期间的通知永久丢失,所以它只能叠加在 TTL 之上,不能替代 TTL。
 */
export interface PgDocTypeRegistryOptions {
  /** 缓存有效期,默认 30 秒。 */
  ttlMs?: number;
  /** 注入时钟,仅供测试。 */
  now?: () => number;
}

interface CacheEntry {
  url: string | null;
  at: number;
}

const DEFAULT_TTL_MS = 30_000;

export class PgDocTypeRegistry {
  #q: Queryable;
  #ttlMs: number;
  #now: () => number;
  #cache = new Map<string, CacheEntry>();

  constructor(q: Queryable, options: PgDocTypeRegistryOptions = {}) {
    this.#q = q;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 只 upsert,不提供删除。一个 doc type 的 N 个副本共用同一个 ingress
   * FQDN,写的是同一行同一值 —— 天然幂等,不需要协调。
   *
   * 刻意不做 `unregister()`:关停时注销会让一次滚动更新在中间时刻把整个
   * doc type 从表里抹掉,而此时其它副本仍在正常服务。下线一个 doc type
   * 是运维显式删行,不是进程退出的副作用。
   */
  async register(docType: string, workerUrl: string): Promise<void> {
    await this.#q.query(
      `INSERT INTO doc_types (doc_type, worker_url, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (doc_type) DO UPDATE
         SET worker_url = EXCLUDED.worker_url,
             updated_at = EXCLUDED.updated_at`,
      [docType, workerUrl, this.#now()],
    );
    this.#cache.delete(docType);
  }

  /**
   * 查库失败时回退到过期的缓存值(stale-while-error)。worker 地址极少
   * 变化(新增 doc type 或更换 Container Apps 环境时才变),Postgres 的
   * 短暂抖动不该让网关无法转发任何请求。
   *
   * 但没有可回退的值时必须抛错 —— 那种情况下返回 null 会被网关当成
   * 「这个 doc type 不存在」而回 404,把一个可恢复的故障伪装成永久性的
   * 客户端错误。
   */
  async resolve(docType: string): Promise<string | null> {
    const cached = this.#cache.get(docType);
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.url;

    try {
      const { rows } = await this.#q.query(
        "SELECT worker_url FROM doc_types WHERE doc_type = $1",
        [docType],
      );
      const url = rows.length > 0 ? (rows[0].worker_url as string) : null;
      this.#cache.set(docType, { url, at: this.#now() });
      return url;
    } catch (err) {
      if (cached) return cached.url;
      throw err;
    }
  }
}
