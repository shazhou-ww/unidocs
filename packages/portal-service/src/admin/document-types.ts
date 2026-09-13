import { CreateDocumentTypeRequestSchema, DocumentTypeRegistrationSchema, DocumentTypeSchema, EtagSchema, UpdateDocumentTypeRequestSchema, type AdminAuditEvent, type DocumentTypeRegistration, type ListDocumentTypesQuery, type ListDocumentTypesResponse, type OperatorRecord, type TypeCardBundleRecord, type ViewBundleRecord } from "@unidocs/protocol-admin-portal";
import { resourceEtag, schemaHash } from "../identity.js";
import type { AdminContext } from "../auth/administrator.js";

export class AdminOperationError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "idempotency_conflict" | "precondition_failed" | "forbidden") {
    super({ invalid_request: "The request is invalid", not_found: "Document type not found", idempotency_conflict: "The idempotency key was used with a different request", precondition_failed: "The If-Match precondition failed", forbidden: "Administrator access is denied" }[code]);
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

export interface DocumentTypeUpdateCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly expectedEtag: string;
  readonly registration: DocumentTypeRegistration;
  readonly audits: readonly AdminAuditEvent[];
}

export interface DocumentTypeRepository {
  create(command: DocumentTypeCreateCommand): Promise<{ readonly documentType: string; readonly etag: string }>;
  replayUpdate(context: AdminContext, key: string, fingerprint: string): Promise<{ readonly documentType: string; readonly etag: string } | null>;
  update(command: DocumentTypeUpdateCommand): Promise<{ readonly documentType: string; readonly etag: string }>;
  get(context: AdminContext, documentType: string): Promise<DocumentTypeRegistration | null>;
  list(context: AdminContext, query: ListDocumentTypesQuery): Promise<ListDocumentTypesResponse>;
  resolveTypeCardBundle(context: AdminContext, documentType: string, bundleId: string): Promise<TypeCardBundleRecord | null>;
  resolveViewBundle(context: AdminContext, documentType: string, bundleId: string): Promise<ViewBundleRecord | null>;
  resolveOperator(context: AdminContext, documentType: string, operatorId: string): Promise<OperatorRecord | null>;
  listDocumentContractIdxs(context: AdminContext, documentType: string): Promise<readonly number[]>;
}

