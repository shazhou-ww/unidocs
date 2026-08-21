/**
 * Azure/Node entry point for the API Gateway.
 *
 * Cloudflare's equivalent (`packages/cloudflare-gateway/src/worker.ts`)
 * resolves `docType` -> worker URL from a KV registry, with an env var as
 * local fallback. Design doc 4.5: Azure has no KV-backed registry, so this
 * process resolves `docType` -> worker URL from `{TYPE}_WORKER_URL` env vars
 * only — platform DNS/service discovery stands in for the KV registry.
 *
 * `docIndex` is `PgDocIndexQuery` over the same Postgres database the
 * doc-type workers write to (shared `docs` table).
 *
 * CAS is phase 4: `casFetcher` is a stub that 501s every request, and
 * `isPublicCasRoute` is a constant `false`, so `/users/{userId}/cas/*` always
 * 404s under `createGatewayHandler`'s own routing (`isPublicCasRoute` gates
 * before the fetcher is ever called).
 *
 * Env vars: DATABASE_URL, INTERNAL_TOKEN, PORT, and one `{TYPE}_WORKER_URL`
 * per registered document type (e.g. MARKDOWN_WORKER_URL).
 */

import {
  attachPoolErrorLogger,
  createPool,
  PgDocIndexQuery,
  requireEnv,
  serve,
} from "@unidocs/azure-sdk";
import { createGatewayHandler } from "@unidocs/server-core";

function resolveWorkerUrl(docType: string): Promise<string | null> {
  const envKey = `${docType.toUpperCase()}_WORKER_URL`;
  return Promise.resolve(process.env[envKey] ?? null);
}

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

  const casFetcher = {
    fetch: async () =>
      Response.json({ error: "CAS is not implemented on Azure yet" }, { status: 501 }),
  };

  const handler = createGatewayHandler({
    internalToken,
    resolveWorkerUrl,
    casFetcher,
    docIndex,
    isPublicCasRoute: () => false,
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
