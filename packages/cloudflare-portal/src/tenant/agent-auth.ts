import { timingSafeEqual } from "node:crypto";
import { TenantAccessError, type TenantContext } from "@unidocs/portal-service";
import { extractBearerCapability } from "@unidocs/service-auth";

/**
 * R18: namespaced apart from tenant user principals; the suffix is the
 * Markdown Operator descriptor's `declaredOperatorId`, so it stays traceable.
 */
export const AGENT_PRINCIPAL_ID = "agent:markdown-primary";

/**
 * R9's grant. The strings must match the scope literals checked in
 * packages/portal-service/src/tenant/submissions.ts (its AGENT_SCOPES and the
 * requireScopes calls), which does not export them.
 */
export const AGENT_SCOPES = ["documents:read", "comments:read", "comments:reply", "versions:submit"] as const;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * The operator Agent's bearer path (R9). A local shared token: the header must
 * be exactly `Bearer <token>` and match `token` by SHA-256 digest compared in
 * constant time. An unset token or tenant refuses every bearer, so an
 * unconfigured environment cannot be entered with an empty one.
 *
 * It never reads the cookie: a rejected bearer is 401 even beside a valid
 * session. A bearer is not subject to Origin, CSRF or sec-fetch-site (it is
 * not ambient), but the request URL origin must still be the portal's, so a
 * rebound hostname cannot reach the API with it.
 */
export async function authenticateAgent(
  request: Request,
  options: { readonly origin: string; readonly token: string | undefined; readonly tenantId: string | undefined },
): Promise<TenantContext> {
  const { origin, token, tenantId } = options;

  let presented: string;
  try {
    presented = extractBearerCapability(request.headers.get("authorization"));
  } catch {
    throw new TenantAccessError("unauthorized");
  }
  if (!token || !tenantId) throw new TenantAccessError("unauthorized");
  // Digests are fixed-length, so neither the comparison nor a length check
  // reveals anything about the configured token.
  if (!timingSafeEqual(await sha256(presented), await sha256(token))) throw new TenantAccessError("unauthorized");

  if (new URL(request.url).origin !== origin) throw new TenantAccessError("forbidden");

  return {
    tenantId,
    principalId: AGENT_PRINCIPAL_ID,
    transport: "bearer",
    scopes: [...AGENT_SCOPES],
  };
}
