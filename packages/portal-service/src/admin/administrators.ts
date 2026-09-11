import {
  AddAdministratorMemberRequestSchema,
  AdministratorMemberRecordSchema,
  PaginationQuerySchema,
  type AdminAuditEvent,
  type AdministratorMemberRecord,
  type ListAdministratorMembersResponse,
} from "@unidocs/protocol-admin-portal";
import { normalizeAdministratorEmail, type AdminContext } from "../auth/administrator.js";
import { resourceEtag, schemaHash } from "../identity.js";

export class AdministratorOperationError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "idempotency_conflict" | "administrator_exists" | "forbidden") {
    super({
      invalid_request: "The request is invalid",
      not_found: "Administrator member not found",
      idempotency_conflict: "The idempotency key was used with a different request",
      administrator_exists: "An administrator membership already exists for this email",
      forbidden: "Administrator access is denied",
    }[code]);
    this.name = "AdministratorOperationError";
  }
}

export interface AdministratorAddCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly member: AdministratorMemberRecord;
  readonly audit: AdminAuditEvent;
}

export interface AdministratorRepository {
  add(command: AdministratorAddCommand): Promise<{ readonly adminId: string; readonly etag: string }>;
  get(context: AdminContext, adminId: string): Promise<AdministratorMemberRecord | null>;
  list(context: AdminContext, query: { readonly cursor?: string; readonly limit?: number }): Promise<ListAdministratorMembersResponse>;
}

export function createAdministratorService(repository: AdministratorRepository, options: {
  readonly now?: () => Date;
  readonly id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  return {
    async add(context: AdminContext, body: unknown, key: string, requestId: string) {
      if (typeof body !== "object" || body === null || Array.isArray(body)
        || Object.keys(body).some(field => field !== "email") || !/^[\x21-\x7e]{1,128}$/.test(key)) {
        throw new AdministratorOperationError("invalid_request");
      }
      let email: string;
      try {
        const rawEmail = (body as { readonly email?: unknown }).email;
        if (typeof rawEmail !== "string") throw new Error();
        email = normalizeAdministratorEmail(rawEmail);
        AddAdministratorMemberRequestSchema.parse({ email });
      } catch {
        throw new AdministratorOperationError("invalid_request");
      }
      const timestamp = new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
      const adminId = id();
      if (!adminId || adminId.length > 256) throw new AdministratorOperationError("invalid_request");
      const representation = { adminId, email, bound: false, addedBy: context.memberId, addedAt: timestamp };
      const member = AdministratorMemberRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
      return repository.add({
        context,
        key,
        fingerprint: await schemaHash({ operation: "addAdministratorMember", body: { email } }),
        member,
        audit: {
          auditEventId: id(), actorId: context.memberId, action: "administrator.added", resourceType: "administrator",
          resourceId: member.adminId, documentType: null, occurredAt: timestamp, requestId, reason: null,
        },
      });
    },
    async get(context: AdminContext, adminId: string) {
      if (typeof adminId !== "string" || !adminId || adminId.length > 256) throw new AdministratorOperationError("invalid_request");
      const member = await repository.get(context, adminId);
      if (!member) throw new AdministratorOperationError("not_found");
      return member;
    },
    async list(context: AdminContext, query: unknown = {}) {
      const parsed = PaginationQuerySchema.safeParse(query);
      if (!parsed.success || (parsed.data.cursor?.length ?? 0) > 1024) throw new AdministratorOperationError("invalid_request");
      return repository.list(context, parsed.data);
    },
  };
}