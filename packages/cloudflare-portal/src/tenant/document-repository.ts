import type { D1Database } from "@cloudflare/workers-types";
import {
  DocumentAuditEventSchema,
  DocumentRecordSchema,
  type DocumentAuditEvent,
  type DocumentRecord,
  type ListDocumentAuditEventsResponse,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type PaginationQuery,
} from "@unidocs/protocol-tenant-portal";
import {
  TenantOperationError,
  type CurrentVersionMoveCommand,
  type DocumentCreateCommand,
  type TenantContext,
  type TenantDocumentRepository,
} from "@unidocs/portal-service";
import { decodeCursor, DEFAULT_PAGE_LIMIT, encodeCursor } from "./cursor.js";

interface DocumentRow {
  readonly tenant_id: string;
  readonly document_id: string;
  readonly name: string;
  readonly document_type: string;
  readonly current_version_idx: number | null;
  readonly created_at: number;
}

interface ReceiptRow {
  readonly fingerprint: string;
  readonly response_json: string;
}

interface AuditRow {
  readonly audit_event_id: string;
  readonly actor_id: string;
  readonly action: string;
  readonly before_version_idx: number | null;
  readonly after_version_idx: number | null;
  readonly reason: string | null;
  readonly request_id: string;
  readonly occurred_at: number;
}

/** Idempotency scope for `create`: matches the operation name Task 2/5 use for their own writes. */
const CREATE_OPERATION = "createDocument";

/**
 * `TenantOperationError` (`packages/portal-service/src/tenant/access.ts`,
 * out of scope for this plan) carries only a `code` - no `data`/`details`
 * field. This subclass does not change that class's shape at all: it stays
 * `instanceof TenantOperationError` with `.code === "version_conflict"`
 * exactly as before, it only adds a `currentVersionIdx` field alongside it,
 * so a refused `moveCurrentVersion` can carry the value
 * `moveCurrentVersionContract`'s description promises ("409 with the
 * current value in error details") out of the repository without waiting
 * on Plan 3's HTTP layer to exist. Nothing downstream reads this field yet
 * - the HTTP layer that would map it into the response body is Plan 3's,
 * not this one's - but the repository can supply it now.
 */
export class VersionConflictError extends TenantOperationError {
  constructor(readonly currentVersionIdx: number | null) {
    super("version_conflict");
  }
}

/**
 * Persists tenant documents in `portal_documents`, alongside their creation
 * audit event, current-pointer moves, and idempotency receipt.
 */
export class D1TenantDocumentRepository implements TenantDocumentRepository {
  constructor(private readonly database: D1Database) {}

  /**
   * Looks up the idempotency receipt for `key`. A hit with a matching
   * fingerprint replays the original response; a hit with a different one is
   * a conflict, because the caller reused a retry key for a different
   * request; no hit at all is `null`, meaning the caller may proceed to write.
   */
  private async replay(context: TenantContext, key: string, fingerprint: string): Promise<DocumentRecord | null> {
    const receipt = await this.database.prepare(
      `SELECT fingerprint, response_json FROM portal_tenant_idempotency_receipts
       WHERE tenant_id = ? AND actor_id = ? AND operation = ? AND key = ?`,
    ).bind(context.tenantId, context.principalId, CREATE_OPERATION, key).first<ReceiptRow>();
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw new TenantOperationError("idempotency_conflict");
    return DocumentRecordSchema.parse(JSON.parse(receipt.response_json));
  }

