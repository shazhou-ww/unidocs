import { validateHash } from "@unicas/codec";

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

/** A retryable optimistic-concurrency conflict or transient store failure. */
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
  readonly entries: readonly (readonly [string, number])[];
}

export interface RootRefScope {
  readonly stackId: string;
  readonly tenantId: string;
  readonly refDomain: string;
}

export interface RootRefRequestRecord {
  readonly payloadHash: string;
  readonly revision: number;
}

export interface RootRefNodeState {
  readonly hash: string;
  readonly rootRefCount: number;
}

export interface RootRefDomainState {
  readonly revision: number;
  readonly balances: ReadonlyMap<string, number>;
}

export interface RootRefProjectionChange {
  readonly hash: string;
  /** Null deletes the zero-balance projection row. */
  readonly refCount: number | null;
}

/** Fully validated transition to be committed atomically by a platform store. */
export interface RootRefCommitPlan {
  readonly scope: RootRefScope;
  readonly requestId: string;
  readonly payloadHash: string;
  readonly changesJson: string;
  readonly entries: readonly (readonly [string, number])[];
  readonly expectedRevision: number;
  readonly revision: number;
  readonly projections: readonly RootRefProjectionChange[];
  readonly appliedAt: number;
}

export interface RootRefRepository {
  findRequest(scope: RootRefScope, requestId: string): Promise<RootRefRequestRecord | null>;
  readNodes(
    scope: Pick<RootRefScope, "stackId" | "tenantId">,
    hashes: readonly string[],
  ): Promise<readonly RootRefNodeState[]>;
  findUnreadyNode(
    scope: Pick<RootRefScope, "stackId" | "tenantId">,
    hashes: readonly string[],
  ): Promise<string | null>;
  readDomainState(scope: RootRefScope): Promise<RootRefDomainState>;
  commit(plan: RootRefCommitPlan): Promise<"committed" | "revision-conflict">;
}

export interface DomainUpdateResult {
  readonly idempotent: boolean;
  readonly revision: number;
}

/** Parse a Root Refs body, rejecting duplicate hash keys before JSON parsing. */
export function parseRootRefsBody(text: string): { requestId: unknown; changes: unknown } {
  const hashKey = /"([0-9a-f]{64})"\s*:/g;
  const seenHashes = new Set<string>();
  let hashMatch: RegExpExecArray | null;
  while ((hashMatch = hashKey.exec(text)) !== null) {
    const hash = hashMatch[1]!;
    if (seenHashes.has(hash)) {
      throw new RootRefsValidationError(
        400,
        RootRefsErrorCodes.INVALID_REQUEST,
        `duplicate JSON key: ${hash}`,
      );
    }
    seenHashes.add(hash);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RootRefsValidationError(
      400,
      RootRefsErrorCodes.INVALID_REQUEST,
      "request body is not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RootRefsValidationError(
      400,
      RootRefsErrorCodes.INVALID_REQUEST,
      "request body must be an object",
    );
  }
  const body = parsed as { requestId?: unknown; changes?: unknown };
  return { requestId: body.requestId, changes: body.changes };
}

/** Validate and canonicalize an update into hash order. */
export async function canonicalizeRootRefsUpdate(input: {
  requestId: unknown;
  changes: unknown;
  refDomain: string;
}): Promise<CanonicalRootRefsUpdate> {
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, "requestId must be a non-empty string");
  }
  if (input.requestId.length > CAS_MAX_REQUEST_ID_LENGTH) {
    throw new RootRefsValidationError(
      400,
      RootRefsErrorCodes.INVALID_REQUEST,
      `requestId exceeds ${CAS_MAX_REQUEST_ID_LENGTH} characters`,
    );
  }
  if (typeof input.changes !== "object" || input.changes === null || Array.isArray(input.changes)) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, "changes must be an object");
  }
  const entries: [string, number][] = [];
  for (const [hash, delta] of Object.entries(input.changes as Record<string, unknown>)) {
    try {
      validateHash(hash);
    } catch {
      throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `invalid hash: ${hash}`);
    }
    if (typeof delta !== "number" || !Number.isSafeInteger(delta) || delta === 0) {
      throw new RootRefsValidationError(
        400,
        RootRefsErrorCodes.INVALID_REQUEST,
        `invalid delta for ${hash}: ${String(delta)}`,
      );
    }
    if (Math.abs(delta) > CAS_MAX_ROOT_REF_DELTA) {
      throw new RootRefsValidationError(
        400,
        RootRefsErrorCodes.INVALID_REQUEST,
        `delta for ${hash} exceeds the per-hash bound`,
      );
    }
    entries.push([hash, delta]);
  }
  if (entries.length === 0) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, "changes must not be empty");
  }
  if (entries.length > CAS_MAX_ROOT_REF_CHANGES) {
    throw new RootRefsValidationError(
      400,
      RootRefsErrorCodes.INVALID_REQUEST,
      `changes exceeds the limit of ${CAS_MAX_ROOT_REF_CHANGES}`,
    );
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const changesJson = JSON.stringify(Object.fromEntries(entries));
  const payloadHash = await sha256Hex(changesJson);
  return { requestId: input.requestId, changesJson, payloadHash, entries };
}

