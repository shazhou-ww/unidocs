import { docInternalRoutes, matchDocRoute } from "@unidocs/protocol-doc";
import type { DocOperation, DocRoute } from "@unidocs/protocol-doc";
import {
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityError,
  extractBearerCapability,
  requireCapabilitySession,
  requireCapabilityTenant,
} from "@unidocs/service-auth";
import type { CapabilityPermission, VerifiedCapability } from "@unidocs/service-auth";
import { docEdgeCapabilityRequirements } from "./doc-capability-policy.js";
import { docSessionObjectName } from "./session-object-name.js";

interface DoNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

export interface DocCapabilityVerifier {
  verify(token: string): Promise<VerifiedCapability>;
}

export type DocInternalAuthMode = "legacy" | "dual" | "capability" | "stack";

export interface DocTypeHandlerConfig {
  docType: string;
  internalAuthMode: DocInternalAuthMode;
  accessKey?: string;
  docCapabilityVerifier?: DocCapabilityVerifier;
  casCapabilityVerifier?: DocCapabilityVerifier;
  audit?: (event: DocAuthenticationAuditEvent) => void;
  editor: DoNamespaceLike;
  operator: DoNamespaceLike;
}

export interface DocAuthenticationAuditEvent {
  readonly credentialKind: "legacy" | "capability";
  readonly routeGeneration: "legacy" | "tenant";
  readonly operation: DocOperation;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly kid?: string;
  readonly jti?: string;
}

type MatchedDocEdgeRoute = DocRoute & {
  readonly generation: "legacy" | "capability";
};

type AuthenticatedDocEdgeRoute = MatchedDocEdgeRoute & {
  readonly delegatedCasCapability?: string;
  readonly kid?: string;
  readonly jti?: string;
};

const legacyOperations = {
  query: { method: "POST", operation: "query" },
  apply: { method: "POST", operation: "apply" },
  export: { method: "GET", operation: "export" },
  history: { method: "GET", operation: "history" },
  rollback: { method: "POST", operation: "rollback" },
  snapshot: { method: "GET", operation: "snapshot" },
  status: { method: "GET", operation: "status" },
  ir: { method: "GET", operation: "ir" },
  "init-from-hash": { method: "POST", operation: "initFromHash" },
  run: { method: "POST", operation: "run" },
  reset: { method: "POST", operation: "reset" },
} as const satisfies Record<string, { method: string; operation: DocOperation }>;

export function createDocTypeHandler(
  cfg: DocTypeHandlerConfig,
): (request: Request) => Promise<Response> {
  validateConfig(cfg);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = matchEdgeRoute(cfg.internalAuthMode, request.method, url.pathname);
    if (!route) {
      return Response.json({ error: "Unknown Doc endpoint" }, { status: 404 });
    }

    let authenticated: AuthenticatedDocEdgeRoute;
    try {
      authenticated = route.generation === "capability"
        ? await authenticateCapabilityRoute(cfg, request, route)
        : authenticateLegacyRoute(cfg, request, route);
    } catch (error) {
      return authenticationErrorResponse(error);
    }
    cfg.audit?.(Object.freeze({
      credentialKind: authenticated.generation,
      routeGeneration: authenticated.generation === "capability" ? "tenant" : "legacy",
      operation: authenticated.operation,
      tenantId: authenticated.tenantId,
      sessionId: authenticated.sessionId,
      ...(authenticated.kid === undefined ? {} : { kid: authenticated.kid }),
      ...(authenticated.jti === undefined ? {} : { jti: authenticated.jti }),
    }));

    const namespace = authenticated.operation === "run"
        || authenticated.operation === "reset"
      ? cfg.operator
      : cfg.editor;
    const objectName = authenticated.generation === "capability"
      ? docSessionObjectName(authenticated.tenantId, authenticated.sessionId)
      : authenticated.sessionId;
    const id = namespace.idFromName(objectName);
    const stub = namespace.get(id);
    const forwardUrl = new URL(request.url);
    forwardUrl.pathname = docInternalRoutes[authenticated.operation];
    return stub.fetch(new Request(forwardUrl.toString(), {
      method: authenticated.operation === "create" ? "POST" : request.method,
      headers: internalHeaders(request, cfg, authenticated),
      body: request.body,
      duplex: "half",
      signal: request.signal,
    } as RequestInit));
  };
}

function matchEdgeRoute(
  mode: DocInternalAuthMode,
  method: string,
  pathname: string,
): MatchedDocEdgeRoute | null {
  const capabilityRoute = matchDocRoute(method, pathname);
  if (capabilityRoute) {
    return mode === "legacy"
      ? null
      : { ...capabilityRoute, generation: "capability" };
  }
  const legacyRoute = matchLegacyDocRoute(method, pathname);
  if (!legacyRoute || mode === "capability") return null;
  return { ...legacyRoute, generation: "legacy" };
}

function matchLegacyDocRoute(method: string, pathname: string): DocRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "sessions") return null;
  const sessionId = decodeSegment(parts[1]);
  if (sessionId === null) return null;
  if (parts.length === 2 && method === "PUT") {
    return { operation: "create", tenantId: "", sessionId };
  }
  if (parts.length !== 3) return null;
  const operation = legacyOperations[parts[2] as keyof typeof legacyOperations];
  return operation?.method === method
    ? { operation: operation.operation, tenantId: "", sessionId }
    : null;
}