  async create(command: DocumentCreateCommand): Promise<DocumentRecord> {
    const { context, key, fingerprint, document, audit } = command;

    const replayed = await this.replay(context, key, fingerprint);
    if (replayed) return replayed;

    const documentCreatedAt = Math.floor(Date.parse(document.createdAt) / 1000);
    const auditOccurredAt = Math.floor(Date.parse(audit.occurredAt) / 1000);

    let results: Awaited<ReturnType<D1Database["batch"]>>;
    try {
      // One atomic write: the receipt, the document row and its audit event all
      // land together, or none of them do. Each of the three is additionally
      // guarded by the same EXISTS check against portal_document_types - an
      // unknown or disabled document type makes every statement a no-op
      // rather than a partial write, so a document with no type card, view
      // bundle or Operator never lands, and a retry after document_type_disabled
      // has no stale receipt to replay. A UNIQUE violation on the receipt's
      // primary key (tenant_id, actor_id, operation, key) is how a concurrent
      // duplicate of this same request surfaces - it is absorbed below by
      // re-reading the receipt, rather than reported as a failure.
      results = await this.database.batch([
        this.database.prepare(
          `INSERT INTO portal_tenant_idempotency_receipts (tenant_id, actor_id, operation, key, fingerprint, response_json, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM portal_document_types WHERE document_type = ? AND enabled = 1)`,
        ).bind(
          context.tenantId, context.principalId, CREATE_OPERATION, key, fingerprint, JSON.stringify(document), documentCreatedAt,
          document.documentType,
        ),
        this.database.prepare(
          `INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM portal_document_types WHERE document_type = ? AND enabled = 1)`,
        ).bind(
          context.tenantId, document.documentId, document.name, document.documentType, document.currentVersionIdx, documentCreatedAt,
          document.documentType,
        ),
        this.database.prepare(
          `INSERT INTO portal_document_audit
             (audit_event_id, tenant_id, document_id, actor_id, action, before_version_idx, after_version_idx, reason, request_id, occurred_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM portal_document_types WHERE document_type = ? AND enabled = 1)`,
        ).bind(
          audit.auditEventId, context.tenantId, document.documentId, audit.actorId, audit.action,
          audit.beforeVersionIdx, audit.afterVersionIdx, audit.reason, audit.requestId, auditOccurredAt,
          document.documentType,
        ),
      ]);
    } catch (error) {
      const concurrent = await this.replay(context, key, fingerprint);
      if (concurrent) return concurrent;
      throw error;
    }

    const documentResult = results[1];
    if (!documentResult || documentResult.meta.changes === 0) throw new TenantOperationError("document_type_disabled");

    return DocumentRecordSchema.parse(document);
  }

  async get(context: TenantContext, documentId: string): Promise<DocumentRecord | null> {
    const row = await this.database.prepare(
      `SELECT tenant_id, document_id, name, document_type, current_version_idx, created_at
       FROM portal_documents WHERE tenant_id = ? AND document_id = ?`,
    ).bind(context.tenantId, documentId).first<DocumentRow>();
    return row ? DocumentRecordSchema.parse(projectDocument(row)) : null;
  }

  async list(context: TenantContext, query: ListDocumentsQuery): Promise<ListDocumentsResponse> {
    let before: { at: number; id: string } | null = null;
    if (query.cursor !== undefined) {
      const key = decodeCursor(query.cursor);
      if (!key) throw new TenantOperationError("invalid_request");
      before = key;
    }
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

    const result = await this.database.prepare(
      `SELECT tenant_id, document_id, name, document_type, current_version_idx, created_at FROM portal_documents
       WHERE tenant_id = ?1
         AND (?2 IS NULL OR document_type = ?2)
         AND (?3 IS NULL OR created_at < ?3 OR (created_at = ?3 AND document_id < ?4))
       ORDER BY created_at DESC, document_id DESC
       LIMIT ?5`,
    ).bind(context.tenantId, query.documentType ?? null, before?.at ?? null, before?.id ?? null, limit + 1).all<DocumentRow>();

    const rows = result.results ?? [];
    const page = rows.slice(0, limit);
    const items = page.map(row => DocumentRecordSchema.parse(projectDocument(row)));
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last
      ? encodeCursor({ at: last.created_at, id: last.document_id })
      : null;
    return { items, nextCursor };
  }

