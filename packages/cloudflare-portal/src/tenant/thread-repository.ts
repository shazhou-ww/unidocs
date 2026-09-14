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
import { decodeCursor, encodeCursor } from "./cursor.js";

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
   * Allocates `comment_idx` inside the `INSERT ... SELECT ... RETURNING`
   * itself, rather than reading `MAX(comment_idx)` and writing it back as two
   * statements - between which a concurrent append could read the same
   * value. The composite primary key `(tenant_id, document_id, thread_id,
   * comment_idx)` is the backstop: two concurrent appends computing the same
   * next index can both attempt the insert, but only one can win it: the
   * loser gets a primary-key violation and retries, recomputing the index
   * against whatever the winner just committed. `RETURNING` was confirmed to
   * work against D1 under Miniflare before being relied on here (see the
   * task report); D1 also enforces the `FOREIGN KEY` from `portal_comments`
   * to `portal_threads` by default, which is what turns an append to a
   * nonexistent thread into `not_found` without a separate existence check.
   *
   * The idempotency receipt is written only after the index is known, since
   * the `CommentRecord` it stores needs that index - so, unlike `create`, it
   * cannot be part of the same atomic batch as the insert above. A duplicate
   * request replayed sequentially is still fully idempotent (the `replay`
   * check above returns the first response before any of this runs again);
   * only two truly concurrent callers reusing the very same idempotency key
   * inside this narrow window could each append a comment before either
   * receipt lands. That is a much rarer condition than two independent
   * callers appending near-simultaneously - the case this method exists to
   * make race-free - and is the same trade-off `AppendCommentRequest`'s
   * design accepts elsewhere in this plan.
   */
  async appendComment(command: CommentAppendCommand): Promise<CommentRecord> {
    const { context, documentId, threadId, key, fingerprint, request } = command;

    const replayed = await this.replay(context, APPEND_COMMENT_OPERATION, key, fingerprint, CommentRecordSchema);
    if (replayed) return replayed;

    const createdAt = new Date().toISOString();
    const createdAtSeconds = Math.floor(Date.parse(createdAt) / 1000);
    const contentJson = JSON.stringify(request.content);
    const locationJson = request.location ? JSON.stringify(request.location) : null;

    let commentIdx: number | null = null;
    for (let attempt = 0; attempt < MAX_COMMENT_IDX_ATTEMPTS && commentIdx === null; attempt++) {
      let row: { comment_idx: number } | undefined;
      try {
        const result = await this.database.prepare(
          `INSERT INTO portal_comments (tenant_id, document_id, thread_id, comment_idx, base_version_idx, content_json, location_json, author_id, created_at)
           SELECT ?1, ?2, ?3, COALESCE(MAX(comment_idx), -1) + 1, ?4, ?5, ?6, ?7, ?8
           FROM portal_comments WHERE tenant_id = ?1 AND document_id = ?2 AND thread_id = ?3
           RETURNING comment_idx`,
        ).bind(context.tenantId, documentId, threadId, request.baseVersionIdx, contentJson, locationJson, context.principalId, createdAtSeconds)
          .all<{ comment_idx: number }>();
        row = result.results?.[0];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("FOREIGN KEY constraint failed")) throw new TenantOperationError("not_found");
        if (message.includes("UNIQUE constraint failed")) continue;
        throw error;
      }
      // The SELECT is an aggregate with no GROUP BY, so it always yields
      // exactly one row for any thread that exists (comment_idx 0 came from
      // `create`), even before any prior appendComment call; a nonexistent
      // thread instead fails the FOREIGN KEY check above before RETURNING
      // runs. This is therefore unreachable in practice - kept only as a
      // defensive backstop against relying on that D1/SQLite behavior.
      if (!row) throw new TenantOperationError("not_found");
      commentIdx = row.comment_idx;
    }
    if (commentIdx === null) throw new Error("comment_idx allocation did not converge after retrying");

    const comment = CommentRecordSchema.parse({
      commentIdx, baseVersionIdx: request.baseVersionIdx, content: request.content, location: request.location,
      authorId: context.principalId, createdAt,
    });

    try {
      await this.database.prepare(
        `INSERT INTO portal_tenant_idempotency_receipts (tenant_id, actor_id, operation, key, fingerprint, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(context.tenantId, context.principalId, APPEND_COMMENT_OPERATION, key, fingerprint, JSON.stringify(comment), createdAtSeconds).run();
    } catch (error) {
      const concurrent = await this.replay(context, APPEND_COMMENT_OPERATION, key, fingerprint, CommentRecordSchema);
      if (concurrent) return concurrent;
      throw error;
    }

    return comment;
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
