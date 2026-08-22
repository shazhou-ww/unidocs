import type {
  BlobCas,
  Delta,
  DeltaLog,
  DocIndex,
  DocIndexQuery,
  DocRecord,
  SnapshotCache,
  SnapshotRef,
  TransactionalPorts,
  UnitOfWork,
} from "./ports.js";
import { VersionConflictError } from "./errors.js";

class MemoryDeltaLog implements DeltaLog {
  #deltas: Delta[] = [];
  #snapshotRefs: SnapshotRef[] = [];

  #headSync(): number {
    if (this.#deltas.length === 0) return 0;
    return this.#deltas.reduce((max, d) => Math.max(max, d.version), 0);
  }

  async append(d: Delta): Promise<void> {
    // Conditional write: the only acceptable version is head + 1. Behind or
    // equal means someone else already took it; ahead would leave a gap.
    //
    // The check and the insert must be one atomic step — a real store gets
    // that from a primary key or a conditional insert, so this one reads the
    // head synchronously rather than awaiting head() and handing a concurrent
    // writer a window between the check and the push.
    const head = this.#headSync();
    if (d.version !== head + 1) {
      throw new VersionConflictError(head, d.version);
    }
    this.#deltas.push(d);
    this.#deltas.sort((a, b) => a.version - b.version);
  }

  async head(): Promise<number> {
    return this.#headSync();
  }

  async since(v: number): Promise<Delta[]> {
    return this.#deltas
      .filter((d) => d.version > v)
      .sort((a, b) => a.version - b.version);
  }

  async range(from?: number, to?: number): Promise<Delta[]> {
    return this.#deltas
      .filter(
        (d) =>
          (from === undefined || d.version >= from) &&
          (to === undefined || d.version <= to),
      )
      .sort((a, b) => a.version - b.version);
  }

