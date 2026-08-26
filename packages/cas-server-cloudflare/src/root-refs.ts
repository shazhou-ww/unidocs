/**
 * Atomic Root Refs update with audit writes.
 *
 * The authoritative update executes in ONE D1 batch: domain-scoped idempotency
 * insert, stack-domain revision allocation (optimistic CAS so a concurrent or
 * retried writer cannot double-allocate), aggregate `cas_nodes.root_ref_count`
 * updates, one domain event append, the domain projection update (negative
 * balances allowed, zero rows removed), and the idempotency result. All
 * validation happens before the batch; the batch is all-or-nothing. Retryable
 * D1 conflicts/transients retry with bounded exponential backoff + jitter;
 * validation and conflict responses never retry.
 */

import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import { validateHash } from "@unidocs/cas-server-common";
import { canonicalJson, sha256Hex } from "@unidocs/cas-control-plane";
import { stackNodeKey } from "./do-names.js";

export const CAS_MAX_ROOT_REF_CHANGES = 1000;
export const CAS_MAX_ROOT_REF_DELTA = 1_000_000;
export const CAS_MAX_REQUEST_ID_LENGTH = 256;

export const RootRefsErrorCodes = {
  INVALID_REQUEST: "ROOT_REF_INVALID",
  NODE_NOT_FOUND: "NODE_NOT_FOUND",
  NODE_NOT_READY: "NODE_NOT_READY",
  NEGATIVE_AGGREGATE: "NEGATIVE_AGGREGATE",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  BUSY: "ROOT_REF_BUSY",
} as const;

export type RootRefsErrorCode = (typeof RootRefsErrorCodes)[keyof typeof RootRefsErrorCodes];

export class RootRefsValidationError extends Error {
  readonly status: number;
  readonly code: RootRefsErrorCode;

  constructor(status: number, code: RootRefsErrorCode, message: string) {
    super(message);
    this.name = "RootRefsValidationError";
    this.status = status;
    this.code = code;
  }
}

/** Retryable conflict (revision CAS lost or transient D1 failure). */
export class RootRefsRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootRefsRetryableError";
  }
}

export interface CanonicalRootRefsUpdate {
  readonly requestId: string;
  /** Canonical hash-sorted JSON of the changes record. */
  readonly changesJson: string;
  readonly payloadHash: string;
  readonly entries: readonly [string, number][];
}

/** Parse a Root Refs body, rejecting duplicate JSON keys. */
export function parseRootRefsBody(text: string): { requestId: unknown; changes: unknown } {
  // JSON.parse collapses duplicate keys before any reviver runs, so duplicate
  // hashes are detected on the raw text: hash keys only appear in `changes`.
  const hashKey = /"([0-9a-f]{64})"\s*:/g;
  const seenHashes = new Set<string>();
  let hashMatch: RegExpExecArray | null;
  while ((hashMatch = hashKey.exec(text)) !== null) {
    const hash = hashMatch[1]!;
    if (seenHashes.has(hash)) {
      throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `duplicate JSON key: ${hash}`);
    }
    seenHashes.add(hash);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, "request body must be an object");
  }
  const body = parsed as { requestId?: unknown; changes?: unknown };
  return { requestId: body.requestId, changes: body.changes };
}

/** Canonicalize + validate the update; hashes sorted, dupes impossible. */
export async function canonicalizeRootRefsUpdate(input: {
  requestId: unknown;
  changes: unknown;
  refDomain: string;
}): Promise<CanonicalRootRefsUpdate> {
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, "requestId must be a non-empty string");
  }
  if (input.requestId.length > CAS_MAX_REQUEST_ID_LENGTH) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `requestId exceeds ${CAS_MAX_REQUEST_ID_LENGTH} characters`);
  }
  if (typeof input.changes !== "object" || input.changes === null || Array.isArray(input.changes)) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, "changes must be an object");
  }
  const changes = input.changes as Record<string, unknown>;
  const entries: [string, number][] = [];
  for (const [hash, delta] of Object.entries(changes)) {
    try {
      validateHash(hash);
    } catch {
      throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `invalid hash: ${hash}`);
    }
    if (typeof delta !== "number" || !Number.isSafeInteger(delta) || delta === 0) {
      throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `invalid delta for ${hash}: ${String(delta)}`);
    }
    if (Math.abs(delta) > CAS_MAX_ROOT_REF_DELTA) {
      throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `delta for ${hash} exceeds the per-hash bound`);
    }
    entries.push([hash, delta]);
  }
  if (entries.length === 0) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, "changes must not be empty");
  }
  if (entries.length > CAS_MAX_ROOT_REF_CHANGES) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `changes exceeds the limit of ${CAS_MAX_ROOT_REF_CHANGES}`);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const changesJson = canonicalJson(Object.fromEntries(entries));
  const payloadHash = await sha256Hex(changesJson);
  return { requestId: input.requestId, changesJson, payloadHash, entries };
}

export interface DomainUpdateResult {
  readonly idempotent: boolean;
  readonly revision: number;
}

/**
 * Execute the atomic domain update. Idempotent retries return the stored
 * revision after the idempotency check and perform no validation or mutation.
 */
