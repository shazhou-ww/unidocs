import {
  handleCasRequest,
  handleRootAssignments,
  handleRootRefs,
  handleReadNode,
  isCasRoute,
} from "./cas/routes.js";
import { migrateCasSchema } from "./cas/schema.js";
import { matchCasRoute } from "@unidocs/protocol-cas-legacy";
import type { CasRoute } from "@unidocs/protocol-cas-legacy";
import { CapabilityError } from "@unidocs/service-auth";
import {
  CasAuthConfigCache,
  type CasAuthBindings,
  type CasRouteAuthorization,
} from "./cas-auth.js";

export { CasDurableObject } from "./cas/do.js";
export { isPublicCasRoute } from "./public-cas-route.js";

interface Env extends CasAuthBindings {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  CAS_DO: DurableObjectNamespace;
  AUTH_AUDIT?: (event: CasAuthenticationAuditEvent) => void;
}

interface CasAuthenticationAuditEvent {
  readonly credentialKind: "legacy" | "capability";
  readonly routeGeneration: "legacy" | "tenant";
  readonly operation: CasRoute["operation"];
  readonly tenantId: string;
  readonly kid?: string;
  readonly jti?: string;
}

const authConfig = new CasAuthConfigCache();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const config = authConfig.get(env);
    const route = matchCasRoute(request.method, url.pathname);
    if (route) {
      let authorization: CasRouteAuthorization;
      try {
        authorization = config.mode === "legacy"
          ? (config.authenticateLegacy(request), {})
          : await config.authorizeCapability(request, route);
      } catch (error) {
        return authErrorResponse(error);
      }
      emitAuthAudit(env, {
        credentialKind: authorization.capability ? "capability" : "legacy",
        routeGeneration: "tenant",
        operation: route.operation,
        tenantId: route.tenantId,
        ...(authorization.capability ? {
          kid: authorization.capability.protectedHeader.kid,
          jti: authorization.capability.claims.jti,
        } : {}),
      });
      if (route.operation === "rootAssignments") {
        const scopeError = await validateRootAssignmentScope(
          request,
          authorization.capability?.claims.sessionId,
        );
        if (scopeError) return scopeError;
      }
      await migrateCasSchema(env.CAS_DB);
      return dispatchRoute(request, env, route);
    }

    const legacyRoute = matchLegacyInternalRoute(request, url.pathname);
    if (legacyRoute) {
      try {
        config.authenticateLegacy(request);
      } catch (error) {
        return authErrorResponse(error);
      }
      emitAuthAudit(env, {
        credentialKind: "legacy",
        routeGeneration: "legacy",
        operation: legacyRoute.operation,
        tenantId: legacyRoute.tenantId,
      });
      emitLegacySurface(env, legacySurface(legacyRoute.operation), legacyRoute.operation, legacyRoute.tenantId);
      await migrateCasSchema(env.CAS_DB);
      return dispatchRoute(request, env, legacyRoute);
    }
    if (isLegacyInternalPath(request.method, url.pathname)) {
      try {
        config.authenticateLegacy(request);
      } catch (error) {
        return authErrorResponse(error);
      }
      return Response.json({ error: "Missing X-Tenant-Id header" }, { status: 401 });
    }

    return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
  },
};

function dispatchRoute(request: Request, env: Env, route: CasRoute): Promise<Response> {
  switch (route.operation) {
    case "rootRefs":
      return handleRootRefs(request, env, route.tenantId);
    case "rootAssignments":
      emitLegacySurface(env, "rootAssignments", route.operation, route.tenantId);
      return handleRootAssignments(request, env, route.tenantId);
    case "readPortableNode":
    case "leasePortableNode":
      emitLegacySurface(env, "portableNode", route.operation, route.tenantId);
      return handleReadNode(request, env, route.tenantId, route.hash);
    default:
      return handleCasRequest(request, env, route.tenantId);
  }
}

/**
 * Compatibility-phase telemetry (Task 9 bullet 11): every use of a retiring
 * legacy surface — shared-key auth, owner-assignment root writes, or the
 * portable-node HTTP routes — emits a structured `cas_legacy_surface` event
 * so operators can prove no supported binary still uses them before the
 * rollback window closes.
 */
function emitLegacySurface(env: Env, surface: string, operation: string, tenantId: string): void {
  console.log(JSON.stringify({
    event: "cas_legacy_surface",
    surface,
    operation,
    tenantId,
  }));
}

function legacySurface(operation: string): string {
  if (operation === "rootAssignments") return "rootAssignments";
  if (operation === "readPortableNode" || operation === "leasePortableNode") return "portableNode";
  return "sharedKey";
}

function matchLegacyInternalRoute(request: Request, pathname: string): CasRoute | null {
  const tenantId = request.headers.get("X-Tenant-Id");
  if (!tenantId) return null;
  if (pathname === "/_internal/root-refs" && request.method === "POST") {
    return { operation: "rootRefs", tenantId };
  }
  if (pathname === "/_internal/root-assignments" && request.method === "POST") {
    return { operation: "rootAssignments", tenantId };
  }
  const node = pathname.match(/^\/_internal\/nodes\/([^/]+)$/);
  if (!node) return null;
  if (request.method === "GET") {
    return { operation: "readPortableNode", tenantId, hash: node[1] };
  }
  if (request.method === "POST") {
    return { operation: "leasePortableNode", tenantId, hash: node[1] };
  }
  return null;
}

function isLegacyInternalPath(method: string, pathname: string): boolean {
  if (method === "POST"
    && (pathname === "/_internal/root-refs"
      || pathname === "/_internal/root-assignments")) {
    return true;
  }
  return (method === "GET" || method === "POST")
    && /^\/_internal\/nodes\/[^/]+$/.test(pathname);
}

async function validateRootAssignmentScope(
  request: Request,
  sessionId: string | undefined,
): Promise<Response | null> {
  if (!sessionId) {
    return Response.json({ error: "CAS root assignment requires a signed session" }, { status: 403 });
  }
  const body = await request.clone().json().catch(() => null) as {
    assignments?: Array<{ owner?: unknown }>;
  } | null;
  if (!body || !Array.isArray(body.assignments)) {
    return Response.json({ error: "Invalid root assignment request" }, { status: 400 });
  }
  const prefix = `session:${sessionId}:`;
  if (body.assignments.some(assignment =>
    typeof assignment.owner !== "string" || !assignment.owner.startsWith(prefix))) {
    return Response.json({ error: "Root owner is outside the signed session" }, { status: 403 });
  }
  return null;
}

function authErrorResponse(error: unknown): Response {
  if (error instanceof CapabilityError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "CAS capability validation failed" }, { status: 401 });
}

function emitAuthAudit(env: Env, event: CasAuthenticationAuditEvent): void {
  const frozen = Object.freeze(event);
  if (env.AUTH_AUDIT) {
    env.AUTH_AUDIT(frozen);
    return;
  }
  console.log(JSON.stringify({ event: "cas_authentication", ...frozen }));
}
