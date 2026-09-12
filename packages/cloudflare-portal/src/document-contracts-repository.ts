import type { D1Database } from "@cloudflare/workers-types";
import { auditAttribution } from "./audit-attribution.js";
import {
  DocumentContractListItemSchema,
  DocumentContractRecordSchema,
  DocumentTypeRegistrationSchema,
  documentLocationContentType,
  documentSnapshotContentType,
  type DocumentContractAppendResult,
  type DocumentContractRecord,
  type DocumentTypeRegistration,
  type ListDocumentContractsResponse,
} from "@unidocs/protocol-admin-portal";
import {
  DocumentContractOperationError,
  type AdminContext,
  type DocumentContractAppendCommand,
  type DocumentContractRepository,
} from "@unidocs/portal-service";

interface TypeState {
  last_contract_idx: number;
  registration_json: string;
}

export class D1DocumentContractRepository implements DocumentContractRepository {
  constructor(private readonly database: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) { }

  private async authorize(context: AdminContext): Promise<void> {
    const member = await this.database.prepare(`SELECT member_id FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
      AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
        WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))`)
      .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now()).first();
    if (!member) throw new DocumentContractOperationError("forbidden");
  }

  async append(command: DocumentContractAppendCommand): Promise<DocumentContractAppendResult> {
    await this.authorize(command.context);
    const replay = async () => {
      await this.authorize(command.context);
      const receipt = await this.database.prepare("SELECT fingerprint, response_json FROM portal_idempotency_receipts WHERE actor_id = ? AND operation = 'appendDocumentContract' AND key = ?")
        .bind(command.context.memberId, command.key).first<{ fingerprint: string; response_json: string }>();
      if (!receipt) return null;
      if (receipt.fingerprint !== command.fingerprint) throw new DocumentContractOperationError("idempotency_conflict");
      return JSON.parse(receipt.response_json) as DocumentContractAppendResult;
    };
    const previous = await replay();
    if (previous) return previous;

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const state = await this.database.prepare("SELECT last_contract_idx, registration_json FROM portal_document_types WHERE document_type = ?")
        .bind(command.documentType).first<TypeState>();
      if (!state) throw new DocumentContractOperationError("not_found");
      const current = DocumentTypeRegistrationSchema.parse(JSON.parse(state.registration_json));
      const nextIdx = state.last_contract_idx + 1;
      const record = DocumentContractRecordSchema.parse({
        documentType: command.documentType,
        documentContractIdx: nextIdx,
        formatVersion: command.request.formatVersion,
        snapshot: { contentType: documentSnapshotContentType(command.documentType), schema: command.request.snapshot.schema, schemaHash: command.snapshotSchemaHash },
        location: { contentType: documentLocationContentType(command.documentType), schema: command.request.location.schema, schemaHash: command.locationSchemaHash },
        contractHash: command.contractHash,
        createdAt: command.occurredAt,
      });
      const registration = await command.buildRegistration(current, record);
      const response = { documentContractIdx: nextIdx, contractHash: command.contractHash };
      try {
        await this.database.batch([
          this.database.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
            (SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
              AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
                WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))) THEN 1 ELSE 0 END`)
            .bind(command.context.memberId, command.context.identity.issuer, command.context.identity.subject, command.context.transport, command.context.sessionHash ?? null, this.now()),
          this.database.prepare("DELETE FROM portal_mutation_guard"),
          this.database.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'appendDocumentContract', ?, ?, ?, ?)")
            .bind(command.context.memberId, command.key, command.fingerprint, JSON.stringify(response), command.occurredAt),
          this.database.prepare(`UPDATE portal_document_types SET last_contract_idx = ?, internal_name = ?, enabled = ?, registration_json = ?
            WHERE document_type = ? AND last_contract_idx = ? AND json_extract(registration_json, '$.etag') = ?`)
            .bind(nextIdx, registration.internalName, registration.enabled ? 1 : 0, JSON.stringify(registration), command.documentType, state.last_contract_idx, current.etag),
          this.database.prepare("INSERT INTO portal_mutation_guard SELECT changes()"),
          this.database.prepare("DELETE FROM portal_mutation_guard"),
          this.database.prepare(`INSERT INTO portal_document_contracts
            (document_type, document_contract_idx, contract_hash, record_json, created_at) VALUES (?, ?, ?, ?, ?)`)
            .bind(command.documentType, nextIdx, command.contractHash, JSON.stringify(record), Math.floor(Date.parse(command.occurredAt) / 1000)),
          this.database.prepare(`INSERT INTO portal_admin_audit
            (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json, caller_channel, oauth_client_handle, tool_name)
            VALUES (?, ?, 'document_contract.appended', 'document_contract', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(command.auditEventId, command.context.memberId, `${command.documentType}:${nextIdx}`, Math.floor(Date.parse(command.occurredAt) / 1000), command.requestId,
              command.documentType, command.request.reason, JSON.stringify({ documentContractIdx: nextIdx, contractHash: command.contractHash }), ...auditAttribution(command.context)),
        ]);
        return response;
      } catch (error) {
        const concurrent = await replay();
        if (concurrent) return concurrent;
        const duplicate = await this.database.prepare("SELECT document_contract_idx FROM portal_document_contracts WHERE document_type = ? AND contract_hash = ?")
          .bind(command.documentType, command.contractHash).first();
        if (duplicate) throw new DocumentContractOperationError("invalid_request");
        const latest = await this.database.prepare("SELECT last_contract_idx, registration_json FROM portal_document_types WHERE document_type = ?")
          .bind(command.documentType).first<TypeState>();
        if (!latest) throw new DocumentContractOperationError("not_found");
        if (latest.last_contract_idx === state.last_contract_idx && DocumentTypeRegistrationSchema.parse(JSON.parse(latest.registration_json)).etag === current.etag) throw error;
      }
    }
    throw new Error("Document Contract append contention exceeded retry budget");
  }

  async get(context: AdminContext, documentType: string, documentContractIdx: number): Promise<DocumentContractRecord | null> {
    await this.authorize(context);
    const row = await this.database.prepare("SELECT record_json FROM portal_document_contracts WHERE document_type = ? AND document_contract_idx = ?")
      .bind(documentType, documentContractIdx).first<{ record_json: string }>();
    return row ? DocumentContractRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  async list(context: AdminContext, documentType: string, query: { readonly cursor?: string; readonly limit?: number }): Promise<ListDocumentContractsResponse> {
    await this.authorize(context);
    if (!await this.database.prepare("SELECT 1 FROM portal_document_types WHERE document_type = ?").bind(documentType).first()) throw new DocumentContractOperationError("not_found");
    const limit = query.limit ?? 25;
    let before: number | null = null;
    if (query.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const cursor = JSON.parse(atob(query.cursor.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
        if (cursor.documentType !== documentType || !Number.isSafeInteger(cursor.before) || (cursor.before as number) < 0) throw new Error();
        before = cursor.before as number;
      } catch {
        throw new DocumentContractOperationError("invalid_request");
      }
    }
    const result = await this.database.prepare(`SELECT document_contract_idx, record_json FROM portal_document_contracts
      WHERE document_type = ? AND (? IS NULL OR document_contract_idx < ?) ORDER BY document_contract_idx DESC LIMIT ?`)
      .bind(documentType, before, before, limit + 1).all<{ document_contract_idx: number; record_json: string }>();
    const page = result.results.slice(0, limit);
    const items = page.map(row => {
      const record = DocumentContractRecordSchema.parse(JSON.parse(row.record_json));
      return DocumentContractListItemSchema.parse({
        documentType: record.documentType,
        documentContractIdx: record.documentContractIdx,
        formatVersion: record.formatVersion,
        snapshotSchemaHash: record.snapshot.schemaHash,
        locationSchemaHash: record.location.schemaHash,
        contractHash: record.contractHash,
        createdAt: record.createdAt,
      });
    });
    const last = page.at(-1);
    const nextCursor = result.results.length > limit && last
      ? btoa(JSON.stringify({ documentType, before: last.document_contract_idx })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
      : null;
    return { items, nextCursor };
  }
}