export function createDocumentTypeService(repository: DocumentTypeRepository, options: {
  readonly now?: () => Date;
  readonly id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  const updateRequest = async (documentType: string, body: unknown, key: string, expectedEtag: string) => {
    const parsed = UpdateDocumentTypeRequestSchema.safeParse(body);
    const allowedFields = ["internalName", "typeCardBundleId", "viewBundleId", "builtinOperatorId", "enabled", "reason"];
    if (!parsed.success || typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some(field => !allowedFields.includes(field))
      || (parsed.data.internalName !== undefined && (!parsed.data.internalName.trim() || parsed.data.internalName.length > 256))
      || !/^[\x20-\x7e]{1,128}$/.test(key) || !EtagSchema.safeParse(expectedEtag).success) throw new AdminOperationError("invalid_request");
    if (!DocumentTypeSchema.safeParse(documentType).success) throw new AdminOperationError("invalid_request");
    return { request: parsed.data, fingerprint: await schemaHash({ operation: "updateDocumentType", documentType, expectedEtag, body: parsed.data }) };
  };
  return {
    async create(context: AdminContext, body: unknown, key: string, requestId: string) {
      const parsed = CreateDocumentTypeRequestSchema.safeParse(body);
      if (!parsed.success || typeof body !== "object" || body === null || Object.keys(body).some(field => field !== "internalName") || !parsed.data.internalName.trim() || parsed.data.internalName.length > 256 || !/^[\x20-\x7e]{1,128}$/.test(key)) throw new AdminOperationError("invalid_request");
      const timestamp = now().toISOString();
      const representation = {
        documentType: DocumentTypeSchema.parse(`dt-${id()}`), internalName: parsed.data.internalName,
        enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, updatedAt: timestamp,
      };
      const registration = DocumentTypeRegistrationSchema.parse({ ...representation, etag: await resourceEtag(representation) });
      return repository.create({
        context, key, fingerprint: await schemaHash({ operation: "createDocumentType", body: parsed.data }), registration,
        audit: {
          auditEventId: id(), actorId: context.memberId, action: "document_type.registered", resourceType: "document_type", resourceId: registration.documentType,
          documentType: registration.documentType, occurredAt: timestamp, requestId, reason: null
        },
      });
    },
    async get(context: AdminContext, documentType: string) {
      if (!DocumentTypeSchema.safeParse(documentType).success) throw new AdminOperationError("invalid_request");
      const registration = await repository.get(context, documentType);
      if (!registration) throw new AdminOperationError("not_found");
      return registration;
    },
    async replayUpdate(context: AdminContext, documentType: string, body: unknown, key: string, expectedEtag: string) {
      const { fingerprint } = await updateRequest(documentType, body, key, expectedEtag);
      return repository.replayUpdate(context, key, fingerprint);
    },
    async update(context: AdminContext, documentType: string, body: unknown, key: string, expectedEtag: string, requestId: string) {
      const parsed = await updateRequest(documentType, body, key, expectedEtag);
      const current = await repository.get(context, documentType);
      if (!current) throw new AdminOperationError("not_found");

      const timestamp = now().toISOString();
      let typeCardBundle = current.typeCardBundle;
      let viewBundle = current.viewBundle;
      let builtinOperator = current.builtinOperator;
      if (parsed.request.typeCardBundleId !== undefined) {
        typeCardBundle = await repository.resolveTypeCardBundle(context, documentType, parsed.request.typeCardBundleId);
        if (!typeCardBundle) throw new AdminOperationError("not_found");
      }
      if (parsed.request.viewBundleId !== undefined) {
        viewBundle = await repository.resolveViewBundle(context, documentType, parsed.request.viewBundleId);
        if (!viewBundle) throw new AdminOperationError("not_found");
      }
      if (parsed.request.builtinOperatorId !== undefined) {
        builtinOperator = parsed.request.builtinOperatorId === null ? null : await repository.resolveOperator(context, documentType, parsed.request.builtinOperatorId);
        if (parsed.request.builtinOperatorId !== null && !builtinOperator) throw new AdminOperationError("not_found");
      }
      const enabled = parsed.request.enabled ?? current.enabled;
      if (enabled && (!current.latestDocumentContract || !typeCardBundle || !viewBundle || !builtinOperator)) throw new AdminOperationError("invalid_request");
      if (enabled) {
        const contractIdxs = await repository.listDocumentContractIdxs(context, documentType);
        const operatorIdxs = new Set(builtinOperator!.descriptor.supportedDocumentContracts[documentType] ?? []);
        if (!contractIdxs.some(idx => viewBundle!.manifest.supportedDocumentContractIdxs.includes(idx) && operatorIdxs.has(idx))) throw new AdminOperationError("invalid_request");
      }
      const representation = {
        documentType, internalName: parsed.request.internalName ?? current.internalName, enabled,
        latestDocumentContract: current.latestDocumentContract, typeCardBundle, viewBundle, builtinOperator, updatedAt: timestamp,
      };
      const registration = DocumentTypeRegistrationSchema.parse({ ...representation, etag: await resourceEtag(representation) });
      const changedActions: AdminAuditEvent["action"][] = [];
      if (parsed.request.internalName !== undefined && parsed.request.internalName !== current.internalName) changedActions.push("document_type.internal_name_changed");
      if (parsed.request.typeCardBundleId !== undefined && typeCardBundle?.typeCardBundleId !== current.typeCardBundle?.typeCardBundleId) changedActions.push("document_type.type_card_bundle_changed");
      if (parsed.request.viewBundleId !== undefined && viewBundle?.viewBundleId !== current.viewBundle?.viewBundleId) changedActions.push("document_type.view_bundle_changed");
      if (parsed.request.builtinOperatorId !== undefined && builtinOperator?.operatorId !== current.builtinOperator?.operatorId) changedActions.push("document_type.operator_changed");
      if (parsed.request.enabled !== undefined && enabled !== current.enabled) changedActions.push(enabled ? "document_type.enabled" : "document_type.disabled");
      const audits = changedActions.map(action => ({
        auditEventId: id(), actorId: context.memberId, action, resourceType: "document_type" as const,
        resourceId: documentType, documentType, occurredAt: timestamp, requestId, reason: parsed.request.reason ?? null
      }));
      return repository.update({
        context, key, expectedEtag, registration, audits,
        fingerprint: parsed.fingerprint,
      });
    },
    list: (context: AdminContext, query: ListDocumentTypesQuery = {}) => repository.list(context, query),
  };
}