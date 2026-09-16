import { timingSafeEqual } from "node:crypto";
import { AGENT_SCOPES, TenantAccessError, type TenantContext } from "@unidocs/portal-service";
import { extractBearerCapability } from "@unidocs/service-auth";

/**
 * R18: namespaced apart from tenant user principals; the suffix is the
 * Markdown Operator descriptor's `declaredOperatorId`, so it stays traceable.
 */
export const AGENT_PRINCIPAL_ID = "agent:markdown-primary";

/** Same shape the rest of the tenant plane validates identifiers with (`portal-service`'s `TENANT_ID`/`requireIdentifier`). */
const TENANT_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Reads the `{tenantId}` segment out of `/api/v1/tenants/{tenantId}/...`,
 * percent-decoding it and validating it like every other tenant identifier.
 * Returns `undefined` for a path with no such segment (the session
 * endpoints) or a segment that fails to decode or validate.
 */
function tenantIdFromPath(pathname: string): string | undefined {
  const match = /^\/api\/v1\/tenants\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return TENANT_ID_PATTERN.test(decoded) ? decoded : undefined;
}

/**
 * The operator Agent's bearer path (R9). A local shared token: the header must
 * be exactly `Bearer <token>` and match `token` by SHA-256 digest compared in
 * constant time. An unset token refuses every bearer, so an unconfigured
 * environment cannot be entered with an empty one.
 *
 * WIDENED (2026-09-16): the tenant the bearer acts for is now read from the
 * request path (`/api/v1/tenants/{tenantId}/...`), not from a configured
 * `AGENT_TENANT_ID`. The token alone authorizes the caller — a valid bearer
 * now reads and writes *every* tenant's documents, not just one preconfigured
 * one. This was accepted deliberately by the product owner: the Markdown
 * Operator addresses tenants by path (`platform-client.ts`), and a
 * self-provisioned tenant would otherwise have no way to receive Agent
 * writes. The consequence is that disclosure of the shared token now exposes
 * every tenant's documents, not one. Narrowing this back down means issuing
 * the Operator a short-lived, per-tenant credential instead of a shared
 * secret; that is future work, not done here.
 *
 * It never reads the cookie: a rejected bearer is 401 even beside a valid
 * session. A bearer is not subject to Origin, CSRF or sec-fetch-site (it is
 * not ambient), but the request URL origin must still be the portal's, so a
 * rebound hostname cannot reach the API with it. The origin is checked first:
 * a foreign host is 403 whatever it presents, so it cannot use the 401/403
 * difference to learn whether a token is valid.
 */
export async function authenticateAgent(
  request: Request,
  options: { readonly origin: string; readonly token: string | undefined },
): Promise<TenantContext> {
  const { origin, token } = options;
  const url = new URL(request.url);
  if (url.origin !== origin) throw new TenantAccessError("forbidden");

  let presented: string;
  try {
    presented = extractBearerCapability(request.headers.get("authorization"));
  } catch {
    throw new TenantAccessError("unauthorized");
  }
  if (!token) throw new TenantAccessError("unauthorized");
  // Digests are fixed-length, so neither the comparison nor a length check
  // reveals anything about the configured token.
  if (!timingSafeEqual(await sha256(presented), await sha256(token))) throw new TenantAccessError("unauthorized");

  // The token alone is not enough: it must also be presented against a path
  // that names a valid tenant. `/portal/auth/session` with a bearer, for
  // example, has nothing to authenticate for.
  const tenantId = tenantIdFromPath(url.pathname);
  if (!tenantId) throw new TenantAccessError("unauthorized");

  return {
    tenantId,
    principalId: AGENT_PRINCIPAL_ID,
    transport: "bearer",
    scopes: [...AGENT_SCOPES],
  };
}
