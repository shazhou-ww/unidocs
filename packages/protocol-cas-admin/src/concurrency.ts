/**
 * Optimistic concurrency, creation idempotency, and list pagination contracts
 * shared by every mutable control-plane resource.
 */

/** Integer resource revision rendered as a strong ETag (`"123"`). */
export type CasAdminRevision = number;

export const CasAdminIfMatchHeader = "If-Match";
export const CasAdminETagHeader = "ETag";
export const CasAdminIdempotencyKeyHeader = "Idempotency-Key";

export function formatCasAdminETag(revision: CasAdminRevision): string {
  return `"${revision}"`;
}

export function parseCasAdminETag(value: string): CasAdminRevision | null {
  const match = /^"(\d+)"$/.exec(value.trim());
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

/**
 * Creation endpoints accept Idempotency-Key scoped to
 * `(administrator identity, method, canonical route)` and retain the response
 * for at least 24 hours.
 */
export const CAS_ADMIN_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Opaque versioned list cursors are bound to filters and a control-data
 * snapshot revision. Implementations encode/decode; callers treat as opaque.
 */
export type CasAdminListCursor = string;

export interface CasAdminPageQuery {
  readonly limit?: number;
  readonly cursor?: CasAdminListCursor;
}

export interface CasAdminPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: CasAdminListCursor | null;
}

/** Mutations that replace or delete require If-Match. */
export interface CasAdminMutationPreconditions {
  readonly ifMatch: CasAdminRevision;
}

export interface CasAdminCreateHeaders {
  readonly idempotencyKey?: string;
}
