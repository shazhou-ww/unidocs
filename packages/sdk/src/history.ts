/**
 * History and versioning primitives.
 */

/**
 * One entry in the document's delta history.
 * A delta is a batch of operations applied transactionally, producing one version.
 */
export interface HistoryEntry<TOp = unknown> {
  /** SHA-256 truncated to 16 hex chars, hash of document state after this delta. */
  version: string;
  timestamp: string; // ISO 8601
  description: string;
  /** Batch of operations applied in this delta (transactional). */
  operations: TOp[];
}

/** Result of applying a delta. */
export interface ApplyResult<T = unknown> {
  success: boolean;
  version: string;
  data?: T;
  error?: string;
}

/** Result of a rollback operation. */
export interface RollbackResult {
  success: boolean;
  version: string;
  error?: string;
}

/** Result of creating a document. */
export interface CreateResult {
  success: boolean;
  docId: string;
  version: string;
  error?: string;
}
