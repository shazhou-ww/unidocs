import { CreateOperatorRequestSchema, EtagSchema, ListBundlesQuerySchema, OperatorRecordSchema, UpdateCandidateMetadataRequestSchema,
  type CreateOperatorRequest, type ListBundlesQuery, type ListOperatorsResponse, type OperatorMutationResult, type OperatorRecord,
  type OperatorValidation, type UpdateCandidateMetadataRequest } from "@unidocs/protocol-admin-portal";
import type { AdminContext } from "../auth/administrator.js";
import { resourceEtag, schemaHash } from "../identity.js";

export type OperatorErrorCode = "invalid_request" | "not_found" | "idempotency_conflict" | "precondition_failed" | "forbidden" | "operator_validation_required";
export class OperatorOperationError extends Error {
  constructor(readonly code: OperatorErrorCode) {
    super({ invalid_request: "The request is invalid", not_found: "Operator not found", idempotency_conflict: "The idempotency key was used with a different request",
      precondition_failed: "The If-Match precondition failed", forbidden: "Administrator access is denied", operator_validation_required: "A current Operator validation is required" }[code]);
    this.name = "OperatorOperationError";
  }
}

export interface OperatorCreateCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly request: CreateOperatorRequest;
  readonly operatorId: string;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly auditEventId: string;
  buildRecord(validation: OperatorValidation): Promise<OperatorRecord>;
}
export interface OperatorMetadataCommand {
  readonly context: AdminContext;
  readonly operatorId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly expectedEtag: string;
  readonly request: UpdateCandidateMetadataRequest;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly auditEventId: string;
  buildRecord(current: OperatorRecord): Promise<OperatorRecord>;
}
export interface OperatorRepository {
  create(command: OperatorCreateCommand): Promise<OperatorMutationResult>;
  updateMetadata(command: OperatorMetadataCommand): Promise<OperatorMutationResult>;
  get(context: AdminContext, operatorId: string): Promise<OperatorRecord | null>;
  list(context: AdminContext, query: ListBundlesQuery): Promise<ListOperatorsResponse>;
}

function validKey(key: string) { return /^[\x21-\x7e]{1,128}$/.test(key); }

export function createOperatorService(repository: OperatorRepository, options: { readonly now?: () => Date; readonly id?: () => string } = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  return {
    async create(context: AdminContext, body: unknown, key: string, requestId: string): Promise<OperatorMutationResult> {
      const parsed = CreateOperatorRequestSchema.safeParse(body);
      if (!parsed.success || typeof body !== "object" || body === null || Array.isArray(body)
        || Object.keys(body).some(field => !["validationId", "name", "description"].includes(field)) || !parsed.data.name.trim()
        || parsed.data.name.length > 256 || parsed.data.description.length > 2048 || !validKey(key)) throw new OperatorOperationError("invalid_request");
      const occurredAt = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
      const operatorId = `op_${id()}`;
      return repository.create({ context, key, request: parsed.data, operatorId, occurredAt, requestId, auditEventId: id(),
        fingerprint: await schemaHash({ operation: "createOperator", body: parsed.data }),
        async buildRecord(validation) {
          const representation = { operatorId, documentType: validation.documentType, name: parsed.data.name, description: parsed.data.description,
            baseUrl: validation.baseUrl, descriptor: validation.descriptor, validatedAt: validation.validatedAt };
          return OperatorRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
        } });
    },
    async updateMetadata(context: AdminContext, operatorId: string, body: unknown, key: string, expectedEtag: string, requestId: string): Promise<OperatorMutationResult> {
      const parsed = UpdateCandidateMetadataRequestSchema.safeParse(body);
      if (!/^op_[A-Za-z0-9!$&^_.+-]{1,256}$/.test(operatorId) || !parsed.success || typeof body !== "object" || body === null || Array.isArray(body)
        || Object.keys(body).some(field => !["name", "description"].includes(field)) || !parsed.data.name.trim() || parsed.data.name.length > 256
        || parsed.data.description.length > 2048 || !validKey(key) || !EtagSchema.safeParse(expectedEtag).success) throw new OperatorOperationError("invalid_request");
      const occurredAt = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
      return repository.updateMetadata({ context, operatorId, key, expectedEtag, request: parsed.data, occurredAt, requestId, auditEventId: id(),
        fingerprint: await schemaHash({ operation: "updateOperatorMetadata", operatorId, expectedEtag, body: parsed.data }),
        async buildRecord(current) {
          const representation = { ...current, name: parsed.data.name, description: parsed.data.description };
          delete (representation as { etag?: string }).etag;
          return OperatorRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
        } });
    },
    async get(context: AdminContext, operatorId: string): Promise<OperatorRecord> {
      if (!/^op_[A-Za-z0-9!$&^_.+-]{1,256}$/.test(operatorId)) throw new OperatorOperationError("invalid_request");
      const record = await repository.get(context, operatorId);
      if (!record) throw new OperatorOperationError("not_found");
      return record;
    },
    async list(context: AdminContext, query: unknown): Promise<ListOperatorsResponse> {
      const parsed = ListBundlesQuerySchema.safeParse(query);
      if (!parsed.success || (parsed.data.cursor?.length ?? 0) > 1024) throw new OperatorOperationError("invalid_request");
      return repository.list(context, parsed.data);
    },
  };
}