export async function executeDomainUpdate(input: {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly stackId: string;
  readonly tenantId: string;
  readonly refDomain: string;
  readonly canonical: CanonicalRootRefsUpdate;
  readonly now?: () => number;
}): Promise<DomainUpdateResult> {
  const now = input.now ?? (() => Date.now());
  const { db, bucket } = input;
  const { stackId, tenantId, refDomain } = input;
  const { requestId, changesJson, payloadHash, entries } = input.canonical;

  // Idempotency check (read before the batch; a retry stops here).
  const existing = await db
    .prepare(
      "SELECT payload_hash, revision FROM cas_root_ref_requests WHERE stack_id = ? AND tenant_id = ? AND ref_domain = ? AND request_id = ?",
    )
    .bind(stackId, tenantId, refDomain, requestId)
    .first<{ payload_hash: string; revision: number }>();
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new RootRefsValidationError(409, RootRefsErrorCodes.IDEMPOTENCY_CONFLICT, "requestId reused with a different payload");
    }
    return { idempotent: true, revision: existing.revision };
  }

  // Validation reads: authoritative aggregate state only (never audit data).
  const nodeRows = new Map<string, { root_ref_count: number }>();
  for (const [hash, delta] of entries) {
    const node = await db
      .prepare("SELECT root_ref_count FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?")
      .bind(stackId, tenantId, hash)
      .first<{ root_ref_count: number }>();
    if (!node) {
      throw new RootRefsValidationError(404, RootRefsErrorCodes.NODE_NOT_FOUND, `node ${hash} not found`);
    }
    const newCount = node.root_ref_count + delta;
    if (newCount < 0) {
      throw new RootRefsValidationError(409, RootRefsErrorCodes.NEGATIVE_AGGREGATE, `root ref count would go negative for ${hash}`);
    }
    if (!Number.isSafeInteger(newCount)) {
      throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `root ref count would overflow for ${hash}`);
    }
    nodeRows.set(hash, node);
  }
  // Positive targets must be ready (content materialized in R2).
  for (const [hash, delta] of entries) {
    if (delta > 0) {
      const object = await bucket.get(stackNodeKey(stackId, tenantId, hash));
      if (!object) {
        throw new RootRefsValidationError(409, RootRefsErrorCodes.NODE_NOT_READY, `node ${hash} is not ready`);
      }
    }
  }

  // Current stack-domain revision + current projection balances (audit
  // maintenance only — not an authoritative validation input).
  const revisionRow = await db
    .prepare("SELECT revision FROM cas_root_domain_revisions WHERE stack_id = ? AND ref_domain = ?")
    .bind(stackId, refDomain)
    .first<{ revision: number }>();
  const currentRevision = revisionRow?.revision ?? 0;
  const nextRevision = currentRevision + 1;

  const projectionRows = await db
    .prepare(
      "SELECT hash, ref_count FROM cas_root_domain_refs WHERE stack_id = ? AND ref_domain = ? AND tenant_id = ?",
    )
    .bind(stackId, refDomain, tenantId)
    .all<{ hash: string; ref_count: number }>();
  const balances = new Map<string, number>();
  for (const row of projectionRows.results ?? []) balances.set(row.hash, row.ref_count);

  // One atomic batch: revision CAS, aggregates, event, projection, idempotency.
  const batch: D1PreparedStatement[] = [
    db.prepare(
      "INSERT INTO cas_root_domain_revisions (stack_id, ref_domain, revision) VALUES (?, ?, ?) ON CONFLICT(stack_id, ref_domain) DO UPDATE SET revision = excluded.revision WHERE cas_root_domain_revisions.revision = ?",
    ).bind(stackId, refDomain, nextRevision, currentRevision),
  ];
  for (const [hash, delta] of entries) {
    batch.push(
      db.prepare(
        "UPDATE cas_nodes SET root_ref_count = root_ref_count + ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
      ).bind(delta, stackId, tenantId, hash),
    );
    const projected = (balances.get(hash) ?? 0) + delta;
    if (projected === 0) {
      batch.push(
        db.prepare(
          "DELETE FROM cas_root_domain_refs WHERE stack_id = ? AND ref_domain = ? AND tenant_id = ? AND hash = ?",
        ).bind(stackId, refDomain, tenantId, hash),
      );
    } else {
      batch.push(
        db.prepare(
          "INSERT INTO cas_root_domain_refs (stack_id, ref_domain, tenant_id, hash, ref_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(stack_id, ref_domain, tenant_id, hash) DO UPDATE SET ref_count = excluded.ref_count",
        ).bind(stackId, refDomain, tenantId, hash, projected),
      );
    }
  }
  batch.push(
    db.prepare(
      "INSERT INTO cas_root_domain_events (stack_id, ref_domain, revision, tenant_id, request_id, payload_hash, changes_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(stackId, refDomain, nextRevision, tenantId, requestId, payloadHash, changesJson, now()),
  );
  batch.push(
    db.prepare(
      "INSERT INTO cas_root_ref_requests (stack_id, tenant_id, ref_domain, request_id, payload_hash, revision, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(stackId, tenantId, refDomain, requestId, payloadHash, nextRevision, now()),
  );

  let results: Awaited<ReturnType<D1Database["batch"]>>;
  try {
    results = await db.batch(batch);
  } catch (error) {
    // Transient D1 failure: the whole batch aborted (atomic), so retry.
    throw new RootRefsRetryableError(
      error instanceof Error ? error.message : "D1 batch failed",
    );
  }
  // The revision CAS is the retryable conflict detector.
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new RootRefsRetryableError("stack-domain revision allocation lost a conflict");
  }
  return { idempotent: false, revision: nextRevision };
}

export interface DomainRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_OPTIONS: Required<Pick<DomainRetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "jitter">> = {
  maxAttempts: 5,
  baseDelayMs: 25,
  maxDelayMs: 800,
  jitter: true,
};

/** Bounded exponential backoff for retryable conflicts/transients. */
export async function withDomainRetry<T>(
  operation: () => Promise<T>,
  options: DomainRetryOptions = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitter } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof RootRefsRetryableError) || attempt >= maxAttempts) {
        throw error;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = jitter ? delay * (0.5 + Math.random() * 0.5) : delay;
      await sleep(Math.floor(jittered));
    }
  }
}
