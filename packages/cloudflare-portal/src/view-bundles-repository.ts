import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  ViewBundleListItemSchema,
  ViewBundleRecordSchema,
  type ListBundlesQuery,
  type ListViewBundlesResponse,
  type ViewBundleMutationResult,
  type ViewBundleRecord,
} from "@unidocs/protocol-admin-portal";
import {
  ViewBundleOperationError,
  schemaHash,
  type AdminContext,
  type ViewBundleMetadataCommand,
  type ViewBundlePublishCommand,
  type ViewBundleRepository,
  type ViewBundleReservation,
  type ViewBundleUploadCommand,
} from "@unidocs/portal-service";

interface ReservationRow {
  view_bundle_id: string;
  fingerprint: string;
}

interface BundleRow {
  view_bundle_id: string;
  record_json: string;
  revision: number;
  uploaded_at: number;
}

export class D1ViewBundleRepository implements ViewBundleRepository {
  constructor(private readonly database: D1Database, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) { }

  private authorityStatement(context: AdminContext): D1PreparedStatement {
    return this.database.prepare(`SELECT member_id FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
      AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
        WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))`)
      .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now());
  }

  private authorityGuardStatement(context: AdminContext): D1PreparedStatement {
    return this.database.prepare(`INSERT INTO portal_mutation_guard SELECT CASE WHEN EXISTS
      (SELECT 1 FROM portal_administrators WHERE member_id = ? AND issuer = ? AND subject = ? AND active = 1
        AND (? = 'bearer' OR EXISTS (SELECT 1 FROM portal_sessions AS session JOIN portal_session_families AS family ON session.family_id = family.family_id
          WHERE session.session_hash = ? AND family.member_id = portal_administrators.member_id AND family.revoked_at IS NULL AND session.expires_at > ?))) THEN 1 ELSE 0 END`)
      .bind(context.memberId, context.identity.issuer, context.identity.subject, context.transport, context.sessionHash ?? null, this.now());
  }

  private async authorize(context: AdminContext): Promise<void> {
    if (!await this.authorityStatement(context).first()) throw new ViewBundleOperationError("forbidden");
  }

  private async replay(context: AdminContext, operation: "uploadViewBundle" | "updateViewBundleMetadata", key: string, fingerprint: string): Promise<ViewBundleMutationResult | null> {
    await this.authorize(context);
    const receipt = await this.database.prepare("SELECT fingerprint, response_json FROM portal_idempotency_receipts WHERE actor_id = ? AND operation = ? AND key = ?")
      .bind(context.memberId, operation, key).first<{ fingerprint: string; response_json: string }>();
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw new ViewBundleOperationError("idempotency_conflict");
    return JSON.parse(receipt.response_json) as ViewBundleMutationResult;
  }

  private async reservation(command: ViewBundleUploadCommand): Promise<ViewBundleReservation | null> {
    const byKey = await this.database.prepare("SELECT view_bundle_id, fingerprint FROM portal_view_bundle_reservations WHERE actor_id = ? AND idempotency_key = ?")
      .bind(command.context.memberId, command.key).first<ReservationRow>();
    if (byKey) {
      if (byKey.fingerprint !== command.fingerprint) throw new ViewBundleOperationError("idempotency_conflict");
      return { kind: "reserved" };
    }
    const candidate = await this.database.prepare("SELECT view_bundle_id FROM portal_view_bundles WHERE content_hash = ?")
      .bind(command.contentHash).first<{ view_bundle_id: string }>();
    if (candidate) {
      const replayed = await this.replay(command.context, "uploadViewBundle", command.key, command.fingerprint);
      if (replayed) return { kind: "replay", result: replayed };
      throw new ViewBundleOperationError("bundle_already_exists", { viewBundleId: candidate.view_bundle_id });
    }
    const byContent = await this.database.prepare("SELECT view_bundle_id FROM portal_view_bundle_reservations WHERE content_hash = ?")
      .bind(command.contentHash).first<{ view_bundle_id: string }>();
    if (byContent) throw new ViewBundleOperationError("bundle_already_exists", { viewBundleId: byContent.view_bundle_id });
    return null;
  }

  async listDocumentContractIdxs(context: AdminContext, documentType: string): Promise<readonly number[] | null> {
    await this.authorize(context);
    if (!await this.database.prepare("SELECT 1 FROM portal_document_types WHERE document_type = ?").bind(documentType).first()) return null;
    const result = await this.database.prepare("SELECT document_contract_idx FROM portal_document_contracts WHERE document_type = ? ORDER BY document_contract_idx ASC")
      .bind(documentType).all<{ document_contract_idx: number }>();
    return result.results.map(row => row.document_contract_idx);
  }

  async reserveUpload(command: ViewBundleUploadCommand): Promise<ViewBundleReservation> {
    const previous = await this.replay(command.context, "uploadViewBundle", command.key, command.fingerprint);
    if (previous) return { kind: "replay", result: previous };
    const existing = await this.reservation(command);
    if (existing) return existing;
    if (!await this.database.prepare("SELECT 1 FROM portal_document_types WHERE document_type = ?").bind(command.documentType).first()) throw new ViewBundleOperationError("not_found");
    try {
      await this.database.batch([
        this.authorityGuardStatement(command.context),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare(`INSERT INTO portal_view_bundle_reservations
          (content_hash, view_bundle_id, document_type, actor_id, idempotency_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(command.contentHash, command.viewBundleId, command.documentType, command.context.memberId, command.key, command.fingerprint, Math.floor(Date.parse(command.occurredAt) / 1000)),
      ]);
      return { kind: "reserved" };
    } catch (error) {
      const replayed = await this.replay(command.context, "uploadViewBundle", command.key, command.fingerprint);
      if (replayed) return { kind: "replay", result: replayed };
      const concurrent = await this.reservation(command);
      if (concurrent) return concurrent;
      if (!await this.database.prepare("SELECT 1 FROM portal_document_types WHERE document_type = ?").bind(command.documentType).first()) throw new ViewBundleOperationError("not_found");
      throw error;
    }
  }

  async publishUpload(command: ViewBundlePublishCommand): Promise<ViewBundleMutationResult> {
    const previous = await this.replay(command.context, "uploadViewBundle", command.key, command.fingerprint);
    if (previous) return previous;
    const response = { viewBundleId: command.viewBundleId, etag: command.record.etag };
    const occurredAt = Math.floor(Date.parse(command.occurredAt) / 1000);
    const rootKey = new URL(command.record.bundleUrl).pathname.slice(1);
    try {
      await this.database.batch([
        this.authorityGuardStatement(command.context),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'uploadViewBundle', ?, ?, ?, ?)")
          .bind(command.context.memberId, command.key, command.fingerprint, JSON.stringify(response), command.occurredAt),
        this.database.prepare(`INSERT INTO portal_view_bundles
          (view_bundle_id, content_hash, document_type, bundle_root_key, record_json, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(command.viewBundleId, command.contentHash, command.documentType, rootKey, JSON.stringify(command.record), occurredAt),
        this.database.prepare(`DELETE FROM portal_view_bundle_reservations WHERE content_hash = ? AND view_bundle_id = ?
          AND actor_id = ? AND idempotency_key = ? AND fingerprint = ?`)
          .bind(command.contentHash, command.viewBundleId, command.context.memberId, command.key, command.fingerprint),
        this.database.prepare("INSERT INTO portal_mutation_guard SELECT changes()"),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare(`INSERT INTO portal_admin_audit
          (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json)
          VALUES (?, ?, 'view_bundle.uploaded', 'view_bundle', ?, ?, ?, ?, NULL, ?)`)
          .bind(command.auditEventId, command.context.memberId, command.viewBundleId, occurredAt, command.requestId, command.documentType,
            JSON.stringify({ contentHash: command.contentHash, size: command.record.size, bundleUrl: command.record.bundleUrl })),
      ]);
      return response;
    } catch (error) {
      const replayed = await this.replay(command.context, "uploadViewBundle", command.key, command.fingerprint);
      if (replayed) return replayed;
      const duplicate = await this.database.prepare("SELECT view_bundle_id FROM portal_view_bundles WHERE content_hash = ?")
        .bind(command.contentHash).first<{ view_bundle_id: string }>();
      if (duplicate) throw new ViewBundleOperationError("bundle_already_exists", { viewBundleId: duplicate.view_bundle_id });
      throw error;
    }
  }

  async updateMetadata(command: ViewBundleMetadataCommand): Promise<ViewBundleMutationResult> {
    const previous = await this.replay(command.context, "updateViewBundleMetadata", command.key, command.fingerprint);
    if (previous) return previous;
    const row = await this.database.prepare("SELECT view_bundle_id, record_json, revision, uploaded_at FROM portal_view_bundles WHERE view_bundle_id = ?")
      .bind(command.viewBundleId).first<BundleRow>();
    if (!row) throw new ViewBundleOperationError("not_found");
    const current = ViewBundleRecordSchema.parse(JSON.parse(row.record_json));
    if (current.etag !== command.expectedEtag) throw new ViewBundleOperationError("precondition_failed");
    const record = await command.buildRecord(current);
    const response = { viewBundleId: command.viewBundleId, etag: record.etag };
    try {
      await this.database.batch([
        this.authorityGuardStatement(command.context),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare("INSERT INTO portal_idempotency_receipts VALUES (?, 'updateViewBundleMetadata', ?, ?, ?, ?)")
          .bind(command.context.memberId, command.key, command.fingerprint, JSON.stringify(response), command.occurredAt),
        this.database.prepare(`UPDATE portal_view_bundles SET record_json = ?, revision = revision + 1
          WHERE view_bundle_id = ? AND revision = ? AND json_extract(record_json, '$.etag') = ?`)
          .bind(JSON.stringify(record), command.viewBundleId, row.revision, command.expectedEtag),
        this.database.prepare("INSERT INTO portal_mutation_guard SELECT changes()"),
        this.database.prepare("DELETE FROM portal_mutation_guard"),
        this.database.prepare(`INSERT INTO portal_admin_audit
          (audit_event_id, actor_id, action, resource_type, resource_id, occurred_at, request_id, document_type, reason, details_json)
          VALUES (?, ?, 'view_bundle.metadata_changed', 'view_bundle', ?, ?, ?, ?, NULL, ?)`)
          .bind(command.auditEventId, command.context.memberId, command.viewBundleId, Math.floor(Date.parse(command.occurredAt) / 1000), command.requestId,
            current.manifest.documentType, JSON.stringify({ before: { name: current.name, description: current.description }, after: command.request })),
      ]);
      return response;
    } catch (error) {
      const replayed = await this.replay(command.context, "updateViewBundleMetadata", command.key, command.fingerprint);
      if (replayed) return replayed;
      const latest = await this.get(command.context, command.viewBundleId);
      if (!latest) throw new ViewBundleOperationError("not_found");
      if (latest.etag !== command.expectedEtag) throw new ViewBundleOperationError("precondition_failed");
      throw error;
    }
  }

  async get(context: AdminContext, viewBundleId: string): Promise<ViewBundleRecord | null> {
    await this.authorize(context);
    const row = await this.database.prepare("SELECT record_json FROM portal_view_bundles WHERE view_bundle_id = ?")
      .bind(viewBundleId).first<{ record_json: string }>();
    return row ? ViewBundleRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  async list(context: AdminContext, query: ListBundlesQuery): Promise<ListViewBundlesResponse> {
    await this.authorize(context);
    if (!await this.database.prepare("SELECT 1 FROM portal_document_types WHERE document_type = ?").bind(query.documentType).first()) throw new ViewBundleOperationError("not_found");
    const limit = query.limit ?? 25;
    const scope = await schemaHash({ documentType: query.documentType });
    let beforeTime = Number.MAX_SAFE_INTEGER;
    let beforeId = "\uffff";
    if (query.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const cursor = JSON.parse(atob(query.cursor.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
        if (cursor.scope !== scope || !Number.isSafeInteger(cursor.beforeTime) || typeof cursor.beforeId !== "string") throw new Error();
        beforeTime = cursor.beforeTime as number;
        beforeId = cursor.beforeId;
      } catch {
        throw new ViewBundleOperationError("invalid_request");
      }
    }
    const result = await this.database.prepare(`SELECT view_bundle_id, record_json, revision, uploaded_at FROM portal_view_bundles
      WHERE document_type = ? AND (uploaded_at < ? OR (uploaded_at = ? AND view_bundle_id < ?))
      ORDER BY uploaded_at DESC, view_bundle_id DESC LIMIT ?`)
      .bind(query.documentType, beforeTime, beforeTime, beforeId, limit + 1).all<BundleRow>();
    const page = result.results.slice(0, limit);
    const items = page.map(row => {
      const record = ViewBundleRecordSchema.parse(JSON.parse(row.record_json));
      const { manifest, ...summary } = record;
      return ViewBundleListItemSchema.parse({ ...summary, documentType: manifest.documentType, supportedDocumentContractIdxs: manifest.supportedDocumentContractIdxs });
    });
    const last = page.at(-1);
    const nextCursor = result.results.length > limit && last
      ? btoa(JSON.stringify({ scope, beforeTime: last.uploaded_at, beforeId: last.view_bundle_id })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
      : null;
    return { items, nextCursor };
  }
}