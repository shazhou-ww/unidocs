import type { D1Database } from "@cloudflare/workers-types";
import { TenantMemberRecordSchema, type ListTenantMembersResponse, type TenantMemberRecord } from "@unidocs/protocol-admin-portal";
import {
  resourceEtag, TenantMemberOperationError,
  type AdminContext, type TenantMemberAddCommand, type TenantMemberRemoveCommand, type TenantMemberRepository, type TenantMemberRevokeSessionsCommand,
} from "@unidocs/portal-service";
import { adminAuthorityGuard, adminAuthorityQuery } from "./admin-authority.js";
import { auditAttribution } from "./audit-attribution.js";

interface MemberRow {
  readonly member_id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly email: string;
  readonly issuer: string | null;
  readonly subject: string | null;
  readonly active: number;
  readonly revision: number;
  readonly added_by: string;
  readonly created_at: number;
}

const toSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const encodeCursor = (after: string) => btoa(JSON.stringify({ after })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export class D1TenantMemberRepository implements TenantMemberRepository {
  constructor(private readonly db: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  private async authorize(context: AdminContext): Promise<void> {
    if (!await adminAuthorityQuery(this.db, context, this.now()).first()) throw new TenantMemberOperationError("forbidden");
  }

  private async record(row: MemberRow): Promise<TenantMemberRecord> {
    const representation = {
      memberId: row.member_id, tenantId: row.tenant_id, principalId: row.principal_id, email: row.email,
      bound: row.issuer !== null && row.subject !== null, addedBy: row.added_by,
      addedAt: new Date(row.created_at * 1000).toISOString(),
    };
    return TenantMemberRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
  }

  private activeMember(memberId: string) {
    return this.db.prepare("SELECT * FROM portal_tenant_members WHERE member_id = ? AND active = 1").bind(memberId).first<MemberRow>();
  }

  private async receipt(context: AdminContext, operation: string, key: string, fingerprint: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT fingerprint, response_json FROM portal_idempotency_receipts WHERE actor_id = ? AND operation = ? AND key = ?")
      .bind(context.memberId, operation, key).first<{ fingerprint: string; response_json: string }>();
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new TenantMemberOperationError("idempotency_conflict");
    return row.response_json;
  }

  private auditStatement(context: AdminContext, audit: TenantMemberAddCommand["audit"]) {
    return this.db.prepare(`INSERT INTO portal_admin_audit
      (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json, caller_channel, oauth_client_handle, tool_name)
      VALUES (?, ?, ?, 'tenant_member', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`)
      .bind(audit.auditEventId, context.memberId, audit.action, audit.resourceId, toSeconds(audit.occurredAt), audit.requestId, ...auditAttribution(context));
  }

  async add(command: TenantMemberAddCommand) {
    const { context, key, fingerprint, member, audit } = command;
    await this.authorize(context);
    const replay = async () => {
      const response = await this.receipt(context, "addTenantMember", key, fingerprint);
      return response === null ? null : JSON.parse(response) as { memberId: string; principalId: string; etag: string };
    };
    const previous = await replay();
    if (previous) return previous;
    const response = { memberId: member.memberId, principalId: member.principalId, etag: member.etag };
    const createdAt = toSeconds(member.addedAt);
    try {
      await this.db.batch([
        adminAuthorityGuard(this.db, context, this.now()),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'addTenantMember', ?, ?, ?, ?)")
          .bind(context.memberId, key, fingerprint, JSON.stringify(response), member.addedAt),
        this.db.prepare(`INSERT INTO portal_tenant_members
          (member_id, tenant_id, principal_id, email, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(member.memberId, member.tenantId, member.principalId, member.email, context.memberId, createdAt, createdAt),
        this.auditStatement(context, audit),
      ]);
      return response;
    } catch (error) {
      const concurrent = await replay();
      if (concurrent) return concurrent;
      if (await this.db.prepare("SELECT 1 FROM portal_tenant_members WHERE email = ? AND active = 1").bind(member.email).first()) {
        throw new TenantMemberOperationError("tenant_member_exists");
      }
      if (!await adminAuthorityQuery(this.db, context, this.now()).first()) throw new TenantMemberOperationError("forbidden");
      throw error;
    }
  }

  async remove(command: TenantMemberRemoveCommand): Promise<void> {
    const { context, memberId, key, fingerprint, expectedEtag, audit } = command;
    await this.authorize(context);
    if (await this.receipt(context, "removeTenantMember", key, fingerprint) !== null) return;
    const check = async () => {
      const target = await this.activeMember(memberId);
      if (!target) throw new TenantMemberOperationError("not_found");
      if ((await this.record(target)).etag !== expectedEtag) throw new TenantMemberOperationError("precondition_failed");
      return target;
    };
    const target = await check();
    try {
      await this.db.batch([
        adminAuthorityGuard(this.db, context, this.now()),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'removeTenantMember', ?, ?, 'null', ?)")
          .bind(context.memberId, key, fingerprint, audit.occurredAt),
        this.db.prepare("UPDATE portal_tenant_members SET active = 0, revision = revision + 1, updated_at = ? WHERE member_id = ? AND active = 1 AND revision = ?")
          .bind(toSeconds(audit.occurredAt), memberId, target.revision),
        this.db.prepare("INSERT INTO portal_mutation_guard SELECT changes()"),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("DELETE FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ?").bind(target.tenant_id, target.principal_id),
        this.auditStatement(context, audit),
      ]);
    } catch (error) {
      if (await this.receipt(context, "removeTenantMember", key, fingerprint) !== null) return;
      await check();
      if (!await adminAuthorityQuery(this.db, context, this.now()).first()) throw new TenantMemberOperationError("forbidden");
      throw error;
    }
  }

  async revokeSessions(command: TenantMemberRevokeSessionsCommand): Promise<void> {
    const { context, memberId, key, fingerprint, audit } = command;
    await this.authorize(context);
    if (await this.receipt(context, "revokeTenantMemberSessions", key, fingerprint) !== null) return;
    const target = await this.activeMember(memberId);
    if (!target) throw new TenantMemberOperationError("not_found");
    try {
      await this.db.batch([
        adminAuthorityGuard(this.db, context, this.now()),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'revokeTenantMemberSessions', ?, ?, 'null', ?)")
          .bind(context.memberId, key, fingerprint, audit.occurredAt),
        this.db.prepare("INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM portal_tenant_members WHERE member_id = ? AND active = 1) THEN 1 ELSE 0 END")
          .bind(memberId),
        this.db.prepare("DELETE FROM portal_mutation_guard"),
        this.db.prepare("DELETE FROM portal_tenant_sessions WHERE tenant_id = ? AND principal_id = ?").bind(target.tenant_id, target.principal_id),
        this.auditStatement(context, audit),
      ]);
    } catch (error) {
      if (await this.receipt(context, "revokeTenantMemberSessions", key, fingerprint) !== null) return;
      if (!await this.activeMember(memberId)) throw new TenantMemberOperationError("not_found");
      if (!await adminAuthorityQuery(this.db, context, this.now()).first()) throw new TenantMemberOperationError("forbidden");
      throw error;
    }
  }

  async list(context: AdminContext, query: { readonly cursor?: string; readonly limit?: number; readonly tenantId?: string }): Promise<ListTenantMembersResponse> {
    await this.authorize(context);
    const limit = query.limit ?? 25;
    let after = "";
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const cursor = JSON.parse(atob(query.cursor.replaceAll("-", "+").replaceAll("_", "/"))) as { after?: unknown };
        if (typeof cursor.after !== "string" || !cursor.after || cursor.after.length > 256) throw new Error();
        after = cursor.after;
      } catch {
        throw new TenantMemberOperationError("invalid_request");
      }
    }
    const result = await this.db.prepare(`SELECT * FROM portal_tenant_members
      WHERE active = 1 AND member_id > ? AND (? IS NULL OR tenant_id = ?) ORDER BY member_id ASC LIMIT ?`)
      .bind(after, query.tenantId ?? null, query.tenantId ?? null, limit + 1).all<MemberRow>();
    const rows = result.results.slice(0, limit);
    return {
      items: await Promise.all(rows.map(row => this.record(row))),
      nextCursor: result.results.length > limit ? encodeCursor(rows.at(-1)!.member_id) : null,
    };
  }
}