  /**
   * Moves `current_version_idx` under an equality lock carried by the
   * command: the UPDATE's WHERE clause itself compares the stored pointer to
   * `observedCurrentVersionIdx` (with `IS`, since that value is legitimately
   * `null` before the first version), rather than a preceding SELECT - so
   * there is no window between checking the pointer and moving it.
   *
   * The audit INSERT is batched BEFORE the UPDATE and guarded by the exact
   * same PRE-state condition the UPDATE's WHERE clause tests - the pointer
   * still equalling `observedCurrentVersionIdx`, via `IS`, and the target
   * version's existence - rather than the post-move state. A `batch` is one
   * transaction whose statements run in order against a single consistent
   * snapshot, so both guards observe the same "as of" state: nothing between
   * them can change what either EXISTS check sees.
   *
   * An earlier version of this guard used the POST-move state
   * (`current_version_idx = targetVersionIdx`) instead. That is wrong: when
   * the pointer already equals `targetVersionIdx` before this call (a stale
   * client re-observing a move someone else already made), the UPDATE's `IS
   * observedCurrentVersionIdx` comparison correctly fails and moves nothing,
   * but the post-state EXISTS check is true anyway - coincidentally, since
   * the pointer already sat at the target - so the audit INSERT fired and
   * recorded a move that never happened, into an append-only table with no
   * correction path, moments before the method itself threw
   * `version_conflict`. Guarding on the pre-state instead ties the audit
   * INSERT to the exact same fact the UPDATE requires to succeed, so a
   * refused move writes nothing.
   *
   * `meta.changes === 0` on the UPDATE means either the lock or the target
   * version's existence check failed. Per `moveCurrentVersionContract`, that
   * is normally `version_conflict` - but if the document itself no longer
   * exists (deleted, or never existed), the contract instead declares
   * `not_found`, and nothing else in this method has done the read needed to
   * tell the two apart, so a refusal now takes one extra read to decide
   * which. That same read's `currentVersionIdx` is threaded into
   * `VersionConflictError` on the version_conflict path, so the value the
   * contract's description promises ("409 with the current value in error
   * details") does not just vanish at this layer.
   */
  async moveCurrentVersion(command: CurrentVersionMoveCommand): Promise<DocumentRecord> {
    const { context, documentId, observedCurrentVersionIdx, targetVersionIdx, audit } = command;
    const auditOccurredAt = Math.floor(Date.parse(audit.occurredAt) / 1000);

    const results = await this.database.batch([
      this.database.prepare(
        `INSERT INTO portal_document_audit
           (audit_event_id, tenant_id, document_id, actor_id, action, before_version_idx, after_version_idx, reason, request_id, occurred_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM portal_documents
                       WHERE tenant_id = ? AND document_id = ? AND current_version_idx IS ?)
           AND EXISTS (SELECT 1 FROM portal_versions
                       WHERE tenant_id = ? AND document_id = ? AND version_idx = ?)`,
      ).bind(
        audit.auditEventId, context.tenantId, documentId, audit.actorId, audit.action,
        audit.beforeVersionIdx, audit.afterVersionIdx, audit.reason, audit.requestId, auditOccurredAt,
        context.tenantId, documentId, observedCurrentVersionIdx,
        context.tenantId, documentId, targetVersionIdx,
      ),
      this.database.prepare(
        `UPDATE portal_documents SET current_version_idx = ?
         WHERE tenant_id = ? AND document_id = ?
           AND current_version_idx IS ?
           AND EXISTS (SELECT 1 FROM portal_versions
                       WHERE tenant_id = ? AND document_id = ? AND version_idx = ?)`,
      ).bind(
        targetVersionIdx, context.tenantId, documentId,
        observedCurrentVersionIdx,
        context.tenantId, documentId, targetVersionIdx,
      ),
    ]);

    const updateResult = results[1];
    if (!updateResult || updateResult.meta.changes === 0) {
      const document = await this.get(context, documentId);
      if (!document) throw new TenantOperationError("not_found");
      throw new VersionConflictError(document.currentVersionIdx);
    }

    const updated = await this.get(context, documentId);
    if (!updated) throw new TenantOperationError("not_found");
    return updated;
  }

  async listAuditEvents(context: TenantContext, documentId: string, query: PaginationQuery): Promise<ListDocumentAuditEventsResponse> {
    let before: { at: number; id: string } | null = null;
    if (query.cursor !== undefined) {
      const key = decodeCursor(query.cursor);
      if (!key) throw new TenantOperationError("invalid_request");
      before = key;
    }
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

    const result = await this.database.prepare(
      `SELECT audit_event_id, actor_id, action, before_version_idx, after_version_idx, reason, request_id, occurred_at
       FROM portal_document_audit
       WHERE tenant_id = ?1 AND document_id = ?2
         AND (?3 IS NULL OR occurred_at < ?3 OR (occurred_at = ?3 AND audit_event_id < ?4))
       ORDER BY occurred_at DESC, audit_event_id DESC
       LIMIT ?5`,
    ).bind(context.tenantId, documentId, before?.at ?? null, before?.id ?? null, limit + 1).all<AuditRow>();

    const rows = result.results ?? [];
    const page = rows.slice(0, limit);
    const items = page.map(row => DocumentAuditEventSchema.parse(projectAudit(row)));
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last
      ? encodeCursor({ at: last.occurred_at, id: last.audit_event_id })
      : null;
    return { items, nextCursor };
  }
}

function projectAudit(row: AuditRow): DocumentAuditEvent {
  return {
    auditEventId: row.audit_event_id,
    actorId: row.actor_id,
    action: row.action as DocumentAuditEvent["action"],
    beforeVersionIdx: row.before_version_idx,
    afterVersionIdx: row.after_version_idx,
    reason: row.reason,
    requestId: row.request_id,
    occurredAt: new Date(row.occurred_at * 1000).toISOString(),
  };
}

function projectDocument(row: DocumentRow): DocumentRecord {
  return {
    documentId: row.document_id,
    name: row.name,
    documentType: row.document_type,
    currentVersionIdx: row.current_version_idx,
    createdAt: new Date(row.created_at * 1000).toISOString(),
  };
}
