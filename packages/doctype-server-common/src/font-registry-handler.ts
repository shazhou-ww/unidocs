/**
 * `/tenants/{t}/fonts` 的中立处理器。
 *
 * 鉴权规则从 cloudflare-psd/src/fonts-do.ts 的 authenticateFontsRoute 逐条
 * 搬来,一条都不放松 —— 尤其"只接受 sessions:create 这一种权限"和"拒绝委派的
 * CAS 权限"(R29:这个端点背后不碰 CAS,多带一份权柄是调用方搞错了)。
 */
import type { FontsRoute, TenantOperation } from "@unidocs/protocol-doc";
import {
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityError,
  extractBearerCapability,
  requireCapabilityTenant,
  sessionCreatePermission,
} from "@unidocs/service-auth";
import type { VerifiedCapability } from "@unidocs/service-auth";
import { fontEntryProblem } from "./font-registry.js";
import type { FontEntry } from "./font-registry.js";
import type { WritableFontProvider } from "./font-provider.js";
import type { DocCapabilityVerifier } from "./doc-type-handler.js";

export interface FontsAuditEvent {
  readonly credentialKind: "capability";
  readonly operation: TenantOperation;
  readonly tenantId: string;
  readonly kid?: string;
  readonly jti?: string;
}

export interface FontsRequestConfig {
  /** 与 `createDocTypeHandler` 用的是同一个校验器(`DocAuthConfigCache` 产出)。 */
  readonly docCapabilityVerifier: DocCapabilityVerifier;
  /**
   * 租户那一档来源。**刻意不收门面**:这个端点回答的是"这个租户**登记了**什么",
   * 不是"这个租户**能用**什么"。掺进内置字体会让 `scripts/seed-psd-fonts.mjs`
   * 的幂等判据("索引里有没有")每次都判成"已经有了",于是一套字体都灌不进去。
   */
  readonly provider: WritableFontProvider;
  readonly audit?: (event: FontsAuditEvent) => void;
}

/**
 * `/tenants/{tenantId}/fonts` 的边缘处理:鉴权 → 读写登记表。
 *
 * 鉴权沿用既有的 doc 凭据(裁定 R30),不为这个端点发明新的授权模型:新增一
 * 个权限种类要在 gateway 的签发策略、CAS 中间件的解析、以及校验器的
 * `allowedPermissionKinds` 白名单三处同时改,而这里并不需要新的授权语义。
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

  if (request.method === "GET") {
    return Response.json({ fonts: await cfg.provider.list() });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  const problem = fontEntryProblem(body);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  await cfg.provider.put(body as FontEntry);
  return Response.json({ success: true });
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
  // 索引是租户级的,凭据里的 sessionId 与它无关,所以要的是**租户作用域**的
  // 那一种权限。doc 校验器只认 `sessions:*` 三种,其中不绑定具体会话的只有
  // `sessions:create`(`status` 端点用的也是它,见 `doc-capability-policy.ts`)。
  const required = sessionCreatePermission(route.tenantId);
  const granted = capability.claims.permissions;
  if (granted.length !== 1 || granted[0] !== required) {
    throw new CapabilityAuthorizationError(
      "insufficient_permission",
      "Doc capability permissions do not match the fonts endpoint",
    );
  }
  // R29:这个端点背后的 DO 不碰 CAS,所以它不该拿到、也不接受委派的 CAS 权限。
  // 照 `authenticateCapabilityRoute` 里 `casPermissions` 为空时的同一姿态:
  // 多带一份权限是调用方搞错了,静默忽略等于把多余的权柄一路带下去。
  if (request.headers.get("X-UniDocs-CAS-Capability") !== null) {
    throw new CapabilityAuthorizationError(
      "insufficient_permission",
      "The fonts endpoint does not accept delegated CAS authority",
    );
  }
  return capability;
}
