/**
 * 租户字体来源(`WritableFontProvider`)的 Postgres 实现。
 *
 * 与 ports-pg.ts 的几个 port 刻意分开成独立文件:那些都绑一个 sessionId,
 * 这个只绑 (stackId, tenantId)。放在一起会让"每个 port 一个会话"这条读起来
 * 显然的性质变得需要逐个确认。
 */
import { casFontBytes } from "@unidocs/doctype-server-common";
import type { FontEntry, FontIo, WritableFontProvider } from "@unidocs/doctype-server-common";
import type { SBlob } from "@unidocs/protocol";
import type { Queryable } from "./ports-pg.js";

export interface FontRegistryScope {
  readonly stackId: string;
  readonly tenantId: string;
}

export class PgFontProvider implements WritableFontProvider {
  #q: Queryable;
  #scope: FontRegistryScope;

  constructor(q: Queryable, scope: FontRegistryScope) {
    this.#q = q;
    this.#scope = scope;
  }

  readonly id = "tenant";

  /** 读取语义两个平台逐字相同(`createSBlob` 住在中立的 `@unidocs/svalue-codec`,
   *  两个平台 SDK 只是再导出它),所以复用中立层那份,不各写一遍。字节在 CAS,
   *  由跑在编辑会话里的 effect 带着会话身份去读 —— 这个 provider 自己拿不到
   *  CAS 权限,也不该拿到(裁定 R29)。 */
  read(entry: FontEntry, io: FontIo): Promise<Uint8Array> { return casFontBytes.read(entry, io); }

  blobFor(entry: FontEntry): SBlob { return casFontBytes.blobFor(entry); }

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
