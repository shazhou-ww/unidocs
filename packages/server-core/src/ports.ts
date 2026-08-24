/**
 * Storage port contracts for the document session core.
 *
 * `DocRecord` / `SnapshotRef` / `DocIndexQuery` live in
 * @unidocs/http-protocol — they cross the gateway/doctype boundary
 * (the gateway lists documents through `DocIndexQuery`).
 */

import type { DocRecord, SnapshotRef } from "@unidocs/http-protocol";

export interface Delta {
  version: number;
  timestamp: number;
  description: string;
  operations: unknown[];
}

export interface DocIdentity { docType: string; docId: string; userId: string }

export interface DeltaLog {
  /**
   * Append one delta. **Contract: only `d.version === head() + 1` is accepted.**
   * Every other version — behind, equal, or ahead of `head() + 1` — is a
   * conflict and MUST throw `VersionConflictError(head(), d.version)`.
   *
   * This is the conditional write. The session computes the version as
   * `baseVersion + 1` and never reads `MAX(version) + 1`, so this is the only
   * thing standing between a wrong `baseVersion` and a corrupt log:
   * a stale `baseVersion` would rewrite history, a future one would leave a
   * gap that replay silently skips. Enforce it structurally (primary key /
   * etag / conditional insert), not with a read-then-write check.
   */
  append(d: Delta): Promise<void>;
  head(): Promise<number>;                  // 无 delta 时返回 0
  since(v: number): Promise<Delta[]>;
  range(from?: number, to?: number): Promise<Delta[]>;
  /**
   * Compensating action for a failed root-refs commit (`DocumentSession.apply`
   * step 4): undo the delta `append()` just wrote, but ONLY if `v` is still
   * the current head. If `v` is no longer the head — a concurrent writer has
   * since appended `v + 1` on top of it — this MUST be a silent no-op, not a
   * delete and not a throw.
   *
   * Why conditional: without a single-writer queue in front of the log —
   * Cloudflare has one (the Durable Object's `#requestTail`), Azure's
   * stateless replicas do not — two racing `apply()` calls can interleave
   * as append(v) [A] → append(v+1) [B, now legitimately
   * committed on top of v] → remove(v) [A's failed rollback]. An
   * unconditional delete there removes a delta that a later, successful
   * delta already depends on, leaving a permanent hole in the log — replay
   * silently skips it and diverges from what any client that already read
   * version v was shown. Restricting the delete to "only when v is still
   * head" downgrades that failure to a retained delta with uncommitted
   * root-refs (a reclaimable reference leak), never a gap.
   *
   * Must not throw on the no-op path: this runs on an already-failing
   * compensation branch, and a race losing this check is an expected
   * outcome, not a new error to surface.
   */
  remove(v: number): Promise<void>;
  latestSnapshotRef(atOrBefore?: number): Promise<SnapshotRef | null>;
  recordSnapshot(v: number, hash: string, timestamp: number): Promise<void>;
  countSince(v: number): Promise<number>;
}

export interface SnapshotCache {
  get(): Promise<{ version: number; bytes: Uint8Array } | null>;
  put(v: number, bytes: Uint8Array): Promise<void>;
}

export interface BlobCas {
  putIfAbsent(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | null>;
}

/**
 * The global, cross-document index (the shared D1 database in the Cloudflare
 * deployment): which documents exist, when they were last touched, and which
 * snapshots they have.
 *
 * **Contract: `register()` MUST be called before any `recordSnapshot()` or
 * `touch()` for that document.** An implementation may rely on this — it is
 * how it learns the identity it needs to key those rows by, and it is free to
 * drop calls that arrive for a document it has never been told about. Callers
 * that snapshot first and register second silently lose the record.
 */
export interface DocIndex {
  register(rec: DocRecord): Promise<void>;
  touch(at: number): Promise<void>;
  recordSnapshot(version: number, hash: string, timestamp: number): Promise<void>;
}

/**
 * The two ports that can take part in one atomic unit of work.
 *
 * Deliberately *not* all five. `BlobCas` is content-addressed — an orphan
 * blob is harmless and collectable — and `SnapshotCache` is a droppable
 * cache, so neither belongs inside a transaction. What must be atomic is the
 * pair that a document's existence is spread across: the delta log (the
 * source of truth for content and version) and the global index (the source
 * of truth for "this document exists and is owned by X").
 */
export interface TransactionalPorts {
  deltas: DeltaLog;
  index: DocIndex;
}

/**
 * Optional-strength atomicity over `TransactionalPorts`.
 *
 * Backends differ in what they can honestly promise here, and the difference
 * is structural, not a matter of effort:
 *
 *   - Postgres (Azure): `deltas` and `docs` are two tables in one database,
 *     so `withTransaction` is a real `BEGIN`/`COMMIT` and a throw is a real
 *     `ROLLBACK`.
 *   - Cloudflare: the delta log lives in a Durable Object's private sqlite
 *     and the index lives in D1 — two physically separate services with no
 *     shared transaction. `DirectUnitOfWork` there just runs the callback,
 *     and a partial failure stays partial.
 *
 * `DocumentSession` writes against the stronger contract and gets whatever
 * the backend can give; it never branches on which one it has.
 */
export interface UnitOfWork {
  /**
   * Run the callback's writes as one atomic unit. A normal return commits;
   * a throw rolls back (where the backend supports it) and propagates.
   *
   * The callback **must** use the port instances handed to it, not ones
   * captured from an enclosing scope — that is how a Postgres implementation
   * binds every statement to the same connection.
   */
  withTransaction<T>(fn: (tx: TransactionalPorts) => Promise<T>): Promise<T>;
}