/**
 * Apply one Root Ref domain update through a semantic repository. All business
 * validation and transition planning happens here; the repository supplies
 * durable state and commits the resulting plan atomically.
 */
export async function applyRootRefsUpdate(input: {
  readonly repository: RootRefRepository;
  readonly stackId: string;
  readonly tenantId: string;
  readonly refDomain: string;
  readonly canonical: CanonicalRootRefsUpdate;
  readonly now?: () => number;
}): Promise<DomainUpdateResult> {
  const scope: RootRefScope = {
    stackId: input.stackId,
    tenantId: input.tenantId,
    refDomain: input.refDomain,
  };
  const { requestId, payloadHash, changesJson, entries } = input.canonical;
  const existing = await repositoryCall(
    () => input.repository.findRequest(scope, requestId),
    "Root Ref request lookup failed",
  );
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new RootRefsValidationError(
        409,
        RootRefsErrorCodes.IDEMPOTENCY_CONFLICT,
        "requestId reused with a different payload",
      );
    }
    return { idempotent: true, revision: existing.revision };
  }

  const hashes = entries.map(([hash]) => hash);
  const nodes = new Map(
    (await repositoryCall(
      () => input.repository.readNodes(scope, hashes),
      "Root Ref node lookup failed",
    )).map((node) => [node.hash, node]),
  );
  for (const [hash, delta] of entries) {
    const node = nodes.get(hash);
    if (!node) {
      throw new RootRefsValidationError(404, RootRefsErrorCodes.NODE_NOT_FOUND, `node ${hash} not found`);
    }
    const newCount = node.rootRefCount + delta;
    if (newCount < 0) {
      throw new RootRefsValidationError(
        409,
        RootRefsErrorCodes.NEGATIVE_AGGREGATE,
        `root ref count would go negative for ${hash}`,
      );
    }
    if (!Number.isSafeInteger(newCount)) {
      throw new RootRefsValidationError(
        400,
        RootRefsErrorCodes.INVALID_REQUEST,
        `root ref count would overflow for ${hash}`,
      );
    }
  }

  const positiveHashes = entries.filter(([, delta]) => delta > 0).map(([hash]) => hash);
  const unreadyHash = positiveHashes.length === 0
    ? null
    : await repositoryCall(
      () => input.repository.findUnreadyNode(scope, positiveHashes),
      "Root Ref readiness lookup failed",
    );
  if (unreadyHash !== null) {
    throw new RootRefsValidationError(
      409,
      RootRefsErrorCodes.NODE_NOT_READY,
      `node ${unreadyHash} is not ready`,
    );
  }

  const domain = await repositoryCall(
    () => input.repository.readDomainState(scope),
    "Root Ref domain-state lookup failed",
  );
  const revision = domain.revision + 1;
  const projections = entries.map(([hash, delta]) => {
    const refCount = (domain.balances.get(hash) ?? 0) + delta;
    return { hash, refCount: refCount === 0 ? null : refCount };
  });
  const plan: RootRefCommitPlan = {
    scope,
    requestId,
    payloadHash,
    changesJson,
    entries,
    expectedRevision: domain.revision,
    revision,
    projections,
    appliedAt: (input.now ?? (() => Date.now()))(),
  };

  const commitResult = await repositoryCall(
    () => input.repository.commit(plan),
    "Root Ref repository commit failed",
  );
  if (commitResult === "revision-conflict") {
    throw new RootRefsRetryableError("stack-domain revision allocation lost a conflict");
  }
  return { idempotent: false, revision };
}

async function repositoryCall<T>(operation: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RootRefsValidationError || error instanceof RootRefsRetryableError) {
      throw error;
    }
    throw new RootRefsRetryableError(error instanceof Error ? error.message : fallback);
  }
}

export interface DomainRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_OPTIONS: Required<
  Pick<DomainRetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "jitter">
> = {
  maxAttempts: 5,
  baseDelayMs: 25,
  maxDelayMs: 800,
  jitter: true,
};

/** Bounded exponential backoff for retryable conflicts and store failures. */
export async function withDomainRetry<T>(
  operation: () => Promise<T>,
  options: DomainRetryOptions = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitter } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  };
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
