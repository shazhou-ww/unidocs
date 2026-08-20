/**
 * Cloudflare storage-port implementations for @unidocs/server-core.
 *
 * Each class implements one server-core port on top of a Cloudflare
 * primitive (Durable Object sqlite, Durable Object KV storage, R2, D1).
 * The SQL below is copied verbatim from `editor-do.ts` (`#ensureLoaded`,
 * `#saveSnapshotKV`, `#shouldSnapshot`, `#saveSnapshot`, and the HTTP
 * handlers) — only the surrounding wiring changed. See
 * `.superpowers/sdd/2026-08-20-azure-phase1-server-core/task-4-report.md`
 * for the line-by-line mapping.
 *
 * NOT WIRED IN YET: nothing in this file is called from editor-do.ts or
 * any worker. That happens in a later task.
 */

import type {
  BlobCas,
  Delta,
  DeltaLog,
  DocIdentity,
  DocIndex,
  DocIndexQuery,
  DocRecord,
  SnapshotCache,
  SnapshotRef,
} from "@unidocs/server-core";
import { VersionConflictError } from "@unidocs/server-core";

// Must stay "snapshot" — changing it orphans the KV snapshot of every
// document already deployed (see editor-do.ts KEY_SNAPSHOT).
const KEY_SNAPSHOT = "snapshot";

interface SnapshotKV {
  version: number;
  bytes: Uint8Array;
}

/**
 * DeltaLog on a Durable Object's attached sqlite storage
 * (`ctx.storage.sql`). Mirrors the `deltas` / `snapshots` tables and
 * queries from editor-do.ts.
 */
export class DoDeltaLog implements DeltaLog {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
  }

  /**
   * Create the sqlite tables. Copied from editor-do.ts `#ensureLoaded()`,
   * with one change: `deltas.version` drops `AUTOINCREMENT` (version is now
   * always supplied by the caller as `baseVersion + 1`; see append() below).
   * `CREATE TABLE IF NOT EXISTS` leaves already-existing tables (which still
   * have AUTOINCREMENT) untouched — no migration needed.
   */
  static ensureTables(ctx: DurableObjectState): void {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS deltas (
        version INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        description TEXT,
        operations TEXT NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        version INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
  }

  /**
   * Conditional insert: the row is only written if the current max version
   * is exactly `d.version - 1`. This is the structural guarantee the
   * `DeltaLog.append` contract requires — check-then-insert as one atomic
   * SQL statement, not two separate calls. If the WHERE clause doesn't hold,
   * `SELECT` yields zero rows and the INSERT writes nothing
   * (`cursor.rowsWritten === 0`), at which point we look up the real head
   * and throw `VersionConflictError`.
   */
  async append(d: Delta): Promise<void> {
    const cursor = this.#ctx.storage.sql.exec(
      `INSERT INTO deltas (version, timestamp, description, operations)
       SELECT ?, ?, ?, ? WHERE (SELECT COALESCE(MAX(version), 0) FROM deltas) = ? - 1`,
      d.version,
      d.timestamp,
      d.description,
      JSON.stringify(d.operations),
      d.version,
    );
    if (cursor.rowsWritten === 0) {
      const head = await this.head();
      throw new VersionConflictError(head, d.version);
    }
  }

  // editor-do.ts `#getNextVersion()` used `SELECT MAX(version)`; head()
  // is the same query, just exposed directly instead of +1'd internally.
  async head(): Promise<number> {
    const result = this.#ctx.storage.sql.exec(`SELECT MAX(version) as max_v FROM deltas`);
    const row = result.one();
    return (row.max_v as number) ?? 0;
  }

  // editor-do.ts `#ensureLoaded()` replay query, without the upper bound.
  async since(v: number): Promise<Delta[]> {
    const result = this.#ctx.storage.sql.exec(
      `SELECT version, timestamp, description, operations FROM deltas WHERE version > ? ORDER BY version ASC`,
      v,
    );
    return result.toArray().map((row) => ({
      version: row.version as number,
      timestamp: row.timestamp as number,
      description: row.description as string,
      operations: JSON.parse(row.operations as string) as unknown[],
    }));
  }

  // editor-do.ts GET /_internal/history, generalized to always take both bounds.
  async range(from?: number, to?: number): Promise<Delta[]> {
    let query = `SELECT version, timestamp, description, operations FROM deltas`;
    const params: number[] = [];
    const conditions: string[] = [];

    if (from !== undefined) {
      conditions.push("version >= ?");
      params.push(from);
    }
    if (to !== undefined) {
      conditions.push("version <= ?");
      params.push(to);
    }
    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY version ASC";

    const result = this.#ctx.storage.sql.exec(query, ...params);
    return result.toArray().map((row) => ({
      version: row.version as number,
      timestamp: row.timestamp as number,
      description: row.description as string,
      operations: JSON.parse(row.operations as string) as unknown[],
    }));
  }

  // editor-do.ts `commitRootRefsOrRollback` failure path: `DELETE FROM deltas WHERE version = ?`.
  async remove(v: number): Promise<void> {
    this.#ctx.storage.sql.exec(`DELETE FROM deltas WHERE version = ?`, v);
  }

  // editor-do.ts POST /_internal/rollback: nearest snapshot at or before target version.
  async latestSnapshotRef(atOrBefore?: number): Promise<SnapshotRef | null> {
    const result =
      atOrBefore === undefined
        ? this.#ctx.storage.sql.exec(
            `SELECT version, hash FROM snapshots ORDER BY version DESC LIMIT 1`,
          )
        : this.#ctx.storage.sql.exec(
            `SELECT version, hash FROM snapshots WHERE version <= ? ORDER BY version DESC LIMIT 1`,
            atOrBefore,
          );
    const rows = result.toArray();
    if (rows.length === 0) return null;
    return { version: rows[0].version as number, hash: rows[0].hash as string };
  }

  // editor-do.ts `#saveSnapshot()`: local sqlite snapshots table (for rollback).
  async recordSnapshot(v: number, hash: string, timestamp: number): Promise<void> {
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO snapshots (version, hash, timestamp) VALUES (?, ?, ?)`,
      v,
      hash,
      timestamp,
    );
  }

  // editor-do.ts `#shouldSnapshot()` delta-count query.
  async countSince(v: number): Promise<number> {
    const result = this.#ctx.storage.sql.exec(
      `SELECT COUNT(*) as cnt FROM deltas WHERE version > ?`,
      v,
    );
    const row = result.one();
    return (row.cnt as number) ?? 0;
  }
}

