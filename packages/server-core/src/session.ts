/**
 * DocumentSession — the cloud-neutral document editing core.
 *
 * This is the algorithm that used to live inside `EditorDO` (cloudflare-sdk),
 * rewritten against the storage ports in `./ports.js`. It owns:
 *
 *   - in-memory document state (`#doc` / `#version`)
 *   - snapshot + replay reconstruction
 *   - the delta write order (see `apply()`)
 *   - the snapshot threshold policy
 *
 * It owns no transport concerns: HTTP parsing and status-code mapping belong
 * to the adapters. Every failure leaves through one of the typed errors in
 * `./errors.js`.
 *
 * Concurrency model (design 3.2): **conditional write**. The version of a new
 * delta is always `baseVersion + 1` — never `MAX(version) + 1`. Conflict
 * detection is delegated to `DeltaLog.append`, which is expected to enforce a
 * primary-key/etag constraint on `version` and throw `VersionConflictError`.
 * There is deliberately no in-memory `baseVersion === this.#version` check:
 * an in-memory check is only correct while a single writer owns the state.
 *
 * Every public method starts with `await this.load()`. The DO original did
 * this once at the top of its request handler; making each entry point carry
 * the obligation keeps the invariant inside the session instead of relying on
 * an adapter to remember it. `load()` is idempotent, so this is a flag check
 * after the first call.
 */

import type {
  DocumentType,
  DocumentTypeContext,
  CasReadContext,
  CasReferences,
} from "@unidocs/core";
import { commitRootRefsOrRollback, leaseOpRefs } from "./cas-client.js";
import {
  DeltaRejectedError,
  DocExistsError,
  DocNotFoundError,
  RootRefsError,
  StorageCorruptError,
} from "./errors.js";
import { computeHash } from "./hash.js";
import type { HistoryEntry } from "./history.js";
import type {
  BlobCas,
  DeltaLog,
  DocIdentity,
  DocIndex,
  SnapshotCache,
} from "./ports.js";
import { encodeQueryValue, type WireQueryValue } from "./query-value.js";

/** Everything the session needs from the CAS service. */
export interface CasGateway extends CasReadContext {
  leaseExisting(hash: string): Promise<unknown>;
  updateRootRefs(update: { requestId: string; changes: CasReferences }): Promise<void>;
}

export interface SessionDeps {
  deltas: DeltaLog;
  snapshots: SnapshotCache;
  blobs: BlobCas;
  index: DocIndex;
  cas: CasGateway;
  identity: DocIdentity;
  /** Injected clock so pure unit tests can assert on timestamps. */
  now: () => number;
}

/** Write a durable snapshot every N deltas. */
export const DELTA_THRESHOLD = 20;

export class DocumentSession<TDoc, TQuery, TOp> {
  readonly #config: DocumentType<TDoc, TQuery, TOp>;
  readonly #deps: SessionDeps;

  #doc: TDoc | null = null;
  #version = 0;
  #loaded = false;

  constructor(config: DocumentType<TDoc, TQuery, TOp>, deps: SessionDeps) {
    this.#config = config;
    this.#deps = deps;
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  get version(): number {
    return this.#version;
  }

  /** True once a document exists in memory (created, cloned, or loaded). */
  get initialized(): boolean {
    return this.#doc !== null;
  }

  #context(): DocumentTypeContext {
    return { cas: this.#deps.cas };
  }

  #requireDoc(): TDoc {
    if (this.#doc === null) {
      throw new DocNotFoundError(
        "Document not initialized. POST /{docType}/ to create.",
      );
    }
    return this.#doc;
  }

  /**
   * Rebuild in-memory state from the snapshot cache plus delta replay.
   * Idempotent: repeated calls return immediately.
   *
   * Migrated from `EditorDO.#ensureLoaded()`. The sqlite `CREATE TABLE`
   * statements are gone — schema is the port implementation's business.
   */
  async load(): Promise<void> {
    if (this.#loaded) return;

    const ctx = this.#context();

    const snapshot = await this.#deps.snapshots.get();
    if (snapshot) {
      this.#doc = await this.#config.load(snapshot.bytes, ctx);
      this.#version = snapshot.version;
    }

    // Replay deltas recorded after the cached snapshot.
    const pending = await this.#deps.deltas.since(this.#version);

    if (pending.length > 0 && this.#doc === null) {
      // The delta log knows about this document but the snapshot cache does
      // not. That is expected, not corruption: the cache is a droppable layer
      // (KV/Redis) while the log is the database, so the two WILL diverge.
      // Replay from an empty document, exactly like rollback() does when no
      // snapshot exists at or before its target.
      this.#doc = await this.#config.init(ctx);
      this.#version = 0;
    }

    for (const delta of pending) {
      this.#doc = await this.#config.apply(
        delta.operations as TOp[],
        this.#doc as TDoc,
        ctx,
      );
      this.#version = delta.version;
    }

    // Whatever we replayed is not in the cache yet — write it back.
    if (pending.length > 0) {
      await this.#saveSnapshotCache();
    }

    this.#loaded = true;
  }

