import adminWorker, { type Env as AdminEnv } from "@unicas/admin-webui";
import { AuthorityRepository } from "@unicas/control-plane";
import mcpWorker, { type Env as McpEnv } from "@unicas/control-plane-mcp";
import tenantWorker, {
  CasDurableObject,
  RootRefDomainDurableObject,
  migrateStackTenantSchema,
  type Env as TenantEnv,
} from "@unicas/server-cloudflare";
import {
  createUniCasService,
  matchUniCasServiceRoute,
  StackCapabilityVerifier,
  type BlobStore,
  type KeyedActorPort,
  type ServicePlatform,
  type SqlDatabase,
} from "@unicas/service";

export { CasDurableObject, RootRefDomainDurableObject };

export type Env = TenantEnv & AdminEnv & McpEnv & {
  CAS_PUBLIC_ORIGIN?: string;
};

const TENANT_STRIPPED_HEADERS = [
  "cookie",
  "x-internal-token",
  "x-cas-audit-reader-key",
] as const;

const ADMIN_STRIPPED_HEADERS = [
  "x-internal-token",
  "x-cas-audit-reader-key",
] as const;

const MCP_STRIPPED_HEADERS = [
  "cookie",
  "x-internal-token",
  "x-cas-audit-reader-key",
] as const;

const MCP_METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
]);

const MCP_BROWSER_PATHS = new Set([
  "/oauth/authorize",
  "/oauth/google/callback",
]);

const MCP_TOKEN_PATHS = new Set([
  "/oauth/token",
  "/oauth/register",
]);

const MCP_BROWSER_COOKIE_NAMES = new Set([
  "unicas_mcp_oauth",
  "unicas_mcp_consent",
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true, service: "unicas" });
    }

    const platform = platformFromEnv(env);
    const auditReader = localAuditReader(env);
    const verifier = verifierFor(env);
    const actor = createUniCasService({
      platform,
      authorizeTenantRequest: async ({ request: tenantRequest, route }) => {
        try {
          return await verifier.verify(
            tenantAuthorizationRequest(tenantRequest),
            route,
          );
        } catch (error) {
          if (!(error instanceof Error) || error.name === "Error") {
            console.error("Unexpected tenant authorization failure", error);
          }
          throw error;
        }
      },
      handleAdminRequest: ({ request: adminRequest }) =>
        adminWorker.fetch(stripAdminHeaders(adminRequest), {
          ...env,
          CAS_TENANT_AUDIT_READER: auditReader,
        }),
    });

    const serviceRoute = matchUniCasServiceRoute(request);
    if (serviceRoute) {
      if (serviceRoute.plane === "tenant") await migrateStackTenantSchema(env.CAS_DB);
      try {
        return await actor.fetch(request);
      } catch (error) {
        console.error("Unhandled UniCAS service actor failure", error);
        throw error;
      }
    }

    if (isPrefixed(pathname, "/admin")) {
      return adminWorker.fetch(stripAdminHeaders(request), {
        ...env,
        CAS_TENANT_AUDIT_READER: auditReader,
      });
    }

    if (pathname === "/mcp") {
      const origin = request.headers.get("Origin");
      const publicOrigin = env.CAS_PUBLIC_ORIGIN ?? env.PUBLIC_ORIGIN;
      if (origin && origin !== publicOrigin) {
        return Response.json({ error: "MCP_ORIGIN_NOT_ALLOWED" }, { status: 403 });
      }
      return fetchMcp(stripHeaders(request, MCP_STRIPPED_HEADERS), env, auditReader, ctx);
    }
    if (MCP_METADATA_PATHS.has(pathname)) {
      return fetchMcp(stripMcpMetadataHeaders(request), env, auditReader, ctx);
    }
    if (MCP_BROWSER_PATHS.has(pathname)) {
      return fetchMcp(stripMcpBrowserHeaders(request), env, auditReader, ctx);
    }
    if (MCP_TOKEN_PATHS.has(pathname)) {
      return fetchMcp(stripHeaders(request, MCP_STRIPPED_HEADERS), env, auditReader, ctx);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const verifiers = new WeakMap<object, StackCapabilityVerifier>();

function verifierFor(env: Env): StackCapabilityVerifier {
  const key = env as object;
  let verifier = verifiers.get(key);
  if (!verifier) {
    verifier = new StackCapabilityVerifier({
      repository: new AuthorityRepository(env.CAS_CONTROL_DB),
      onEvent: (event) => {
        console.log(JSON.stringify({ event: "cas_stack_authorization", ...event }));
      },
    });
    verifiers.set(key, verifier);
  }
  return verifier;
}

function platformFromEnv(env: Env): ServicePlatform {
  return {
    controlDatabase: env.CAS_CONTROL_DB as unknown as SqlDatabase,
    tenantDatabase: env.CAS_DB as unknown as SqlDatabase,
    blobs: env.CAS_R2 as unknown as BlobStore,
    tenantActors: keyedActorPort(env.CAS_DO),
    refDomainActors: keyedActorPort(env.CAS_DOMAIN_DO),
  };
}

function keyedActorPort(namespace: DurableObjectNamespace): KeyedActorPort {
  return {
    fetch(key, request) {
      return namespace.get(namespace.idFromName(key)).fetch(request);
    },
  };
}

function localAuditReader(env: Env): Fetcher {
  return {
    fetch(request) {
      const normalized = request instanceof Request
        ? request
        : new Request(request.toString());
      return tenantWorker.fetch(normalized, env);
    },
    connect() {
      throw new Error("UniCAS local audit reader does not support sockets");
    },
  };
}

function fetchMcp(
  request: Request,
  env: Env,
  auditReader: Fetcher,
  ctx: ExecutionContext,
): Promise<Response> {
  return mcpWorker.fetch(request, {
    ...env,
    CAS_TENANT_AUDIT_READER: auditReader,
  }, ctx);
}

function isPrefixed(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function stripHeaders(request: Request, names: readonly string[]): Request {
  const headers = new Headers(request.headers);
  for (const name of names) headers.delete(name);
  return new Request(request, { headers });
}

function tenantAuthorizationRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of TENANT_STRIPPED_HEADERS) headers.delete(name);
  return new Request(request.url, { method: request.method, headers });
}

function stripAdminHeaders(request: Request): Request {
  const sanitized = stripHeaders(request, ADMIN_STRIPPED_HEADERS);
  const headers = new Headers(sanitized.headers);
  const authorization = headers.get("Authorization");
  if (!authorization || !/^Basic\s+/i.test(authorization)) {
    headers.delete("Authorization");
  }
  return new Request(sanitized, { headers });
}

function stripMcpMetadataHeaders(request: Request): Request {
  const sanitized = stripHeaders(request, MCP_STRIPPED_HEADERS);
  const headers = new Headers(sanitized.headers);
  headers.delete("Authorization");
  return new Request(sanitized, { headers });
}

function stripMcpBrowserHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  const cookies = (headers.get("Cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => MCP_BROWSER_COOKIE_NAMES.has(cookie.split("=", 1)[0] ?? ""));
  headers.delete("Authorization");
  headers.delete("X-Internal-Token");
  headers.delete("X-Cas-Audit-Reader-Key");
  if (cookies.length > 0) headers.set("Cookie", cookies.join("; "));
  else headers.delete("Cookie");
  return new Request(request, { headers });
}