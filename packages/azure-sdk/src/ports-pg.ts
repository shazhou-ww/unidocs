/**
 * Postgres implementations of the three relational server-core storage ports
 * (`DeltaLog`, `DocIndex`, `DocIndexQuery`) plus the real `UnitOfWork`.
 *
 * Table shapes come from `migrations/0001_init.sql`. Nothing here imports a
 * Cloudflare type: the semantics are the ones documented on
 * `@unidocs/server-core`'s `ports.ts`, re-expressed as Postgres SQL (the
 * Cloudflare adapter expresses the same semantics as sqlite/D1).
 *
 * A note on numbers: `pg` returns `int8`/`bigint` columns as *strings* (they do
 * not fit in a JS number in general), so every `timestamp`, `created_at`,
 * `updated_at` and `count(*)` read below goes through `Number(...)`. `version`
 * is `INTEGER` (`int4`) and already arrives as a number, but is normalised the
 * same way so the mapping never depends on which of the two a column happens to
 * be. `operations` is `JSONB` — `pg` parses it for us, so it must NOT be
 * `JSON.parse`d again.
 */

import type {
  Delta,
  DeltaLog,
  DocIdentity,
  DocIndex,
  DocIndexQuery,
  DocRecord,
  SnapshotRef,
  TransactionalPorts,
  UnitOfWork,
} from "@unidocs/server-core";
import { VersionConflictError } from "@unidocs/server-core";
import type { Pool } from "pg";

/**
 * The common subset of `pg.Pool` and `pg.PoolClient`, so a port instance can be
 * built over either the pool (autocommit, one connection per statement) or over
 * a single checked-out connection inside a transaction. `PgUnitOfWork` relies on
 * exactly this: it hands the port constructors the transaction's `PoolClient`.
 */
export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function toDelta(row: Record<string, unknown>): Delta {
  return {
    version: toNumber(row.version),
    timestamp: toNumber(row.timestamp),
    // `description` is a nullable column; the port type is a plain string.
    description: (row.description as string | null) ?? "",
    // JSONB: already an array by the time it gets here.
    operations: row.operations as unknown[],
  };
}

/**
 * `DeltaLog` over the `deltas` table, scoped to one `(doc_type, doc_id)`.
 */
export class PgDeltaLog implements DeltaLog {
  #q: Queryable;
  #identity: DocIdentity;

  constructor(q: Queryable, identity: DocIdentity) {
    this.#q = q;
    this.#identity = identity;
  }

  /**
   * The conditional write the `DeltaLog.append` contract demands: check and
   * insert in ONE statement, never `head()` followed by an `INSERT`.
   *
   * Two independent guards, both required:
   *
   *  1. `WHERE (SELECT COALESCE(MAX(version), 0) ...) = $3 - 1` — the version
   *     rule. It rejects a stale `baseVersion` (would rewrite history) and a
   *     future one (would leave a gap replay silently skips). The sub-select is
   *     evaluated inside the same statement as the insert, so there is no
   *     application-visible window between them.
   *
   *  2. `ON CONFLICT (doc_type, doc_id, version) DO NOTHING` — the primary key.
   *     Guard 1 alone is not enough under concurrency: at READ COMMITTED two
   *     overlapping statements both take their snapshot before either commits,
   *     so both can see the same `MAX(version)` and both clear the WHERE. The
   *     primary key is what actually serialises them — the second insert blocks
   *     on the index entry until the first commits, and then finds the row
   *     already there. Spelling it as `DO NOTHING` rather than letting it raise
   *     `23505` matters inside `withTransaction`: a raised unique violation
   *     would abort the surrounding transaction and make the follow-up `head()`
   *     read fail, whereas `DO NOTHING` funnels the loss into the very same
   *     `rowCount === 0` signal as guard 1.
   *
   * Either guard failing means someone else owns this version: re-read the head
   * and report the conflict.
   */
  async append(d: Delta): Promise<void> {
    const result = await this.#q.query(
      `INSERT INTO deltas (doc_type, doc_id, version, timestamp, description, operations)
       SELECT $1::text, $2::text, $3::int, $4::bigint, $5::text, $6::jsonb
       WHERE (
         SELECT COALESCE(MAX(version), 0) FROM deltas
         WHERE doc_type = $1::text AND doc_id = $2::text
       ) = $3::int - 1
       ON CONFLICT (doc_type, doc_id, version) DO NOTHING`,
      [
        this.#identity.docType,
        this.#identity.docId,
        d.version,
        d.timestamp,
        d.description,
        JSON.stringify(d.operations),
      ],
    );

