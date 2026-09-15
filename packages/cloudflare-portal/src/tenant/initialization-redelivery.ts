/**
 * Asks the Operator again to initialize a document that still has no version.
 *
 * `document.created` is the only event a document ever gets before its first
 * version: no thread or comment can exist before version 0 (design §5.4), so
 * no later event absorbs a lost one. If the creation dispatch fails, or the
 * Operator accepts it and then fails (a CAS write error, a Platform 5xx, three
 * rejections), the document would wait for Operator initialization forever
 * (spec §18).
 *
 * The one party that notices is a reader: the tenant console polls
 * `getDocument` while it shows "waiting for the Operator", and the page is
 * reopened when that wait times out. So a session read of a versionless
 * document calls this, and it re-dispatches `document.created` - a fresh
 * webhook event, delivered at least once like any other - at most once every
 * `INITIALIZATION_REDELIVERY_SECONDS` per document.
 *
 * A document whose type has no builtin Operator is never asked for: nobody
 * could initialize it, and the dispatcher would only log a skip.
 *
 * The pacing is claimed atomically in D1, so concurrent readers ask once. The
 * window is counted from creation until the first redelivery, which leaves the
 * creation dispatch its own 20 seconds. A redelivery that overlaps a slow but
 * healthy Operator is harmless: both first-version submissions observe no
 * current version, one commits and the other is rejected, re-reads and stops.
 *
 * Nothing here throws: a failure is logged and the next read asks again.
 */
import type { CommittedTenantWrite } from "./operator-dispatch.js";

export const INITIALIZATION_REDELIVERY_SECONDS = 20;

export interface InitializationRedeliveryOptions {
  readonly database: D1Database;
  /** The Operator dispatcher; it logs its own failures and never rejects. */
  readonly dispatch: (write: CommittedTenantWrite) => Promise<void>;
  readonly now?: () => Date;
}

export function createInitializationRedelivery(options: InitializationRedeliveryOptions): (tenantId: string, documentId: string) => Promise<void> {
  return async (tenantId, documentId) => {
    let claimed: boolean;
    try {
      const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
      const result = await options.database.prepare(
        `UPDATE portal_documents SET initialization_redelivered_at = ?3
         WHERE tenant_id = ?1 AND document_id = ?2 AND current_version_idx IS NULL
           AND COALESCE(initialization_redelivered_at, created_at) <= ?4
           AND EXISTS (
             SELECT 1 FROM portal_document_types t
             WHERE t.document_type = portal_documents.document_type
               AND json_extract(t.registration_json, '$.builtinOperator.baseUrl') IS NOT NULL
           )`,
      ).bind(tenantId, documentId, now, now - INITIALIZATION_REDELIVERY_SECONDS).run();
      claimed = result.meta.changes === 1;
    } catch (error) {
      console.error(JSON.stringify({
        event: "portal_document_initialization_redelivery_failed", tenantId, documentId,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    if (!claimed) return;
    console.log(JSON.stringify({ event: "portal_document_initialization_redelivered", tenantId, documentId }));
    await options.dispatch({ kind: "document.created", tenantId, documentId });
  };
}
