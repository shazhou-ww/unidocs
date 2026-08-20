/**
 * CAS HTTP client for @unidocs/server-core.
 *
 * Public mode talks to Gateway (`baseUrl` + optional Bearer).
 * Editor mode talks to the CAS worker through a fetch-capable binding
 * (`fetcher` + `X-Internal-Token` + `X-User-Id`) — see `HttpFetcher` below,
 * which is structural so this file stays cloud-neutral (no Cloudflare
 * `Fetcher` type import).
 */

import type { CasRootRefUpdate } from "@unidocs/cas";
import type { CasRef, CasReadContext, CasReferences } from "@unidocs/core";
import { computeHash } from "./hash.js";

/** Structural interface for a fetch-capable binding (e.g. a Cloudflare service binding). */
export interface HttpFetcher {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/** Result of a lease claim or extension. */
interface CasLeaseResult {
  readonly hash: string;
  readonly ready: true;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
}

export type CasClientConfig =
  | { baseUrl: string; userId: string; authToken?: string }
  | { fetcher: HttpFetcher; userId: string; internalToken: string };

export class CasClientError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, operation: string) {
    super(`CAS ${operation} failed: ${status} ${statusText}`);
    this.name = "CasClientError";
    this.status = status;
  }
}

function isInternalConfig(
  config: CasClientConfig,
): config is { fetcher: HttpFetcher; userId: string; internalToken: string } {
  return "fetcher" in config;
}

/**
 * CAS HTTP client implementing CasReadContext + upload operations.
 */
export class CasClient implements CasReadContext {
  private config: CasClientConfig;

  constructor(config: CasClientConfig) {
    this.config = isInternalConfig(config)
      ? config
      : { ...config, baseUrl: config.baseUrl.replace(/\/$/, "") };
  }

  private origin(): string {
    return isInternalConfig(this.config)
      ? "https://cas.internal"
      : this.config.baseUrl;
  }

  private casUrl(path: string): string {
    return `${this.origin()}/users/${this.config.userId}/cas${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (isInternalConfig(this.config)) {
      h["X-Internal-Token"] = this.config.internalToken;
      h["X-User-Id"] = this.config.userId;
    } else if (this.config.authToken) {
      h.Authorization = `Bearer ${this.config.authToken}`;
    }
    return h;
  }

  private request(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = this.headers(init.headers ?? {});
    if (isInternalConfig(this.config)) {
      return this.config.fetcher.fetch(url, { ...init, headers });
    }
    return fetch(url, { ...init, headers });
  }

  /** Read CAS node content. */
  async read(ref: CasRef): Promise<Uint8Array> {
    const resp = await this.request(this.casUrl(`/nodes/${ref.hash}/content`));
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "read");
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  /**
   * Store content, returning its CAS hash. Satisfies the editor-side
   * `CasReadContext.store` — content-addressed upload via `ensureNode`.
   */
  async store(bytes: Uint8Array, contentType: string): Promise<string> {
    const hash = await computeHash(bytes);
    await this.ensureNode(hash, bytes, contentType);
    return hash;
  }

  /** Read CAS node metadata. */
  async metadata(ref: CasRef): Promise<{ hash: string; size: number; contentType: string; refs: readonly string[] }> {
    const resp = await this.request(this.casUrl(`/nodes/${ref.hash}/metadata`));
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "metadata");
    }
    const body = await resp.json() as { metadata: { hash: string; size: number; contentType: string; refs: string[] } };
    return body.metadata;
  }

  /**
   * Lease a node, uploading content when the node is not already ready.
   *
   * POST /users/{userId}/cas/nodes/{hash}
   */
  async ensureNode(
    hash: string,
    content: Uint8Array,
    contentType: string,
    refs: string[] = [],
    requestedDurationMs?: number,
  ): Promise<CasLeaseResult> {
    const extra: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(content.length),
    };
    if (refs.length > 0) extra["X-CAS-Refs"] = refs.join(",");
    if (requestedDurationMs != null) extra["X-CAS-Lease-Duration"] = String(requestedDurationMs);

    const resp = await this.request(this.casUrl(`/nodes/${hash}`), {
      method: "POST",
      headers: extra,
      body: content as BufferSource,
    });
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "lease");
    }
    return resp.json() as Promise<CasLeaseResult>;
  }

  /**
   * Extend a lease on an existing ready node.
   *
   * POST /users/{userId}/cas/nodes/{hash}/lease
   */
  async leaseExisting(hash: string, requestedDurationMs?: number): Promise<CasLeaseResult> {
    const extra: Record<string, string> = {};
    if (requestedDurationMs != null) extra["X-CAS-Lease-Duration"] = String(requestedDurationMs);

    const resp = await this.request(this.casUrl(`/nodes/${hash}/lease`), {
      method: "POST",
      headers: extra,
    });
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "leaseExisting");
    }
    return resp.json() as Promise<CasLeaseResult>;
  }

  /**
   * Editor-only: increment root-reference counts on the CAS worker.
   *
   * POST /_internal/root-refs
   */
  async updateRootRefs(update: CasRootRefUpdate): Promise<void> {
    if (!isInternalConfig(this.config)) {
      throw new Error("updateRootRefs is only available in Editor (service-binding) mode");
    }
    const resp = await this.request(`${this.origin()}/_internal/root-refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "updateRootRefs");
    }
  }
}

/**
 * Aggregate CAS references from a batch of operations.
 * Returns hash → count map with positive safe-integer counts.
 */
export function aggregateRefs<TOp>(
  operations: readonly TOp[],
  refsFromOp: (op: TOp) => CasReferences,
): CasReferences {
  const result: Record<string, number> = {};
  for (const op of operations) {
    const refs = refsFromOp(op);
    for (const [hash, count] of Object.entries(refs)) {
      if (!Number.isSafeInteger(count) || count <= 0) continue;
      result[hash] = (result[hash] ?? 0) + count;
    }
  }
  return result;
}

/**
 * Structural view of the lease capability a delta write needs.
 * Satisfied by `CasClient`, and by any cloud-neutral gateway.
 */
export interface CasLeaseGateway {
  leaseExisting(hash: string): Promise<unknown>;
}

/**
 * Structural view of the root-reference capability a delta commit needs.
 * Satisfied by `CasClient` (Editor mode), and by any cloud-neutral gateway.
 */
export interface CasRootRefGateway {
  updateRootRefs(update: { requestId: string; changes: CasReferences }): Promise<void>;
}

/** Lease every hash referenced by a delta. Empty maps are a no-op. */
export async function leaseOpRefs<TOp>(
  operations: readonly TOp[],
  refsFromOp: (op: TOp) => CasReferences,
  cas: CasLeaseGateway,
): Promise<CasReferences> {
  const refs = aggregateRefs(operations, refsFromOp);
  for (const hash of Object.keys(refs)) {
    await cas.leaseExisting(hash);
  }
  return refs;
}

/**
 * Persist root-ref increments after a delta insert. On failure, run rollback
 * (typically DELETE the new delta row) and rethrow.
 */
export async function commitRootRefsOrRollback(
  cas: CasRootRefGateway,
  requestId: string,
  changes: CasReferences,
  rollback: () => void | Promise<void>,
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  try {
    await cas.updateRootRefs({ requestId, changes });
  } catch (err) {
    await rollback();
    throw err;
  }
}
