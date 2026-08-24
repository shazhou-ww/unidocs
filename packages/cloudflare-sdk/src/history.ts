/**
 * History and versioning primitives.
 *
 * These types now live in `@unidocs/http-protocol` (cloud-neutral wire
 * contracts). This module stays as a named re-export so both the
 * cloudflare-sdk public surface and the `./history.js` import path used
 * inside this package are unchanged.
 */

export type {
  HistoryEntry,
  ApplyResult,
  RollbackResult,
  CreateResult,
} from "@unidocs/http-protocol";