/**
 * SnapshotCache on a Durable Object's KV storage (`ctx.storage`).
 * Mirrors editor-do.ts `#saveSnapshotKV()` / the KEY_SNAPSHOT read in
 * `#ensureLoaded()`.
 */
export class DoSnapshotCache implements SnapshotCache {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
  }

  async get(): Promise<{ version: number; bytes: Uint8Array } | null> {
    const snapshot = await this.#ctx.storage.get<SnapshotKV>(KEY_SNAPSHOT);
    return snapshot ?? null;
  }

  async put(v: number, bytes: Uint8Array): Promise<void> {
    const snapshotKV: SnapshotKV = { version: v, bytes };
    await this.#ctx.storage.put(KEY_SNAPSHOT, snapshotKV);
  }
}

/**
 * BlobCas on R2. Mirrors editor-do.ts `#saveSnapshot()` (`this.#env.CAS.put`)
 * and the `/_internal/init_from_hash` / rollback reads (`this.#env.CAS.get`).
 */
export class R2BlobCas implements BlobCas {
  #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  // Content-addressed: same hash implies same bytes, so overwriting an
  // existing key is idempotent — no need to check existence first.
  async putIfAbsent(hash: string, bytes: Uint8Array): Promise<void> {
    await this.#bucket.put(hash, bytes);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const obj = await this.#bucket.get(hash);
    if (!obj) return null;
    return await obj.bytes();
  }
}

