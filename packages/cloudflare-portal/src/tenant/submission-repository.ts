import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { DocumentTypeRegistration } from "@unidocs/protocol-admin-portal";
import { SubmissionReceiptSchema } from "@unidocs/protocol-platform";
import { DocumentContractRecordSchema } from "@unidocs/protocol-tenant-portal";
import {
  TenantOperationError,
  type CommittedSubmissionReceipt, type SubmissionCommitCommand, type SubmissionCommitOutcome, type SubmissionContract,
  type SubmissionState, type SubmissionThreadState, type TenantContext, type TenantSubmissionRepository,
} from "@unidocs/portal-service";
import { availableContractIdxs } from "./catalog-repository.js";

interface DocumentStateRow {
  readonly document_type: string;
  readonly current_version_idx: number | null;
  readonly registration_json: string | null;
}

interface ReceiptRow {
  readonly fingerprint: string;
  readonly receipt_json: string;
}

/**
 * Upper bound on commit attempts that lose an index race while every lock
 * still holds. As with `thread-repository.ts`'s comment allocation, each lost
 * race means a concurrent writer committed first; this is a starvation
 * backstop, not a normal-operation limit.
 */
const MAX_COMMIT_ATTEMPTS = 5;

/** One optimistic lock as a SQL boolean expression with its bindings. */
interface Lock {
  readonly condition: string;
  readonly bindings: readonly unknown[];
}

/**
 * The derived acknowledgement watermark, `-1` when nobody has replied yet -
 * the same rule `thread-repository.ts`'s `list` uses for its open filter.
 * Bindings: ?1 tenant, ?2 document, ?3 thread.
 */
const ACKNOWLEDGED_SQL = `(SELECT COALESCE(MAX(respond_through_comment_idx), -1) FROM portal_replies
  WHERE tenant_id = ?1 AND document_id = ?2 AND thread_id = ?3)`;

/**
 * Persists Agent submissions: the version row, the document pointer move, the
 * replies and the committed receipt in `portal_submissions`, all in one D1
 * batch guarded by the version lock and every thread lock.
 */
export class D1TenantSubmissionRepository implements TenantSubmissionRepository {
  constructor(private readonly database: D1Database) {}

  async findReceipt(context: TenantContext, documentId: string, submissionId: string): Promise<{ fingerprint: string; receipt: CommittedSubmissionReceipt } | null> {
    const row = await this.database.prepare(
      "SELECT fingerprint, receipt_json FROM portal_submissions WHERE tenant_id = ? AND document_id = ? AND submission_id = ?",
    ).bind(context.tenantId, documentId, submissionId).first<ReceiptRow>();
    if (!row) return null;
    const receipt = SubmissionReceiptSchema.parse(JSON.parse(row.receipt_json));
    if (receipt.state !== "committed") throw new Error(`portal_submissions holds a ${receipt.state} receipt for ${submissionId}`);
    return { fingerprint: row.fingerprint, receipt };
  }

