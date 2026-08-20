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
  append(d: Delta): Promise<void>;          // 版本冲突抛 VersionConflictError
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

export interface DocIndex {
  register(rec: DocRecord): Promise<void>;
  touch(at: number): Promise<void>;
  recordSnapshot(version: number, hash: string, timestamp: number): Promise<void>;
}

export interface DocIndexQuery {
  list(userId: string, docType: string): Promise<DocRecord[]>;
}
