/**
 * Stack-domain audit reads (operator-selected domain, never tenant-write
 * credentials).
 *
 * `listRootDomainRefs` returns `(tenantId, hash)`-ordered current-balance
 * pages bound to a stack-domain revision: the page reads the revision, queries
 * rows, and re-reads the revision (first pages retry a bounded number of times
 * on change; cursor pages require the cursor revision to equal the current one
 * before AND after the query, else `ROOT_REF_SNAPSHOT_CHANGED`). No historical
 * projection is implied — the cursor binds to the current revision only.
 *
 * `listRootDomainEvents` returns revision-ordered event pages with exclusive
 * `after`, optional exact tenant filtering, a consistently-read
 * `latestRevision`, and `nextAfter` that advances empty tenant-filtered pages
 * to the stack-domain watermark so polling never sticks on other tenants'
 * events.
 */

import type { D1Database } from "@cloudflare/workers-types";

export const CAS_AUDIT_DEFAULT_LIMIT = 200;
export const CAS_AUDIT_MAX_LIMIT = 1000;

export const AuditReadErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_CURSOR: "INVALID_CURSOR",
  ROOT_REF_SNAPSHOT_CHANGED: "ROOT_REF_SNAPSHOT_CHANGED",
} as const;

export class AuditReadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuditReadError";
    this.status = status;
    this.code = code;
  }
}

export interface RootDomainBalanceRow {
  readonly tenantId: string;
  readonly hash: string;
  readonly count: number;
}

export interface RootDomainRefsPage {
  readonly revision: number;
  readonly refs: readonly RootDomainBalanceRow[];
  readonly nextCursor: string | null;
}

export interface RootDomainEventRow {
  readonly revision: number;
  readonly tenantId: string;
  readonly requestId: string;
  readonly changes: Record<string, number>;
  readonly appliedAt: number;
}

export interface RootDomainEventsPage {
  readonly events: readonly RootDomainEventRow[];
  readonly latestRevision: number;
  readonly nextAfter: number;
}

export interface RootDomainSummary {
  readonly stackId: string;
  readonly refDomain: string;
  readonly revision: number;
}

/** Domains observed through successful Root Ref writes, ordered by name. */
export async function listRootDomains(input: {
  readonly db: D1Database;
  readonly stackId: string;
}): Promise<readonly RootDomainSummary[]> {
  const rows = await input.db
    .prepare(
      "SELECT stack_id, ref_domain, revision FROM cas_root_domain_revisions WHERE stack_id = ? ORDER BY ref_domain",
    )
    .bind(input.stackId)
    .all<{ stack_id: string; ref_domain: string; revision: number }>();
  return (rows.results ?? []).map((row) => ({
    stackId: row.stack_id,
    refDomain: row.ref_domain,
    revision: row.revision,
  }));
}

/** Read-side refDomain validation; reserved migration domains are readable. */
export function validateAuditRefDomain(value: string): string | null {
  if (value.length === 0) return "refDomain must not be empty";
  if (value.length > 64) return "refDomain is too long";
  if (!/^[a-z0-9_][a-z0-9_:.-]*$/.test(value)) {
    return "refDomain is malformed";
  }
  return null;
}

export function parseAuditLimit(value: number | undefined): number | null {
  if (value === undefined) return CAS_AUDIT_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > CAS_AUDIT_MAX_LIMIT) {
    return null;
  }
  return value;
}

// ----------------------------------------------------------------------
// Cursor
// ----------------------------------------------------------------------

interface RefsCursor {
  readonly version: 1;
  readonly kind: "refs";
  readonly revision: number;
  readonly stackDomain: string;
  readonly tenantFilter: string | null;
  readonly lastTenant: string;
  readonly lastHash: string;
}

export function encodeRefsCursor(cursor: RefsCursor): string {
  return btoa(JSON.stringify(cursor));
}

export function decodeRefsCursor(value: string): RefsCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(value));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1
    || candidate.kind !== "refs"
    || typeof candidate.revision !== "number"
    || !Number.isSafeInteger(candidate.revision)
    || candidate.revision < 0
    || typeof candidate.stackDomain !== "string"
    || (candidate.tenantFilter !== null && typeof candidate.tenantFilter !== "string")
    || typeof candidate.lastTenant !== "string"
    || typeof candidate.lastHash !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    kind: "refs",
    revision: candidate.revision,
    stackDomain: candidate.stackDomain,
    tenantFilter: candidate.tenantFilter as string | null,
    lastTenant: candidate.lastTenant,
    lastHash: candidate.lastHash,
  };
}

// ----------------------------------------------------------------------
// Current-balance pages
// ----------------------------------------------------------------------

