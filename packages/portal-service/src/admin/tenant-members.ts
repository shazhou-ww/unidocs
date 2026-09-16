import {
  AddTenantMemberRequestSchema,
  ListTenantMembersQuerySchema,
  TenantMemberRecordSchema,
  type AdminAuditEvent,
  type ListTenantMembersResponse,
  type TenantMemberRecord,
} from "@unidocs/protocol-admin-portal";
import { normalizeGoogleEmail, type AdminContext } from "../auth/administrator.js";
import { resourceEtag, schemaHash } from "../identity.js";

export type TenantMemberOperationCode =
  "invalid_request" | "not_found" | "idempotency_conflict" | "tenant_member_exists" | "precondition_failed" | "forbidden";

export class TenantMemberOperationError extends Error {
  constructor(readonly code: TenantMemberOperationCode) {
    super({
      invalid_request: "The request is invalid",
      not_found: "Tenant member not found",
      idempotency_conflict: "The idempotency key was used with a different request",
      tenant_member_exists: "An active tenant membership already exists for this email",
      precondition_failed: "The If-Match precondition failed",
      forbidden: "Administrator access is denied",
    }[code]);
    this.name = "TenantMemberOperationError";
  }
}

export interface TenantMemberAddCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly member: TenantMemberRecord;
  readonly audit: AdminAuditEvent;
}

export interface TenantMemberRemoveCommand {
  readonly context: AdminContext;
  readonly memberId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly expectedEtag: string;
  readonly audit: AdminAuditEvent;
}

export interface TenantMemberRevokeSessionsCommand {
  readonly context: AdminContext;
  readonly memberId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly audit: AdminAuditEvent;
}

export interface TenantMemberRepository {
  add(command: TenantMemberAddCommand): Promise<{ readonly memberId: string; readonly principalId: string; readonly etag: string }>;
  remove(command: TenantMemberRemoveCommand): Promise<void>;
  revokeSessions(command: TenantMemberRevokeSessionsCommand): Promise<void>;
  list(context: AdminContext, query: { readonly cursor?: string; readonly limit?: number; readonly tenantId?: string }): Promise<ListTenantMembersResponse>;
}

const KEY = /^[\x20-\x7e]{1,128}$/;
const TENANT_ID = /^[\x21-\x7e]{1,128}$/;
const ETAG = /^"sha256-[A-Za-z0-9_-]{43}"$/;

// `ListTenantMembersQuerySchema` is `.readonly()`-wrapped, and `ZodReadonly` does not proxy `.strict()`.
// Unwrap to the underlying object schema to reject unknown query keys.
const StrictListTenantMembersQuerySchema = ListTenantMembersQuerySchema.unwrap().strict();

function requireMemberId(memberId: unknown): string {
  if (typeof memberId !== "string" || !memberId || memberId.length > 256) throw new TenantMemberOperationError("invalid_request");
  return memberId;
}

export function createTenantMemberService(repository: TenantMemberRepository, options: {
  readonly now?: () => Date;
  readonly id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  const timestamp = () => new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString();
  const audit = (context: AdminContext, action: AdminAuditEvent["action"], memberId: string, requestId: string, occurredAt: string): AdminAuditEvent => ({
    auditEventId: id(), actorId: context.memberId, action, resourceType: "tenant_member",
    resourceId: memberId, documentType: null, occurredAt, requestId, reason: null,
  });

  return {
    async add(context: AdminContext, body: unknown, key: string, requestId: string) {
      if (typeof body !== "object" || body === null || Array.isArray(body)
        || Object.keys(body).some(field => field !== "tenantId" && field !== "email") || !KEY.test(key)) {
        throw new TenantMemberOperationError("invalid_request");
      }
      const { tenantId, email: rawEmail } = body as { readonly tenantId?: unknown; readonly email?: unknown };
      let email: string;
      try {
        if (typeof tenantId !== "string" || !TENANT_ID.test(tenantId) || typeof rawEmail !== "string") throw new Error();
        email = normalizeGoogleEmail(rawEmail);
        AddTenantMemberRequestSchema.parse({ tenantId, email });
      } catch {
        throw new TenantMemberOperationError("invalid_request");
      }
      const addedAt = timestamp();
      const memberId = id();
      const principalId = `user:${id()}`;
      const representation = { memberId, tenantId, principalId, email, bound: false, addedBy: context.memberId, addedAt };
      const member = TenantMemberRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
      return repository.add({
        context, key, member,
        fingerprint: await schemaHash({ operation: "addTenantMember", body: { tenantId, email } }),
        audit: audit(context, "tenant_member.added", memberId, requestId, addedAt),
      });
    },

    async remove(context: AdminContext, memberId: string, key: string, expectedEtag: string, requestId: string) {
      requireMemberId(memberId);
      if (!KEY.test(key) || !ETAG.test(expectedEtag)) throw new TenantMemberOperationError("invalid_request");
      return repository.remove({
        context, memberId, key, expectedEtag,
        fingerprint: await schemaHash({ operation: "removeTenantMember", memberId, expectedEtag }),
        audit: audit(context, "tenant_member.removed", memberId, requestId, timestamp()),
      });
    },

    async revokeSessions(context: AdminContext, memberId: string, key: string, requestId: string) {
      requireMemberId(memberId);
      if (!KEY.test(key)) throw new TenantMemberOperationError("invalid_request");
      return repository.revokeSessions({
        context, memberId, key,
        fingerprint: await schemaHash({ operation: "revokeTenantMemberSessions", memberId }),
        audit: audit(context, "tenant_member.sessions_revoked", memberId, requestId, timestamp()),
      });
    },

    async list(context: AdminContext, query: unknown = {}) {
      const parsed = StrictListTenantMembersQuerySchema.safeParse(query);
      if (!parsed.success || (parsed.data.cursor?.length ?? 0) > 1024) throw new TenantMemberOperationError("invalid_request");
      return repository.list(context, parsed.data);
    },
  };
}