  /**
   * Reads the document, its available contracts and every named thread in one
   * read-only batch, so the whole state comes from a single snapshot. A thread
   * id that does not exist in the document is simply absent from `threads`.
   * `latestCommentIdx` is the last of the thread's comments, which is the same
   * `MAX(comment_idx)` the thread repository derives.
   */
  async loadState(context: TenantContext, documentId: string, threadIds: readonly string[]): Promise<SubmissionState | null> {
    const ids = [...new Set(threadIds)];
    const results = await this.database.batch([
      this.database.prepare(
        `SELECT d.document_type, d.current_version_idx, t.registration_json
         FROM portal_documents d LEFT JOIN portal_document_types t ON t.document_type = d.document_type
         WHERE d.tenant_id = ? AND d.document_id = ?`,
      ).bind(context.tenantId, documentId),
      ...ids.flatMap(threadId => [
        this.database.prepare(
          `SELECT ${ACKNOWLEDGED_SQL} AS acknowledged FROM portal_threads WHERE tenant_id = ?1 AND document_id = ?2 AND thread_id = ?3`,
        ).bind(context.tenantId, documentId, threadId),
        this.database.prepare(
          `SELECT comment_idx, base_version_idx FROM portal_comments
           WHERE tenant_id = ? AND document_id = ? AND thread_id = ? ORDER BY comment_idx ASC`,
        ).bind(context.tenantId, documentId, threadId),
      ]),
    ]);

    const document = results[0]?.results?.[0] as DocumentStateRow | undefined;
    if (!document) return null;

    const threads = new Map<string, SubmissionThreadState>();
    ids.forEach((threadId, index) => {
      const thread = results[1 + index * 2]?.results?.[0] as { acknowledged: number } | undefined;
      if (!thread) return;
      const comments = ((results[2 + index * 2]?.results ?? []) as { comment_idx: number; base_version_idx: number }[])
        .map(row => ({ commentIdx: row.comment_idx, baseVersionIdx: row.base_version_idx }));
      threads.set(threadId, {
        threadId,
        acknowledgedCommentIdx: thread.acknowledged < 0 ? null : thread.acknowledged,
        latestCommentIdx: comments.at(-1)?.commentIdx ?? -1,
        comments,
      });
    });

    const registration = document.registration_json === null
      ? {}
      : JSON.parse(document.registration_json) as Partial<DocumentTypeRegistration>;
    return {
      documentType: document.document_type,
      currentVersionIdx: document.current_version_idx,
      availableDocumentContractIdxs: availableContractIdxs(registration),
      threads,
    };
  }

  async loadContract(documentType: string, documentContractIdx: number): Promise<SubmissionContract | null> {
    const row = await this.database.prepare(
      "SELECT record_json FROM portal_document_contracts WHERE document_type = ? AND document_contract_idx = ?",
    ).bind(documentType, documentContractIdx).first<{ record_json: string }>();
    if (!row) return null;
    const contract = DocumentContractRecordSchema.parse(JSON.parse(row.record_json));
    return { snapshotSchema: contract.snapshot.schema, locationSchema: contract.location.schema };
  }

