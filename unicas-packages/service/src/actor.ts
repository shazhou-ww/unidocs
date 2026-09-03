import {
  matchCasAdminRoute,
  type CasAdminRoute,
} from "@unicas/admin-protocol";
import {
  CapabilityError,
  matchCasRoute,
  type CasRoute,
} from "@unicas/tenant-protocol";
import {
  CasLeaseDurationHeader,
  CasUploadIdHeader,
  CasUploadLengthHeader,
} from "@unicas/tenant-protocol";
import type { ServicePlatform } from "./ports.js";

export interface HttpActor {
  fetch(request: Request): Promise<Response>;
}

export interface TenantRequestContext {
  readonly request: Request;
  readonly route: CasRoute;
  readonly platform: ServicePlatform;
}

export interface AuthorizedTenantCall {
  readonly stackId: string;
  readonly tenantId: string;
  readonly subject: string;
  readonly jti: string;
  readonly kid: string;
  readonly permissions: readonly string[];
  readonly refDomain?: string;
}

export interface AdminRequestContext {
  readonly request: Request;
  readonly route: CasAdminRoute;
  readonly platform: ServicePlatform;
}

export interface ServiceContext {
  readonly platform: ServicePlatform;
  authorizeTenantRequest(context: TenantRequestContext): Promise<AuthorizedTenantCall>;
  handleAdminRequest(context: AdminRequestContext): Promise<Response>;
}

export type UniCasServiceRoute =
  | { readonly plane: "tenant"; readonly route: CasRoute }
  | { readonly plane: "admin"; readonly route: CasAdminRoute };

export function matchUniCasServiceRoute(request: Request): UniCasServiceRoute | null {
  const pathname = new URL(request.url).pathname;
  const tenantRoute = matchCasRoute(request.method, pathname);
  if (tenantRoute) return { plane: "tenant", route: tenantRoute };
  const adminRoute = matchCasAdminRoute(request.method, pathname);
  if (adminRoute) return { plane: "admin", route: adminRoute };
  return null;
}

export function createUniCasService(context: ServiceContext): HttpActor {
  return {
    fetch(request) {
      const matched = matchUniCasServiceRoute(request);
      if (!matched) {
        return Promise.resolve(Response.json(
          { error: "Unknown UniCAS endpoint" },
          { status: 404 },
        ));
      }
      if (matched.plane === "tenant") {
        const tenantContext = {
          request,
          route: matched.route,
          platform: context.platform,
        };
        return context.authorizeTenantRequest(tenantContext)
          .then(
            (call) => dispatchTenantRequest(tenantContext, call),
            tenantAuthorizationErrorResponse,
          );
      }
      return context.handleAdminRequest({
        request,
        route: matched.route,
        platform: context.platform,
      });
    },
  };
}

function tenantAuthorizationErrorResponse(error: unknown): Response {
  if (error instanceof CapabilityError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "CAS capability validation failed" }, { status: 401 });
}

async function dispatchTenantRequest(
  context: TenantRequestContext,
  call: AuthorizedTenantCall,
): Promise<Response> {
  const { request, route, platform } = context;
  const actorKey = canonicalActorKey(call.stackId, call.tenantId);
  const headers: Record<string, string> = {
    "X-CAS-Stack-Id": call.stackId,
    "X-CAS-Tenant-Id": call.tenantId,
  };

  if (route.operation === "updateRootRefs") {
    if (call.refDomain === undefined) {
      return Response.json(
        { error: "ROOT_REF_INVALID", message: "Root Refs write requires a verified refDomain" },
        { status: 403 },
      );
    }
    headers["X-CAS-Ref-Domain"] = call.refDomain;
    return platform.tenantActors.fetch(actorKey, new Request(
      "https://tenant.internal/updateRootRefs",
      { method: "POST", headers, body: await request.text() },
    ));
  }

  let path: string;
  let method = "GET";
  let body: BodyInit | null | undefined;
  switch (route.operation) {
    case "readContent": {
      path = "/read";
      headers["X-CAS-Hash"] = route.hash;
      const range = request.headers.get("Range");
      if (range) headers.Range = range;
      break;
    }
    case "readMetadata":
      path = "/metadata";
      headers["X-CAS-Hash"] = route.hash;
      break;
    case "lease": {
      path = "/lease";
      method = "POST";
      headers["X-CAS-Hash"] = route.hash;
      const duration = request.headers.get(CasLeaseDurationHeader);
      if (duration) headers[CasLeaseDurationHeader] = duration;
      const contentType = request.headers.get("Content-Type");
      if (contentType) headers["Content-Type"] = contentType;
      const contentLength = request.headers.get("Content-Length");
      if (contentLength) headers["Content-Length"] = contentLength;
      const uploadLength = request.headers.get(CasUploadLengthHeader);
      if (uploadLength) headers[CasUploadLengthHeader] = uploadLength;
      const uploadId = request.headers.get(CasUploadIdHeader);
      if (uploadId) headers[CasUploadIdHeader] = uploadId;
      body = request.body;
      break;
    }
    case "usage":
      path = "/usage";
      break;
    case "gc":
      path = "/gc";
      method = "POST";
      body = request.body;
      break;
  }
  return platform.tenantActors.fetch(actorKey, new Request(
    `https://tenant.internal${path}`,
    {
      method,
      headers,
      ...(body === null || body === undefined ? {} : { body, duplex: "half" }),
    } as RequestInit & { duplex?: "half" },
  ));
}

function canonicalActorKey(stackId: string, component: string): string {
  if (stackId.length === 0 || component.length === 0) {
    throw new TypeError("actor key parts must not be empty");
  }
  return `${encodeURIComponent(stackId)}|${encodeURIComponent(component)}`;
}