  // ------------------------------------------------------------------
  // Snapshots
  // ------------------------------------------------------------------

  /** Refresh the fast (non-durable) snapshot cache. */
  async #saveSnapshotCache(): Promise<void> {
    // Strict null check on purpose: TDoc is opaque here and may legitimately
    // be a falsy value (the DO original used `!this.#doc`, which silently
    // skipped the write for such documents).
    if (this.#doc === null) return;
    const bytes = await this.#config.save(this.#doc);
    await this.#deps.snapshots.put(this.#version, bytes);
  }

  async #shouldSnapshot(): Promise<boolean> {
    const ref = await this.#deps.deltas.latestSnapshotRef();
    const deltasSince = await this.#deps.deltas.countSince(ref?.version ?? 0);
    return deltasSince >= DELTA_THRESHOLD;
  }

  /**
   * Write a durable, content-addressed snapshot of the current version and
   * record it in every index that tracks snapshots.
   */
  async #writeSnapshot(): Promise<void> {
    if (this.#doc === null) return;

    const bytes = await this.#config.save(this.#doc);
    const hash = await computeHash(bytes);

    // Content-addressed: the same bytes are the same blob.
    await this.#deps.blobs.putIfAbsent(hash, bytes);

    const timestamp = this.#deps.now();
    await this.#deps.index.recordSnapshot(this.#version, hash, timestamp);
    await this.#deps.index.touch(timestamp);
    // Local log record — this is what rollback searches.
    await this.#deps.deltas.recordSnapshot(this.#version, hash, timestamp);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Create a new document, optionally from uploaded bytes.
   * Multipart parsing stays in the adapter; this only takes the bytes.
   */
  async create(input?: { bytes?: Uint8Array }): Promise<{ docId: string; version: number }> {
    await this.load();

    if (this.#doc !== null) {
      throw new DocExistsError("Document already exists");
    }

    const ctx = this.#context();
    const { docType, docId, userId } = this.#deps.identity;

    // Build the document on the side. Same rule as apply(): nothing touches
    // #doc/#version until the conditional write has actually landed.
    const doc = input?.bytes
      ? await this.#config.load(input.bytes, ctx)
      : await this.#config.init(ctx);

    const timestamp = this.#deps.now();
    await this.#deps.deltas.append({
      version: 1,
      timestamp,
      description: "Document created",
      operations: [],
    });

    this.#doc = doc;
    this.#version = 1;

    // Register BEFORE writing the snapshot: DocIndex.recordSnapshot files a
    // snapshot against a known document, so a document the index has never
    // seen has nowhere to file it and the record is silently dropped.
    await this.#deps.index.register({
      docId,
      docType,
      ownerId: userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await this.#saveSnapshotCache();
    // Deliberate: version 1 gets a durable snapshot immediately, so a fresh
    // document is restorable without replaying from `init()`.
    await this.#writeSnapshot();

    this.#loaded = true;
    return { docId, version: 1 };
  }

  /**
   * Adopt an existing snapshot as version 1 (the clone path).
   * The bytes are already in the blob store, so no new blob is written.
   */
  async initFromHash(
    hash: string,
    sourceVersion: number,
  ): Promise<{ docId: string; version: number }> {
    await this.load();

    if (this.#doc !== null) {
      throw new DocExistsError("Document already exists");
    }

    const bytes = await this.#deps.blobs.get(hash);
    if (!bytes) {
      throw new DocNotFoundError(`Snapshot ${hash} not found in R2`);
    }

    const { docType, docId, userId } = this.#deps.identity;
    const doc = await this.#config.load(bytes, this.#context());

    const timestamp = this.#deps.now();
    await this.#deps.deltas.append({
      version: 1,
      timestamp,
      description: `Cloned from snapshot ${hash} (source version ${sourceVersion})`,
      operations: [],
    });

    this.#doc = doc;
    this.#version = 1;

    // Register before recording the snapshot — see create().
    await this.#deps.index.register({
      docId,
      docType,
      ownerId: userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await this.#saveSnapshotCache();
    await this.#deps.index.recordSnapshot(1, hash, timestamp);
    await this.#deps.deltas.recordSnapshot(1, hash, timestamp);

    this.#loaded = true;
    return { docId, version: 1 };
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  async query(q: TQuery): Promise<{ data: WireQueryValue; version: number }> {
    await this.load();
    const doc = this.#requireDoc();
    const data = await this.#config.query(q, doc, this.#context());
    return { data: encodeQueryValue(data), version: this.#version };
  }

  async exportBytes(): Promise<{ bytes: Uint8Array; contentType: string }> {
    await this.load();
    const doc = this.#requireDoc();
    const bytes = await this.#config.save(doc);
    return { bytes, contentType: this.#config.contentType };
  }

  async history(from?: number, to?: number): Promise<HistoryEntry<TOp>[]> {
    await this.load();
    const deltas = await this.#deps.deltas.range(from, to);
    return deltas.map((d) => ({
      version: d.version,
      timestamp: new Date(d.timestamp).toISOString(),
      description: d.description,
      operations: d.operations as TOp[],
    }));
  }

  // ------------------------------------------------------------------
  // Writes
  // ------------------------------------------------------------------

  /**
   * Apply one atomic batch of operations.
   *
   * The write order is load-bearing (design 4.3) — do not reorder:
   *
   *   1. lease every CAS ref the batch mentions
   *   2. run `config.apply` on a working copy (all-or-nothing, in memory)
   *   3. append the delta at `baseVersion + 1` — the conditional write
   *   4. commit root-refs, removing the delta again on failure
   *   5. only now commit the in-memory document
   *   6. refresh the snapshot cache
   *   7. write a durable snapshot if the threshold was crossed
   *
   * Step 5 must follow step 4: if root-refs fail, the in-memory document must
   * not be polluted by a batch that was rolled back on disk.
   */
  async apply(
    ops: readonly TOp[],
    description: string,
    baseVersion: number,
  ): Promise<{ version: number }> {
    await this.load();

    const doc = this.#requireDoc();
    const ctx = this.#context();

    // 1. Lease refs. Failures propagate verbatim (CasClientError carries the
    //    status the adapter maps to 409/400/502).
    const refs = await leaseOpRefs(ops, this.#config.refsFromOp, this.#deps.cas);

    // 2. Apply transactionally to a working copy — nothing is written yet.
    let newDoc: TDoc;
    try {
      newDoc = await this.#config.apply(ops, doc, ctx);
    } catch (err) {
      throw new DeltaRejectedError(`Delta failed: ${err}`);
    }

    // 3. Conditional write: the log is the source of truth for the version.
    //    A concurrent writer that already took this version makes the port
    //    throw VersionConflictError, which we let through untouched.
    const nextVersion = baseVersion + 1;
    await this.#deps.deltas.append({
      version: nextVersion,
      timestamp: this.#deps.now(),
      description,
      operations: [...ops] as unknown[],
    });

    // 4. Root-refs. On failure the delta we just wrote is removed again.
    const { userId, docId } = this.#deps.identity;
    try {
      await commitRootRefsOrRollback(
        this.#deps.cas,
        `apply:${userId}:${docId}:${nextVersion}`,
        refs,
        () => this.#deps.deltas.remove(nextVersion),
      );
    } catch (err) {
      throw new RootRefsError(`CAS root-refs failed: ${err}`);
    }

    // 5. Commit in memory — only after the durable writes have succeeded.
    this.#doc = newDoc;
    this.#version = nextVersion;

    // 6.
    await this.#saveSnapshotCache();

    // 7.
    if (await this.#shouldSnapshot()) {
      await this.#writeSnapshot();
    }

    return { version: nextVersion };
  }

  /**
   * Roll back to `target` by rebuilding from the nearest snapshot and
   * replaying. Rollback moves the version *forward*: it appends a synthetic
   * delta rather than deleting history.
   */
  async rollback(target: number): Promise<{ version: number }> {
    await this.load();

    this.#requireDoc();
    const ctx = this.#context();

    const existing = await this.#deps.deltas.range(target, target);
    if (existing.length === 0) {
      throw new DocNotFoundError(`Version ${target} not found`);
    }

    let baseDoc: TDoc;
    let baseVersion: number;

    const ref = await this.#deps.deltas.latestSnapshotRef(target);
    if (ref) {
      const bytes = await this.#deps.blobs.get(ref.hash);
      if (!bytes) {
        // The delta log records this snapshot, so the blob store losing it is
        // corruption, not a missing document — the adapter maps this to 500.
        throw new StorageCorruptError(`Snapshot ${ref.hash} not found in R2`);
      }
      baseDoc = await this.#config.load(bytes, ctx);
      baseVersion = ref.version;
    } else {
      // No snapshot at or before the target — replay from the beginning.
      baseDoc = await this.#config.init(ctx);
      baseVersion = 0;
    }

    for (const delta of await this.#deps.deltas.range(baseVersion + 1, target)) {
      baseDoc = await this.#config.apply(delta.operations as TOp[], baseDoc, ctx);
    }

    // Same conditional-write rule as apply(): never MAX(version) + 1 read
    // back from the log at commit time. A racing writer makes append throw.
    const newVersion = (await this.#deps.deltas.head()) + 1;
    await this.#deps.deltas.append({
      version: newVersion,
      timestamp: this.#deps.now(),
      description: `Rollback to version ${target}`,
      operations: [], // synthetic delta — the state comes from the replay
    });

    this.#doc = baseDoc;
    this.#version = newVersion;

    await this.#saveSnapshotCache();

    if (await this.#shouldSnapshot()) {
      await this.#writeSnapshot();
    }

    return { version: newVersion };
  }

  /** Force a durable snapshot and return its hash (the clone source path). */
  async snapshot(): Promise<{
    hash: string;
    version: number;
    docType: string;
    docId: string;
  }> {
    await this.load();

    const doc = this.#requireDoc();

    await this.#writeSnapshot();

    const bytes = await this.#config.save(doc);
    const hash = await computeHash(bytes);

    return {
      hash,
      version: this.#version,
      docType: this.#deps.identity.docType,
      docId: this.#deps.identity.docId,
    };
  }
}
