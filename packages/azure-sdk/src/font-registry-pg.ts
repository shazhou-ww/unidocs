/**
 * FontRegistry 的 Postgres 实现。
 *
 * 与 ports-pg.ts 的几个 port 刻意分开成独立文件:那些都绑一个 sessionId,
 * 这个只绑 (stackId, tenantId)。放在一起会让"每个 port 一个会话"这条读起来
 * 显然的性质变得需要逐个确认。
 */
import type { FontEntry, FontRegistry } from "@unidocs/doctype-server-common";
import type { Queryable } from "./ports-pg.js";

export interface FontRegistryScope {
  readonly stackId: string;
  readonly tenantId: string;
}

export class PgFontRegistry implements FontRegistry {
  #q: Queryable;
  #scope: FontRegistryScope;

  constructor(q: Queryable, scope: FontRegistryScope) {
    this.#q = q;
    this.#scope = scope;
  }

  async list(): Promise<readonly FontEntry[]> {
    const { rows } = await this.#q.query(
      `SELECT post_script_name, family, hash, units_per_em, coverage
         FROM font_registry
        WHERE stack_id = $1 AND tenant_id = $2
        ORDER BY post_script_name`,
      [this.#scope.stackId, this.#scope.tenantId],
    );
    return rows.map((row: Record<string, unknown>) => ({
      postScriptName: row.post_script_name as string,
      family: row.family as string,
      hash: row.hash as string,
      unitsPerEm: Number(row.units_per_em),
      // pg 把 jsonb 解析成 JS 值,不需要再 JSON.parse。
      coverage: row.coverage as FontEntry["coverage"],
    }));
  }

  /** 幂等,与 CF 侧 INSERT OR REPLACE 同语义。 */
  async put(entry: FontEntry): Promise<void> {
    await this.#q.query(
      `INSERT INTO font_registry
         (stack_id, tenant_id, post_script_name, family, hash, units_per_em, coverage)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stack_id, tenant_id, post_script_name) DO UPDATE
         SET family = EXCLUDED.family,
             hash = EXCLUDED.hash,
             units_per_em = EXCLUDED.units_per_em,
             coverage = EXCLUDED.coverage`,
      [
        this.#scope.stackId,
        this.#scope.tenantId,
        entry.postScriptName,
        entry.family,
        entry.hash,
        entry.unitsPerEm,
        JSON.stringify(entry.coverage),
      ],
    );
  }
}
