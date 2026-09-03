/**
 * agent 对话历史 + "正在跑"租约的 Postgres 实现。表见
 * `migrations/0004_agent_sessions.sql`。
 *
 * 为什么要租约:Cloudflare 那边靠 Durable Object 的 `#requestTail`——单线程
 * isolate 里的一条 promise 链——把同一文档上的并发 /run 串起来,等待不占任何
 * 资源。Azure 是 2-5 副本、无会话亲和,没有等价物:跨副本的等待要么攥着 Postgres
 * 连接(几个等待者就能吃干连接池),要么攥着 HTTP 请求槽最长 30 分钟。所以这里
 * 是"抢不到就快速失败",由调用方回 409。
 */
import type { Pool } from "pg";
import type { JsonValue } from "@unidocs/protocol";
import type { SessionIdentity } from "@unidocs/doctype-server-common";

/**
 * 租约时长,与 `/run` 自己的能力票窗口一致
 * (`gateway-common/src/capability-policy.ts:74-80`,注释:"窗口必须覆盖整次
 * run")。票过期后这次 run 再写也是 401,所以它就是一次 run 的硬上限。
 *
 * 代价:持有者进程崩溃后,同一份文档最多 30 分钟抢不到租约。`/reset` 走
 * `clear()` 强制释放,是明确的人工逃生口。
 */
export const AGENT_LEASE_SECONDS = 1800;

export class PgAgentSessionStore {
  readonly #pool: Pool;
  readonly #identity: SessionIdentity;

  constructor(pool: Pool, identity: SessionIdentity) {
    this.#pool = pool;
    this.#identity = identity;
  }

  get #key(): [string, string, string] {
    return [this.#identity.tenantId, this.#identity.docType, this.#identity.sessionId];
  }

  /**
   * 抢租约并取回历史。抢到返回历史(从未存过是 `[]`),抢不到返回 `null`。
   *
   * 一条语句完成"插入或抢占":`ON CONFLICT ... DO UPDATE ... WHERE` 的 WHERE
   * 不满足时不返回行,于是 `rowCount === 0` 就是"别人正在跑"。分成先 SELECT
   * 再 UPDATE 会在两句之间留下竞态窗口,而这正是租约要消灭的东西。
   */
  async acquire(leaseSeconds: number): Promise<JsonValue | null> {
    const { rows } = await this.#pool.query<{ history: JsonValue }>(
      `INSERT INTO agent_sessions (tenant_id, doc_type, session_id, running_until)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT (tenant_id, doc_type, session_id) DO UPDATE
         SET running_until = now() + make_interval(secs => $4), updated_at = now()
         WHERE agent_sessions.running_until IS NULL
            OR agent_sessions.running_until < now()
       RETURNING history`,
      [...this.#key, leaseSeconds],
    );
    return rows.length === 0 ? null : rows[0]!.history;
  }

  /** 写回历史并释放租约。调用方必须放在 finally 里。 */
  async release(history: JsonValue): Promise<void> {
    await this.#pool.query(
      `UPDATE agent_sessions
          SET history = $4::jsonb, running_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND doc_type = $2 AND session_id = $3`,
      [...this.#key, JSON.stringify(history)],
    );
  }

  /** 清空历史并**强制**释放租约 —— `/reset` 是崩溃后的人工逃生口。 */
  async clear(): Promise<void> {
    await this.#pool.query(
      `UPDATE agent_sessions
          SET history = '[]'::jsonb, running_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND doc_type = $2 AND session_id = $3`,
      this.#key,
    );
  }
}
