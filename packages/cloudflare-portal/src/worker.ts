import { D1PortalAuthRepository } from "./auth-repository.js";
import { createPortalBff } from "./bff.js";
import { portalGoogleConfigFromGateway } from "./google-config.js";
import { createDocumentTypesHttp } from "./document-types-http.js";
import { D1DocumentTypeRepository } from "./document-types-repository.js";
import { serveAdminWebUi, serveTenantWebUi } from "./static-assets.js";
import { createAdministratorsHttp } from "./administrators-http.js";
import { D1AdministratorRepository } from "./administrators-repository.js";
import { createAuditEventsHttp } from "./audit-events-http.js";
import { D1AuditEventRepository } from "./audit-events-repository.js";
import { createDocumentContractsHttp } from "./document-contracts-http.js";
import { D1DocumentContractRepository } from "./document-contracts-repository.js";
import { createTypeCardBundlesHttp } from "./type-card-bundles-http.js";
import { D1TypeCardBundleRepository } from "./type-card-bundles-repository.js";
import { R2BundleObjectStore } from "./bundle-object-store.js";
import { serveBundleObject } from "./bundle-ingress.js";
import { createViewBundlesHttp } from "./view-bundles-http.js";
import { D1ViewBundleRepository } from "./view-bundles-repository.js";
import { createOperatorValidationsHttp } from "./operator-validations-http.js";
import { D1OperatorValidationRepository } from "./operator-validations-repository.js";
import { createMarkdownOperatorValidationTarget } from "./operator-validation-target.js";
import { createOperatorsHttp } from "./operators-http.js";
import { D1OperatorRepository } from "./operators-repository.js";
import { ADMIN_MCP_PATHS, dispatchAdminMcp } from "./mcp/dispatcher.js";
import { hashSessionSecret, sessionTokenFromCookie } from "./auth.js";
import { createAdminMcpAuthorizationTransactions } from "./mcp/authorization-transactions.js";
import { createAdminMcpAuthorization } from "./mcp/authorization.js";
import { D1AdminMcpMembers } from "./mcp/members.js";
import { handleAdminMcp } from "./mcp/worker.js";
import { TenantAccessError, type AdminContext, type AdminMcpScope } from "@unidocs/portal-service";
import { createPortalCasRuntime } from "./cas-runtime.js";
import type { SnapshotStore } from "./snapshot-store.js";
import { D1TenantCatalogRepository } from "./tenant/catalog-repository.js";
import { D1TenantDocumentRepository } from "./tenant/document-repository.js";
import { createLocationValidator } from "./tenant/location-validator.js";
import { authenticateTenant, D1TenantSessionStore } from "./tenant/session.js";
import { createTenantSessionHttp } from "./tenant/session-http.js";
import { createTenantHttp } from "./tenant/tenant-http.js";
import { createOperatorDispatcher } from "./tenant/operator-dispatch.js";
import { createAgentHttp, isSubmissionPath } from "./tenant/agent-http.js";
import { CasUnavailableError } from "./tenant/cas-unavailable.js";
import { createInitializationRedelivery } from "./tenant/initialization-redelivery.js";
import { createSnapshotRetention } from "./tenant/snapshot-retention.js";
import { D1TenantSubmissionRepository } from "./tenant/submission-repository.js";
import { D1TenantThreadRepository } from "./tenant/thread-repository.js";
import { D1TenantVersionRepository } from "./tenant/version-repository.js";

function isTenantPath(path: string): boolean {
  return path === "/portal/auth/session" || path === "/portal/auth/logout" || path.startsWith("/api/v1/tenants/");
}

/**
 * Defers building the CAS-backed store until a snapshot is actually read.
 * `createPortalCasRuntime` throws when a CAS_* binding is missing, and only the
 * snapshot route needs CAS: built up front, an unconfigured CAS would fail
 * every authenticated tenant route (this worker has already gone down three times to a
 * capability built unconditionally on every request). Built here, the failure
 * surfaces inside `read()`, which the version repository maps to `unavailable`.
 * `build` is expected to throw `CasUnavailableError` for a store it cannot
 * build, so the Agent submissions adapter can log that case by type.
 */
function lazySnapshotStore(build: () => Promise<SnapshotStore>): SnapshotStore {
  let store: Promise<SnapshotStore> | undefined;
  const resolve = () => (store ??= build());
  return {
    read: async (ref, signal) => (await resolve()).read(ref, signal),
    retain: async (ref, requestId) => (await resolve()).retain(ref, requestId),
    release: async (ref, requestId) => (await resolve()).release(ref, requestId),
  };
}

/**
 * One lazy snapshot store per tenant for the life of a request. The request's
 * own tenant is the common case; the retention sweep can reach other tenants'
 * versions, and a CAS capability is tenant-scoped.
 */
