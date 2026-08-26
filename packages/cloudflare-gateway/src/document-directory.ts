import {
  GatewayDirectoryConflictError,
  type GatewayDocumentDirectory,
  type GatewayDocumentRecord,
  type GatewayDocumentReservation,
  type GatewayDocumentState,
  type ReserveGatewayDocumentInput,
} from "@unidocs/gateway-common";

interface GatewayDocumentRow {
  doc_id: string;
  tenant_id: string;
  doc_type: string;
  service_id: string;
  session_id: string;
  idempotency_key: string;
  requested_doc_id: string | null;
  state: GatewayDocumentState;
  version: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export class D1GatewayDocumentDirectory implements GatewayDocumentDirectory {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async reserve(input: ReserveGatewayDocumentInput): Promise<GatewayDocumentReservation> {
    const [result] = await this.#db.batch([
      this.#db.prepare(
        `INSERT OR IGNORE INTO gateway_documents
        (tenant_id, doc_id, doc_type, service_id, session_id,
         idempotency_key, state, version, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'creating', NULL, NULL, ?, ?)`,
      ).bind(
        input.tenantId,
        input.docId,
        input.docType,
        input.serviceId,
        input.sessionId,
        input.idempotencyKey,
        input.now,
        input.now,
      ),
      this.#db.prepare(
        `INSERT OR IGNORE INTO gateway_document_requests
          (tenant_id, idempotency_key, requested_doc_id)
         SELECT ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM gateway_documents
           WHERE tenant_id = ? AND idempotency_key = ?
         )`,
      ).bind(
        input.tenantId,
        input.idempotencyKey,
        input.requestedDocId,
        input.tenantId,
        input.idempotencyKey,
      ),
    ]);

    const record = await this.#findByIdempotencyKey(input.tenantId, input.idempotencyKey);
    if (!record) {
      if (await this.get(input.tenantId, input.docId)) {
        throw new GatewayDirectoryConflictError(`Document ${input.docId} already exists`);
      }
      throw new Error("Gateway document reservation was not persisted");
    }
    assertSameReservation(record, input);
    return { record, created: (result.meta.changes ?? 0) > 0 };
  }

  async get(tenantId: string, docId: string): Promise<GatewayDocumentRecord | null> {
    const row = await this.#db.prepare(
      "SELECT * FROM gateway_documents WHERE tenant_id = ? AND doc_id = ?",
    ).bind(tenantId, docId).first<GatewayDocumentRow>();
    return row ? fromRow(row) : null;
  }

  async list(tenantId: string, docType: string): Promise<readonly GatewayDocumentRecord[]> {
    const result = await this.#db.prepare(
      `SELECT * FROM gateway_documents
      WHERE tenant_id = ? AND doc_type = ? AND state = 'ready'
       ORDER BY updated_at DESC`,
    ).bind(tenantId, docType).all<GatewayDocumentRow>();
    return (result.results ?? []).map(fromRow);
  }

  async markReady(
    tenantId: string,
    docId: string,
    version: number,
    updatedAt: number,
  ): Promise<GatewayDocumentRecord> {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError("version must be a positive safe integer");
    }
    const result = await this.#db.prepare(
      `UPDATE gateway_documents
       SET state = 'ready', version = ?, error = NULL, updated_at = ?
       WHERE tenant_id = ? AND doc_id = ? AND state IN ('creating', 'ready')`,
     ).bind(version, updatedAt, tenantId, docId).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new GatewayDirectoryConflictError(`Document ${docId} cannot become ready`);
    }
    return (await this.get(tenantId, docId))!;
  }

  async markFailed(
    tenantId: string,
    docId: string,
    error: string,
    updatedAt: number,
  ): Promise<GatewayDocumentRecord> {
    const result = await this.#db.prepare(
      `UPDATE gateway_documents
       SET state = 'failed', error = ?, updated_at = ?
       WHERE tenant_id = ? AND doc_id = ? AND state IN ('creating', 'failed')`,
     ).bind(error, updatedAt, tenantId, docId).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new GatewayDirectoryConflictError(`Document ${docId} cannot become failed`);
    }
    return (await this.get(tenantId, docId))!;
  }

  async touch(tenantId: string, docId: string, updatedAt: number): Promise<void> {
    const result = await this.#db.prepare(
      "UPDATE gateway_documents SET updated_at = ? WHERE tenant_id = ? AND doc_id = ? AND state = 'ready'",
    ).bind(updatedAt, tenantId, docId).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new GatewayDirectoryConflictError(`Document ${docId} is not ready`);
    }
  }

  async #findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<GatewayDocumentRecord | null> {
    const row = await this.#db.prepare(
      `SELECT documents.*, requests.requested_doc_id
       FROM gateway_documents AS documents
       LEFT JOIN gateway_document_requests AS requests
         USING (tenant_id, idempotency_key)
       WHERE documents.tenant_id = ? AND documents.idempotency_key = ?`,
    ).bind(tenantId, idempotencyKey).first<GatewayDocumentRow>();
    return row ? fromRow(row) : null;
  }

}

function fromRow(row: GatewayDocumentRow): GatewayDocumentRecord {
  return {
    docId: row.doc_id,
    tenantId: row.tenant_id,
    docType: row.doc_type,
    serviceId: row.service_id,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    requestedDocId: row.requested_doc_id ?? null,
    state: row.state,
    version: row.version,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertSameReservation(
  record: GatewayDocumentRecord,
  input: ReserveGatewayDocumentInput,
): void {
  if (record.tenantId !== input.tenantId
    || record.docType !== input.docType
    || record.serviceId !== input.serviceId
    || record.requestedDocId !== input.requestedDocId) {
    throw new GatewayDirectoryConflictError(
      `Idempotency key ${input.idempotencyKey} was used for a different document request`,
    );
  }
}