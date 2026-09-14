import type { D1Database } from "@cloudflare/workers-types";
import {
  CommentRecordSchema,
  DocumentContractRecordSchema,
  ReplyRecordSchema,
  ThreadDetailSchema,
  ThreadRefSchema,
  type CommentRecord,
  type ListThreadsQuery,
  type ListThreadsResponse,
  type ReplyRecord,
  type ThreadDetail,
} from "@unidocs/protocol-tenant-portal";
import {
  TenantOperationError,
  type CommentAnchor, type CommentAppendCommand, type TenantContext, type TenantThreadRepository, type ThreadCreateCommand,
} from "@unidocs/portal-service";
import { decodeCursor, DEFAULT_PAGE_LIMIT, encodeCursor } from "./cursor.js";

interface CommentAnchorRow {
  readonly document_contract_idx: number;
  readonly record_json: string;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly created_at: number;
}

interface ReceiptRow {
  readonly fingerprint: string;
  readonly response_json: string;
}

interface CommentRow {
  readonly comment_idx: number;
  readonly base_version_idx: number;
  readonly content_json: string;
  readonly location_json: string | null;
  readonly author_id: string;
  readonly created_at: number;
}

interface ReplyRow {
  readonly reply_idx: number;
  readonly respond_through_comment_idx: number;
  readonly content_json: string;
  readonly result_locations_json: string;
  readonly author_agent_id: string;
  readonly submission_id: string;
  readonly created_at: number;
}

/** Idempotency scope for `create`: matches the operation name `threads.ts` uses when computing the fingerprint. */
const CREATE_THREAD_OPERATION = "createThread";

/** Idempotency scope for `appendComment`: matches the operation name `threads.ts` uses when computing the fingerprint. */
const APPEND_COMMENT_OPERATION = "appendComment";

/**
 * Upper bound on retries for the `comment_idx` allocation below. Each retry
 * means another concurrent writer won the same index first - a handful of
 * live competitors is expected, a runaway loop is not, so this is a
 * corruption/starvation backstop, not a normal-operation limit.
 */
const MAX_COMMENT_IDX_ATTEMPTS = 5;

function projectComment(row: CommentRow): CommentRecord {
  return CommentRecordSchema.parse({
    commentIdx: row.comment_idx,
    baseVersionIdx: row.base_version_idx,
    content: JSON.parse(row.content_json),
    location: row.location_json ? JSON.parse(row.location_json) : null,
    authorId: row.author_id,
    createdAt: new Date(row.created_at * 1000).toISOString(),
  });
}

