/**
 * Azure/Node entry point for the API Gateway.
 *
 * Cloudflare's equivalent (`packages/cloudflare-gateway/src/worker.ts`)
 * resolves `docType` -> worker URL from a KV registry, with an env var as
 * local fallback. Here the registry is `PgDocTypeRegistry` (Postgres-backed,
 * same database the doc-type workers write to): doc-type services upsert
 * their own `SELF_WORKER_URL` into it once they're actually listening, and
 * the gateway reads it back. An env var (`{TYPE}_WORKER_URL`) remains as a
 * fallback for local dev, where there's no Container Apps FQDN to register.
 *
 * `docIndex` is `PgDocIndexQuery` over the same Postgres database the
 * doc-type workers write to (shared `docs` table).
 *
 * CAS: transitional (deleted in phase 4). Without `CAS_BASE_URL` set,
 * `casFetcher` is a stub that 501s every request and `isPublicCasRoute` is a
 * constant `false`, so `/users/{userId}/cas/*` always 404s under
 * `createGatewayHandler`'s own routing (`isPublicCasRoute` gates before the
 * fetcher is ever called) — this keeps a markdown-only deployment from
 * failing to start over a variable it doesn't use. With `CAS_BASE_URL` set,
 * requests are proxied straight to the Cloudflare CAS worker; see
 * `packages/azure-sdk/src/doc-type-service.ts`'s `httpCasFetcher` for the
 * matching doc-type-service-side wiring and why this has to be the CAS
 * worker's own base URL, never the gateway's.
 *
 * Env vars: DATABASE_URL, INTERNAL_TOKEN, PORT, CAS_BASE_URL (optional), and
 * (local-dev fallback only) one `{TYPE}_WORKER_URL` per document type.
 */

import {
  attachPoolErrorLogger,
  createPool,
  PgDocIndexQuery,
  PgDocTypeRegistry,
  requireEnv,
  serve,
} from "@unidocs/azure-sdk";
import { isPublicCasRoute } from "@unidocs/http-protocol";
import { createGatewayHandler } from "@unidocs/gateway-common";
import { makeResolveWorkerUrl } from "./resolve-worker-url.js";

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const internalToken = requireEnv("INTERNAL_TOKEN");
  const port = Number(process.env.PORT ?? 8787);

  // Gateway never touches Blob Storage — `blobConnectionString` is unused by
  // `createPool`, so an empty string is fine (same idiom as
  // azure-sdk/tests/containers.ts's `waitForPostgres`).
  const pool = createPool({ databaseUrl, blobConnectionString: "" });
  attachPoolErrorLogger(pool, "azure-gateway");
  const docIndex = new PgDocIndexQuery(pool);
  const registry = new PgDocTypeRegistry(pool);
  const resolveWorkerUrl = makeResolveWorkerUrl(registry);

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
    internalToken,
    resolveWorkerUrl,
    casFetcher,
    docIndex,
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
