/**
 * Cross-microservice document index contract.
 *
 * `DocIndexQuery` is the read side of the shared document index: the gateway
 * lists documents through it (`createGatewayHandler`'s `docIndex` config),
 * and each backend implements it (D1 on Cloudflare, Postgres on Azure).
 * `DocRecord` / `SnapshotRef` are its wire-relevant shapes — the gateway
 * serializes `DocRecord` directly into the list response.
 */

export interface DocRecord {
  docId: string;
  docType: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SnapshotRef {
  version: number;
  hash: string;
}

export interface DocIndexQuery {
  /**
   * Documents owned by `userId` of type `docType`, **descending by
   * `updatedAt`** (most recently touched first). Callers (list UIs) depend
   * on this order; an implementation that returns physical/insertion order
   * instead silently breaks "recently updated" sorting.
   */
  list(userId: string, docType: string): Promise<DocRecord[]>;
  /**
   * Snapshots the index holds for one document, ascending by version.
   * Keyed by `(docType, docId)` to match the index's primary key.
   */
  snapshots(docType: string, docId: string): Promise<SnapshotRef[]>;
}