/**
 * DocIndex on the shared D1 database, scoped to one document identity.
 * Mirrors editor-do.ts `#saveSnapshot()` (snapshots + docs updated_at) and
 * the docs-table registration in the create / init_from_hash handlers.
 *
 * `register()` is a no-op beyond what the constructor already captured:
 * this implementation is handed its `DocIdentity` up front, so it does not
 * need `register()` to learn who it is indexing the way MemoryDocIndex
 * does. It still honors the DocIndex contract (`register()` before
 * `touch()`/`recordSnapshot()`) — callers must still call it first.
 */
export class D1DocIndex implements DocIndex {
  #db: D1Database;
  #identity: DocIdentity;

  constructor(db: D1Database, identity: DocIdentity) {
    this.#db = db;
    this.#identity = identity;
  }

  // editor-do.ts create / init_from_hash: docs table CREATE + INSERT OR REPLACE.
  async register(rec: DocRecord): Promise<void> {
    await this.#db.exec(
      "CREATE TABLE IF NOT EXISTS docs (doc_id TEXT NOT NULL, doc_type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (doc_id, doc_type))",
    );
    await this.#db
      .prepare(
        `INSERT OR REPLACE INTO docs (doc_id, doc_type, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(rec.docId, rec.docType, rec.ownerId, rec.createdAt, rec.updatedAt)
      .run();
  }

  // editor-do.ts `#saveSnapshot()`: docs table CREATE + UPDATE updated_at.
  // ownerId isn't part of DocIndex.touch(), so we key on (doc_id, doc_type)
  // alone, matching the docs table primary key.
  async touch(at: number): Promise<void> {
    await this.#db.exec(
      "CREATE TABLE IF NOT EXISTS docs (doc_id TEXT NOT NULL, doc_type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (doc_id, doc_type))",
    );
    await this.#db
      .prepare(`UPDATE docs SET updated_at = ? WHERE doc_id = ? AND doc_type = ?`)
      .bind(at, this.#identity.docId, this.#identity.docType)
      .run();
  }

  // editor-do.ts `#saveSnapshot()`: snapshots table CREATE + INSERT OR REPLACE.
  async recordSnapshot(version: number, hash: string, timestamp: number): Promise<void> {
    await this.#db.exec(
      "CREATE TABLE IF NOT EXISTS snapshots (hash TEXT NOT NULL, doc_type TEXT NOT NULL, doc_id TEXT NOT NULL, version INTEGER NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY (doc_type, doc_id, version))",
    );
    await this.#db
      .prepare(
        `INSERT OR REPLACE INTO snapshots (hash, doc_type, doc_id, version, timestamp) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(hash, this.#identity.docType, this.#identity.docId, version, timestamp)
      .run();
  }
}

/**
 * DocIndexQuery on the shared D1 database. Mirrors the (not-yet-existing
 * in editor-do.ts) list/snapshots read paths — table shapes are the same
 * `docs` / `snapshots` tables `D1DocIndex` writes.
 */
export class D1DocIndexQuery implements DocIndexQuery {
  #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async list(userId: string, docType: string): Promise<DocRecord[]> {
    await this.#db.exec(
      "CREATE TABLE IF NOT EXISTS docs (doc_id TEXT NOT NULL, doc_type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (doc_id, doc_type))",
    );
    const result = await this.#db
      .prepare(
        `SELECT doc_id, doc_type, owner_id, created_at, updated_at FROM docs WHERE owner_id = ? AND doc_type = ?`,
      )
      .bind(userId, docType)
      .all();
    return (result.results ?? []).map((row) => ({
      docId: row.doc_id as string,
      docType: row.doc_type as string,
      ownerId: row.owner_id as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  async snapshots(docType: string, docId: string): Promise<SnapshotRef[]> {
    await this.#db.exec(
      "CREATE TABLE IF NOT EXISTS snapshots (hash TEXT NOT NULL, doc_type TEXT NOT NULL, doc_id TEXT NOT NULL, version INTEGER NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY (doc_type, doc_id, version))",
    );
    const result = await this.#db
      .prepare(
        `SELECT version, hash FROM snapshots WHERE doc_type = ? AND doc_id = ? ORDER BY version ASC`,
      )
      .bind(docType, docId)
      .all();
    return (result.results ?? []).map((row) => ({
      version: row.version as number,
      hash: row.hash as string,
    }));
  }
}