  /**
   * Writes the whole submission in one `batch`, which D1 runs as a single
   * transaction:
   *
   * 1. One guard per lock - an `INSERT INTO portal_mutation_guard` whose value
   *    is 1 only if the lock holds, followed at once by `DELETE FROM
   *    portal_mutation_guard`, exactly like `auth-repository.ts`'s `guard()`.
   *    A failed lock inserts 0, the table's `CHECK (valid = 1)` aborts the
   *    batch, and every statement rolls back. The version lock also requires
   *    the document row to exist (`null IS null` would otherwise pass for a
   *    missing document); a thread lock requires the thread row to exist.
   *    One guard per lock rather than one combined guard keeps each statement
   *    well under D1's 100 bound parameters with up to 50 thread updates.
   * 2. The version row and the pointer move, then the replies, then the
   *    receipt.
   *
   * `version_idx` and each `reply_idx` are read in JS before the attempt and
   * bound as literals, so the receipt carries the exact indexes the rows get.
   * The read is only a proposal: the composite primary keys adjudicate. If a
   * concurrent writer took an index, the batch fails, and `classifyFailure`
   * decides by re-reading the database - never by error text - whether this
   * was a twin submission (a receipt with this id now exists: `conflict`, so
   * the service replays or rejects by fingerprint), a vanished document or
   * thread (`not_found`), a moved lock (`conflict`), or an index race with
   * every lock still holding (retry, logged as `portal_submission_commit_retry`;
   * after `MAX_COMMIT_ATTEMPTS` the last error is logged as
   * `portal_submission_commit_failed` and the commit is `unavailable`).
   *
   * Known gap: contract availability (`newDocumentContractIdx` being in the
   * View ∩ Operator intersection) is checked by the service against the state
   * it read, and is NOT re-checked in the guard. An administrator who changes
   * the document type's View or Operator between that read and this batch can
   * therefore see a version committed in a revision that has just stopped
   * being available. The version and thread locks are atomic; this one is not.
   */
  async commit(command: SubmissionCommitCommand): Promise<SubmissionCommitOutcome> {
    const locks = this.locks(command);

    for (let attempt = 1; ; attempt++) {
      const { statements, receipt } = await this.prepareAttempt(command, locks);
      try {
        await this.database.batch(statements);
        return { kind: "committed", receipt };
      } catch (error) {
        if (await this.classifyFailure(command, locks) === "conflict") return { kind: "conflict" };
        // Every lock still holds, so nothing explains the failure but an index race or a D1
        // fault. TenantOperationError carries no cause and the adapter logs only uncoded
        // errors, so this line is the only record of what failed. Name and message only.
        const failure = error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };
        if (attempt === MAX_COMMIT_ATTEMPTS) {
          console.error(JSON.stringify({ event: "portal_submission_commit_failed", attempt, ...failure }));
          throw new TenantOperationError("unavailable");
        }
        console.error(JSON.stringify({ event: "portal_submission_commit_retry", attempt, ...failure }));
      }
    }
  }

  private locks({ context, documentId, request }: SubmissionCommitCommand): Lock[] {
    const locks: Lock[] = [];
    if (request.newSnapshotBlob !== undefined) {
      locks.push({
        condition: "EXISTS (SELECT 1 FROM portal_documents WHERE tenant_id = ?1 AND document_id = ?2 AND current_version_idx IS ?3)",
        bindings: [context.tenantId, documentId, request.observedCurrentVersionIdx ?? null],
      });
    }
    for (const update of request.threadUpdates) {
      locks.push({
        condition: `EXISTS (SELECT 1 FROM portal_threads WHERE tenant_id = ?1 AND document_id = ?2 AND thread_id = ?3)
          AND ${ACKNOWLEDGED_SQL} = ?4`,
        bindings: [context.tenantId, documentId, update.threadId, update.observedAcknowledgedCommentIdx ?? -1],
      });
    }
    return locks;
  }

  /** Reads the proposed indexes and builds this attempt's statements and the receipt that names them. */
  private async prepareAttempt(command: SubmissionCommitCommand, locks: readonly Lock[]): Promise<{ statements: D1PreparedStatement[]; receipt: CommittedSubmissionReceipt }> {
    const { context, documentId, fingerprint, request, addressedComments, now } = command;
    const snapshot = request.newSnapshotBlob;
    const createdAtSeconds = Math.floor(now.getTime() / 1000);
    const createdAt = new Date(createdAtSeconds * 1000).toISOString();

    const [versionIdx, replyIdxs] = await Promise.all([
      snapshot === undefined ? null : this.nextIdx(
        "SELECT COALESCE(MAX(version_idx), -1) + 1 AS next_idx FROM portal_versions WHERE tenant_id = ? AND document_id = ?",
        context.tenantId, documentId,
      ),
      Promise.all(request.threadUpdates.map(update => this.nextIdx(
        "SELECT COALESCE(MAX(reply_idx), -1) + 1 AS next_idx FROM portal_replies WHERE tenant_id = ? AND document_id = ? AND thread_id = ?",
        context.tenantId, documentId, update.threadId,
      ))),
    ]);

    const addressed = addressedComments.map(({ threadId, commentIdx, baseVersionIdx }) => ({ threadId, commentIdx, baseVersionIdx }));
    const receipt = SubmissionReceiptSchema.parse({
      submissionId: request.submissionId,
      state: "committed",
      version: snapshot === undefined ? null : {
        versionIdx,
        parentVersionIdx: request.observedCurrentVersionIdx ?? null,
        documentContractIdx: request.newDocumentContractIdx,
        authorAgentId: context.principalId,
        submissionId: request.submissionId,
        addressedComments: addressed,
        createdAt,
      },
      replies: request.threadUpdates.map((update, index) => ({
        replyIdx: replyIdxs[index],
        respondThroughCommentIdx: update.respondThroughCommentIdx,
        content: update.content,
        resultLocations: update.resultLocations,
        authorAgentId: context.principalId,
        submissionId: request.submissionId,
        createdAt,
      })),
      committedAt: createdAt,
    }) as CommittedSubmissionReceipt;

    const statements: D1PreparedStatement[] = locks.flatMap(lock => [
      this.database.prepare(`INSERT INTO portal_mutation_guard (valid) SELECT CASE WHEN ${lock.condition} THEN 1 ELSE 0 END`).bind(...lock.bindings),
      this.database.prepare("DELETE FROM portal_mutation_guard"),
    ]);

    if (snapshot !== undefined && receipt.version) {
      statements.push(
        this.database.prepare(
          `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id,
             addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          context.tenantId, documentId, receipt.version.versionIdx, receipt.version.parentVersionIdx, receipt.version.documentContractIdx,
          context.principalId, request.submissionId, JSON.stringify(addressed),
          snapshot.blobHash, snapshot.size, snapshot.contentType, createdAtSeconds,
        ),
        this.database.prepare(
          "UPDATE portal_documents SET current_version_idx = ? WHERE tenant_id = ? AND document_id = ?",
        ).bind(receipt.version.versionIdx, context.tenantId, documentId),
      );
    }

    request.threadUpdates.forEach((update, index) => {
      const reply = receipt.replies[index]!;
      statements.push(this.database.prepare(
        `INSERT INTO portal_replies (tenant_id, document_id, thread_id, reply_idx, respond_through_comment_idx, content_json, result_locations_json,
           author_agent_id, submission_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        context.tenantId, documentId, update.threadId, reply.replyIdx, reply.respondThroughCommentIdx,
        JSON.stringify(reply.content), JSON.stringify(reply.resultLocations), context.principalId, request.submissionId, createdAtSeconds,
      ));
    });

    statements.push(this.database.prepare(
      `INSERT INTO portal_submissions (tenant_id, document_id, submission_id, actor_id, fingerprint, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(context.tenantId, documentId, request.submissionId, context.principalId, fingerprint, JSON.stringify(receipt), createdAtSeconds));

    return { statements, receipt };
  }

  private async nextIdx(sql: string, ...bindings: unknown[]): Promise<number> {
    const row = await this.database.prepare(sql).bind(...bindings).first<{ next_idx: number }>();
    return row?.next_idx ?? 0;
  }

  /**
   * Explains a failed batch by re-reading the database, never by error text:
   * a receipt for this submission id now exists (a twin committed first) is
   * `conflict`, so the service replays or rejects it by fingerprint; a vanished
   * document or thread throws `not_found`; a lock that no longer evaluates as
   * the guard required is `conflict`; and with every lock still holding the
   * batch lost an index race (or hit a fault) and may `retry`.
   */
  private async classifyFailure({ context, documentId, request }: SubmissionCommitCommand, locks: readonly Lock[]): Promise<"conflict" | "retry"> {
    if (await this.findReceipt(context, documentId, request.submissionId)) return "conflict";
    const [documentExists, threadsExist, held] = await Promise.all([
      this.database.prepare("SELECT 1 AS found FROM portal_documents WHERE tenant_id = ? AND document_id = ?")
        .bind(context.tenantId, documentId).first(),
      Promise.all(request.threadUpdates.map(update => this.database.prepare(
        "SELECT 1 AS found FROM portal_threads WHERE tenant_id = ? AND document_id = ? AND thread_id = ?",
      ).bind(context.tenantId, documentId, update.threadId).first())),
      Promise.all(locks.map(lock => this.database.prepare(
        `SELECT CASE WHEN ${lock.condition} THEN 1 ELSE 0 END AS holds`,
      ).bind(...lock.bindings).first<{ holds: number }>())),
    ]);
    if (!documentExists || threadsExist.some(thread => !thread)) throw new TenantOperationError("not_found");
    return held.every(row => row?.holds === 1) ? "retry" : "conflict";
  }
}
