import type { D1Database } from "@cloudflare/workers-types";
import { AdministratorMemberRecordSchema, type AdministratorMemberRecord, type ListAdministratorMembersResponse } from "@unidocs/protocol-admin-portal";
import {
  AdministratorOperationError,
  resourceEtag,
  type AdminContext,
  type AdministratorAddCommand,
  type AdministratorRepository,
} from "@unidocs/portal-service";

interface MemberRow {
  member_id: string;
  email: string;
  issuer: string | null;
  subject: string | null;
  active: number;
  added_by: string;
  created_at: number;
}

export class D1AdministratorRepository implements AdministratorRepository {
  constructor(private readonly database: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  private authorityStatement(context: AdminContext) {
    return this.database.prepare(`SELECT member_id FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
      AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
        WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))`)
      .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now());
  }

  private async authorize(context: AdminContext): Promise<void> {
    if (!await this.authorityStatement(context).first()) throw new AdministratorOperationError("forbidden");
  }

  private async record(row: MemberRow): Promise<AdministratorMemberRecord> {
    const representation = {
      adminId: row.member_id,
      email: row.email,
      bound: row.issuer !== null && row.subject !== null,
      addedBy: row.added_by,
      addedAt: new Date(row.created_at * 1000).toISOString(),
    };
    return AdministratorMemberRecordSchema.parse({ ...representation, etag: await resourceEtag(representation) });
  }

  async add(command: AdministratorAddCommand) {
    const { context, key, fingerprint, member, audit } = command;
    await this.authorize(context);
    const replay = async () => {
      await this.authorize(context);
      const receipt = await this.database.prepare("SELECT fingerprint, response_json FROM portal_idempotency_receipts WHERE actor_id = ? AND operation = 'addAdministratorMember' AND key = ?")
        .bind(context.memberId, key).first<{ fingerprint: string; response_json: string }>();
      if (!receipt) return null;
      if (receipt.fingerprint !== fingerprint) throw new AdministratorOperationError("idempotency_conflict");
      return JSON.parse(receipt.response_json) as { adminId: string; etag: string };
    };
    const previous = await replay();
    if (previous) return previous;
    const response = { adminId: member.adminId, etag: member.etag };
    const occurredAt = Math.floor(Date.parse(audit.occurredAt) / 1000);
    try {
      await this.database.batch([
        this.database.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
          (SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
            AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
              WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))) THEN 1 ELSE 0 END`)
          .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now()),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'addAdministratorMember', ?, ?, ?, ?)")
          .bind(context.memberId, key, fingerprint, JSON.stringify(response), member.addedAt),
        this.database.prepare(`INSERT INTO portal_administrators
          (member_id, email, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(member.adminId, member.email, context.memberId, occurredAt, occurredAt),
        this.database.prepare(`INSERT INTO portal_admin_audit
          (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json)
          VALUES (?, ?, ?, 'administrator', ?, ?, ?, NULL, NULL, NULL)`)
          .bind(audit.auditEventId, context.memberId, audit.action, member.adminId, occurredAt, audit.requestId),
      ]);
      return response;
    } catch (error) {
      const concurrent = await replay();
      if (concurrent) return concurrent;
      const existing = await this.database.prepare("SELECT member_id FROM portal_administrators WHERE email = ? AND active = 1").bind(member.email).first();
      if (existing) throw new AdministratorOperationError("administrator_exists");
      throw error;
    }
  }

  async get(context: AdminContext, adminId: string): Promise<AdministratorMemberRecord | null> {
    await this.authorize(context);
    const row = await this.database.prepare("SELECT * FROM portal_administrators WHERE member_id = ? AND active = 1").bind(adminId).first<MemberRow>();
    return row ? this.record(row) : null;
  }

  async list(context: AdminContext, query: { readonly cursor?: string; readonly limit?: number }): Promise<ListAdministratorMembersResponse> {
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
        throw new AdministratorOperationError("invalid_request");
      }
    }
    const result = await this.database.prepare(`SELECT * FROM portal_administrators
      WHERE active = 1 AND member_id > ? ORDER BY member_id ASC LIMIT ?`).bind(after, limit + 1).all<MemberRow>();
    const rows = result.results.slice(0, limit);
    const records = await Promise.all(rows.map(row => this.record(row)));
    const items = records.map(record => ({ ...record, isSelf: record.adminId === context.memberId }));
    const nextCursor = result.results.length > limit
      ? btoa(JSON.stringify({ after: rows.at(-1)!.member_id })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
      : null;
    return { items, nextCursor };
  }
}