    if ((result.rowCount ?? 0) === 0) {
      const head = await this.head();
      throw new VersionConflictError(head, d.version);
    }
  }

  async head(): Promise<number> {
    const result = await this.#q.query(
      `SELECT COALESCE(MAX(version), 0) AS head FROM deltas
       WHERE doc_type = $1 AND doc_id = $2`,
      [this.#identity.docType, this.#identity.docId],
    );
    return toNumber(result.rows[0]?.head ?? 0);
  }

  async since(v: number): Promise<Delta[]> {
    const result = await this.#q.query(
      `SELECT version, timestamp, description, operations FROM deltas
       WHERE doc_type = $1 AND doc_id = $2 AND version > $3
       ORDER BY version ASC`,
      [this.#identity.docType, this.#identity.docId, v],
    );
    return result.rows.map(toDelta);
  }

  async range(from?: number, to?: number): Promise<Delta[]> {
    const values: unknown[] = [this.#identity.docType, this.#identity.docId];
    let sql = `SELECT version, timestamp, description, operations FROM deltas
       WHERE doc_type = $1 AND doc_id = $2`;
    if (from !== undefined) {
      values.push(from);
      sql += ` AND version >= $${values.length}`;
    }
    if (to !== undefined) {
      values.push(to);
      sql += ` AND version <= $${values.length}`;
    }
    sql += " ORDER BY version ASC";

    const result = await this.#q.query(sql, values);
    return result.rows.map(toDelta);
  }

  /**
   * Conditional delete: `v` is removed only if `v` is still the head *as this
   * statement sees it*. Never throws — this runs on an already-failing
   * compensation branch (a failed root-refs commit), and losing the race is an
   * expected outcome, not a new error to surface.
   *
   * **This narrows the race with a concurrent `append`; it does not close it.**
   * Against an append that has already COMMITTED `v + 1`, the guard holds: the
   * sub-select sees `MAX(version) = v + 1`, the predicate fails, and the delete
   * is a no-op — which is the case the port contract exercises. Against an
   * append that is still IN FLIGHT, it does not:
   *
   *   1. B: `INSERT ... version = v + 1` starts. Its snapshot sees `MAX = v`,
   *      so its own WHERE clause passes. Not committed yet.
   *   2. A: `DELETE ... version = v` starts. Under READ COMMITTED it takes its
   *      own snapshot, which does not include B's uncommitted row, so it also
   *      sees `MAX = v` and the guard passes.
   *   3. Neither blocks the other: they lock different index keys (`v` and
   *      `v + 1`), so there is nothing for either to wait on.
   *   4. Both commit. The log now holds `... v - 1, v + 1` — the hole this
   *      guard exists to prevent. Replay skips straight over the gap and
   *      silently diverges from what any client that read version `v` was shown.
   *
   * This gap is known and deliberately accepted for now (see section 9 of
   * `docs/superpowers/specs/2026-08-20-azure-phase2-azure-sdk-design.md`); the
   * fix is a `pg_advisory_xact_lock` on `(docType, docId)` taken by BOTH
   * `append` and `remove`, which turns steps 1-2 into a real wait. It is not
   * taken here because `append` alone must stay lock-free on its hot path.
   *
   * Cloudflare has no such window: every call into a Durable Object is
   * serialised by the DO itself, so `remove` and `append` can never overlap
   * there. This is a cost of moving to stateless replicas, not a translation
   * error in the SQL.
   */
  async remove(v: number): Promise<void> {
    await this.#q.query(
      `DELETE FROM deltas
       WHERE doc_type = $1 AND doc_id = $2 AND version = $3
         AND version = (
           SELECT MAX(version) FROM deltas WHERE doc_type = $1 AND doc_id = $2
         )`,
      [this.#identity.docType, this.#identity.docId, v],
    );
  }

  async latestSnapshotRef(atOrBefore?: number): Promise<SnapshotRef | null> {
    const values: unknown[] = [this.#identity.docType, this.#identity.docId];
    let sql = `SELECT version, hash FROM doc_snapshots
       WHERE doc_type = $1 AND doc_id = $2`;
    if (atOrBefore !== undefined) {
      values.push(atOrBefore);
      sql += ` AND version <= $${values.length}`;
    }
    sql += " ORDER BY version DESC LIMIT 1";

    const result = await this.#q.query(sql, values);
    const row = result.rows[0];
    if (!row) return null;
    return { version: toNumber(row.version), hash: row.hash as string };
  }

  /**
   * Idempotent by version: re-recording a snapshot for a version already known
   * overwrites it, matching the Cloudflare adapter's `INSERT OR REPLACE`.
   *
   * This writes the same `doc_snapshots` table `PgDocIndex.recordSnapshot()`
   * writes. On Cloudflare those are two physically separate stores (the DO's
   * private sqlite and D1) that happen to hold the same facts; on one Postgres
   * database they collapse into one table, and the upsert makes the duplicate
   * write from a session that calls both a no-op rather than a violation.
   */
  async recordSnapshot(v: number, hash: string, timestamp: number): Promise<void> {
    await this.#q.query(
      `INSERT INTO doc_snapshots (doc_type, doc_id, version, hash, timestamp)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (doc_type, doc_id, version)
       DO UPDATE SET hash = EXCLUDED.hash, timestamp = EXCLUDED.timestamp`,
      [this.#identity.docType, this.#identity.docId, v, hash, timestamp],
    );
  }

  async countSince(v: number): Promise<number> {
    const result = await this.#q.query(
      `SELECT COUNT(*) AS n FROM deltas
       WHERE doc_type = $1 AND doc_id = $2 AND version > $3`,
      [this.#identity.docType, this.#identity.docId, v],
    );
    // COUNT(*) is bigint — `pg` hands it back as a string.
    return toNumber(result.rows[0]?.n ?? 0);
  }
}

/**
 * `DocIndex` over the shared `docs` / `doc_snapshots` tables, scoped to one
 * document identity.
 *
 * Like the Cloudflare `D1DocIndex`, this is handed its `DocIdentity` up front,
 * so `register()` does not need to teach it who it is indexing. It still
 * honours the port contract's ordering requirement (`register()` before
 * `touch()`/`recordSnapshot()`) — without the `docs` row, `touch()` has nothing
 * to update.
 */
export class PgDocIndex implements DocIndex {
  #q: Queryable;
  #identity: DocIdentity;

  constructor(q: Queryable, identity: DocIdentity) {
    this.#q = q;
    this.#identity = identity;
  }

  /**
   * Upsert, because the contract allows `register()` to be called repeatedly
   * for the same document (session creation and `init_from_hash` both do it),
   * and a second call must refresh the record rather than raise.
   */
  async register(rec: DocRecord): Promise<void> {
    await this.#q.query(
      `INSERT INTO docs (doc_id, doc_type, owner_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (doc_id, doc_type)
       DO UPDATE SET owner_id = EXCLUDED.owner_id,
                     created_at = EXCLUDED.created_at,
                     updated_at = EXCLUDED.updated_at`,
      [rec.docId, rec.docType, rec.ownerId, rec.createdAt, rec.updatedAt],
    );
  }

  // `ownerId` is not part of `touch()`, so the row is keyed on the `docs`
  // primary key alone.
  async touch(at: number): Promise<void> {
    await this.#q.query(
      `UPDATE docs SET updated_at = $1 WHERE doc_id = $2 AND doc_type = $3`,
      [at, this.#identity.docId, this.#identity.docType],
    );
  }

  async recordSnapshot(version: number, hash: string, timestamp: number): Promise<void> {
    await this.#q.query(
      `INSERT INTO doc_snapshots (doc_type, doc_id, version, hash, timestamp)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (doc_type, doc_id, version)
       DO UPDATE SET hash = EXCLUDED.hash, timestamp = EXCLUDED.timestamp`,
      [this.#identity.docType, this.#identity.docId, version, hash, timestamp],
    );
  }
}

