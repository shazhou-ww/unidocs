import {
  CreateDocumentRequestSchema, DocumentAuditEventSchema, DocumentRecordSchema, DocumentTypeSchema, MoveCurrentVersionRequestSchema,
  type DocumentAuditEvent, type DocumentRecord, type ListDocumentAuditEventsResponse, type ListDocumentsQuery, type ListDocumentsResponse, type PaginationQuery,
} from "@unidocs/protocol-tenant-portal";
import { schemaHash } from "../identity.js";
import {
  guardCanonicalization, requireExactFields, requireIdempotencyKey, requireIdentifier, requirePagination, requireTenantScope,
  TENANT_LIMITS, TenantOperationError, type TenantContext,
} from "./access.js";

export interface DocumentCreateCommand {
  readonly context: TenantContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly document: DocumentRecord;
  readonly audit: DocumentAuditEvent;
}

/**
 * The equality lock travels with the command: the repository must refuse the
 * move unless the pointer still equals observedCurrentVersionIdx at commit, and
 * must write the audit event in the same transaction as the move.
 */
export interface CurrentVersionMoveCommand {
  readonly context: TenantContext;
  readonly documentId: string;
  readonly observedCurrentVersionIdx: number | null;
  readonly targetVersionIdx: number;
  readonly audit: DocumentAuditEvent;
}

export interface TenantDocumentRepository {
  create(command: DocumentCreateCommand): Promise<DocumentRecord>;
  get(context: TenantContext, documentId: string): Promise<DocumentRecord | null>;
  list(context: TenantContext, query: ListDocumentsQuery): Promise<ListDocumentsResponse>;
  moveCurrentVersion(command: CurrentVersionMoveCommand): Promise<DocumentRecord>;
  listAuditEvents(context: TenantContext, documentId: string, query: PaginationQuery): Promise<ListDocumentAuditEventsResponse>;
}

export function createTenantDocumentService(repository: TenantDocumentRepository, options: {
  readonly now?: () => Date;
  readonly id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());

  return {
    async create(context: TenantContext, tenantId: string, body: unknown, key: string, requestId: string): Promise<DocumentRecord> {
      requireTenantScope(context, tenantId);
      const idempotencyKey = requireIdempotencyKey(key);
      requireExactFields(body, ["documentType", "name"]);
      const parsed = CreateDocumentRequestSchema.safeParse(body);
      if (!parsed.success || !parsed.data.name.trim() || parsed.data.name.length > TENANT_LIMITS.documentName) throw new TenantOperationError("invalid_request");
      const occurredAt = now().toISOString();
      const document = DocumentRecordSchema.parse({
        documentId: `doc-${id()}`, name: parsed.data.name, documentType: parsed.data.documentType, currentVersionIdx: null, createdAt: occurredAt,
      });
      return repository.create({
        context, key: idempotencyKey, fingerprint: await guardCanonicalization(() => schemaHash({ operation: "createDocument", body: parsed.data })), document,
        audit: DocumentAuditEventSchema.parse({
          auditEventId: id(), actorId: context.principalId, action: "document.created",
          beforeVersionIdx: null, afterVersionIdx: null, reason: null, requestId, occurredAt,
        }),
      });
    },

    async get(context: TenantContext, tenantId: string, documentId: string): Promise<DocumentRecord> {
      requireTenantScope(context, tenantId);
      const document = await repository.get(context, requireIdentifier(documentId));
      if (!document) throw new TenantOperationError("not_found");
      return document;
    },

    async list(context: TenantContext, tenantId: string, query: ListDocumentsQuery = {}): Promise<ListDocumentsResponse> {
      requireTenantScope(context, tenantId);
      const page = requirePagination({ cursor: query.cursor, limit: query.limit });
      if (query.documentType !== undefined && !DocumentTypeSchema.safeParse(query.documentType).success) throw new TenantOperationError("invalid_request");
      return repository.list(context, { ...page, ...(query.documentType === undefined ? {} : { documentType: query.documentType }) });
    },

    async moveCurrentVersion(context: TenantContext, tenantId: string, documentId: string, body: unknown, requestId: string): Promise<DocumentRecord> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      requireExactFields(body, ["observedCurrentVersionIdx", "targetVersionIdx", "reason"]);
      const parsed = MoveCurrentVersionRequestSchema.safeParse(body);
      if (!parsed.success || !parsed.data.reason.trim() || parsed.data.reason.length > TENANT_LIMITS.reason) throw new TenantOperationError("invalid_request");
      return repository.moveCurrentVersion({
        context, documentId: document,
        observedCurrentVersionIdx: parsed.data.observedCurrentVersionIdx, targetVersionIdx: parsed.data.targetVersionIdx,
        audit: DocumentAuditEventSchema.parse({
          auditEventId: id(), actorId: context.principalId, action: "current_version.moved",
          beforeVersionIdx: parsed.data.observedCurrentVersionIdx, afterVersionIdx: parsed.data.targetVersionIdx,
          reason: parsed.data.reason, requestId, occurredAt: now().toISOString(),
        }),
      });
    },

    async listAuditEvents(context: TenantContext, tenantId: string, documentId: string, query: unknown = {}): Promise<ListDocumentAuditEventsResponse> {
      requireTenantScope(context, tenantId);
      return repository.listAuditEvents(context, requireIdentifier(documentId), requirePagination(query));
    },
  };
}
