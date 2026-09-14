import type { D1Database } from "@cloudflare/workers-types";
import {
  DocumentContractRecordSchema,
  ThreadRefSchema,
  type ListThreadsQuery,
  type ListThreadsResponse,
} from "@unidocs/protocol-tenant-portal";
import { TenantOperationError, type CommentAnchor, type TenantContext } from "@unidocs/portal-service";
import { decodeCursor, encodeCursor } from "./cursor.js";

interface CommentAnchorRow {
  readonly document_contract_idx: number;
  readonly record_json: string;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly created_at: number;
}

/**
 * Persists tenant discussion threads in `portal_threads`, `portal_comments`
 * and `portal_replies`.
 *
 * A thread's open state is never stored: it is derived as
 * `latestCommentIdx > acknowledgedCommentIdx`, exactly as
 * `packages/tenant-portal-client/src/memory/store.ts`'s `isOpen` computes it
 * in memory - both watermarks taken as a `MAX` over the thread's rows,
 * defaulting to `-1` when there are none. `list` translates that rule into
 * two correlated subqueries rather than reading a cached column, because the
 * contract has no resolve or reopen operation: a stored flag would be a
 * second source of truth that drifts the moment a comment lands after a
 * reply.
 *
 * `create`, `get` and `appendComment` are added on this same class by Task 8,
 * which is also where this class picks up `implements TenantThreadRepository`
 * - adding it now, ahead of those methods existing, would force throwing
 * stubs that fake a completeness this task doesn't have.
 */
export class D1TenantThreadRepository {
  constructor(private readonly database: D1Database) {}

  /**
   * `document_contract_idx` comes off the version row itself; the location
   * schema that revision fixes comes from `portal_document_contracts`, keyed
   * by the owning document's `document_type` (versions don't carry it) and
   * that same `document_contract_idx` - the same join shape
   * `version-repository.ts`'s `readSnapshot` uses to reach `document_type`.
   */
  async loadCommentAnchor(context: TenantContext, documentId: string, baseVersionIdx: number): Promise<CommentAnchor | null> {
    const row = await this.database.prepare(
      `SELECT v.document_contract_idx, c.record_json
       FROM portal_versions v
       JOIN portal_documents d ON d.tenant_id = v.tenant_id AND d.document_id = v.document_id
       JOIN portal_document_contracts c ON c.document_type = d.document_type AND c.document_contract_idx = v.document_contract_idx
       WHERE v.tenant_id = ? AND v.document_id = ? AND v.version_idx = ?`,
    ).bind(context.tenantId, documentId, baseVersionIdx).first<CommentAnchorRow>();
    if (!row) return null;

    const contract = DocumentContractRecordSchema.parse(JSON.parse(row.record_json));
    return { documentContractIdx: row.document_contract_idx, locationSchema: contract.location.schema };
  }

  /**
   * Lists `ThreadRef`s only - never comment or reply content - so a caller
   * that only wants to know which threads are open cannot see message
   * bodies in the same response.
   *
   * `open` and `versionIdx` are each an optional filter compiled to
   * `(?n IS NULL OR ...)`, so a single prepared statement serves every
   * combination of filters rather than branching to build different SQL text.
   *
   * The open filter is two correlated `MAX` subqueries, one per watermark,
   * each `COALESCE`d to `-1` exactly like the in-memory `isOpen` fixture:
   * `latestCommentIdx` from `portal_comments.comment_idx`, `acknowledgedCommentIdx`
   * from `portal_replies.respond_through_comment_idx`. The comparison itself
   * is wrapped in a `CASE` so it can be tested against the bound `?4` (1 or 0)
   * as the middle argument of `?4 IS NULL OR ?4 = (...)`, keeping the same
   * "optional filter" shape as every other predicate in this query.
   *
   * The keyset predicate uses `created_at < ?5 OR (created_at = ?5 AND
   * thread_id < ?6)` rather than the row-value form `(created_at, thread_id)
   * < (?5, ?6)`: D1's SQLite does support row-value comparison (verified
   * against a real D1 instance under Miniflare), but every other tenant
   * repository in this package already spells keyset paging as a disjunction,
   * so this keeps one style across the package rather than introducing a
   * second one that happens to also work.
   */
  async list(context: TenantContext, documentId: string, query: ListThreadsQuery): Promise<ListThreadsResponse> {
    let before: { at: number; id: string } | null = null;
    if (query.cursor !== undefined) {
      const key = decodeCursor(query.cursor);
      if (!key) throw new TenantOperationError("invalid_request");
      before = key;
    }
    const limit = query.limit ?? 25;
    const openFilter = query.open === undefined ? null : (query.open ? 1 : 0);

    const result = await this.database.prepare(
      `SELECT t.thread_id, t.created_at
       FROM portal_threads t
       WHERE t.tenant_id = ?1 AND t.document_id = ?2
         AND (?3 IS NULL OR EXISTS (
               SELECT 1 FROM portal_comments c
               WHERE c.tenant_id = t.tenant_id AND c.document_id = t.document_id
                 AND c.thread_id = t.thread_id AND c.base_version_idx = ?3))
         AND (?4 IS NULL OR ?4 = (
               CASE WHEN (
                 SELECT COALESCE(MAX(c.comment_idx), -1) FROM portal_comments c
                 WHERE c.tenant_id = t.tenant_id AND c.document_id = t.document_id AND c.thread_id = t.thread_id
               ) > (
                 SELECT COALESCE(MAX(r.respond_through_comment_idx), -1) FROM portal_replies r
                 WHERE r.tenant_id = t.tenant_id AND r.document_id = t.document_id AND r.thread_id = t.thread_id
               ) THEN 1 ELSE 0 END))
         AND (?5 IS NULL OR t.created_at < ?5 OR (t.created_at = ?5 AND t.thread_id < ?6))
       ORDER BY t.created_at DESC, t.thread_id DESC
       LIMIT ?7`,
    ).bind(
      context.tenantId, documentId,
      query.versionIdx ?? null,
      openFilter,
      before?.at ?? null, before?.id ?? null,
      limit + 1,
    ).all<ThreadRow>();

    const rows = result.results ?? [];
    const page = rows.slice(0, limit);
    const items = page.map(row => ThreadRefSchema.parse({ threadId: row.thread_id }));
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last
      ? encodeCursor({ at: last.created_at, id: last.thread_id })
      : null;
    return { items, nextCursor };
  }
}
