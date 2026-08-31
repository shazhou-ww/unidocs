import {
  configFromEnv,
  createAdminBff,
  type AdminBffEnv,
  uiAssets,
} from "@unicas/admin-webui";
import { ControlPlaneService } from "@unicas/control-plane";
import mcpWorker, { type Env as McpEnv } from "@unicas/control-plane-mcp";
import {
  createUniCasService,
  matchUniCasServiceRoute,
  StackCapabilityVerifier,
  type BlobStore,
  type KeyedActorPort,
  type ServicePlatform,
  type SqlDatabase,
} from "@unicas/service";
import {
  AuditReadError,
  listRootDomainEvents,
  listRootDomainRefs,
  listRootDomains,
} from "./audit-reads.js";
import { AuthorityRepository } from "./control-authority.js";
import { migrateControlSchema } from "./control-schema.js";
import { ControlSessionStore } from "./control-sessions.js";
import {
  RootRefDomainDurableObject,
  type RootRefDomainDoEnv,
} from "./domain-do.js";
import { migrateStackTenantSchema } from "./schema.js";
import { CasDurableObject, type TenantCasDoEnv } from "./tenant-do.js";

export { CasDurableObject, RootRefDomainDurableObject };

export interface TenantEnv extends TenantCasDoEnv, RootRefDomainDoEnv {
  CAS_CONTROL_DB: D1Database;
  CAS_DO: DurableObjectNamespace;
  CAS_AUDIT_READER_KEY?: string;
}

export type Env = TenantEnv & AdminBffEnv & McpEnv & {
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
      handleAdminRequest: async ({ request: adminRequest }) =>
        (await adminHandlerFor(env))(stripAdminHeaders(adminRequest)),
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
      return (await adminHandlerFor(env))(stripAdminHeaders(request));
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
const controlSchemaInitializations = new WeakMap<object, Promise<void>>();
const adminHandlers = new WeakMap<object, Promise<(request: Request) => Promise<Response>>>();

function ensureControlSchema(env: Env): Promise<void> {
  const key = env as object;
  let initialization = controlSchemaInitializations.get(key);
  if (!initialization) {
    initialization = migrateControlSchema(env.CAS_CONTROL_DB);
    controlSchemaInitializations.set(key, initialization);
    void initialization.catch(() => controlSchemaInitializations.delete(key));
  }
  return initialization;
}

function adminHandlerFor(env: Env): Promise<(request: Request) => Promise<Response>> {
  const key = env as object;
  let handler = adminHandlers.get(key);
  if (!handler) {
    handler = (async () => {
      await ensureControlSchema(env);
      const config = configFromEnv(env);
      const now = config.now ?? (() => Date.now());
      return createAdminBff({
        config,
        controlPlane: new ControlPlaneService(env.CAS_CONTROL_DB, { now }),
        sessionStore: new ControlSessionStore(env.CAS_CONTROL_DB, now),
        auditReader: localAuditReader(env),
        assets: uiAssets,
      });
    })();
    adminHandlers.set(key, handler);
    void handler.catch(() => adminHandlers.delete(key));
  }
  return handler;
}

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
    refDomainActors: keyedActorPort(env.CAS_DOMAIN_DO as unknown as DurableObjectNamespace),
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
    async fetch(request) {
      const normalized = request instanceof Request
        ? request
        : new Request(request.toString());
      await migrateStackTenantSchema(env.CAS_DB);
      return handleAuditRpc(normalized, env, new URL(normalized.url));
    },
    connect() {
      throw new Error("UniCAS local audit reader does not support sockets");
    },
  };
}

/** Private audit-reader RPC. Requires the shared reader key; fail closed. */
async function handleAuditRpc(request: Request, env: Env, url: URL): Promise<Response> {
  const expectedKey = env.CAS_AUDIT_READER_KEY;
  if (!expectedKey || request.headers.get("X-CAS-Audit-Reader-Key") !== expectedKey) {
    return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const stackId = url.searchParams.get("stackId") ?? "";
  const refDomain = url.searchParams.get("refDomain") ?? "";
  try {
    if (url.pathname === "/_internal/audit/domains") {
      const domains = await listRootDomains({ db: env.CAS_DB, stackId });
      return Response.json({ domains }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/_internal/audit/refs") {
      const page = await listRootDomainRefs({
        db: env.CAS_DB,
        stackId,
        refDomain,
        tenantId: url.searchParams.get("tenantId") ?? undefined,
        limit: optionalNumber(url.searchParams.get("limit")),
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return Response.json({ revision: page.revision, refs: page.refs, nextCursor: page.nextCursor }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const page = await listRootDomainEvents({
      db: env.CAS_DB,
      stackId,
      refDomain,
      tenantId: url.searchParams.get("tenantId") ?? undefined,
      after: optionalNumber(url.searchParams.get("after")),
      limit: optionalNumber(url.searchParams.get("limit")),
    });
    return Response.json({ events: page.events, latestRevision: page.latestRevision, nextAfter: page.nextAfter }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AuditReadError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: "SERVICE_UNAVAILABLE", message: "audit read failed" }, { status: 503 });
  }
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function fetchMcp(
  request: Request,
  env: Env,
  auditReader: Fetcher,
  ctx: ExecutionContext,
): Promise<Response> {
  await ensureControlSchema(env);
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

export { StackCapabilityVerifier, permissionFor } from "@unicas/service";
export type { StackAuthEvent, VerifiedStackCall } from "@unicas/service";

export { migrateStackTenantSchema } from "./schema.js";

export { canonicalComposite, decodeComposite, stackCanonicalNodeKey } from "./do-names.js";

export type {
  CanonicalRootRefsUpdate,
  DomainUpdateResult,
  DomainRetryOptions,
  RootRefsErrorCode,
} from "./root-refs.js";
export { RootRefsRetryableError, RootRefsValidationError } from "./root-refs.js";

export type {
  RootDomainBalanceRow,
  RootDomainEventRow,
  RootDomainEventsPage,
  RootDomainRefsPage,
} from "./audit-reads.js";
export { AuditReadError } from "./audit-reads.js";