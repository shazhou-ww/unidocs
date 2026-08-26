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
 * Env vars: DATABASE_URL, DOC_SERVICES_JSON, CAS_ACCESS_KEY, PORT, and
 * CAS_BASE_URL (optional).
 */

import {
  attachPoolErrorLogger,
  createPool,
  requireEnv,
  serve,
} from "@unidocs/azure-sdk";
import { isPublicCasRoute } from "@unidocs/protocol-cas";
import {
  createGatewayHandler,
  createInsecureTenantIdentityResolver,
  GatewayCapabilityAuthority,
  parseGatewayInternalAuthMode,
  StaticDocServiceRegistry,
} from "@unidocs/gateway-common";
import { createPkcs8CapabilityIssuer } from "@unidocs/service-auth";
import { PgGatewayDocumentDirectory } from "./document-directory.js";

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const registry = new StaticDocServiceRegistry(requireEnv("DOC_SERVICES_JSON"));
  const internalAuthMode = parseGatewayInternalAuthMode(process.env.INTERNAL_AUTH_MODE);
  const casAccessKey = internalAuthMode === "capability"
    ? undefined
    : requireEnv("CAS_ACCESS_KEY");
  const capabilityAuthority = internalAuthMode === "legacy"
    ? undefined
    : new GatewayCapabilityAuthority({
      issuer: await createPkcs8CapabilityIssuer({
        issuer: requireEnv("CAPABILITY_ISSUER"),
        kid: requireEnv("CAPABILITY_KEY_ID"),
        privateKeyPkcs8: requireEnv("CAPABILITY_PRIVATE_KEY_PKCS8"),
      }),
      casAudience: requireEnv("CAS_CAPABILITY_AUDIENCE"),
      audit: event => console.log(JSON.stringify({ event: "gateway_capability_issued", ...event })),
    });
  const port = Number(process.env.PORT ?? 8787);

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
    internalAuthMode,
    casAccessKey,
    capabilityAuthority,
    identityResolver: createInsecureTenantIdentityResolver(
      process.env.INSECURE_PATH_IDENTITY === "true",
    ),
    resolveDocService: (docType) => registry.resolve(docType),
    casFetcher,
    directory,
    isPublicCasRoute: casBaseUrl ? isPublicCasRoute : () => false,
  });

  const { close } = await serve(handler, { port, host: "0.0.0.0" });
  console.log(`azure-gateway listening on :${port}`);

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

main().catch((err) => {
  console.error("azure-gateway failed to start:", err);
  process.exit(1);
});
