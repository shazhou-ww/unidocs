import type { D1Database } from "@cloudflare/workers-types";
import {
  AdminAuditEventSchema,
  type AdminAuditEvent,
  type ListAdminAuditEventsQuery,
  type ListAdminAuditEventsResponse,
} from "@unidocs/protocol-admin-portal";
import { AuditOperationError, schemaHash, type AdminContext, type AuditEventRepository } from "@unidocs/portal-service";

interface AuditRow {
  audit_event_id: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  occurred_at: number;
  request_id: string;
  document_type: string | null;
  reason: string | null;
  details_json: string | null;
  caller_channel: string;
  oauth_client_handle: string | null;
  tool_name: string | null;
}

export class D1AuditEventRepository implements AuditEventRepository {
  constructor(private readonly database: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  private async authorize(context: AdminContext): Promise<void> {
    const member = await this.database.prepare(`SELECT member_id FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
      AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
        WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))`)
      .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now()).first();
    if (!member) throw new AuditOperationError("forbidden");
  }

  async list(context: AdminContext, query: ListAdminAuditEventsQuery): Promise<ListAdminAuditEventsResponse> {
    await this.authorize(context);
    const limit = query.limit ?? 25;
    const scope = await schemaHash({
      callerChannel: query.callerChannel ?? null,
      toolName: query.toolName ?? null,
      actorId: query.actorId ?? null,
      action: query.action ?? null,
      resourceType: query.resourceType ?? null,
      documentType: query.documentType ?? null,
      occurredFrom: query.occurredFrom ?? null,
      occurredTo: query.occurredTo ?? null,
    });
    let cursorTime: number | null = null;
    let cursorId: string | null = null;
    if (query.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const cursor = JSON.parse(atob(query.cursor.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
        if (cursor.scope !== scope || !Number.isSafeInteger(cursor.occurredAt) || (cursor.occurredAt as number) < 0
          || typeof cursor.auditEventId !== "string" || !cursor.auditEventId || cursor.auditEventId.length > 256) throw new Error();
        cursorTime = cursor.occurredAt as number;
        cursorId = cursor.auditEventId;
      } catch {
        throw new AuditOperationError("invalid_request");
      }
    }
    const occurredFrom = query.occurredFrom === undefined ? null : Math.ceil(Date.parse(query.occurredFrom) / 1000);
    const occurredTo = query.occurredTo === undefined ? null : Math.ceil(Date.parse(query.occurredTo) / 1000);
    const result = await this.database.prepare(`SELECT * FROM portal_admin_audit
      WHERE (? IS NULL OR actor_id = ?) AND (? IS NULL OR action = ?) AND (? IS NULL OR resource_type = ?)
      AND (? IS NULL OR document_type = ?) AND (? IS NULL OR occurred_at >= ?) AND (? IS NULL OR occurred_at < ?)
      AND (? IS NULL OR caller_channel = ?) AND (? IS NULL OR tool_name = ?)
      AND (? IS NULL OR occurred_at < ? OR (occurred_at = ? AND audit_event_id < ?))
      ORDER BY occurred_at DESC, audit_event_id DESC LIMIT ?`)
      .bind(query.actorId ?? null, query.actorId ?? null, query.action ?? null, query.action ?? null,
        query.resourceType ?? null, query.resourceType ?? null, query.documentType ?? null, query.documentType ?? null,
        occurredFrom, occurredFrom, occurredTo, occurredTo,
        query.callerChannel ?? null, query.callerChannel ?? null, query.toolName ?? null, query.toolName ?? null,
        cursorTime, cursorTime, cursorTime, cursorId, limit + 1)
      .all<AuditRow>();
    const page = result.results.slice(0, limit);
    const items: AdminAuditEvent[] = page.map(row => AdminAuditEventSchema.parse({
      auditEventId: row.audit_event_id,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      documentType: row.document_type,
      occurredAt: new Date(row.occurred_at * 1000).toISOString(),
      requestId: row.request_id,
      reason: row.reason,
      callerChannel: row.caller_channel,
      oauthClientHandle: row.oauth_client_handle,
      toolName: row.tool_name,
      ...(row.details_json === null ? {} : { details: JSON.parse(row.details_json) }),
    }));
    const last = page.at(-1);
    const nextCursor = result.results.length > limit && last
      ? btoa(JSON.stringify({ scope, occurredAt: last.occurred_at, auditEventId: last.audit_event_id })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
      : null;
    return { items, nextCursor };
  }
}