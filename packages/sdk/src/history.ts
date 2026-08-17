/**
 * History and versioning primitives.
 */

/** One entry in the document's history log. */
export interface HistoryEntry<TOp = unknown> {
  version: number;
  timestamp: string; // ISO 8601
  description: string;
  operation?: TOp;
}

/** Result of applying an operation. */
export interface ApplyResult<T = unknown> {
  success: boolean;
  version: number;
  data?: T;
  error?: string;
}

/** Result of a rollback operation. */
export interface RollbackResult {
  success: boolean;
  version: number;
  error?: string;
}
