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
import type { AdminContext, AdminMcpScope } from "@unidocs/portal-service";

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
      const tenantUi = serveTenantWebUi(request);
      if (tenantUi) {
        const requestId = crypto.randomUUID();
        tenantUi.headers.set("X-Request-ID", requestId);
        console.log(JSON.stringify({ event: "portal_request", requestId, path: new URL(request.url).pathname, status: tenantUi.status }));
        return tenantUi;
      }
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