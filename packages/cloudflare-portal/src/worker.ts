import { D1PortalAuthRepository } from "./auth-repository.js";
import { createPortalBff } from "./bff.js";
import { portalGoogleConfigFromGateway } from "./google-config.js";
import { createDocumentTypesHttp } from "./document-types-http.js";
import { D1DocumentTypeRepository } from "./document-types-repository.js";
import { serveAdminWebUi } from "./static-assets.js";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).origin === env.BUNDLE_ORIGIN) return serveBundleObject(request, env.BUNDLES, env.PORTAL_ORIGIN);
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