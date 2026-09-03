/**
 * 租户级字体索引：Durable Object 本体，以及它对外那个端点的边缘处理。
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
 * 边缘处理（`handleFontsRequest`）和 DO 放在同一个文件里，是因为它们是同一个
 * 端点的两端：一端把 `/tenants/{t}/fonts` 鉴权后改写成 `/_internal/fonts`
 * 转发，另一端认这条内部路径。拆开两个文件，改一端忘改另一端不会有任何东西
 * 报错 —— 只会 404。
 */
import type { FontEntry } from "@unidocs/doctype-psd";
import type { DocCapabilityVerifier } from "@unidocs/doctype-server-common";
import {
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityError,
  extractBearerCapability,
  requireCapabilityTenant,
  sessionCreatePermission,
} from "@unidocs/service-auth";
import type { VerifiedCapability } from "@unidocs/service-auth";

/** 边缘 worker → 字体 DO 这一跳的内部路径，与 `docInternalRoutes` 同一惯例。 */
export const FONTS_INTERNAL_PATH = "/_internal/fonts";

const TABLE = "psd_fonts";
/** `createSBlob` 只收 64 位小写十六进制；登记时就挡住，别留到 setText 才炸。 */
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CODE_POINT = 0x10ffff;

/**
 * 租户级 DO 的对象名。
 *
 * 命名照 CAS 侧的先例（`unicas-packages/service-cloudflare/src/do-names.ts`
 * 的 `canonicalComposite`）：两段各自 `encodeURIComponent` 再用 `|` 连接，
 * 这样带 `|` 的 tenantId 不可能和另一对 (stackId, tenantId) 撞名。
 *
 * 带 stackId 前缀，不是只用 tenantId：字体**字节**在 CAS 里的键本来就是
 * stack 作用域的（`stackCanonicalNodeKey` = `stacks/{stackId}/...`），换一个
 * stack 那些字节就已经不在了。索引跟着一起换名，两边同生同死；不带前缀反而
 * 会得到一张指向不存在字节的索引，而那种失效是静默的。
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

/** 对外的租户级字体路由：`/tenants/{tenantId}/fonts`。 */
export interface FontsRoute {
  readonly tenantId: string;
}

/**
 * 只按路径匹配，不按方法。
 *
 * 方法不认识时由字体处理器回 405，而不是在这里返回 null —— 返回 null 会
 * 落回 `createDocTypeHandler`，那边不认识这条路径，答的是 404
 * "Unknown Doc endpoint"，把"方法用错了"说成"这个端点不存在"。
 */
export function matchFontsRoute(pathname: string): FontsRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "tenants" || parts[2] !== "fonts") return null;
  let tenantId: string;
  try {
    tenantId = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  return tenantId.length === 0 ? null : { tenantId };
}

/**
 * 校验一条登记载荷。合法返回 null，否则返回**说得出哪一条不对**的原因。
 *
 * coverage 的形状是硬要求，不是洁癖：`selectFonts`（`doctype-psd` 的
 * `text/registry.ts`）用二分查找判一个码位有没有被覆盖，喂给它一个乱序或
 * 重叠的区间数组，查找会**静默返回错的结果** —— 那个字被判成"这套字体不
 * 认识"，然后掉到回退链上，没有任何东西会报错。写入侧是唯一挡得住的地方。
 */
export function fontEntryProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "font entry must be a JSON object";
  }
  const entry = value as Record<string, unknown>;
  for (const field of ["postScriptName", "family", "hash"] as const) {
    const text = entry[field];
    if (typeof text !== "string" || text.length === 0) {
      return `${field} must be a non-empty string`;
    }
  }
  if (!HASH_PATTERN.test(entry.hash as string)) {
    return "hash must be 64 lowercase hexadecimal characters (a CAS content hash)";
  }
  const unitsPerEm = entry.unitsPerEm;
  if (typeof unitsPerEm !== "number" || !Number.isInteger(unitsPerEm) || unitsPerEm <= 0) {
    return `unitsPerEm must be a positive integer, got ${JSON.stringify(unitsPerEm)}`;
  }
  return coverageProblem(entry.coverage);
}

function coverageProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "coverage must be an array of [start, end] ranges";
  if (value.length === 0) {
    // 一套什么都不覆盖的字体永远不会被 `selectFonts` 选中，登记它只会得到一条
    // 谁也发现不了的死条目。这只可能是解析出错。
    return "coverage must not be empty";
  }
  // -2 让第一个区间的 start（≥ 0）必然通过下面 `start > previousEnd + 1` 那一关。
  let previousEnd = -2;
  for (let index = 0; index < value.length; index++) {
    const range: unknown = value[index];
    if (!Array.isArray(range) || range.length !== 2) {
      return `coverage[${index}] must be a [start, end] pair, got ${JSON.stringify(range)}`;
    }
    const [start, end] = range as unknown[];
    if (!isCodePoint(start) || !isCodePoint(end)) {
      return `coverage[${index}] must be two code points in [0, 0x10FFFF], got ${JSON.stringify(range)}`;
    }
    if (start > end) {
      return `coverage[${index}] is reversed: start ${start} is greater than end ${end}`;
    }
    if (start <= previousEnd + 1) {
      return `coverage[${index}] starts at ${start}, but coverage[${index - 1}] ends at ${previousEnd}`
        + " — ranges must be ascending, non-overlapping, and merged (adjacent ranges must be one)";
    }
    previousEnd = end;
  }
  return null;
}

function isCodePoint(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_CODE_POINT;
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

export interface FontsAuditEvent {
  readonly credentialKind: "capability";
  readonly operation: "listFonts" | "registerFont";
  readonly tenantId: string;
  readonly kid?: string;
  readonly jti?: string;
}

export interface FontsRequestConfig {
  /** 与 `createDocTypeHandler` 用的是同一个校验器（`DocAuthConfigCache` 产出）。 */
  readonly docCapabilityVerifier: DocCapabilityVerifier;
  readonly namespace: DurableObjectNamespace;
  /** `fontsObjectName({ stackId, tenantId })`。 */
  readonly objectName: string;
  readonly audit?: (event: FontsAuditEvent) => void;
}

/**
 * `/tenants/{tenantId}/fonts` 的边缘处理：鉴权 → 取租户级 stub → 改写路径转发。
 *
 * 鉴权沿用既有的 doc 凭据（裁定 R30），不为这个端点发明新的授权模型：新增一
 * 个权限种类要在 gateway 的签发策略、CAS 中间件的解析、以及校验器的
 * `allowedPermissionKinds` 白名单三处同时改，而这里并不需要新的授权语义。
 */
export async function handleFontsRequest(
  cfg: FontsRequestConfig,
  request: Request,
  route: FontsRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json(
      { error: `Method not allowed: ${request.method}` },
      { status: 405 },
    );
  }
  let capability: VerifiedCapability;
  try {
    capability = await authenticateFontsRoute(cfg, request, route);
  } catch (error) {
    if (error instanceof CapabilityError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Capability validation failed" }, { status: 401 });
  }
  cfg.audit?.(Object.freeze({
    credentialKind: "capability" as const,
    operation: request.method === "GET" ? "listFonts" as const : "registerFont" as const,
    tenantId: route.tenantId,
    ...(capability.protectedHeader.kid === undefined ? {} : { kid: capability.protectedHeader.kid }),
    ...(capability.claims.jti === undefined ? {} : { jti: capability.claims.jti }),
  }));

  const stub = cfg.namespace.get(cfg.namespace.idFromName(cfg.objectName));
  const forwardUrl = new URL(request.url);
  forwardUrl.pathname = FONTS_INTERNAL_PATH;
  const headers = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-Tenant-Id", route.tenantId);
  return stub.fetch(new Request(forwardUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    duplex: "half",
    signal: request.signal,
  } as RequestInit));
}

async function authenticateFontsRoute(
  cfg: FontsRequestConfig,
  request: Request,
  route: FontsRoute,
): Promise<VerifiedCapability> {
  const token = extractBearerCapability(request.headers.get("Authorization"));
  const capability = await cfg.docCapabilityVerifier.verify(token);
  requireCapabilityTenant(capability, route.tenantId);
  if (capability.claims.sub !== "gateway") {
    throw new CapabilityAuthenticationError("invalid_token", "Doc capability subject is invalid");
  }
  // 索引是租户级的，凭据里的 sessionId 与它无关，所以要的是**租户作用域**的
  // 那一种权限。doc 校验器只认 `sessions:*` 三种，其中不绑定具体会话的只有
  // `sessions:create`（`status` 端点用的也是它，见 `doc-capability-policy.ts`）。
  const required = sessionCreatePermission(route.tenantId);
  const granted = capability.claims.permissions;
  if (granted.length !== 1 || granted[0] !== required) {
    throw new CapabilityAuthorizationError(
      "insufficient_permission",
      "Doc capability permissions do not match the fonts endpoint",
    );
  }
  // R29：这个端点背后的 DO 不碰 CAS，所以它不该拿到、也不接受委派的 CAS 权限。
  // 照 `authenticateCapabilityRoute` 里 `casPermissions` 为空时的同一姿态：
  // 多带一份权限是调用方搞错了，静默忽略等于把多余的权柄一路带下去。
  if (request.headers.get("X-UniDocs-CAS-Capability") !== null) {
    throw new CapabilityAuthorizationError(
      "insufficient_permission",
      "The fonts endpoint does not accept delegated CAS authority",
    );
  }
  return capability;
}