  async remove(v: number): Promise<void> {
    // Conditional: only the current head may be removed. If a concurrent
    // append already moved head past v, this is a silent no-op — see the
    // contract note on DeltaLog.remove. Never throw here: the caller is
    // already on a failure/compensation path.
    if (this.#headSync() !== v) return;
    this.#deltas = this.#deltas.filter((d) => d.version !== v);
  }

  async latestSnapshotRef(atOrBefore?: number): Promise<SnapshotRef | null> {
    const candidates = this.#snapshotRefs.filter(
      (s) => atOrBefore === undefined || s.version <= atOrBefore,
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((latest, s) =>
      s.version > latest.version ? s : latest,
    );
  }

  async recordSnapshot(v: number, hash: string, _timestamp: number): Promise<void> {
    this.#snapshotRefs = this.#snapshotRefs.filter((s) => s.version !== v);
    this.#snapshotRefs.push({ version: v, hash });
    this.#snapshotRefs.sort((a, b) => a.version - b.version);
  }

  async countSince(v: number): Promise<number> {
    return this.#deltas.filter((d) => d.version > v).length;
  }

  // --- MemoryTxParticipant: rollback support for MemoryUnitOfWork ---------
  // Shallow array copies are enough: nothing ever mutates a Delta or a
  // SnapshotRef in place, they are only added and removed.

  captureTxState(): unknown {
    return { deltas: [...this.#deltas], snapshotRefs: [...this.#snapshotRefs] };
  }

  restoreTxState(state: unknown): void {
    const s = state as { deltas: Delta[]; snapshotRefs: SnapshotRef[] };
    this.#deltas = [...s.deltas];
    this.#snapshotRefs = [...s.snapshotRefs];
  }
}

class MemorySnapshotCache implements SnapshotCache {
  #entry: { version: number; bytes: Uint8Array } | null = null;

  async get(): Promise<{ version: number; bytes: Uint8Array } | null> {
    return this.#entry;
  }

  async put(v: number, bytes: Uint8Array): Promise<void> {
    this.#entry = { version: v, bytes };
  }

  /**
   * Test-only. Drops the cached snapshot without touching the delta log or
   * blob store, so a test can force the next `load()` down the durable
   * (`latestSnapshotRef()` + `blobs.get()`) fallback path — the situation
   * `session.ts`'s own comments describe as "the cache WILL diverge from the
   * delta log" but that no real backend's lifecycle ever produces on its
   * own. Not part of the `SnapshotCache` port contract.
   */
  clear(): void {
    this.#entry = null;
  }
}

class MemoryBlobCas implements BlobCas {
  #blobs = new Map<string, Uint8Array>();

  async putIfAbsent(hash: string, bytes: Uint8Array): Promise<void> {
    if (this.#blobs.has(hash)) return;
    this.#blobs.set(hash, bytes);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.#blobs.get(hash) ?? null;
  }

  /**
   * Test-only. Drops every blob while leaving delta-log snapshot refs
   * intact, so a test can reproduce "the log records a snapshot but the
   * blob behind it is gone" — the fail-closed `StorageCorruptError` branch
   * in `session.ts`'s `load()`. Not part of the `BlobCas` port contract.
   */
  deleteAll(): void {
    this.#blobs.clear();
  }
}

interface SharedDocStore {
  docs: Map<string, DocRecord>;
  snapshots: Map<string, { version: number; hash: string; timestamp: number }[]>;
}

function docKey(docType: string, docId: string): string {
  return `${docType}:${docId}`;
}

class MemoryDocIndex implements DocIndex {
  // Learned from register(). Until then this index does not know which
  // document it is indexing, so touch()/recordSnapshot() have nowhere to
  // write — see the contract note on DocIndex.
  #identity: { docType: string; docId: string } | null = null;
  #store: SharedDocStore;

  constructor(store: SharedDocStore) {
    this.#store = store;
  }

  async register(rec: DocRecord): Promise<void> {
    this.#identity = { docType: rec.docType, docId: rec.docId };
    this.#store.docs.set(docKey(rec.docType, rec.docId), { ...rec });
  }

  async touch(at: number): Promise<void> {
    if (this.#identity === null) return;
    const rec = this.#store.docs.get(docKey(this.#identity.docType, this.#identity.docId));
    if (rec) rec.updatedAt = at;
  }

  async recordSnapshot(version: number, hash: string, timestamp: number): Promise<void> {
    if (this.#identity === null) return;
    const key = docKey(this.#identity.docType, this.#identity.docId);
    const list = this.#store.snapshots.get(key) ?? [];
    list.push({ version, hash, timestamp });
    this.#store.snapshots.set(key, list);
  }

  // --- MemoryTxParticipant: rollback support for MemoryUnitOfWork ---------
  //
  // Three things move under a transaction here and all three must come back:
  // the learned #identity (register() sets it), the shared docs map (whose
  // DocRecord values touch() mutates in place, hence the per-record copy),
  // and the shared snapshots map (whose arrays recordSnapshot() pushes onto).
  // The shared maps are restored by mutation, not reassignment —
  // MemoryDocIndexQuery holds the same SharedDocStore by reference.

  captureTxState(): unknown {
    return {
      identity: this.#identity === null ? null : { ...this.#identity },
      docs: new Map(
        [...this.#store.docs].map(([k, v]) => [k, { ...v }] as const),
      ),
      snapshots: new Map(
        [...this.#store.snapshots].map(([k, v]) => [k, [...v]] as const),
      ),
    };
  }

  restoreTxState(state: unknown): void {
    const s = state as {
      identity: { docType: string; docId: string } | null;
      docs: Map<string, DocRecord>;
      snapshots: Map<string, { version: number; hash: string; timestamp: number }[]>;
    };
    this.#identity = s.identity === null ? null : { ...s.identity };
    this.#store.docs.clear();
    for (const [k, v] of s.docs) this.#store.docs.set(k, { ...v });
    this.#store.snapshots.clear();
    for (const [k, v] of s.snapshots) this.#store.snapshots.set(k, [...v]);
  }
}

class MemoryDocIndexQuery implements DocIndexQuery {
  #store: SharedDocStore;

  constructor(store: SharedDocStore) {
    this.#store = store;
  }

  async list(userId: string, docType: string): Promise<DocRecord[]> {
    return [...this.#store.docs.values()]
      .filter((r) => r.ownerId === userId && r.docType === docType)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async snapshots(docType: string, docId: string): Promise<SnapshotRef[]> {
    const list = this.#store.snapshots.get(docKey(docType, docId)) ?? [];
    return [...list]
      .sort((a, b) => a.version - b.version)
      .map(({ version, hash }) => ({ version, hash }));
  }
}

/**
 * Opt-in capability that lets `MemoryUnitOfWork` undo a port's writes: take a
 * snapshot of its internal state on the way in, put it back if the callback
 * throws. This is the simplest honest rollback an in-memory implementation
 * can offer, and the port contract's transaction tests depend on it being a
 * real one rather than a no-op.
 *
 * A port that does not implement it simply is not rolled back — see
 * `MemoryUnitOfWork`.
 */
export interface MemoryTxParticipant {
  captureTxState(): unknown;
  restoreTxState(state: unknown): void;
}

// Generic in T so `array.filter(isMemoryTxParticipant)` narrows the element
// type instead of widening it to MemoryTxParticipant.
export function isMemoryTxParticipant<T>(value: T): value is T & MemoryTxParticipant {
  const candidate = value as unknown as Partial<MemoryTxParticipant> | null;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof candidate?.captureTxState === "function" &&
    typeof candidate?.restoreTxState === "function"
  );
}

/**
 * Snapshot-and-restore transactions for the in-memory ports.
 *
 * Scope, stated plainly: this is a test double. It gives real *rollback*
 * (the whole point — the port contract asserts that a throw inside
 * `withTransaction` leaves nothing behind), but it gives no isolation, so
 * two overlapping transactions over the same ports would restore each
 * other's state. Nothing in `DocumentSession` runs concurrent transactions
 * over one document, and a real backend gets this from its database.
 *
 * Ports that do not implement `MemoryTxParticipant` — a test spy, a fake
 * that throws — are passed through to the callback untouched and not rolled
 * back. That is deliberate: such a port is the *cause* of the rollback in
 * the tests that use one, not a participant in it.
 */
export class MemoryUnitOfWork implements UnitOfWork {
  #ports: TransactionalPorts;

  constructor(ports: TransactionalPorts) {
    this.#ports = ports;
  }

  async withTransaction<T>(fn: (tx: TransactionalPorts) => Promise<T>): Promise<T> {
    const saved = [this.#ports.deltas, this.#ports.index]
      .filter(isMemoryTxParticipant)
      .map((port) => ({ port, state: port.captureTxState() }));

    try {
      return await fn(this.#ports);
    } catch (err) {
      // Reverse order so a port that appears twice (it cannot today, but the
      // list is not the invariant) unwinds like a stack.
      for (const { port, state } of saved.reverse()) port.restoreTxState(state);
      throw err;
    }
  }
}

/**
 * A `UnitOfWork` over an arbitrary pair of ports — used by tests that swap
 * one of the memory ports for a spy or a failing fake and still need the
 * other one to roll back.
 */
export function createMemoryUnitOfWork(ports: TransactionalPorts): UnitOfWork {
  return new MemoryUnitOfWork(ports);
}

export function createMemoryPorts(): {
  deltas: DeltaLog;
  // Widened over the plain SnapshotCache/BlobCas port types to surface the
  // test-only clear()/deleteAll() methods above — fault-injection tests
  // (packages/server-core/tests/session-faults.test.ts) need them to force
  // session.ts's durable-fallback and fail-closed branches, which nothing
  // in a normal lifecycle ever reaches. The `SessionDeps`/`ports.ts`
  // contracts themselves are untouched: this is only the concrete return
  // type of the in-memory test double.
  snapshots: SnapshotCache & { clear(): void };
  blobs: BlobCas & { deleteAll(): void };
  index: DocIndex;
  indexQuery: DocIndexQuery;
  unitOfWork: UnitOfWork;
} {
  const store: SharedDocStore = { docs: new Map(), snapshots: new Map() };
  const deltas = new MemoryDeltaLog();
  const index = new MemoryDocIndex(store);
  return {
    deltas,
    snapshots: new MemorySnapshotCache(),
    blobs: new MemoryBlobCas(),
    index,
    indexQuery: new MemoryDocIndexQuery(store),
    unitOfWork: new MemoryUnitOfWork({ deltas, index }),
  };
}
