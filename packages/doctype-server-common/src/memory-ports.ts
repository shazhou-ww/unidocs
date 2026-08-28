import type { CasRef, CasReferences } from "@unidocs/protocol";
import type {
  BlobCas,
  Delta,
  DeltaLog,
  SnapshotRef,
  SnapshotCache,
  TransactionalPorts,
  UnitOfWork,
} from "./ports.js";
import type { CasGateway } from "./session.js";
import { VersionConflictError } from "@unidocs/protocol-doc";
import { computeNodeDigest, encodeHeader, hashToHex } from "@unicas/server-common";

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
}

/**
 * In-memory CAS gateway for tests. Content-addressed: `store` computes the
 * canonical CAS node digest and keeps the bytes so `read` returns them
 * verbatim.
 */
export class MemoryCas implements CasGateway {
  #nodes = new Map<string, { bytes: Uint8Array; contentType: string; refs: string[] }>();
  rootRefUpdates: { requestId: string; changes: CasReferences }[] = [];

  /** Count of distinct content-addressed nodes currently stored. Content
   *  addressing means a re-upload of already-stored bytes is a no-op, so this
   *  is the observable "did dedup happen?" signal for tests. */
  get size(): number {
    return this.#nodes.size;
  }

  async store(bytes: Uint8Array, contentType: string): Promise<string> {
    // Mirror the real CAS service's canonical node digest so tests exercise
    // the same hashes production does (a plain content hash would diverge).
    const header = encodeHeader(bytes.length, contentType, 0);
    const hash = hashToHex(await computeNodeDigest(header, contentType, [], bytes));
    if (!this.#nodes.has(hash)) {
      this.#nodes.set(hash, { bytes, contentType, refs: [] });
    }
    return hash;
  }

  async read(ref: CasRef): Promise<Uint8Array> {
    const node = this.#nodes.get(ref.hash);
    if (!node) throw new Error(`CAS node ${ref.hash} not found`);
    return node.bytes;
  }

  async metadata(
    ref: CasRef,
  ): Promise<{ hash: string; size: number; contentType: string; refs: readonly string[] }> {
    const node = this.#nodes.get(ref.hash);
    if (!node) throw new Error(`CAS node ${ref.hash} not found`);
    return { hash: ref.hash, size: node.bytes.length, contentType: node.contentType, refs: node.refs };
  }

  async leaseNode(hash: string): Promise<unknown> {
    return { hash, ready: true };
  }

  async updateRootRefs(update: { requestId: string; changes: CasReferences }): Promise<{
    success: boolean;
    idempotent?: boolean;
    revision?: number;
  }> {
    this.rootRefUpdates.push(update);
    return { success: true };
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
    const saved = [this.#ports.deltas]
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
  snapshots: SnapshotCache;
  blobs: BlobCas;
  cas: MemoryCas;
  unitOfWork: UnitOfWork;
} {
  const deltas = new MemoryDeltaLog();
  return {
    deltas,
    snapshots: new MemorySnapshotCache(),
    blobs: new MemoryBlobCas(),
    cas: new MemoryCas(),
    unitOfWork: new MemoryUnitOfWork({ deltas }),
  };
}
