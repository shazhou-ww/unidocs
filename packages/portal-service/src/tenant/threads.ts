import {
  AppendCommentRequestSchema, CreateThreadRequestSchema,
  type AppendCommentRequest, type CommentRecord, type CreateThreadRequest, type DocumentLocation,
  type ListThreadsQuery, type ListThreadsResponse, type SValueSchema, type ThreadDetail,
} from "@unidocs/protocol-tenant-portal";
import { canonicalJson, schemaHash } from "../identity.js";
import {
  requireExactFields, requireIdempotencyKey, requireIdentifier, requirePagination, requireRecordIdx, requireTenantScope,
  TENANT_LIMITS, TenantOperationError, type TenantContext,
} from "./access.js";

/** What the base version fixes for any location written against it. */
export interface CommentAnchor {
  readonly documentContractIdx: number;
  readonly locationSchema: SValueSchema;
}

/** Supplied by the adapter; there is deliberately no default, so it cannot be skipped silently. */
export type DocumentLocationValidator = (location: DocumentLocation, schema: SValueSchema) => boolean;

export interface ThreadCreateCommand {
  readonly context: TenantContext;
  readonly documentId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly request: CreateThreadRequest;
}

export interface CommentAppendCommand {
  readonly context: TenantContext;
  readonly documentId: string;
  readonly threadId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly request: AppendCommentRequest;
}

export interface TenantThreadRepository {
  loadCommentAnchor(context: TenantContext, documentId: string, baseVersionIdx: number): Promise<CommentAnchor | null>;
  list(context: TenantContext, documentId: string, query: ListThreadsQuery): Promise<ListThreadsResponse>;
  create(command: ThreadCreateCommand): Promise<ThreadDetail>;
  get(context: TenantContext, documentId: string, threadId: string): Promise<ThreadDetail | null>;
  appendComment(command: CommentAppendCommand): Promise<CommentRecord>;
}

function requireBoundedMessage(request: { readonly content: { readonly text: string | null; readonly attachments: readonly unknown[] }; readonly location: DocumentLocation | null }): void {
  if ((request.content.text?.length ?? 0) > TENANT_LIMITS.messageText || request.content.attachments.length > TENANT_LIMITS.attachments) throw new TenantOperationError("limit_exceeded");
  if (request.location && new TextEncoder().encode(canonicalJson(request.location.payload)).byteLength > TENANT_LIMITS.locationPayloadBytes) throw new TenantOperationError("limit_exceeded");
}

export function createTenantThreadService(repository: TenantThreadRepository, options: { readonly validateLocation: DocumentLocationValidator }) {
  async function anchor(context: TenantContext, documentId: string, request: { readonly baseVersionIdx: number; readonly location: DocumentLocation | null }): Promise<void> {
    const found = await repository.loadCommentAnchor(context, documentId, request.baseVersionIdx);
    if (!found) throw new TenantOperationError("not_found");
    if (!request.location) return;
    if (request.location.documentContractIdx !== found.documentContractIdx) throw new TenantOperationError("location_contract_violation");
    if (!options.validateLocation(request.location, found.locationSchema)) throw new TenantOperationError("location_contract_violation");
  }

  return {
    async list(context: TenantContext, tenantId: string, documentId: string, query: ListThreadsQuery = {}): Promise<ListThreadsResponse> {
      requireTenantScope(context, tenantId);
      const page = requirePagination({ cursor: query.cursor, limit: query.limit });
      if (query.open !== undefined && typeof query.open !== "boolean") throw new TenantOperationError("invalid_request");
      if (query.versionIdx !== undefined) requireRecordIdx(query.versionIdx);
      return repository.list(context, requireIdentifier(documentId), {
        ...page,
        ...(query.open === undefined ? {} : { open: query.open }),
        ...(query.versionIdx === undefined ? {} : { versionIdx: query.versionIdx }),
      });
    },

    async create(context: TenantContext, tenantId: string, documentId: string, body: unknown, key: string): Promise<ThreadDetail> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const idempotencyKey = requireIdempotencyKey(key);
      requireExactFields(body, ["baseVersionIdx", "content", "location"]);
      const parsed = CreateThreadRequestSchema.safeParse(body);
      if (!parsed.success) throw new TenantOperationError("invalid_request");
      requireBoundedMessage(parsed.data);
      await anchor(context, document, parsed.data);
      return repository.create({
        context, documentId: document, key: idempotencyKey,
        fingerprint: await schemaHash({ operation: "createThread", body: parsed.data }), request: parsed.data,
      });
    },

    async get(context: TenantContext, tenantId: string, documentId: string, threadId: string): Promise<ThreadDetail> {
      requireTenantScope(context, tenantId);
      const detail = await repository.get(context, requireIdentifier(documentId), requireIdentifier(threadId));
      if (!detail) throw new TenantOperationError("not_found");
      return detail;
    },

    async appendComment(context: TenantContext, tenantId: string, documentId: string, threadId: string, body: unknown, key: string): Promise<CommentRecord> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const thread = requireIdentifier(threadId);
      const idempotencyKey = requireIdempotencyKey(key);
      requireExactFields(body, ["baseVersionIdx", "content", "location"]);
      const parsed = AppendCommentRequestSchema.safeParse(body);
      if (!parsed.success) throw new TenantOperationError("invalid_request");
      requireBoundedMessage(parsed.data);
      await anchor(context, document, parsed.data);
      return repository.appendComment({
        context, documentId: document, threadId: thread, key: idempotencyKey,
        fingerprint: await schemaHash({ operation: "appendComment", threadId: thread, body: parsed.data }), request: parsed.data,
      });
    },
  };
}
