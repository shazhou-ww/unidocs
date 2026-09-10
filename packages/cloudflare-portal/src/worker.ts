import { D1PortalAuthRepository } from "./auth-repository.js";
import { createPortalBff } from "./bff.js";
import { portalGoogleConfigFromGateway } from "./google-config.js";
import { createDocumentTypesHttp } from "./document-types-http.js";
import { D1DocumentTypeRepository } from "./document-types-repository.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const config = portalGoogleConfigFromGateway({
        GATEWAY_OIDC_CLIENT_ID: env.GATEWAY_OIDC_CLIENT_ID,
        GATEWAY_OIDC_CLIENT_SECRET: env.GATEWAY_OIDC_CLIENT_SECRET,
        GATEWAY_OIDC_ISSUER: env.GATEWAY_OIDC_ISSUER,
      }, env.PORTAL_ORIGIN);
      const repository = new D1PortalAuthRepository(env.DB);
      const response = await createPortalBff(config, repository, { bootstrapEmail: env.PORTAL_BOOTSTRAP_EMAIL || null, adminApi: createDocumentTypesHttp(new D1DocumentTypeRepository(env.DB)) })(request);
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