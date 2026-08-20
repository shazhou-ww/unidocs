/**
 * Runs the cloud-neutral port contract (`runPortContract`) against the real
 * Azure implementations: `ports-pg.ts` on a Postgres container and
 * `ports-blob.ts` on an Azurite container, both from `docker-compose.azure.yml`.
 *
 * `transactional: true` — and it is not a formality. `deltas` and `docs` are two
 * tables in one database, so `PgUnitOfWork` gives a real `BEGIN`/`ROLLBACK` and
 * must satisfy the contract's two rollback assertions. The option is required
 * with no default precisely so a backend that CAN roll back cannot skip them by
 * omission.
 */

import { afterAll, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { BlobServiceClient } from "@azure/storage-blob";
import { runPortContract } from "@unidocs/server-core/port-contract";
import {
  BlobCasStore,
  BlobSnapshotCache,
  PgDeltaLog,
  PgDocIndex,
  PgDocIndexQuery,
  PgUnitOfWork,
  createBlobService,
  createPool,
  runMigrations,
} from "../src/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const COMPOSE_FILE = path.resolve(__dirname, "../../../docker-compose.azure.yml");
const DATABASE_URL = "postgres://unidocs:unidocs@localhost:5433/unidocs";
// Azurite's well-known emulator account, resolved by the SDK to
// http://127.0.0.1:10000/devstoreaccount1.
const BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true";

// The contract's DocIndex tests address the indexed document as
// ("text", "doc-1") owned by "user-1" — those names are baked into the
// assertions — while every other test wants a document nobody has touched.
// So the index identity is pinned and per-test isolation rides on a fresh
// delta-log doc id plus a truncate of the two cross-document tables. This
// mirrors how the Cloudflare contract run separates X-Probe-Instance from
// X-Doc-Id (scripts/cf-port-contract.test.mjs).
const DOC_TYPE = "text";
const INDEX_DOC_ID = "doc-1";
const USER_ID = "user-1";

let pool: Pool;
let blobService: BlobServiceClient;
let docSeq = 0;

function nextDocId(): string {
  docSeq += 1;
  return `contract-doc-${docSeq}`;
}

/** Poll with a real query: a freshly created container may still be running initdb. */
async function waitForPostgres(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const probe = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
    try {
      await probe.query("SELECT 1");
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await probe.end();
    }
  }
  throw new Error(`postgres did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

/** Same idea for Azurite: the blob endpoint accepts TCP before it serves the API. */
async function waitForAzurite(svc: BlobServiceClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await svc.getContainerClient("readiness-probe").createIfNotExists();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`azurite did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

/**
 * Make sure the pool holds at least `n` IDLE connections, by checking that many
 * out at once and handing them straight back.
 *
 * This is what makes the contract's concurrency sentinel actually concurrent,
 * and it is not optional. `pg.Pool` opens connections purely on demand, so
 * after a run of sequential statements it holds exactly one. The two racing
 * `append()` calls then do not overlap at all: the first takes the single idle
 * connection and completes its read AND its write in ~0.7ms, while the second
 * has to wait ~4ms for a fresh TCP connect + auth handshake, and so reads the
 * head only after the first writer has already committed. Measured on this
 * machine, the split is exact — with 1 idle connection the two writers
 * serialised in 4/4 attempts, with 2 or more they interleaved in 6/6.
 *
 * Two things keep eroding the idle count, which is why this runs per-factory
 * rather than once in `beforeAll`:
 *   - `pg-pool` calls `client.release(err)` on any failed query, and a release
 *     carrying an error DESTROYS the connection. One rejected statement = one
 *     fewer pooled connection.
 *   - idle connections also expire on `idleTimeoutMillis` (10s by default).
 *
 * A production server under load holds warm idle connections for exactly the
 * same reason, so this restores the realistic state rather than inventing one.
 */
async function warmPool(n: number): Promise<void> {
  const clients = await Promise.all(
    Array.from({ length: n }, () => pool.connect()),
  );
  // Run a real statement on every one of them, of the same shape the contract
  // will race. A connection that has only completed its handshake still has a
  // cold backend (no parsed/planned statement, nothing paged in) and answers
  // its first query measurably slower than a connection that has already run
  // one. That difference alone is enough to hide the race.
  await Promise.all(
    clients.map((client) =>
      client.query(
        `SELECT COALESCE(MAX(version), 0) AS head FROM deltas WHERE doc_type = $1 AND doc_id = $2`,
        ["warmup", "warmup"],
      ),
    ),
  );
  for (const client of clients) client.release();
}

async function makeAzurePorts(docId: string) {
  // `deltas` is isolated by the fresh doc id; `docs` / `doc_snapshots` are
  // global, so they get cleared to give each factory() the clean state the
  // contract assumes.
  await pool.query("TRUNCATE docs, doc_snapshots");
  await warmPool(4);

  const identity = { docType: DOC_TYPE, docId, userId: USER_ID };
  const indexIdentity = { docType: DOC_TYPE, docId: INDEX_DOC_ID, userId: USER_ID };

  return {
    deltas: new PgDeltaLog(pool, identity),
    snapshots: new BlobSnapshotCache(blobService, identity),
    blobs: new BlobCasStore(blobService),
    index: new PgDocIndex(pool, indexIdentity),
    indexQuery: new PgDocIndexQuery(pool),
    unitOfWork: new PgUnitOfWork(pool, identity),
  };
}

beforeAll(async () => {
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d`, { stdio: "inherit" });
  await waitForPostgres(60_000);
  pool = createPool({
    databaseUrl: DATABASE_URL,
    blobConnectionString: BLOB_CONNECTION_STRING,
  });
  await runMigrations(pool);

  blobService = createBlobService({
    databaseUrl: DATABASE_URL,
    blobConnectionString: BLOB_CONNECTION_STRING,
  });
  await waitForAzurite(blobService, 60_000);
}, 180_000);

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  execSync(`docker compose -f "${COMPOSE_FILE}" down`, { stdio: "inherit" });
}, 120_000);

runPortContract("postgres + blob ports", async () => makeAzurePorts(nextDocId()), {
  transactional: true,
});
