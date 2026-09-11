import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { OperatorValidationSchema, type OperatorValidation } from "@unidocs/protocol-admin-portal";
import {
  OperatorValidationOperationError,
  type AdminContext,
  type OperatorValidationFailureCommand,
  type OperatorValidationPublishCommand,
  type OperatorValidationRepository,
} from "@unidocs/portal-service";

export class D1OperatorValidationRepository implements OperatorValidationRepository {
  constructor(private readonly database: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) { }

  private authorityGuardStatement(context: AdminContext): D1PreparedStatement {
    return this.database.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
      (SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
        AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
          WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))) THEN 1 ELSE 0 END`)
      .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now());
  }

  private async authorize(context: AdminContext): Promise<void> {
    const member = await this.database.prepare(`SELECT member_id FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
      AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
        WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))`)
      .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now()).first();
    if (!member) throw new OperatorValidationOperationError("forbidden");
  }

  async replay(context: AdminContext, key: string, fingerprint: string): Promise<OperatorValidation | null> {
    await this.authorize(context);
    const receipt = await this.database.prepare("SELECT fingerprint, response_json FROM portal_idempotency_receipts WHERE actor_id = ? AND operation = 'createOperatorValidation' AND key = ?")
      .bind(context.memberId, key).first<{ fingerprint: string; response_json: string }>();
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw new OperatorValidationOperationError("idempotency_conflict");
    return OperatorValidationSchema.parse(JSON.parse(receipt.response_json));
  }

  async listDocumentContractIdxs(context: AdminContext, documentType: string): Promise<readonly number[] | null> {
    await this.authorize(context);
    if (!await this.database.prepare("SELECT 1 FROM portal_document_types WHERE document_type = ?").bind(documentType).first()) return null;
    const result = await this.database.prepare("SELECT document_contract_idx FROM portal_document_contracts WHERE document_type = ? ORDER BY document_contract_idx ASC")
      .bind(documentType).all<{ document_contract_idx: number }>();
    return result.results.map(row => row.document_contract_idx);
  }

  async publish(command: OperatorValidationPublishCommand): Promise<OperatorValidation> {
    const previous = await this.replay(command.context, command.key, command.fingerprint);
    if (previous) return previous;
    const validatedAt = Math.floor(Date.parse(command.validation.validatedAt) / 1000);
    const expiresAt = Math.floor(Date.parse(command.validation.expiresAt) / 1000);
    try {
      await this.database.batch([
        this.authorityGuardStatement(command.context),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'createOperatorValidation', ?, ?, ?, ?)")
          .bind(command.context.memberId, command.key, command.fingerprint, JSON.stringify(command.validation), command.validation.validatedAt),
        this.database.prepare(`INSERT INTO portal_operator_validations
          (validation_id, actor_id, document_type, record_json, validated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(command.validation.validationId, command.context.memberId, command.validation.documentType, JSON.stringify(command.validation), validatedAt, expiresAt),
        this.database.prepare(`INSERT INTO portal_admin_audit
          (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json)
          VALUES (?, ?, 'operator.validation_passed', 'operator_validation', ?, ?, ?, ?, NULL, ?)`)
          .bind(command.auditEventId, command.context.memberId, command.validation.validationId, validatedAt, command.requestId, command.validation.documentType,
            JSON.stringify({ baseUrl: command.validation.baseUrl, declaredOperatorId: command.validation.descriptor.declaredOperatorId, expectedConfigEtag: command.validation.expectedConfigEtag })),
      ]);
      return command.validation;
    } catch (error) {
      const replayed = await this.replay(command.context, command.key, command.fingerprint);
      if (replayed) return replayed;
      throw error;
    }
  }

  async recordFailure(command: OperatorValidationFailureCommand): Promise<void> {
    await this.database.batch([
      this.authorityGuardStatement(command.context),
      this.database.prepare("DELETE FROM portal_mutation_guard"),
      this.database.prepare(`INSERT INTO portal_admin_audit
        (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json)
        VALUES (?, ?, 'operator.validation_failed', 'operator_validation', ?, ?, ?, ?, NULL, ?)`)
        .bind(command.auditEventId, command.context.memberId, command.requestId, Math.floor(Date.parse(command.occurredAt) / 1000), command.requestId,
          command.documentType, JSON.stringify({ phase: command.phase })),
    ]);
  }

  async get(context: AdminContext, validationId: string, now: string): Promise<OperatorValidation | null> {
    await this.authorize(context);
    const row = await this.database.prepare("SELECT record_json FROM portal_operator_validations WHERE validation_id = ? AND actor_id = ? AND expires_at > ?")
      .bind(validationId, context.memberId, Math.floor(Date.parse(now) / 1000)).first<{ record_json: string }>();
    return row ? OperatorValidationSchema.parse(JSON.parse(row.record_json)) : null;
  }
}