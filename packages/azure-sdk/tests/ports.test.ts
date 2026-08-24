/**
 * Runs the cloud-neutral port contract (`runPortContract`) against the real
 * Azure implementations: `ports-pg.ts` on a Postgres container and
 * `ports-blob.ts` on an Azurite container. Both containers are started once for
 * the whole run by `tests/containers.ts` (`globalSetup`).
 *
 * `transactional: true` — and it is not a formality. `deltas` and `docs` are two
 * tables in one database, so `PgUnitOfWork` gives a real `BEGIN`/`ROLLBACK` and
 * must satisfy the contract's two rollback assertions. The option is required
 * with no default precisely so a backend that CAN roll back cannot skip them by
 * omission.
 */

import { afterAll, beforeAll, expect } from "vitest";
import type { Pool } from "pg";
import type { BlobServiceClient } from "@azure/storage-blob";
import { runPortContract } from "@unidocs/doctype-server-common/port-contract";
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
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

// The contract's DocIndex tests address the indexed document as
// ("text", "doc-1") owned by "user-1" — those names are baked into the
// assertions — while every other test wants a document nobody has touched.
// So the index identity is pinned and per-test isolation rides on a fresh
// delta-log doc id plus a truncate of the two cross-document tables. This
// mirrors how the Cloudflare contract run separates X-Probe-Instance from
// X-Doc-Id (tests/integration/cloudflare/cf-port-contract.test.mjs).
const DOC_TYPE = "text";
const INDEX_DOC_ID = "doc-1";
const USER_ID = "user-1";

/**
 * How many idle connections the pool must hold before the contract's
 * concurrency sentinel runs. Two is the minimum for the two writers to overlap
 * at all; four leaves headroom.
 */
const WARM_CONNECTIONS = 4;

let pool: Pool;
let blobService: BlobServiceClient;
let docSeq = 0;

function nextDocId(): string {
  docSeq += 1;
  return `contract-doc-${docSeq}`;
}

/**
 * Make sure the pool holds at least `n` IDLE, ALREADY-USED connections.
 *
 * This is what makes the contract's concurrency sentinel actually concurrent,
 * and it is not optional. Two separate effects each hide the race on their own:
 *
 *   - `pg.Pool` opens connections purely on demand, so after a run of
 *     sequential statements it holds exactly one. The two racing `append()`
 *     calls then do not overlap: the first takes the single idle connection and
 *     completes its read AND its write in ~0.7ms, while the second waits ~4ms
 *     for a fresh TCP connect + auth handshake and so reads the head only after
 *     the first writer has committed. Measured here: with 1 idle connection the
 *     writers serialised 4/4, with 2 or more they interleaved 6/6.
 *   - A connection that has only completed its handshake still has a cold
 *     backend and answers its first statement ~0.5ms slower than one that has
 *     already run a query. `pg-pool` hands out the most recently used
 *     connection first, so writer A got a hot one and writer B a cold one —
 *     enough asymmetry, on its own, to close the window again. Hence the warm-up
 *     runs a real statement, not just `connect()`.
 *
 * The idle count keeps eroding, which is why this runs per-factory rather than
 * once in `beforeAll`: `pg-pool` calls `client.release(err)` on any failed
 * query and a release carrying an error DESTROYS the connection, and idle
 * connections also expire on `idleTimeoutMillis` (10s by default).
 *
 * A production server under load holds warm idle connections for exactly the
 * same reason, so this restores the realistic state rather than inventing one.
 */
async function warmPool(n: number): Promise<void> {
  const clients = await Promise.all(
    Array.from({ length: n }, () => pool.connect()),
  );
  // A real statement on every one of them, of the same shape the contract will
  // race — see the note above on cold backends.
  await Promise.all(
    clients.map((client) =>
      client.query(
        `SELECT COALESCE(MAX(version), 0) AS head FROM deltas WHERE doc_type = $1 AND doc_id = $2`,
        ["warmup", "warmup"],
      ),
    ),
  );
  for (const client of clients) client.release();

  // Assert, don't assume. Whether the sentinel can turn red depends entirely on
  // this warm-up, and `runPortContract` knows nothing about it — a backend
  // author who copies this harness and drops the warm-up gets a sentinel that
  // passes without ever having raced anything. That is precisely the failure
  // Task 1 hit on Cloudflare. Fail loudly instead of silently green.
  expect(pool.idleCount).toBeGreaterThanOrEqual(2);
}

async function makeAzurePorts(docId: string) {
  // `deltas` is isolated by the fresh doc id; `docs` / `doc_snapshots` are
  // global, so they get cleared to give each factory() the clean state the
  // contract assumes.
  await pool.query("TRUNCATE docs, doc_snapshots");

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
  pool = createPool({
    databaseUrl: DATABASE_URL,
    blobConnectionString: BLOB_CONNECTION_STRING,
  });
  // Idempotent: whichever test file gets here first applies the schema.
  await runMigrations(pool);
  blobService = createBlobService({
    databaseUrl: DATABASE_URL,
    blobConnectionString: BLOB_CONNECTION_STRING,
  });
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

runPortContract("postgres + blob ports", async () => makeAzurePorts(nextDocId()), {
  transactional: true,
  prepareConcurrency: async () => {
    await warmPool(WARM_CONNECTIONS);
    return {
      concurrentWriters: WARM_CONNECTIONS,
      how: `warmed the pg pool to ${WARM_CONNECTIONS} idle, already-used connections (see warmPool)`,
    };
  },
});
