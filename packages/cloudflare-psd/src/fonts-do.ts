/**
 * 租户级字体索引：Durable Object 本体。
 *
 * PSD 文字层记的是字体**名字**，不是字体文件，所以自己排版就得先知道"这个
 * 名字对应 CAS 里哪一坨字节、它认识哪些码位"。这张索引按租户存，不按会话：
 * 同一租户下所有 psd 文档共用一套字体，按会话存等于每开一个文档就要重登记
 * 一遍。
 *
 * 它**只存元数据，绝不碰 CAS**（裁定 R29）。DO 访问 CAS 靠边缘注入的
 * `X-Session-Id` 等请求头，而 `createRequestCasClient` 缺 sessionId 直接抛错
 * —— 租户级 DO 天然没有 sessionId。所以字节由预置脚本写进 CAS、由跑在编辑
 * 会话里的 `setText` effect 读，两边都拿得到会话身份，这个矛盾就不存在了。
 *
 * `/tenants/{t}/fonts` 的路由匹配与边缘鉴权/转发已经下沉到中立层
 * （`@unidocs/protocol-doc` 的 `matchFontsRoute`、`@unidocs/doctype-server-common`
 * 的 `handleFontsRequest`）。这个文件此前把边缘处理和 DO 放在一起，是因为
 * 它们是同一个端点的两端；现在两端分处两层，接线靠 `font-registry-do.ts`
 * 的 `createDoFontRegistry`（把 `FontRegistry.list/put` 映到这个 DO 的
 * GET/POST）与 `worker.ts` 完成。
 */
import type { FontEntry } from "@unidocs/doctype-psd";
import { fontEntryProblem } from "@unidocs/doctype-server-common";

/** 边缘 worker → 字体 DO 这一跳的内部路径，与 `docInternalRoutes` 同一惯例。 */
export const FONTS_INTERNAL_PATH = "/_internal/fonts";

const TABLE = "psd_fonts";

/**
 * 租户级 DO 的对象名。
 *
 * 命名照 CAS 侧的先例（`unicas-packages/service-cloudflare/src/do-names.ts`
 * 的 `canonicalComposite`）：两段各自 `encodeURIComponent` 再用 `|` 连接，
 * 这样带 `|` 的 tenantId 不可能和另一对 (stackId, tenantId) 撞名。
 *
 * 带 stackId 前缀，不是只用 tenantId：字体**字节**在 CAS 里的键是
 * `stacks/{stackId}/tenants/{tenantId}/nodes-v2/{hash}`
 * （`service-cloudflare/src/do-names.ts` 的 `stackCanonicalNodeKey`）——
 * **stack 和 tenant 两段都在键里**。换一个 stack，那些字节就已经不在了。
 * 索引跟着一起换名，两边同生同死；不带前缀反而会得到一张指向不存在字节的
 * 索引，而那种失效是静默的。
 *
 * 顺带说明一个常被问到的点：正因为 tenantId 也在 CAS 的键里，索引**做不到**
 * "一份字节所有租户共用" —— 同一个哈希在别的租户分区里根本没有那个对象。
 * 要做成栈级共享，得把字节挪出 CAS（栈级的 R2/KV）,那是另一套设计。
 */
export function fontsObjectName({ stackId, tenantId }: {
  readonly stackId: string;
  readonly tenantId: string;
}): string {
  if (stackId.length === 0 || tenantId.length === 0) {
    throw new TypeError("Fonts DO name parts must not be empty");
  }
  return `${encodeURIComponent(stackId)}|${encodeURIComponent(tenantId)}`;
}

/** sqlite 里的一行。列名照 `FontEntry` 的字段（brief Step 1 给定）。 */
interface FontRow {
  readonly postScriptName: string;
  readonly family: string;
  readonly hash: string;
  readonly units_per_em: number;
  readonly coverage: string;
}

/**
 * 字体索引 DO。
 *
 * 不做 `editor-do-svalue.ts` / `operator-do-agent.ts` 那样的请求串行化：那两个
 * 有跨 await 的读-改-写不变式，这里没有 —— 每个请求要么是一条 SELECT，要么是
 * 一条 `INSERT OR REPLACE`，都在 `await request.json()` 之后一步做完。
 */
export class PsdFontsDurableObject {
  readonly #ctx: DurableObjectState;
  #schemaReady = false;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== FONTS_INTERNAL_PATH) {
      return Response.json(
        { success: false, error: `Unknown endpoint: ${url.pathname}` },
        { status: 404 },
      );
    }
    try {
      this.#initializeSchema();
      if (request.method === "GET") {
        return Response.json({ fonts: this.#list() });
      }
      if (request.method === "POST") {
        return await this.#register(request);
      }
      return Response.json(
        { success: false, error: `Method not allowed: ${request.method}` },
        { status: 405 },
      );
    } catch (err) {
      return Response.json({ success: false, error: String(err) }, { status: 500 });
    }
  }

  #initializeSchema(): void {
    if (this.#schemaReady) return;
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        postScriptName TEXT PRIMARY KEY,
        family TEXT NOT NULL,
        hash TEXT NOT NULL,
        units_per_em INTEGER NOT NULL,
        coverage TEXT NOT NULL
      )
    `);
    this.#schemaReady = true;
  }

  #list(): FontEntry[] {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT postScriptName, family, hash, units_per_em, coverage
         FROM ${TABLE}
        ORDER BY postScriptName`,
    ).toArray() as unknown as FontRow[];
    return rows.map(row => ({
      postScriptName: row.postScriptName,
      family: row.family,
      hash: row.hash,
      unitsPerEm: row.units_per_em,
      coverage: JSON.parse(row.coverage) as FontEntry["coverage"],
    }));
  }

  async #register(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ success: false, error: "Request body must be JSON" }, { status: 400 });
    }
    const problem = fontEntryProblem(body);
    if (problem) {
      return Response.json({ success: false, error: problem }, { status: 400 });
    }
    const entry = body as FontEntry;
    // 幂等：同一个 postScriptName 重登记覆盖旧的一条，不是报冲突 —— 预置脚本
    // 每次跑都会把配置里的全套字体登记一遍。
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ${TABLE}
        (postScriptName, family, hash, units_per_em, coverage)
       VALUES (?, ?, ?, ?, ?)`,
      entry.postScriptName,
      entry.family,
      entry.hash,
      entry.unitsPerEm,
      JSON.stringify(entry.coverage),
    );
    return Response.json({ success: true });
  }
}
