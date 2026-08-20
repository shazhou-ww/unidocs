export interface Delta {
  version: number;
  timestamp: number;
  description: string;
  operations: unknown[];
}

export interface SnapshotRef { version: number; hash: string }

export interface DocIdentity { docType: string; docId: string; userId: string }

export interface DocRecord {
  docId: string; docType: string; ownerId: string;
  createdAt: number; updatedAt: number;
}

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

export interface DocIndexQuery {
  list(userId: string, docType: string): Promise<DocRecord[]>;
  /**
   * Snapshots the index holds for one document, ascending by version.
   * Keyed by `(docType, docId)` to match the index's primary key.
   */
  snapshots(docType: string, docId: string): Promise<SnapshotRef[]>;
}