/** Read side of the index. Not scoped to a document — it queries across them. */
export class PgDocIndexQuery implements DocIndexQuery {
  #q: Queryable;

  constructor(q: Queryable) {
    this.#q = q;
  }

  /**
   * `ORDER BY updated_at DESC` is contractual, not cosmetic: list UIs show
   * "recently updated" and physical/insertion order would silently break them.
   * The `docs_owner_type_idx` index in 0001_init.sql covers exactly this
   * predicate + ordering.
   */
  async list(userId: string, docType: string): Promise<DocRecord[]> {
    const result = await this.#q.query(
      `SELECT doc_id, doc_type, owner_id, created_at, updated_at FROM docs
       WHERE owner_id = $1 AND doc_type = $2
       ORDER BY updated_at DESC`,
      [userId, docType],
    );
    return result.rows.map((row) => ({
      docId: row.doc_id as string,
      docType: row.doc_type as string,
      ownerId: row.owner_id as string,
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    }));
  }

  async snapshots(docType: string, docId: string): Promise<SnapshotRef[]> {
    const result = await this.#q.query(
      `SELECT version, hash FROM doc_snapshots
       WHERE doc_type = $1 AND doc_id = $2
       ORDER BY version ASC`,
      [docType, docId],
    );
    return result.rows.map((row) => ({
      version: toNumber(row.version),
      hash: row.hash as string,
    }));
  }
}