function projectReply(row: ReplyRow): ReplyRecord {
  return ReplyRecordSchema.parse({
    replyIdx: row.reply_idx,
    respondThroughCommentIdx: row.respond_through_comment_idx,
    content: JSON.parse(row.content_json),
    resultLocations: JSON.parse(row.result_locations_json),
    authorAgentId: row.author_agent_id,
    submissionId: row.submission_id,
    createdAt: new Date(row.created_at * 1000).toISOString(),
  });
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
 * `create` and `appendComment` are immutable, append-only writes - there is
 * no update path anywhere in this class. A correction is a new comment, and
 * appending one is also what reopens a thread that had already been
 * answered, since `open` is derived rather than stored (see the class doc
 * above `list`).
 */
export class D1TenantThreadRepository implements TenantThreadRepository {
  constructor(private readonly database: D1Database) {}

  /**
   * Looks up the idempotency receipt for `operation`/`key`. A hit with a
   * matching fingerprint replays the original response; a hit with a
   * different one is a conflict, because the caller reused a retry key for a
   * different request; no hit at all is `null`, meaning the caller may
   * proceed to write. Shared by `create` and `appendComment`, which differ
   * only in operation name and response schema.
   */
  private async replay<T>(
    context: TenantContext, operation: string, key: string, fingerprint: string, schema: { parse(value: unknown): T },
  ): Promise<T | null> {
    const receipt = await this.database.prepare(
      `SELECT fingerprint, response_json FROM portal_tenant_idempotency_receipts
       WHERE tenant_id = ? AND actor_id = ? AND operation = ? AND key = ?`,
    ).bind(context.tenantId, context.principalId, operation, key).first<ReceiptRow>();
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw new TenantOperationError("idempotency_conflict");
    return schema.parse(JSON.parse(receipt.response_json));
  }

  /**
   * Writes the thread row, its first comment (`commentIdx` 0) and the
   * idempotency receipt in one atomic `batch` - the same replay-then-batch-
   * then-re-read-on-failure shape `document-repository.ts`'s `create` uses,
   * so a concurrent duplicate of this same request is absorbed by re-reading
   * the receipt rather than surfaced as an error.
   *
   * `threadId` is generated here, not by the service layer: unlike
   * `DocumentCreateCommand`, `ThreadCreateCommand` carries no pre-built
   * record for the repository to persist as-is, only the raw request.
   */
  async create(command: ThreadCreateCommand): Promise<ThreadDetail> {
    const { context, documentId, key, fingerprint, request } = command;

    const replayed = await this.replay(context, CREATE_THREAD_OPERATION, key, fingerprint, ThreadDetailSchema);
    if (replayed) return replayed;

    const threadId = `th-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const createdAtSeconds = Math.floor(Date.parse(createdAt) / 1000);
    const contentJson = JSON.stringify(request.content);
    const locationJson = request.location ? JSON.stringify(request.location) : null;

    const comment = CommentRecordSchema.parse({
      commentIdx: 0,
      baseVersionIdx: request.baseVersionIdx,
      content: request.content,
      location: request.location,
      authorId: context.principalId,
      createdAt,
    });
    const threadDetail = ThreadDetailSchema.parse({ threadId, comments: [comment], replies: [] });

    try {
      await this.database.batch([
        this.database.prepare(
          `INSERT INTO portal_tenant_idempotency_receipts (tenant_id, actor_id, operation, key, fingerprint, response_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(context.tenantId, context.principalId, CREATE_THREAD_OPERATION, key, fingerprint, JSON.stringify(threadDetail), createdAtSeconds),
        this.database.prepare(
          `INSERT INTO portal_threads (tenant_id, document_id, thread_id, created_at) VALUES (?, ?, ?, ?)`,
        ).bind(context.tenantId, documentId, threadId, createdAtSeconds),
        this.database.prepare(
          `INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        ).bind(context.tenantId, documentId, threadId, request.baseVersionIdx, contentJson, locationJson, context.principalId, createdAtSeconds),
      ]);
    } catch (error) {
      const concurrent = await this.replay(context, CREATE_THREAD_OPERATION, key, fingerprint, ThreadDetailSchema);
      if (concurrent) return concurrent;
      throw error;
    }

    return threadDetail;
  }

  /**
   * Assembles the full thread: both append-only sequences, each ordered
   * ascending by its own index. `null` when the thread itself has no row -
   * `create` always writes the thread row and its first comment together, so
   * an existing thread is never without at least one comment.
   */
  async get(context: TenantContext, documentId: string, threadId: string): Promise<ThreadDetail | null> {
    const threadRow = await this.database.prepare(
      `SELECT thread_id FROM portal_threads WHERE tenant_id = ? AND document_id = ? AND thread_id = ?`,
    ).bind(context.tenantId, documentId, threadId).first<{ thread_id: string }>();
    if (!threadRow) return null;

    const [comments, replies] = await Promise.all([
      this.database.prepare(
        `SELECT comment_idx, base_version_idx, content_json, location_json, author_id, created_at
         FROM portal_comments WHERE tenant_id = ? AND document_id = ? AND thread_id = ? ORDER BY comment_idx ASC`,
      ).bind(context.tenantId, documentId, threadId).all<CommentRow>(),
      this.database.prepare(
        `SELECT reply_idx, respond_through_comment_idx, content_json, result_locations_json, author_agent_id, submission_id, created_at
         FROM portal_replies WHERE tenant_id = ? AND document_id = ? AND thread_id = ? ORDER BY reply_idx ASC`,
      ).bind(context.tenantId, documentId, threadId).all<ReplyRow>(),
    ]);

    return ThreadDetailSchema.parse({
      threadId,
      comments: (comments.results ?? []).map(projectComment),
      replies: (replies.results ?? []).map(projectReply),
    });
  }

  /**
   * Allocates `comment_idx` by reading `COALESCE(MAX(comment_idx), -1) + 1`
   * and then, in the SAME atomic `batch`, inserting the comment at that
   * explicit index together with the idempotency receipt. The read is only a
   * proposal - it does not decide anything by itself, so this is not the
   * read-then-write pattern the brief warns against. The composite primary
   * key `(tenant_id, document_id, thread_id, comment_idx)` is still what
   * adjudicates: if a concurrent writer already took that index, the insert
   * loses the batch and rolls back with it, and the loop retries against
   * whatever that writer just committed.
   *
   * Batching the comment and its receipt together (rather than writing the
   * receipt only after the comment, as an earlier version of this method
   * did) closes two races a receipt-only-guards-itself design leaves open:
   * two same-key concurrent callers could otherwise each get past the
   * initial `replay()` check and each successfully commit their own comment
   * before either receipt landed - producing orphan rows even when both
   * calls carried the same fingerprint, or, worse, a persisted write from
   * the *loser* of a same-key-different-fingerprint race, which then also
   * threw `idempotency_conflict` - the exact inverse of what an idempotency
   * key promises. With the comment and its receipt as one batch, losing
   * either primary key - the comment's or the receipt's - rolls back both
   * statements, so a same-key racer never leaves a row behind: it either
   * commits cleanly or contributes nothing.
   *
   * The `FOREIGN KEY constraint failed` check runs before the `replay()`
   * re-read below: `SELECT MAX(comment_idx)` over a nonexistent thread still
   * returns a row (COALESCE'd to 0), so a missing thread is only caught when
   * the insert itself trips `portal_comments`' `FOREIGN KEY` to
   * `portal_threads` - which D1 enforces by default - and that must map to
   * `not_found` regardless of what a receipt lookup would say.
   */
  async appendComment(command: CommentAppendCommand): Promise<CommentRecord> {
    const { context, documentId, threadId, key, fingerprint, request } = command;

    const replayed = await this.replay(context, APPEND_COMMENT_OPERATION, key, fingerprint, CommentRecordSchema);
    if (replayed) return replayed;

    const createdAt = new Date().toISOString();
    const createdAtSeconds = Math.floor(Date.parse(createdAt) / 1000);
    const contentJson = JSON.stringify(request.content);
    const locationJson = request.location ? JSON.stringify(request.location) : null;

    for (let attempt = 0; attempt < MAX_COMMENT_IDX_ATTEMPTS; attempt++) {
      const next = await this.database.prepare(
        `SELECT COALESCE(MAX(comment_idx), -1) + 1 AS next_idx
         FROM portal_comments WHERE tenant_id = ? AND document_id = ? AND thread_id = ?`,
      ).bind(context.tenantId, documentId, threadId).first<{ next_idx: number }>();
      const commentIdx = next?.next_idx ?? 0;

      const comment = CommentRecordSchema.parse({
        commentIdx, baseVersionIdx: request.baseVersionIdx, content: request.content, location: request.location,
        authorId: context.principalId, createdAt,
      });

      try {
        await this.database.batch([
          this.database.prepare(
            `INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(context.tenantId, documentId, threadId, commentIdx, request.baseVersionIdx, contentJson, locationJson, context.principalId, createdAtSeconds),
          this.database.prepare(
            `INSERT INTO portal_tenant_idempotency_receipts (tenant_id, actor_id, operation, key, fingerprint, response_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(context.tenantId, context.principalId, APPEND_COMMENT_OPERATION, key, fingerprint, JSON.stringify(comment), createdAtSeconds),
        ]);
        return comment;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("FOREIGN KEY constraint failed")) throw new TenantOperationError("not_found");

        // Either primary key could have lost this batch: the comment's (an
        // independent append won this index first) or the receipt's (a
        // same-key racer got there first - possibly with a different
        // fingerprint). A receipt match means the latter: replay its winner,
        // or surface the fingerprint mismatch as a conflict - never our own
        // now-rolled-back write.
        const concurrent = await this.replay(context, APPEND_COMMENT_OPERATION, key, fingerprint, CommentRecordSchema);
        if (concurrent) return concurrent;

        if (message.includes("UNIQUE constraint failed")) continue;
        throw error;
      }
    }
    throw new TenantOperationError("unavailable");
  }

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
   * The `versionIdx` anchoring EXISTS above filters `portal_comments` on
   * `base_version_idx`, which had no index of its own: `comment_idx` is the
   * trailing PK column, so `MAX(comment_idx)` is a seek, but that EXISTS
   * scanned every comment row for the document. `migrations/0012_tenant.sql`
   * adds `portal_comment_version (tenant_id, document_id, base_version_idx)`
   * for this. It lands now rather than as a later migration purely because of
   * timing: 0012 has never reached production, so widening it is still a
   * one-line edit rather than a new migration after Plan 3 ships.
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
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
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
