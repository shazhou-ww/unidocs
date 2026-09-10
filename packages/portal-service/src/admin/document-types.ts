import { CreateDocumentTypeRequestSchema, DocumentTypeRegistrationSchema, DocumentTypeSchema, type AdminAuditEvent, type DocumentTypeRegistration, type ListDocumentTypesQuery, type ListDocumentTypesResponse } from "@unidocs/protocol-admin-portal";
import { resourceEtag, schemaHash } from "../identity.js";
import type { AdminContext } from "../auth/administrator.js";

export class AdminOperationError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "idempotency_conflict" | "forbidden") {
    super({ invalid_request: "The request is invalid", not_found: "Document type not found", idempotency_conflict: "The idempotency key was used with a different request", forbidden: "Administrator access is denied" }[code]);
    this.name = "AdminOperationError";
  }
}

export interface DocumentTypeCreateCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly registration: DocumentTypeRegistration;
  readonly audit: AdminAuditEvent;
}

export interface DocumentTypeRepository {
  create(command: DocumentTypeCreateCommand): Promise<{ readonly documentType: string; readonly etag: string }>;
  get(context: AdminContext, documentType: string): Promise<DocumentTypeRegistration | null>;
  list(context: AdminContext, query: ListDocumentTypesQuery): Promise<ListDocumentTypesResponse>;
}

export function createDocumentTypeService(repository: DocumentTypeRepository, options: {
  readonly now?: () => Date;
  readonly id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  return {
    async create(context: AdminContext, body: unknown, key: string, requestId: string) {
      const parsed = CreateDocumentTypeRequestSchema.safeParse(body);
      if (!parsed.success || typeof body !== "object" || body === null || Object.keys(body).some(field => field !== "internalName") || !parsed.data.internalName.trim() || parsed.data.internalName.length > 256 || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new AdminOperationError("invalid_request");
      const timestamp = now().toISOString();
      const representation = {
        documentType: DocumentTypeSchema.parse(`dt-${id()}`), internalName: parsed.data.internalName,
        enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, updatedAt: timestamp,
      };
      const registration = DocumentTypeRegistrationSchema.parse({ ...representation, etag: await resourceEtag(representation) });
      return repository.create({ context, key, fingerprint: await schemaHash({ operation: "createDocumentType", body: parsed.data }), registration,
        audit: { auditEventId: id(), actorId: context.memberId, action: "document_type.registered", resourceType: "document_type", resourceId: registration.documentType,
          documentType: registration.documentType, occurredAt: timestamp, requestId, reason: null },
      });
    },
    async get(context: AdminContext, documentType: string) {
      if (!DocumentTypeSchema.safeParse(documentType).success) throw new AdminOperationError("invalid_request");
      const registration = await repository.get(context, documentType);
      if (!registration) throw new AdminOperationError("not_found");
      return registration;
    },
    list: (context: AdminContext, query: ListDocumentTypesQuery = {}) => repository.list(context, query),
  };
}