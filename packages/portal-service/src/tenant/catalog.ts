import { DocumentTypeSchema, type DocumentContractRecord, type ListPublicDocumentTypesResponse, type PaginationQuery } from "@unidocs/protocol-tenant-portal";
import { requirePagination, requireRecordIdx, requireTenantScope, TenantOperationError, type TenantContext } from "./access.js";

export interface TenantCatalogRepository {
  listDocumentTypes(context: TenantContext, query: PaginationQuery): Promise<ListPublicDocumentTypesResponse>;
  getDocumentContract(context: TenantContext, documentType: string, documentContractIdx: number): Promise<DocumentContractRecord | null>;
}

export function createTenantCatalogService(repository: TenantCatalogRepository) {
  return {
    async listDocumentTypes(context: TenantContext, tenantId: string, query: unknown = {}): Promise<ListPublicDocumentTypesResponse> {
      requireTenantScope(context, tenantId);
      return repository.listDocumentTypes(context, requirePagination(query));
    },

    async getDocumentContract(context: TenantContext, tenantId: string, documentType: string, documentContractIdx: number): Promise<DocumentContractRecord> {
      requireTenantScope(context, tenantId);
      if (!DocumentTypeSchema.safeParse(documentType).success) throw new TenantOperationError("invalid_request");
      const record = await repository.getDocumentContract(context, documentType, requireRecordIdx(documentContractIdx));
      if (!record) throw new TenantOperationError("not_found");
      return record;
    },
  };
}
