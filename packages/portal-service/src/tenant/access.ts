import { PaginationQuerySchema, type PaginationQuery } from "@unidocs/protocol-tenant-portal";

export class TenantAccessError extends Error {
  constructor(readonly code: "unauthorized" | "forbidden") {
    super(code === "unauthorized" ? "User authentication is required" : "The caller is not allowed to perform this operation");
    this.name = "TenantAccessError";
  }
}

export type TenantOperationCode = "invalid_request" | "forbidden" | "not_found" | "limit_exceeded"
  | "location_contract_violation" | "document_type_disabled" | "version_conflict" | "idempotency_conflict"
  | "content_unavailable" | "unavailable";

const MESSAGES: Readonly<Record<TenantOperationCode, string>> = {
  invalid_request: "The request is invalid",
  forbidden: "The caller is not allowed to perform this operation",
  not_found: "The requested resource was not found",
  limit_exceeded: "A size or quota limit was exceeded",
  location_contract_violation: "The location does not satisfy its Document Contract location schema",
  document_type_disabled: "The document type is not enabled for document creation",
  version_conflict: "The observed current version does not match the current pointer",
  idempotency_conflict: "The idempotency key was used with a different request",
  content_unavailable: "The referenced content is not available",
  unavailable: "The Platform is temporarily unavailable",
};

export class TenantOperationError extends Error {
  constructor(readonly code: TenantOperationCode) {
    super(MESSAGES[code]);
    this.name = "TenantOperationError";
  }
}

/**
 * Who is calling. Whether this principal may read or write a given document is
 * decided by the repository, the way administrator authority already is: the
 * document grant vocabulary is still open in the ER model, and the business
 * core must not freeze it by guessing.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly transport: "bearer" | "session";
  readonly sessionHash?: string;
  /** Present for Agent bearer tokens; a browser session carries none. */
  readonly scopes?: readonly string[];
}

export const TENANT_LIMITS = {
  documentName: 256,
  reason: 512,
  messageText: 16_384,
  attachments: 20,
  locationPayloadBytes: 8_192,
  idempotencyKey: 128,
  identifier: 128,
  cursor: 1_024,
} as const;

/**
 * The tenant appears in the path as well as in the credential. They must agree,
 * or one tenant's session addresses another tenant's documents.
 */
export function requireTenantScope(context: TenantContext, tenantId: unknown): void {
  if (typeof tenantId !== "string" || !tenantId.trim() || tenantId.length > TENANT_LIMITS.identifier) throw new TenantOperationError("invalid_request");
  if (tenantId !== context.tenantId) throw new TenantOperationError("forbidden");
}

export function requireIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !key || key.length > TENANT_LIMITS.idempotencyKey || /[^\x21-\x7e]/.test(key)) throw new TenantOperationError("invalid_request");
  return key;
}

export function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > TENANT_LIMITS.identifier || /[^\x21-\x7e]/.test(value)) throw new TenantOperationError("invalid_request");
  return value;
}

export function requireRecordIdx(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TenantOperationError("invalid_request");
  return value;
}

export function requirePagination(query: unknown): PaginationQuery {
  const parsed = PaginationQuerySchema.safeParse(query ?? {});
  if (!parsed.success || (parsed.data.cursor?.length ?? 0) > TENANT_LIMITS.cursor) throw new TenantOperationError("invalid_request");
  return parsed.data;
}

/** Reject bodies carrying fields the operation does not define, before they reach storage. */
export function requireExactFields(body: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new TenantOperationError("invalid_request");
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(field => !fields.includes(field))) throw new TenantOperationError("invalid_request");
  return record;
}
