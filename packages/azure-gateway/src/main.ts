/**
 * Azure/Node entry point for the API Gateway.
 *
 * Document services come from one deployment-time `DOC_SERVICES_JSON`
 * registry. There is no runtime registration or env-name fallback.
 *
 * The Gateway owns its `gateway_documents` directory. Doc services may still
 * share the physical Postgres instance during migration, but never read or
 * write that table.
 *
 * CAS: transitional (deleted in phase 4). Without `CAS_BASE_URL` set,
 * `casFetcher` is a stub that 501s every request and `isPublicCasRoute` is a
 * constant `false`, so `/tenants/{tenantId}/cas/*` always 404s under
 * `createGatewayHandler`'s own routing (`isPublicCasRoute` gates before the
 * fetcher is ever called) — this keeps a markdown-only deployment from
 * failing to start over a variable it doesn't use. With `CAS_BASE_URL` set,
 * requests are proxied straight to the Cloudflare CAS worker; see
 * `packages/azure-sdk/src/doc-type-service.ts`'s `httpCasFetcher` for the
 * matching doc-type-service-side wiring and why this has to be the CAS
 * worker's own base URL, never the gateway's.
 *
 * Env vars: DATABASE_URL, DOC_SERVICES_JSON, CAS_STACK_ID, PORT, and
 * CAS_BASE_URL (optional).
 */

import {
  attachPoolErrorLogger,
  createPool,
  requireEnv,
  serve,
} from "@unidocs/azure-sdk";
import { isGatewayExposedCasRoute } from "@unidocs/protocol-gateway";
import {
  createGatewayHandler,
  createInsecureTenantIdentityResolver,
  GatewayCapabilityAuthority,
  StaticDocServiceRegistry,
} from "@unidocs/gateway-common";
import {
  createGatewayOAuthDiscoveryHandler,
  type GatewayOAuthDiscoveryHandler,
} from "@unidocs/gateway-oauth";
import {
  createPkcs8CapabilityIssuer,
  derivePkcs8CapabilityPublicJwk,
  parseCapabilityRuntimePolicy,
} from "@unidocs/service-auth";
import { PgGatewayDocumentDirectory } from "./document-directory.js";
import { hasWebAssets, webAssetResponse } from "./web-assets.js";

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const registry = new StaticDocServiceRegistry(requireEnv("DOC_SERVICES_JSON"));
  const policy = parseCapabilityRuntimePolicy(process.env);
  const casStackId = requireEnv("CAS_STACK_ID");
  const casStackIssuer = requireEnv("CAS_STACK_ISSUER");
  const casStackKeyId = requireEnv("CAS_STACK_KEY_ID");
  const casStackPrivateKey = requireEnv("CAS_STACK_PRIVATE_KEY_PKCS8");
  const oauthDiscovery = await createOAuthDiscovery(
    process.env.GATEWAY_OAUTH_ISSUER,
    casStackIssuer,
    casStackKeyId,
    casStackPrivateKey,
  );
  const capabilityAuthority = new GatewayCapabilityAuthority({
    issuer: await createPkcs8CapabilityIssuer({
      issuer: requireEnv("CAPABILITY_ISSUER"),
      kid: requireEnv("CAPABILITY_KEY_ID"),
      privateKeyPkcs8: requireEnv("CAPABILITY_PRIVATE_KEY_PKCS8"),
      defaultLifetimeSeconds: policy.defaultLifetimeSeconds,
      maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
    }),
    casIssuer: await createPkcs8CapabilityIssuer({
      issuer: casStackIssuer,
      kid: casStackKeyId,
      privateKeyPkcs8: casStackPrivateKey,
      defaultLifetimeSeconds: policy.defaultLifetimeSeconds,
      maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
    }),
    casAudience: requireEnv("CAS_CAPABILITY_AUDIENCE"),
    casStackId,
    casRefDomain: process.env.CAS_REF_DOMAIN,
    audit: event => console.log(JSON.stringify({ event: "gateway_capability_issued", ...event })),
  });
  const port = Number(process.env.PORT ?? 8787);
  // 0 / 缺省 = 不限,与这个开关存在之前的行为一致。
  const declaredLimit = Number(process.env.MAX_UPLOAD_BYTES ?? 0);
  const maxUploadBytes = Number.isSafeInteger(declaredLimit) && declaredLimit > 0
    ? declaredLimit
    : undefined;

  // Gateway never touches Blob Storage — `blobConnectionString` is unused by
  // `createPool`, so an empty string is fine (same idiom as
  // azure-sdk/tests/containers.ts's `waitForPostgres`).
  const pool = createPool({ databaseUrl, blobConnectionString: "" });
  attachPoolErrorLogger(pool, "azure-gateway");
  const directory = new PgGatewayDocumentDirectory(pool);

  // Transitional (deleted in phase 4): CAS_BASE_URL points at the
  // Cloudflare CAS worker itself. Unset means unchanged behavior — CAS
  // routes always 404 (isPublicCasRoute is a constant false) — so a
  // markdown-only deployment doesn't fail to start over a variable it has
  // no use for.
  const casBaseUrl = process.env.CAS_BASE_URL;
  const casFetcher = casBaseUrl
    ? {
      fetch: async (input: string | Request, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        return fetch(`${casBaseUrl.replace(/\/$/, "")}${url.pathname}${url.search}`, req);
      },
    }
    : {
      fetch: async () =>
        Response.json({ error: "CAS is not implemented on Azure yet" }, { status: 501 }),
    };

  const handler = createGatewayHandler({
    capabilityAuthority,
    identityResolver: createInsecureTenantIdentityResolver(
      process.env.INSECURE_PATH_IDENTITY === "true",
    ),
    resolveDocService: (docType) => registry.resolve(docType),
    casFetcher,
    directory,
    isGatewayExposedCasRoute: casBaseUrl ? isGatewayExposedCasRoute : () => false,
    ...(maxUploadBytes === undefined ? {} : { maxUploadBytes }),
    casStackId,
  });

  // The built web-psd app is served from this same origin (see
  // src/web-assets.ts). `/tenants/*` stays with the API handler; everything
  // else falls through to the UI, so the SPA and its API live under one
  // hostname and no CORS is involved.
  const withUi = async (request: Request): Promise<Response> =>
    await oauthDiscovery?.(request) ?? webAssetResponse(request) ?? handler(request);

  const { close } = await serve(withUi, { port, host: "0.0.0.0" });
  console.log(
    `azure-gateway listening on :${port}` + (hasWebAssets() ? " (web-psd UI bundled)" : " (no UI bundled)"),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`azure-gateway received ${signal}, shutting down`);
    await close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function createOAuthDiscovery(
  oauthIssuer: string | undefined,
  casIssuer: string,
  kid: string,
  privateKeyPkcs8: string,
): Promise<GatewayOAuthDiscoveryHandler | null> {
  if (!oauthIssuer) return null;
  if (oauthIssuer !== casIssuer) {
    throw new Error("GATEWAY_OAUTH_ISSUER must exactly equal CAS_STACK_ISSUER");
  }
  const publicJwk = await derivePkcs8CapabilityPublicJwk(privateKeyPkcs8);
  return createGatewayOAuthDiscoveryHandler({
    metadata: { issuer: oauthIssuer },
    signingKeys: {
      publicSigningKeys: async () => [{ algorithm: "ES256", kid, publicJwk }],
    },
  });
}

main().catch((err) => {
  console.error("azure-gateway failed to start:", err);
  process.exit(1);
});
