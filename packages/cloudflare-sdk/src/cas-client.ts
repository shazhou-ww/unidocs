/**
 * CAS HTTP client for cloudflare-sdk.
 *
 * Implements CasReadContext by calling the gateway's CAS endpoints.
 * Uploading a node is a single lease-with-content POST.
 */

import type { CasRef, CasReadContext, CasReferences } from "@unidocs/core";

/** Result of a lease claim or extension. */
interface CasLeaseResult {
  readonly hash: string;
  readonly ready: true;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
}

export interface CasClientConfig {
  /** Gateway base URL (e.g. "http://localhost:8787" or "https://gateway.example.com"). */
  baseUrl: string;
  /** User ID for CAS scoping. */
  userId: string;
  /** Optional auth token for gateway requests. */
  authToken?: string;
}

/**
 * CAS HTTP client implementing CasReadContext + upload operations.
 */
export class CasClient implements CasReadContext {
  private baseUrl: string;
  private userId: string;
  private authToken?: string;

  constructor(config: CasClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.userId = config.userId;
    this.authToken = config.authToken;
  }

  private casUrl(path: string): string {
    return `${this.baseUrl}/users/${this.userId}/cas${path}`;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    const h: Record<string, string> = { ...extra };
    if (this.authToken) {
      h.Authorization = `Bearer ${this.authToken}`;
    }
    return h;
  }

  /** Read CAS node content. */
  async read(ref: CasRef): Promise<Uint8Array> {
    const resp = await fetch(this.casUrl(`/nodes/${ref.hash}/content`), {
      headers: this.headers(),
    });
    if (!resp.ok) {
      throw new Error(`CAS read failed: ${resp.status} ${resp.statusText}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** Read CAS node metadata. */
  async metadata(ref: CasRef): Promise<{ hash: string; size: number; contentType: string; refs: readonly string[] }> {
    const resp = await fetch(this.casUrl(`/nodes/${ref.hash}/metadata`), {
      headers: this.headers(),
    });
    if (!resp.ok) {
      throw new Error(`CAS metadata failed: ${resp.status} ${resp.statusText}`);
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

    const resp = await fetch(this.casUrl(`/nodes/${hash}`), {
      method: "POST",
      headers: this.headers(extra),
      body: content,
    });
    if (!resp.ok) {
      throw new Error(`CAS lease failed: ${resp.status} ${resp.statusText}`);
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

    const resp = await fetch(this.casUrl(`/nodes/${hash}/lease`), {
      method: "POST",
      headers: this.headers(extra),
    });
    if (!resp.ok) {
      throw new Error(`CAS leaseExisting failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as Promise<CasLeaseResult>;
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