function tenantSnapshotStores(env: Env): (tenantId: string) => SnapshotStore {
  const stores = new Map<string, SnapshotStore>();
  return tenantId => {
    let store = stores.get(tenantId);
    if (!store) {
      store = lazySnapshotStore(async () => {
        try {
          return await createPortalCasRuntime(env, tenantId);
        } catch (error) {
          throw new CasUnavailableError(error);
        }
      });
      stores.set(tenantId, store);
    }
    return store;
  };
}

/** Holds background work open when there is an execution context (tests have none); the work itself never rejects. */
function inBackground(context: ExecutionContext | undefined, work: Promise<unknown>): void {
  if (context) context.waitUntil(work);
  else void work;
}

const TENANT_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

/**
 * The tenant session endpoints and the tenant API. Every repository here is
 * cheap and does not throw on construction; CAS is the exception and is lazy.
 * An unexpected failure is answered here as a tenant error, so it neither
 * leaks its message (repository errors can carry SQL) nor falls through to
 * the worker's Administrator-shaped 503.
 */
async function serveTenant(request: Request, env: Env, path: string, context?: ExecutionContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  const now = () => Math.floor(Date.now() / 1000);
  let response: Response;
  try {
    const store = new D1TenantSessionStore(env.DB);
    // Plain string vars: reading them cannot throw, and an unset one simply
    // refuses every bearer inside authenticateAgent.
    const agent = { agentToken: env.AGENT_API_TOKEN, agentTenantId: env.AGENT_TENANT_ID };
    const session = await createTenantSessionHttp({
      origin: env.PORTAL_ORIGIN, store, now, ...agent,
      // Unset in production config: `undefined === "true"` keeps it off.
      devSession: env.PORTAL_TENANT_DEV_SESSION === "true",
    })(request, requestId);
    if (session) {
      response = session;
    } else {
      try {
        const tenant = await authenticateTenant(request, { origin: env.PORTAL_ORIGIN, now: now(), store, ...agent });
        // Built lazily, like CAS: `pnpm dev portal` binds neither the Markdown
        // Operator service nor its key, so the target is only constructed when a
        // committed write's type has a builtin Operator, and a construction
        // failure is logged by the dispatcher instead of failing the write.
        const dispatchToOperator = createOperatorDispatcher({
          database: env.DB,
          target: () => createMarkdownOperatorValidationTarget(env.ADMIN_MARKDOWN_SERVICE, env.MARKDOWN_OPERATOR_HMAC_KEY),
        });
        const snapshotStores = tenantSnapshotStores(env);
        const snapshots = snapshotStores(tenant.tenantId);
        if (isSubmissionPath(path)) {
          const retention = createSnapshotRetention({ database: env.DB, snapshots: snapshotStores });
          response = await createAgentHttp({
            submissions: new D1TenantSubmissionRepository(env.DB),
            snapshots,
            retention,
            validateLocation: createLocationValidator(),
          })(request, tenant, requestId);
          // Versions only ever come from submissions, so each one the Agent
          // lands is also the moment to repair any version whose retain was
          // lost earlier. A refused or malformed request triggers nothing.
          if (request.method === "POST" && response.status === 201) inBackground(context, retention.sweep());
        } else {
          const redeliverInitialization = createInitializationRedelivery({ database: env.DB, dispatch: dispatchToOperator });
          response = await createTenantHttp({
            catalog: new D1TenantCatalogRepository(env.DB),
            documents: new D1TenantDocumentRepository(env.DB),
            versions: new D1TenantVersionRepository(env.DB, snapshots),
            threads: new D1TenantThreadRepository(env.DB),
            validateLocation: createLocationValidator(),
            // The response does not wait for the Operator. With no execution
            // context (tests) the dispatch still starts, it is just not held
            // open; it never rejects, so nothing is left unhandled.
            onCommitted: write => inBackground(context, dispatchToOperator(write)),
            onUninitializedRead: ({ tenantId, documentId }) => inBackground(context, redeliverInitialization(tenantId, documentId)),
          })(request, tenant, requestId);
        }
      } catch (error) {
        if (!(error instanceof TenantAccessError)) throw error;
        response = Response.json(
          { error: { code: error.code, message: error.message, requestId } },
          { status: error.code === "unauthorized" ? 401 : 403 },
        );
      }
    }
  } catch (error) {
    // Name and message only, as bff.ts logs `portal_operation_failed`.
    console.error(JSON.stringify({
      event: "portal_operation_failed", requestId, path,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    }));
    response = Response.json({ error: { code: "internal_error", message: "Tenant operation failed", requestId } }, { status: 500 });
  }
  // Rebuilt rather than mutated in place: a Response can carry immutable
  // headers, and every tenant response must get these regardless of which
  // handler produced it. `new Headers(...)` keeps each Set-Cookie separate.
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(TENANT_HEADERS)) headers.set(name, value);
  headers.set("X-Request-ID", requestId);
  console.log(JSON.stringify({ event: "portal_request", requestId, path, status: response.status }));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    try {
      const mcpEnabled = env.MCP_ENABLED === "true";
      const requestPath = new URL(request.url).pathname;
      let mcpResponse: Response | null = null;
      if (mcpEnabled && (ADMIN_MCP_PATHS as readonly string[]).includes(requestPath)) {
        if (!context) throw new Error("MCP execution context unavailable");
        const { createAdminMcpOAuth } = await import("./mcp/oauth.js");
        const members = new D1AdminMcpMembers(env.DB);
        const allowedEmails = env.MCP_ADMIN_EMAIL_ALLOWLIST.split(",").map(value => value.trim()).filter(Boolean);
        const policy = {
          enabled: true,
          contentMutationsEnabled: env.MCP_CONTENT_MUTATIONS_ENABLED === "true",
          publishMutationsEnabled: env.MCP_PUBLISH_MUTATIONS_ENABLED === "true",
          securityMutationsEnabled: env.MCP_SECURITY_MUTATIONS_ENABLED === "true",
        };
        const resourceScopes: AdminMcpScope[] = [
          "admin:read",
          ...(policy.contentMutationsEnabled ? ["admin:content" as const] : []),
          ...(policy.publishMutationsEnabled ? ["admin:publish" as const] : []),
          ...(policy.securityMutationsEnabled ? ["admin:security" as const] : []),
        ];
        const provider = createAdminMcpOAuth({
          publicOrigin: env.MCP_PUBLIC_ORIGIN, allowedEmails, resourceScopes,
          authorize: (authorizationRequest, helpers) => {
            const authRepository = new D1PortalAuthRepository(env.DB);
            const transactions = createAdminMcpAuthorizationTransactions({
              database: env.DB, storage: env.OAUTH_KV, encryptionKey: env.OAUTH_STATE_ENCRYPTION_KEY, publicOrigin: env.MCP_PUBLIC_ORIGIN,
            });
            return createAdminMcpAuthorization({
              publicOrigin: env.MCP_PUBLIC_ORIGIN, helpers, transactions,
              authenticateSession: async sessionRequest => {
                const sessionHash = await hashSessionSecret(sessionTokenFromCookie(sessionRequest.headers.get("Cookie")));
                const session = await authRepository.findSession(sessionHash);
                if (!session) throw new Error("Invalid Admin session");
                return { memberId: session.memberId, identity: session.identity };
              },
              findMember: memberId => members.findById(memberId), allowedEmails,
            })(authorizationRequest);
          },
          api: (apiRequest, grant) => handleAdminMcp(apiRequest, env, context, grant, { publicOrigin: env.MCP_PUBLIC_ORIGIN, allowedEmails, policy }),
        });
        mcpResponse = await provider.fetch(request, env, context, true);
      } else if (!mcpEnabled) {
        mcpResponse = await dispatchAdminMcp(request, { enabled: false, publicOrigin: env.MCP_PUBLIC_ORIGIN });
      }
      if (mcpResponse) return mcpResponse;
      if (new URL(request.url).origin === env.BUNDLE_ORIGIN) return serveBundleObject(request, env.BUNDLES, env.PORTAL_ORIGIN);
      // Ahead of the BFF, and ahead of reading the Google settings: the tenant
      // UI has no login to gate it with (see `serveTenantWebUi`), the
      // admin-shaped BFF would send an anonymous visitor to `/admin/login`,
      // and it should still serve on an environment that has no Google client
      // configured at all.
      // The bare origin is what a developer opens first, and it has no page of
      // its own. Production routes only /admin, /mcp and the OAuth paths to this
      // worker (wrangler.production.jsonc), so this only ever answers locally.
      if (requestPath === "/" && (request.method === "GET" || request.method === "HEAD")) {
        const requestId = crypto.randomUUID();
        console.log(JSON.stringify({ event: "portal_request", requestId, path: requestPath, status: 302 }));
        return new Response(null, {
          status: 302,
          headers: { Location: "/portal/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Request-ID": requestId },
        });
      }
      const tenantUi = serveTenantWebUi(request);
      if (tenantUi) {
        const requestId = crypto.randomUUID();
        tenantUi.headers.set("X-Request-ID", requestId);
        console.log(JSON.stringify({ event: "portal_request", requestId, path: new URL(request.url).pathname, status: tenantUi.status }));
        return tenantUi;
      }
      // Ahead of the Google settings for the same reason as the tenant UI:
      // nothing in the tenant data plane needs Google, and a missing client
      // must not take it down.
      if (isTenantPath(requestPath)) return await serveTenant(request, env, requestPath, context);
      const config = portalGoogleConfigFromGateway({
        GATEWAY_OIDC_CLIENT_ID: env.GATEWAY_OIDC_CLIENT_ID,
        GATEWAY_OIDC_CLIENT_SECRET: env.GATEWAY_OIDC_CLIENT_SECRET,
        GATEWAY_OIDC_ISSUER: env.GATEWAY_OIDC_ISSUER,
      }, env.PORTAL_ORIGIN);
      const repository = new D1PortalAuthRepository(env.DB);
      const documentTypesHttp = createDocumentTypesHttp(new D1DocumentTypeRepository(env.DB));
      const administratorsHttp = createAdministratorsHttp(new D1AdministratorRepository(env.DB));
      const auditEventsHttp = createAuditEventsHttp(new D1AuditEventRepository(env.DB));
      const documentContractsHttp = createDocumentContractsHttp(new D1DocumentContractRepository(env.DB));
      const typeCardBundlesHttp = createTypeCardBundlesHttp(new D1TypeCardBundleRepository(env.DB), new R2BundleObjectStore(env.BUNDLES), env.BUNDLE_ORIGIN);
      const viewBundlesHttp = createViewBundlesHttp(new D1ViewBundleRepository(env.DB), new R2BundleObjectStore(env.BUNDLES), env.BUNDLE_ORIGIN);
      // Deliberately NOT built up front like the handlers above: the Markdown
      // Operator validation target needs ADMIN_MARKDOWN_SERVICE and
      // MARKDOWN_OPERATOR_HMAC_KEY, and `pnpm dev portal` binds neither --
      // there is no markdown worker running locally for a service binding to
      // target. Building it unconditionally on every request 503'd the whole
      // portal (tenant console and admin sign-in included) on an admin
      // capability most requests never touch. Building it only inside the
      // one route that needs it, and turning its "not configured" throw into
      // a scoped response, keeps that capability optional without disabling
      // the rest of the admin API.
      const operatorValidations = async (apiRequest: Request, admin: AdminContext, requestId: string): Promise<Response> => {
        let operatorTarget: ReturnType<typeof createMarkdownOperatorValidationTarget>;
        try {
          operatorTarget = createMarkdownOperatorValidationTarget(env.ADMIN_MARKDOWN_SERVICE, env.MARKDOWN_OPERATOR_HMAC_KEY);
        } catch {
          return Response.json({ error: { code: "operator_not_configured", message: "Markdown Operator validation is not configured", requestId } }, { status: 503 });
        }
        return createOperatorValidationsHttp(new D1OperatorValidationRepository(env.DB), operatorTarget.transport, operatorTarget.keys)(apiRequest, admin, requestId);
      };
      const operatorsHttp = createOperatorsHttp(new D1OperatorRepository(env.DB));
      const response = await createPortalBff(config, repository, {
        bootstrapEmail: env.PORTAL_BOOTSTRAP_EMAIL || null,
        bundleOrigin: env.BUNDLE_ORIGIN,
        adminApi: (apiRequest, admin, requestId) => {
          const path = new URL(apiRequest.url).pathname;
          if (path.startsWith("/admin/api/v1/administrators")) return administratorsHttp(apiRequest, admin, requestId);
          if (path === "/admin/api/v1/audit-events") return auditEventsHttp(apiRequest, admin, requestId);
          if (path.includes("/document-contracts")) return documentContractsHttp(apiRequest, admin, requestId);
          if (path.startsWith("/admin/api/v1/type-card-bundles")) return typeCardBundlesHttp(apiRequest, admin, requestId);
          if (path.startsWith("/admin/api/v1/view-bundles")) return viewBundlesHttp(apiRequest, admin, requestId);
          if (path.startsWith("/admin/api/v1/operator-validations")) return operatorValidations(apiRequest, admin, requestId);
          if (path.startsWith("/admin/api/v1/operators")) return operatorsHttp(apiRequest, admin, requestId);
          return documentTypesHttp(apiRequest, admin, requestId);
        },
        adminUi: serveAdminWebUi
      })(request);
      console.log(JSON.stringify({ event: "portal_request", requestId: response.headers.get("X-Request-ID"), path: new URL(request.url).pathname, status: response.status }));
      return response;
    } catch {
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ event: "portal_unavailable", requestId }));
      return Response.json({ error: { code: "internal_error", message: "Administrator service is unavailable", requestId } }, {
        status: 503, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Request-ID": requestId, "X-Content-Type-Options": "nosniff" },
      });
    }
  },
} satisfies ExportedHandler<Env>;