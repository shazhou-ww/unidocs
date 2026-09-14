import type { D1Database } from "@cloudflare/workers-types";
import {
  DocumentRecordSchema,
  type DocumentRecord,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
} from "@unidocs/protocol-tenant-portal";
import { TenantOperationError, type DocumentCreateCommand, type TenantContext, type TenantDocumentRepository } from "@unidocs/portal-service";
import { decodeCursor, encodeCursor } from "./cursor.js";

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

/** Idempotency scope for `create`: matches the operation name Task 2/5 use for their own writes. */
const CREATE_OPERATION = "createDocument";

/**
 * Persists tenant documents in `portal_documents`, alongside their creation
 * audit event and idempotency receipt.
 *
 * Only `create`, `get` and `list` are implemented here (Task 4). Task 5 adds
 * `moveCurrentVersion` and `listAuditEvents` to this same class, at which
 * point it starts declaring `implements TenantDocumentRepository` in full;
 * until then this type only promises the slice it actually has.
 */
export class D1TenantDocumentRepository implements Pick<TenantDocumentRepository, "create" | "get" | "list"> {
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

    try {
      // One atomic write: the receipt, the document row and its audit event all
      // land together, or none of them do. A UNIQUE violation on the receipt's
      // primary key (tenant_id, actor_id, operation, key) is how a concurrent
      // duplicate of this same request surfaces - it is absorbed below by
      // re-reading the receipt, rather than reported as a failure.
      await this.database.batch([
        this.database.prepare(
          `INSERT INTO portal_tenant_idempotency_receipts (tenant_id, actor_id, operation, key, fingerprint, response_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(context.tenantId, context.principalId, CREATE_OPERATION, key, fingerprint, JSON.stringify(document), documentCreatedAt),
        this.database.prepare(
          `INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(context.tenantId, document.documentId, document.name, document.documentType, document.currentVersionIdx, documentCreatedAt),
        this.database.prepare(
          `INSERT INTO portal_document_audit
             (audit_event_id, tenant_id, document_id, actor_id, action, before_version_idx, after_version_idx, reason, request_id, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          audit.auditEventId, context.tenantId, document.documentId, audit.actorId, audit.action,
          audit.beforeVersionIdx, audit.afterVersionIdx, audit.reason, audit.requestId, auditOccurredAt,
        ),
      ]);
    } catch (error) {
      const concurrent = await this.replay(context, key, fingerprint);
      if (concurrent) return concurrent;
      throw error;
    }

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
    const limit = query.limit ?? 25;

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