/**
 * A real `BEGIN`/`COMMIT`/`ROLLBACK` over the two transactional ports.
 *
 * The whole point is that every statement in the callback runs on ONE
 * connection: a pooled `query()` picks an arbitrary connection per call, which
 * would leave the callback's writes scattered across connections and outside
 * the `BEGIN`. So the connection is checked out here and passed *as the
 * `Queryable`* into freshly constructed `PgDeltaLog` / `PgDocIndex` instances,
 * and those instances — not the ones the caller captured from an enclosing
 * scope — are what the callback is handed. That is why the `UnitOfWork`
 * contract insists the callback use the ports it is given.
 *
 * A normal return commits; a throw rolls back and propagates the original
 * error. The connection is released in `finally` either way.
 *
 * The `BEGIN` pins the isolation level explicitly to `READ COMMITTED` rather
 * than trusting the server's `default_transaction_isolation`. This is not
 * defensive boilerplate: `PgDeltaLog.append()`'s conflict handling and
 * `remove()`'s window analysis above are both written *as arguments about
 * READ COMMITTED specifically* — they reason about what a statement's
 * snapshot can and cannot see relative to concurrent, possibly-uncommitted
 * writes under that isolation level. A deployment that raises the server
 * default to REPEATABLE READ (a single `ALTER DATABASE ... SET
 * default_transaction_isolation`, no code change, easy to do without
 * noticing) would silently invalidate both arguments: `append()`'s `INSERT
 * ... ON CONFLICT` would start raising serialization failures (`40001`)
 * instead of hitting `DO NOTHING`, turning `VersionConflictError` (409) into
 * an unhandled `40001` (500); and the `head()` re-read that follows a lost
 * race would run inside the same repeatable-read snapshot as the failed
 * insert, so `VersionConflictError.currentVersion` — the exact field the e2e
 * suite asserts on in the 409 body — would come back stale. Pinning the
 * level makes the code's correctness independent of server configuration.
 */
export class PgUnitOfWork implements UnitOfWork {
  #pool: Pool;
  #identity: DocIdentity;

  constructor(pool: Pool, identity: DocIdentity) {
    this.#pool = pool;
    this.#identity = identity;
  }

  async withTransaction<T>(fn: (tx: TransactionalPorts) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    // Set when ROLLBACK itself failed, which leaves the connection in an
    // unknown state — see the release() call below.
    let poisoned = false;
    try {
      // Pinned, not inherited from the server default — see the class doc
      // comment above for why this specific level is load-bearing.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const tx: TransactionalPorts = {
        deltas: new PgDeltaLog(client, this.#identity),
        index: new PgDocIndex(client, this.#identity),
      };
      try {
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        // The rollback itself must not replace the error the caller cares
        // about, so its failure is recorded rather than thrown.
        try {
          await client.query("ROLLBACK");
        } catch {
          poisoned = true;
        }
        throw err;
      }
    } finally {
      // `release()` with no argument RETURNS the connection to the pool;
      // `pg-pool` only destroys it when the release carries a truthy error. A
      // failed ROLLBACK (a statement timeout, say) can leave the connection
      // still queryable but still inside an open — or aborted — transaction,
      // and handing that back to the pool means the next borrower opens with
      // `current transaction is aborted` or, worse, writes into someone else's
      // transaction. So a failed rollback discards the connection instead.
      client.release(poisoned || undefined);
    }
  }
}
