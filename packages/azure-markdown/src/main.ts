/**
 * Azure/Node entry point for the Markdown document type.
 *
 * Cloudflare's equivalent (`packages/cloudflare-markdown/src/worker.ts`)
 * exports two Durable Object classes and lets the runtime address them.
 * There is no DO runtime here, so this process:
 *
 *   1. builds a Postgres pool + Blob Storage client from env vars
 *   2. wires `createDocTypeHandler` to a local "no DO" editor namespace
 *      (`./local-editor.js`) that builds a fresh `DocumentSession` per
 *      request straight from the pool/blob client — see that module's doc
 *      comment for why no session is cached across requests
 *   3. serves it over plain HTTP via `@unidocs/azure-sdk`'s `serve()`
 *
 * Migrations are NOT run here. `@unidocs/azure-sdk`'s `runMigrations()`
 * locates `migrations/*.sql` relative to its own module via
 * `import.meta.url`, which only resolves correctly when that module runs
 * from its own unbundled location; this package's `dist/main.js` is an
 * esbuild bundle (see `scripts/bundle.mjs` for why), and bundling rewrites
 * `import.meta.url` to point at the bundle, not at
 * `packages/azure-sdk/src/migrate.ts`'s real directory — so a bundled
 * `runMigrations()` call fails with `ENOENT` on `migrations`. Running
 * migrations against N horizontally-scaled replicas on every boot is
 * also not obviously the behavior you want anyway. Run migrations once,
 * unbundled, before starting this process — see the deployment doc / task
 * report for the exact command.
 *
 * Env vars: DATABASE_URL, BLOB_CONNECTION_STRING, INTERNAL_TOKEN, PORT.
 */

import {
  BlobCasStore,
  BlobSnapshotCache,
  createBlobService,
  createPool,
  PgDeltaLog,
  PgDocIndex,
  PgUnitOfWork,
  serve,
} from "@unidocs/azure-sdk";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import {
  CasClient,
  createDocTypeHandler,
  type DocIdentity,
  type SessionDeps,
} from "@unidocs/server-core";
import { createLocalEditorNamespace, createStubOperatorNamespace } from "./local-editor.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const blobConnectionString = requireEnv("BLOB_CONNECTION_STRING");
  const internalToken = requireEnv("INTERNAL_TOKEN");
  const port = Number(process.env.PORT ?? 8788);

  const pool = createPool({ databaseUrl, blobConnectionString });
  // `pg-pool` emits `error` on an idle client that goes bad (a dropped
  // connection, the DB restarting, ...). EventEmitter treats an `error`
  // event with no listener as an uncaught exception and kills the process —
  // without this listener, a routine DB blip takes the whole service down
  // instead of just failing the one request holding that connection.
  pool.on("error", (err) => {
    console.error("azure-markdown: pg pool error", err);
  });
  const blobService = createBlobService({ databaseUrl, blobConnectionString });

  const markdown = createMarkdownDocumentType({});

  // CAS is phase 4 — markdown's `refsFromOp` always returns `{}` (see
  // doctype-markdown/src/markdown.ts), so `leaseOpRefs`/`commitRootRefsOrRollback`
  // inside `DocumentSession.apply()` never actually call into this gateway.
  // It exists only to satisfy `SessionDeps.cas`'s type; every call it *would*
  // make 501s, matching the gateway's own CAS stub for this task.
  const casStubFetcher = {
    fetch: async () =>
      Response.json({ error: "CAS is not implemented on Azure yet" }, { status: 501 }),
  };

  function buildDeps(identity: DocIdentity): SessionDeps {
    return {
      deltas: new PgDeltaLog(pool, identity),
      snapshots: new BlobSnapshotCache(blobService, identity),
      blobs: new BlobCasStore(blobService),
      index: new PgDocIndex(pool, identity),
      unitOfWork: new PgUnitOfWork(pool, identity),
      cas: new CasClient({
        fetcher: casStubFetcher,
        userId: identity.userId,
        internalToken,
      }),
      identity,
      now: () => Date.now(),
    };
  }

  const handler = createDocTypeHandler({
    docType: "markdown",
    internalToken,
    editor: createLocalEditorNamespace(markdown, buildDeps),
    operator: createStubOperatorNamespace(),
  });

  const { close } = await serve(handler, { port, host: "0.0.0.0" });
  console.log(`azure-markdown listening on :${port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`azure-markdown received ${signal}, shutting down`);
    await close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("azure-markdown failed to start:", err);
  process.exit(1);
});
