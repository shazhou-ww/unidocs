/**
 * History and versioning primitives.
 */

/** One entry in the document's history log. */
export interface HistoryEntry<TOp = unknown> {
  /** xxhash64 hex string of the document state at this version. */
  version: string;
  timestamp: string; // ISO 8601
  description: string;
  operation?: TOp;
}

/** Result of applying an operation. */
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