function authenticateLegacyRoute(
  cfg: DocTypeHandlerConfig,
  request: Request,
  route: MatchedDocEdgeRoute,
): AuthenticatedDocEdgeRoute {
  const token = request.headers.get("X-Internal-Token");
  if (!cfg.accessKey || token !== cfg.accessKey) {
    throw new CapabilityAuthenticationError("invalid_token", "Legacy service credential is invalid");
  }
  const tenantId = request.headers.get("X-Tenant-Id");
  if (!tenantId) {
    throw new CapabilityAuthenticationError("missing_token", "Legacy tenant context is required");
  }
  return { ...route, tenantId };
}

async function authenticateCapabilityRoute(
  cfg: DocTypeHandlerConfig,
  request: Request,
  route: MatchedDocEdgeRoute,
): Promise<AuthenticatedDocEdgeRoute> {
  const token = extractBearerCapability(request.headers.get("Authorization"));
  const primary = await cfg.docCapabilityVerifier!.verify(token);
  requireCapabilityTenant(primary, route.tenantId);
  requireCapabilitySession(primary, route.sessionId);
  if (primary.claims.sub !== "gateway") {
    throw new CapabilityAuthenticationError("invalid_token", "Doc capability subject is invalid");
  }

  const requirements = docEdgeCapabilityRequirements(
    route.operation,
    route.tenantId,
    route.sessionId,
  );
  requireExactPermissions(primary, [requirements.docPermission], "Doc");

  const delegatedToken = request.headers.get("X-UniDocs-CAS-Capability");
  if (requirements.casPermissions.length === 0) {
    if (delegatedToken !== null) {
      throw new CapabilityAuthorizationError(
        "insufficient_permission",
        "This Doc operation does not accept delegated CAS authority",
      );
    }
    return {
      ...route,
      kid: primary.protectedHeader.kid,
      jti: primary.claims.jti,
    };
  }
  if (!delegatedToken) {
    throw new CapabilityAuthenticationError("missing_token", "Delegated CAS capability is required");
  }

  const delegated = await cfg.casCapabilityVerifier!.verify(delegatedToken);
  requireCapabilityTenant(delegated, route.tenantId);
  requireCapabilitySession(delegated, route.sessionId);
  if (delegated.claims.sub !== `doc:${cfg.docType}`) {
    throw new CapabilityAuthenticationError("invalid_token", "Delegated CAS subject is invalid");
  }
  if (delegated.claims.exp > primary.claims.exp) {
    throw new CapabilityAuthorizationError(
      "resource_scope_mismatch",
      "Delegated CAS capability outlives the Doc capability",
    );
  }
  requireExactPermissions(delegated, requirements.casPermissions, "Delegated CAS");
  return {
    ...route,
    delegatedCasCapability: delegatedToken,
    kid: primary.protectedHeader.kid,
    jti: primary.claims.jti,
  };
}

function requireExactPermissions(
  capability: VerifiedCapability,
  expected: readonly CapabilityPermission[],
  label: string,
): void {
  if (capability.claims.permissions.length !== expected.length
    || expected.some(permission => !capability.claims.permissions.includes(permission))) {
    throw new CapabilityAuthorizationError(
      "insufficient_permission",
      `${label} capability permissions do not match the operation`,
    );
  }
}

function internalHeaders(
  request: Request,
  cfg: DocTypeHandlerConfig,
  route: AuthenticatedDocEdgeRoute,
): Headers {
  const headers = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (route.generation === "legacy") {
    headers.set("X-Internal-Token", cfg.accessKey!);
  }
  headers.set("X-Tenant-Id", route.tenantId);
  headers.set("X-Doc-Type", cfg.docType);
  headers.set("X-Session-Id", route.sessionId);
  headers.set("X-UniDocs-Auth-Context", route.generation);
  headers.set("X-UniDocs-Doc-Operation", route.operation);
  if (route.delegatedCasCapability) {
    headers.set("X-UniDocs-CAS-Capability", route.delegatedCasCapability);
  }
  return headers;
}

function authenticationErrorResponse(error: unknown): Response {
  if (error instanceof CapabilityError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "Capability validation failed" }, { status: 401 });
}

function validateConfig(cfg: DocTypeHandlerConfig): void {
  if (cfg.internalAuthMode !== "legacy"
    && cfg.internalAuthMode !== "dual"
    && cfg.internalAuthMode !== "capability"
    && cfg.internalAuthMode !== "stack") {
    throw new TypeError("Doc internal auth mode must be explicit");
  }
  if ((cfg.internalAuthMode === "legacy" || cfg.internalAuthMode === "dual")
    && !cfg.accessKey) {
    throw new TypeError("Legacy Doc auth requires an access key");
  }
  if ((cfg.internalAuthMode === "capability" || cfg.internalAuthMode === "dual" || cfg.internalAuthMode === "stack")
    && (!cfg.docCapabilityVerifier || !cfg.casCapabilityVerifier)) {
    throw new TypeError("Capability Doc auth requires Doc and CAS verifiers");
  }
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
