import {
  ListAdminAuditEventsQuerySchema,
  type ListAdminAuditEventsQuery,
  type ListAdminAuditEventsResponse,
} from "@unidocs/protocol-admin-portal";
import type { AdminContext } from "../auth/administrator.js";

export class AuditOperationError extends Error {
  constructor(readonly code: "invalid_request" | "forbidden") {
    super(code === "invalid_request" ? "The request is invalid" : "Administrator access is denied");
    this.name = "AuditOperationError";
  }
}

export interface AuditEventRepository {
  list(context: AdminContext, query: ListAdminAuditEventsQuery): Promise<ListAdminAuditEventsResponse>;
}

export function createAuditEventService(repository: AuditEventRepository) {
  return {
    async list(context: AdminContext, input: unknown = {}) {
      const parsed = ListAdminAuditEventsQuerySchema.safeParse(input);
      if (!parsed.success || (parsed.data.cursor?.length ?? 0) > 2048 || (parsed.data.actorId?.length ?? 0) > 256
        || (parsed.data.occurredFrom !== undefined && parsed.data.occurredTo !== undefined
          && Date.parse(parsed.data.occurredFrom) > Date.parse(parsed.data.occurredTo))) {
        throw new AuditOperationError("invalid_request");
      }
      return repository.list(context, parsed.data);
    },
  };
}