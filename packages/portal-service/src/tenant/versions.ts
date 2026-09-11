import { documentSnapshotContentType, type ListVersionsResponse, type PaginationQuery, type VersionRecord } from "@unidocs/protocol-tenant-portal";
import { requireIdentifier, requirePagination, requireRecordIdx, requireTenantScope, TenantOperationError, type TenantContext } from "./access.js";

/**
 * Snapshot bytes leave storage with the document type rather than a media type
 * string, so the wire content type is always derived and never free-form.
 */
export interface VersionSnapshot {
  readonly documentType: string;
  readonly body: ReadableStream<Uint8Array>;
}

export interface TenantVersionRepository {
  list(context: TenantContext, documentId: string, query: PaginationQuery): Promise<ListVersionsResponse>;
  get(context: TenantContext, documentId: string, versionIdx: number): Promise<VersionRecord | null>;
  readSnapshot(context: TenantContext, documentId: string, versionIdx: number): Promise<VersionSnapshot | null>;
}

export function createTenantVersionService(repository: TenantVersionRepository) {
  return {
    async list(context: TenantContext, tenantId: string, documentId: string, query: unknown = {}): Promise<ListVersionsResponse> {
      requireTenantScope(context, tenantId);
      return repository.list(context, requireIdentifier(documentId), requirePagination(query));
    },

    async get(context: TenantContext, tenantId: string, documentId: string, versionIdx: number): Promise<VersionRecord> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const idx = requireRecordIdx(versionIdx);
      const record = await repository.get(context, document, idx);
      if (!record) throw new TenantOperationError("not_found");
      return record;
    },

    async getSnapshot(context: TenantContext, tenantId: string, documentId: string, versionIdx: number): Promise<{ readonly contentType: string; readonly body: ReadableStream<Uint8Array> }> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const idx = requireRecordIdx(versionIdx);
      const snapshot = await repository.readSnapshot(context, document, idx);
      if (!snapshot) throw new TenantOperationError("not_found");
      try {
        return { contentType: documentSnapshotContentType(snapshot.documentType), body: snapshot.body };
      } catch {
        await snapshot.body.cancel();
        throw new TenantOperationError("content_unavailable");
      }
    },
  };
}
