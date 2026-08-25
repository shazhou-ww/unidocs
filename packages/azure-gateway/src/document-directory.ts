import {
  GatewayDirectoryConflictError,
  type GatewayDocumentDirectory,
  type GatewayDocumentRecord,
  type GatewayDocumentReservation,
  type GatewayDocumentState,
  type ReserveGatewayDocumentInput,
} from "@unidocs/gateway-common";
import type { Pool } from "pg";

interface GatewayDocumentRow {
  doc_id: string;
  owner_id: string;
  tenant_id: string;
  doc_type: string;
  service_id: string;
  session_id: string;
  idempotency_key: string;
  requested_doc_id: string | null;
  state: GatewayDocumentState;
  version: number | null;
  error: string | null;
  created_at: string | number;
  updated_at: string | number;
}

export class PgGatewayDocumentDirectory implements GatewayDocumentDirectory {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async reserve(input: ReserveGatewayDocumentInput): Promise<GatewayDocumentReservation> {
    const inserted = await this.#pool.query<GatewayDocumentRow>(
      `INSERT INTO gateway_documents
        (owner_id, doc_id, tenant_id, doc_type, service_id, session_id,
         idempotency_key, requested_doc_id, state, version, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'creating', NULL, NULL, $9, $9)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        input.userId,
        input.docId,
        input.tenantId,
        input.docType,
        input.serviceId,
        input.sessionId,
        input.idempotencyKey,
        input.requestedDocId,
        input.now,
      ],
    );
    if (inserted.rows[0]) {
      return { record: fromRow(inserted.rows[0]), created: true };
    }

    const existing = await this.#findByIdempotencyKey(input.userId, input.idempotencyKey);
    if (!existing) {
      if (await this.get(input.userId, input.docId)) {
        throw new GatewayDirectoryConflictError(`Document ${input.docId} already exists`);
      }
      throw new Error("Gateway document reservation was not persisted");
    }
    assertSameReservation(existing, input);
    return { record: existing, created: false };
  }

  async get(userId: string, docId: string): Promise<GatewayDocumentRecord | null> {
    const result = await this.#pool.query<GatewayDocumentRow>(
      "SELECT * FROM gateway_documents WHERE owner_id = $1 AND doc_id = $2",
      [userId, docId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async list(userId: string, docType: string): Promise<readonly GatewayDocumentRecord[]> {
    const result = await this.#pool.query<GatewayDocumentRow>(
      `SELECT * FROM gateway_documents
       WHERE owner_id = $1 AND doc_type = $2 AND state = 'ready'
       ORDER BY updated_at DESC`,
      [userId, docType],
    );
    return result.rows.map(fromRow);
  }

  async markReady(
    userId: string,
    docId: string,
    version: number,
    updatedAt: number,
  ): Promise<GatewayDocumentRecord> {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError("version must be a positive safe integer");
    }
    const result = await this.#pool.query<GatewayDocumentRow>(
      `UPDATE gateway_documents
       SET state = 'ready', version = $3, error = NULL, updated_at = $4
       WHERE owner_id = $1 AND doc_id = $2 AND state IN ('creating', 'ready')
       RETURNING *`,
      [userId, docId, version, updatedAt],
    );
    if (!result.rows[0]) {
      throw new GatewayDirectoryConflictError(`Document ${docId} cannot become ready`);
    }
    return fromRow(result.rows[0]);
  }

  async markFailed(
    userId: string,
    docId: string,
    error: string,
    updatedAt: number,
  ): Promise<GatewayDocumentRecord> {
    const result = await this.#pool.query<GatewayDocumentRow>(
      `UPDATE gateway_documents
       SET state = 'failed', error = $3, updated_at = $4
       WHERE owner_id = $1 AND doc_id = $2 AND state IN ('creating', 'failed')
       RETURNING *`,
      [userId, docId, error, updatedAt],
    );
    if (!result.rows[0]) {
      throw new GatewayDirectoryConflictError(`Document ${docId} cannot become failed`);
    }
    return fromRow(result.rows[0]);
  }

  async touch(userId: string, docId: string, updatedAt: number): Promise<void> {
    const result = await this.#pool.query(
      `UPDATE gateway_documents SET updated_at = $3
       WHERE owner_id = $1 AND doc_id = $2 AND state = 'ready'`,
      [userId, docId, updatedAt],
    );
    if (result.rowCount !== 1) {
      throw new GatewayDirectoryConflictError(`Document ${docId} is not ready`);
    }
  }

  async #findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<GatewayDocumentRecord | null> {
    const result = await this.#pool.query<GatewayDocumentRow>(
      "SELECT * FROM gateway_documents WHERE owner_id = $1 AND idempotency_key = $2",
      [userId, idempotencyKey],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
}

function fromRow(row: GatewayDocumentRow): GatewayDocumentRecord {
  return {
    docId: row.doc_id,
    userId: row.owner_id,
    tenantId: row.tenant_id,
    docType: row.doc_type,
    serviceId: row.service_id,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    requestedDocId: row.requested_doc_id ?? null,
    state: row.state,
    version: row.version,
    error: row.error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
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