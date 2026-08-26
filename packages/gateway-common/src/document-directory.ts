export type GatewayDocumentState = "creating" | "ready" | "failed";

export interface GatewayDocumentRecord {
  readonly docId: string;
  readonly tenantId: string;
  readonly docType: string;
  readonly serviceId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestedDocId: string | null;
  readonly state: GatewayDocumentState;
  readonly version: number | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ReserveGatewayDocumentInput {
  readonly docId: string;
  readonly tenantId: string;
  readonly docType: string;
  readonly serviceId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestedDocId: string | null;
  readonly now: number;
}

export interface GatewayDocumentReservation {
  readonly record: GatewayDocumentRecord;
  readonly created: boolean;
}

export interface GatewayDocumentDirectory {
  reserve(input: ReserveGatewayDocumentInput): Promise<GatewayDocumentReservation>;
  get(tenantId: string, docId: string): Promise<GatewayDocumentRecord | null>;
  list(tenantId: string, docType: string): Promise<readonly GatewayDocumentRecord[]>;
  markReady(
    tenantId: string,
    docId: string,
    version: number,
    updatedAt: number,
  ): Promise<GatewayDocumentRecord>;
  markFailed(
    tenantId: string,
    docId: string,
    error: string,
    updatedAt: number,
  ): Promise<GatewayDocumentRecord>;
  touch(tenantId: string, docId: string, updatedAt: number): Promise<void>;
}

export class GatewayDirectoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayDirectoryConflictError";
  }
}

export class MemoryGatewayDocumentDirectory implements GatewayDocumentDirectory {
  readonly #byDocument = new Map<string, GatewayDocumentRecord>();
  readonly #byIdempotencyKey = new Map<string, string>();

  async reserve(input: ReserveGatewayDocumentInput): Promise<GatewayDocumentReservation> {
    const idempotencyKey = directoryKey(input.tenantId, input.idempotencyKey);
    const existingDocumentKey = this.#byIdempotencyKey.get(idempotencyKey);
    if (existingDocumentKey) {
      const existing = this.#byDocument.get(existingDocumentKey)!;
      assertSameReservation(existing, input);
      return { record: existing, created: false };
    }

    const documentKey = directoryKey(input.tenantId, input.docId);
    const existing = this.#byDocument.get(documentKey);
    if (existing) {
      throw new GatewayDirectoryConflictError(`Document ${input.docId} already exists`);
    }

    const record: GatewayDocumentRecord = Object.freeze({
      docId: input.docId,
      tenantId: input.tenantId,
      docType: input.docType,
      serviceId: input.serviceId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      requestedDocId: input.requestedDocId,
      state: "creating",
      version: null,
      error: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    this.#byDocument.set(documentKey, record);
    this.#byIdempotencyKey.set(idempotencyKey, documentKey);
    return { record, created: true };
  }

  async get(tenantId: string, docId: string): Promise<GatewayDocumentRecord | null> {
    return this.#byDocument.get(directoryKey(tenantId, docId)) ?? null;
  }

  async list(tenantId: string, docType: string): Promise<readonly GatewayDocumentRecord[]> {
    return [...this.#byDocument.values()]
      .filter(record => record.tenantId === tenantId
        && record.docType === docType
        && record.state === "ready")
      .sort((left, right) => right.updatedAt - left.updatedAt);
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
    const record = this.#require(tenantId, docId);
    if (record.state === "failed") {
      throw new GatewayDirectoryConflictError(`Document ${docId} is failed`);
    }
    return this.#replace(record, {
      state: "ready",
      version,
      error: null,
      updatedAt,
    });
  }

  async markFailed(
    tenantId: string,
    docId: string,
    error: string,
    updatedAt: number,
  ): Promise<GatewayDocumentRecord> {
    const record = this.#require(tenantId, docId);
    if (record.state === "ready") {
      throw new GatewayDirectoryConflictError(`Document ${docId} is ready`);
    }
    return this.#replace(record, {
      state: "failed",
      error,
      updatedAt,
    });
  }

  async touch(tenantId: string, docId: string, updatedAt: number): Promise<void> {
    const record = this.#require(tenantId, docId);
    if (record.state !== "ready") {
      throw new GatewayDirectoryConflictError(`Document ${docId} is not ready`);
    }
    this.#replace(record, { updatedAt });
  }

  #require(tenantId: string, docId: string): GatewayDocumentRecord {
    const record = this.#byDocument.get(directoryKey(tenantId, docId));
    if (!record) throw new GatewayDirectoryConflictError(`Unknown document ${docId}`);
    return record;
  }

  #replace(
    record: GatewayDocumentRecord,
    changes: Partial<GatewayDocumentRecord>,
  ): GatewayDocumentRecord {
    const updated = Object.freeze({ ...record, ...changes });
    this.#byDocument.set(directoryKey(record.tenantId, record.docId), updated);
    return updated;
  }
}

function directoryKey(tenantId: string, value: string): string {
  return `${tenantId}\u0000${value}`;
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