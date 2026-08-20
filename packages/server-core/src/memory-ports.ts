import type {
  BlobCas,
  Delta,
  DeltaLog,
  DocIndex,
  DocIndexQuery,
  DocRecord,
  SnapshotCache,
  SnapshotRef,
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

export function createMemoryPorts(): {
  deltas: DeltaLog;
  snapshots: SnapshotCache;
  blobs: BlobCas;
  index: DocIndex;
  indexQuery: DocIndexQuery;
} {
  const store: SharedDocStore = { docs: new Map(), snapshots: new Map() };
  return {
    deltas: new MemoryDeltaLog(),
    snapshots: new MemorySnapshotCache(),
    blobs: new MemoryBlobCas(),
    index: new MemoryDocIndex(store),
    indexQuery: new MemoryDocIndexQuery(store),
  };
}
