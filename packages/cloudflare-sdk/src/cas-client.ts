/**
 * CAS HTTP client for cloudflare-sdk.
 *
 * Implements CasReadContext by calling the gateway's CAS endpoints.
 * Also provides upload helpers for the two-phase lease/upload protocol.
 */

import type { CasRef, CasReadContext, CasReferences } from "@unidocs/core";

/** Result of a lease claim or extension. */
interface CasLeaseResult {
  readonly hash: string;
  readonly ready: boolean;
  readonly uploadRequired: boolean;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
  readonly uploadToken?: string;
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

  private headers(): HeadersInit {
    const h: Record<string, string> = {
      "X-User-Id": this.userId,
    };
    if (this.authToken) {
      h["Authorization"] = `Bearer ${this.authToken}`;
    }
    return h;
  }

  /** Read CAS node content. */
  async read(ref: CasRef): Promise<Uint8Array> {
    const resp = await fetch(`${this.baseUrl}/v1/cas/nodes/${ref.hash}/content`, {
      headers: this.headers(),
    });
    if (!resp.ok) {
      throw new Error(`CAS read failed: ${resp.status} ${resp.statusText}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** Read CAS node metadata. */
  async metadata(ref: CasRef): Promise<{ hash: string; size: number; contentType: string; refs: readonly string[] }> {
    const resp = await fetch(`${this.baseUrl}/v1/cas/nodes/${ref.hash}/metadata`, {
      headers: this.headers(),
    });
    if (!resp.ok) {
      throw new Error(`CAS metadata failed: ${resp.status} ${resp.statusText}`);
    }
    const body = await resp.json() as { metadata: { hash: string; size: number; contentType: string; refs: string[] } };
    return body.metadata;
  }

  /**
   * Claim a lease for a CAS node (two-phase upload protocol).
   *
   * Phase 1: POST /v1/cas/nodes/{hash}/lease
   * Returns uploadRequired=true if content needs to be uploaded.
   */
  async claimLease(
    hash: string,
    size: number,
    contentType: string,
    refs: string[],
    requestedDurationMs?: number,
  ): Promise<CasLeaseResult & { uploadToken?: string }> {
    const resp = await fetch(`${this.baseUrl}/v1/cas/nodes/${hash}/lease`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ size, contentType, refs, requestedDurationMs }),
    });
    if (!resp.ok) {
      throw new Error(`CAS lease claim failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as Promise<CasLeaseResult & { uploadToken?: string }>;
  }

  /**
   * Upload CAS node content (two-phase upload protocol).
   *
   * Phase 2: PUT /v1/cas/nodes/{hash}/content
   * Requires the uploadToken from claimLease.
   */
  async uploadContent(
    hash: string,
    content: Uint8Array,
    uploadToken: string,
  ): Promise<CasLeaseResult> {
    const resp = await fetch(`${this.baseUrl}/v1/cas/nodes/${hash}/content`, {
      method: "PUT",
      headers: {
        ...this.headers(),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
        "X-CAS-Upload-Token": uploadToken,
      },
      body: content,
    });
    if (!resp.ok) {
      throw new Error(`CAS upload failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as Promise<CasLeaseResult>;
  }

  /**
   * Extend a lease on an existing ready node.
   */
  async leaseExisting(hash: string, requestedDurationMs?: number): Promise<CasLeaseResult> {
    // Use the DO directly via internal endpoint
    const resp = await fetch(`${this.baseUrl}/v1/cas/nodes/${hash}/lease`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ size: 0, contentType: "", refs: [], requestedDurationMs }),
    });
    if (!resp.ok) {
      throw new Error(`CAS leaseExisting failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as Promise<CasLeaseResult>;
  }

  /**
   * Convenience: create or lease a node, upload if needed.
   */
  async ensureNode(
    hash: string,
    content: Uint8Array,
    contentType: string,
    refs: string[] = [],
  ): Promise<CasLeaseResult> {
    const lease = await this.claimLease(hash, content.length, contentType, refs);
    if (lease.uploadRequired && lease.uploadToken) {
      return this.uploadContent(hash, content, lease.uploadToken);
    }
    return lease;
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