export async function listRootDomainRefs(input: {
  readonly db: D1Database;
  readonly stackId: string;
  readonly refDomain: string;
  readonly tenantId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<RootDomainRefsPage> {
  const domainError = validateAuditRefDomain(input.refDomain);
  if (domainError) throw new AuditReadError(400, AuditReadErrorCodes.INVALID_REQUEST, domainError);
  const limit = parseAuditLimit(input.limit);
  if (limit === null) {
    throw new AuditReadError(400, AuditReadErrorCodes.INVALID_REQUEST, "invalid list limit");
  }
  const cursor = input.cursor === undefined ? null : decodeRefsCursor(input.cursor);
  if (input.cursor !== undefined && cursor === null) {
    throw new AuditReadError(400, AuditReadErrorCodes.INVALID_CURSOR, "malformed cursor");
  }
  const tenantFilter = input.tenantId ?? null;

  // First pages retry a bounded number of times when the revision moves
  // mid-read; cursor pages fail with ROOT_REF_SNAPSHOT_CHANGED instead.
  const MAX_FIRST_PAGE_RETRIES = 3;
  for (let attempt = 0; ; attempt += 1) {
    const revision = await readDomainRevision(input.db, input.stackId, input.refDomain);
    if (cursor) {
      if (cursor.revision !== revision) {
        throw new AuditReadError(409, AuditReadErrorCodes.ROOT_REF_SNAPSHOT_CHANGED, "cursor revision is no longer current");
      }
      if (cursor.stackDomain !== input.refDomain) {
        throw new AuditReadError(400, AuditReadErrorCodes.INVALID_CURSOR, "cursor is bound to another domain");
      }
      if ((cursor.tenantFilter ?? null) !== tenantFilter) {
        throw new AuditReadError(400, AuditReadErrorCodes.INVALID_CURSOR, "cursor is bound to another tenant filter");
      }
    }
    const rows = await input.db
      .prepare(
        `SELECT tenant_id, hash, ref_count FROM cas_root_domain_refs
         WHERE stack_id = ? AND ref_domain = ?
           ${tenantFilter === null ? "" : "AND tenant_id = ?"}
           AND (tenant_id, hash) > (?, ?)
         ORDER BY tenant_id, hash LIMIT ?`,
      )
      .bind(
        input.stackId,
        input.refDomain,
        ...(tenantFilter === null ? [] : [tenantFilter]),
        cursor?.lastTenant ?? "",
        cursor?.lastHash ?? "",
        limit + 1,
      )
      .all<{ tenant_id: string; hash: string; ref_count: number }>();
    const afterRevision = await readDomainRevision(input.db, input.stackId, input.refDomain);
    if (afterRevision === revision) {
      const results = rows.results ?? [];
      const refs = results.slice(0, limit).map((row) => ({
        tenantId: row.tenant_id,
        hash: row.hash,
        count: row.ref_count,
      }));
      const nextCursor =
        results.length > limit
          ? encodeRefsCursor({
            version: 1,
            kind: "refs",
            revision: afterRevision,
            stackDomain: input.refDomain,
            tenantFilter,
            lastTenant: refs[refs.length - 1]!.tenantId,
            lastHash: refs[refs.length - 1]!.hash,
          })
          : null;
      return { revision: afterRevision, refs, nextCursor };
    }
    if (cursor || attempt >= MAX_FIRST_PAGE_RETRIES) {
      throw new AuditReadError(409, AuditReadErrorCodes.ROOT_REF_SNAPSHOT_CHANGED, "stack-domain revision changed while reading");
    }
  }
}

// ----------------------------------------------------------------------
// Event pages
// ----------------------------------------------------------------------

export async function listRootDomainEvents(input: {
  readonly db: D1Database;
  readonly stackId: string;
  readonly refDomain: string;
  readonly tenantId?: string;
  readonly after?: number;
  readonly limit?: number;
}): Promise<RootDomainEventsPage> {
  const domainError = validateAuditRefDomain(input.refDomain);
  if (domainError) throw new AuditReadError(400, AuditReadErrorCodes.INVALID_REQUEST, domainError);
  const limit = parseAuditLimit(input.limit);
  if (limit === null) {
    throw new AuditReadError(400, AuditReadErrorCodes.INVALID_REQUEST, "invalid list limit");
  }
  const after = input.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AuditReadError(400, AuditReadErrorCodes.INVALID_REQUEST, "after must be a non-negative safe integer");
  }
  const tenantFilter = input.tenantId ?? null;

  // Consistently read the stack-domain watermark before the page query.
  const latestRevision = await readDomainRevision(input.db, input.stackId, input.refDomain);
  const rows = await input.db
    .prepare(
      `SELECT revision, tenant_id, request_id, changes_json, applied_at FROM cas_root_domain_events
       WHERE stack_id = ? AND ref_domain = ? AND revision > ?
         ${tenantFilter === null ? "" : "AND tenant_id = ?"}
       ORDER BY revision LIMIT ?`,
    )
    .bind(
      input.stackId,
      input.refDomain,
      after,
      ...(tenantFilter === null ? [] : [tenantFilter]),
      limit + 1,
    )
    .all<{ revision: number; tenant_id: string; request_id: string; changes_json: string; applied_at: number }>();

  const results = rows.results ?? [];
  const events = results.slice(0, limit).map((row) => ({
    revision: row.revision,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    changes: JSON.parse(row.changes_json) as Record<string, number>,
    appliedAt: row.applied_at,
  }));
  const nextAfter =
    events.length > 0
      ? events[events.length - 1]!.revision
      : Math.max(after, latestRevision);
  return { events, latestRevision, nextAfter };
}

async function readDomainRevision(db: D1Database, stackId: string, refDomain: string): Promise<number> {
  const row = await db
    .prepare("SELECT revision FROM cas_root_domain_revisions WHERE stack_id = ? AND ref_domain = ?")
    .bind(stackId, refDomain)
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}
