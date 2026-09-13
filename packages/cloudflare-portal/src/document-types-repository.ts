import type { D1Database } from "@cloudflare/workers-types";
import { auditAttribution } from "./audit-attribution.js";
import { AdminOperationError, schemaHash, type AdminContext, type DocumentTypeCreateCommand, type DocumentTypeRepository, type DocumentTypeUpdateCommand } from "@unidocs/portal-service";
import { DocumentTypeRegistrationSchema, DocumentTypeSchema, ListDocumentTypesQuerySchema, OperatorRecordSchema, TypeCardBundleRecordSchema, ViewBundleRecordSchema, type DocumentTypeRegistration, type ListDocumentTypesQuery, type ListDocumentTypesResponse } from "@unidocs/protocol-admin-portal";

export class D1DocumentTypeRepository implements DocumentTypeRepository {
  constructor(private readonly database: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) { }

  private authorityStatement(context: AdminContext) {
    return this.database.prepare(`SELECT member_id FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
      AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
        WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))`)
      .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now());
  }

  private async authorize(context: AdminContext): Promise<void> {
    const member = await this.authorityStatement(context).first();
    if (!member) throw new AdminOperationError("forbidden");
  }

  async create(command: DocumentTypeCreateCommand) {
    const { context, key, fingerprint, registration, audit } = command;
    await this.authorize(context);
    const replay = async () => {
      await this.authorize(context);
      const receipt = await this.database.prepare("SELECT fingerprint, response_json FROM portal_idempotency_receipts WHERE actor_id = ? AND operation = 'createDocumentType' AND key = ?")
        .bind(context.memberId, key).first<{ fingerprint: string; response_json: string }>();
      if (!receipt) return null;
      if (receipt.fingerprint !== fingerprint) throw new AdminOperationError("idempotency_conflict");
      return JSON.parse(receipt.response_json) as { documentType: string; etag: string };
    };
    const previous = await replay();
    if (previous) return previous;
    const response = { documentType: registration.documentType, etag: registration.etag };
    try {
      await this.database.batch([
        this.database.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
          (SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
            AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
              WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))) THEN 1 ELSE 0 END`)
          .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now()),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'createDocumentType', ?, ?, ?, ?)")
          .bind(context.memberId, key, fingerprint, JSON.stringify(response), registration.updatedAt),
        this.database.prepare(`INSERT INTO portal_document_types
          (document_type, internal_name, enabled, registration_json, created_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(registration.documentType, registration.internalName, registration.enabled ? 1 : 0, JSON.stringify(registration), registration.updatedAt),
        this.database.prepare(`INSERT INTO portal_admin_audit
          (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json, caller_channel, oauth_client_handle, tool_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
          .bind(audit.auditEventId, context.memberId, audit.action, audit.resourceType, audit.resourceId, Math.floor(Date.parse(audit.occurredAt) / 1000), audit.requestId, audit.documentType, audit.reason, ...auditAttribution(context)),
      ]);
      return response;
    } catch (error) {
      const concurrent = await replay();
      if (concurrent) return concurrent;
      throw error;
    }
  }

  async replayUpdate(context: AdminContext, key: string, fingerprint: string) {
    await this.authorize(context);
    const receipt = await this.database.prepare("SELECT fingerprint, response_json FROM portal_idempotency_receipts WHERE actor_id = ? AND operation = 'updateDocumentType' AND key = ?")
      .bind(context.memberId, key).first<{ fingerprint: string; response_json: string }>();
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw new AdminOperationError("idempotency_conflict");
    return JSON.parse(receipt.response_json) as { documentType: string; etag: string };
  }

  async update(command: DocumentTypeUpdateCommand) {
    const { context, key, fingerprint, expectedEtag, registration, audits } = command;
    await this.authorize(context);
    const replay = () => this.replayUpdate(context, key, fingerprint);
    const previous = await replay();
    if (previous) return previous;
    const response = { documentType: registration.documentType, etag: registration.etag };
    const auditStatements = audits.map(audit => this.database.prepare(`INSERT INTO portal_admin_audit
      (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json, caller_channel, oauth_client_handle, tool_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(audit.auditEventId, context.memberId, audit.action, audit.resourceType, audit.resourceId, Math.floor(Date.parse(audit.occurredAt) / 1000), audit.requestId,
        audit.documentType, audit.reason, audit.details === undefined ? null : JSON.stringify(audit.details), ...auditAttribution(context)));
    try {
      await this.database.batch([
        this.database.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
          (SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
            AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
              WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))) THEN 1 ELSE 0 END`)
          .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now()),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'updateDocumentType', ?, ?, ?, ?)")
          .bind(context.memberId, key, fingerprint, JSON.stringify(response), registration.updatedAt),
        this.database.prepare(`UPDATE portal_document_types SET internal_name = ?, enabled = ?, registration_json = ?
          WHERE document_type = ? AND json_extract(registration_json, '$.etag') = ?`)
          .bind(registration.internalName, registration.enabled ? 1 : 0, JSON.stringify(registration), registration.documentType, expectedEtag),
        this.database.prepare("INSERT INTO portal_mutation_guard SELECT changes()"),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        ...auditStatements,
      ]);
      return response;
    } catch (error) {
      const concurrent = await replay();
      if (concurrent) return concurrent;
      const current = await this.get(context, registration.documentType);
      if (!current) throw new AdminOperationError("not_found");
      if (current.etag !== expectedEtag) throw new AdminOperationError("precondition_failed");
      throw error;
    }
  }

  async resolveTypeCardBundle(context: AdminContext, documentType: string, bundleId: string) {
    await this.authorize(context);
    const row = await this.database.prepare(`SELECT record_json FROM portal_type_card_bundles
      WHERE type_card_bundle_id = ? AND document_type = ?`).bind(bundleId, documentType).first<{ record_json: string }>();
    return row ? TypeCardBundleRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  async resolveViewBundle(context: AdminContext, documentType: string, bundleId: string) {
    await this.authorize(context);
    const row = await this.database.prepare(`SELECT record_json FROM portal_view_bundles
      WHERE view_bundle_id = ? AND document_type = ?`).bind(bundleId, documentType).first<{ record_json: string }>();
    return row ? ViewBundleRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  async resolveOperator(context: AdminContext, documentType: string, operatorId: string) {
    await this.authorize(context);
    const row = await this.database.prepare("SELECT record_json FROM portal_operators WHERE operator_id = ? AND document_type = ?").bind(operatorId, documentType).first<{ record_json: string }>();
    return row ? OperatorRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  async listDocumentContractIdxs(context: AdminContext, documentType: string) {
    await this.authorize(context);
    const result = await this.database.prepare("SELECT document_contract_idx FROM portal_document_contracts WHERE document_type = ? ORDER BY document_contract_idx ASC").bind(documentType).all<{ document_contract_idx: number }>();
    return result.results.map(row => row.document_contract_idx);
  }

  async get(context: AdminContext, documentType: string): Promise<DocumentTypeRegistration | null> {
    await this.authorize(context);
    const row = await this.database.prepare("SELECT registration_json FROM portal_document_types WHERE document_type = ?").bind(documentType).first<{ registration_json: string }>();
    return row ? DocumentTypeRegistrationSchema.parse(JSON.parse(row.registration_json)) : null;
  }

  async list(context: AdminContext, input: ListDocumentTypesQuery): Promise<ListDocumentTypesResponse> {
    await this.authorize(context);
    const parsed = ListDocumentTypesQuerySchema.safeParse(input);
    if (!parsed.success || (parsed.data.q?.length ?? 0) > 256) throw new AdminOperationError("invalid_request");
    const query = parsed.data;
    const limit = query.limit ?? 25;
    const scope = await schemaHash({ q: query.q ?? "", enabled: query.enabled ?? null });
    let after = "";
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const cursor = JSON.parse(atob(query.cursor.replaceAll("-", "+").replaceAll("_", "/")));
        if (cursor.scope !== scope || !DocumentTypeSchema.safeParse(cursor.after).success) throw new Error();
        after = cursor.after;
      } catch { throw new AdminOperationError("invalid_request"); }
    }
    const result = await this.database.prepare(`SELECT registration_json FROM portal_document_types
      WHERE document_type > ? AND (? IS NULL OR enabled = ?)
      AND (instr(lower(internal_name), lower(?)) > 0 OR instr(document_type, lower(?)) > 0)
      ORDER BY document_type ASC LIMIT ?`)
      .bind(after, query.enabled === undefined ? null : Number(query.enabled), query.enabled === undefined ? null : Number(query.enabled), query.q ?? "", query.q ?? "", limit + 1)
      .all<{ registration_json: string }>();
    const page = result.results.slice(0, limit).map(row => DocumentTypeRegistrationSchema.parse(JSON.parse(row.registration_json)));
    const items = page.map(record => ({
      documentType: record.documentType, internalName: record.internalName, enabled: record.enabled,
      latestDocumentContractIdx: record.latestDocumentContract?.documentContractIdx ?? null,
      typeCardBundle: record.typeCardBundle ? { typeCardBundleId: record.typeCardBundle.typeCardBundleId, name: record.typeCardBundle.name } : null,
      viewBundle: record.viewBundle ? { viewBundleId: record.viewBundle.viewBundleId, name: record.viewBundle.name } : null,
      builtinOperator: record.builtinOperator ? { operatorId: record.builtinOperator.operatorId, name: record.builtinOperator.name } : null,
      etag: record.etag, updatedAt: record.updatedAt,
    }));
    const nextCursor = result.results.length > limit
      ? btoa(JSON.stringify({ scope, after: page.at(-1)!.documentType })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : null;
    return { items, nextCursor };
  }
}