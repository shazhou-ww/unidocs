import {
  AppendDocumentContractRequestSchema,
  DocumentTypeSchema,
  PaginationQuerySchema,
  type AppendDocumentContractRequest,
  type DocumentContractAppendResult,
  type DocumentContractRecord,
  type DocumentTypeRegistration,
  type ListDocumentContractsResponse,
} from "@unidocs/protocol-admin-portal";
import type { AdminContext } from "../auth/administrator.js";
import { contractHash, resourceEtag, schemaHash } from "../identity.js";

export class DocumentContractOperationError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "idempotency_conflict" | "forbidden") {
    super({
      invalid_request: "The request is invalid",
      not_found: "Document type or contract not found",
      idempotency_conflict: "The idempotency key was used with a different request",
      forbidden: "Administrator access is denied",
    }[code]);
    this.name = "DocumentContractOperationError";
  }
}

export interface DocumentContractAppendCommand {
  readonly context: AdminContext;
  readonly documentType: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly request: AppendDocumentContractRequest;
  readonly snapshotSchemaHash: string;
  readonly locationSchemaHash: string;
  readonly contractHash: string;
  readonly occurredAt: string;
  readonly auditEventId: string;
  readonly requestId: string;
  buildRegistration(current: DocumentTypeRegistration, record: DocumentContractRecord): Promise<DocumentTypeRegistration>;
}

export interface DocumentContractRepository {
  append(command: DocumentContractAppendCommand): Promise<DocumentContractAppendResult>;
  get(context: AdminContext, documentType: string, documentContractIdx: number): Promise<DocumentContractRecord | null>;
  list(context: AdminContext, documentType: string, query: { readonly cursor?: string; readonly limit?: number }): Promise<ListDocumentContractsResponse>;
}

export function createDocumentContractService(repository: DocumentContractRepository, options: {
  readonly now?: () => Date;
  readonly id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  return {
    async append(context: AdminContext, documentType: string, body: unknown, key: string, requestId: string) {
      const parsed = AppendDocumentContractRequestSchema.safeParse(body);
      if (!DocumentTypeSchema.safeParse(documentType).success || !parsed.success || typeof body !== "object" || body === null || Array.isArray(body)
        || Object.keys(body).some(field => !["formatVersion", "snapshot", "location", "reason"].includes(field))
        || parsed.data.reason.length > 2048 || !/^[\x21-\x7e]{1,128}$/.test(key)) {
        throw new DocumentContractOperationError("invalid_request");
      }
      const timestamp = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
      const snapshotSchemaHash = await schemaHash(parsed.data.snapshot.schema);
      const locationSchemaHash = await schemaHash(parsed.data.location.schema);
      const pairedHash = await contractHash({ documentType, ...parsed.data });
      return repository.append({
        context,
        documentType,
        key,
        fingerprint: await schemaHash({ operation: "appendDocumentContract", documentType, body: parsed.data }),
        request: parsed.data,
        snapshotSchemaHash,
        locationSchemaHash,
        contractHash: pairedHash,
        occurredAt: timestamp,
        auditEventId: id(),
        requestId,
        async buildRegistration(current, record) {
          const representation = { ...current, latestDocumentContract: record, updatedAt: timestamp };
          delete (representation as { etag?: string }).etag;
          return { ...representation, etag: await resourceEtag(representation) };
        },
      });
    },
    async get(context: AdminContext, documentType: string, documentContractIdx: number) {
      if (!DocumentTypeSchema.safeParse(documentType).success || !Number.isSafeInteger(documentContractIdx) || documentContractIdx < 0) {
        throw new DocumentContractOperationError("invalid_request");
      }
      const record = await repository.get(context, documentType, documentContractIdx);
      if (!record) throw new DocumentContractOperationError("not_found");
      return record;
    },
    async list(context: AdminContext, documentType: string, input: unknown = {}) {
      const parsed = PaginationQuerySchema.safeParse(input);
      if (!DocumentTypeSchema.safeParse(documentType).success || !parsed.success || (parsed.data.cursor?.length ?? 0) > 1024) {
        throw new DocumentContractOperationError("invalid_request");
      }
      return repository.list(context, documentType, parsed.data);
    },
  };
}