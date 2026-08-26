/**
 * CAS HTTP client for @unidocs/cas-client.
 *
 * Public mode talks to Gateway (`baseUrl` + tenant identity + optional Bearer).
 * Editor mode talks to the CAS worker through a fetch-capable binding using
 * either the legacy shared headers or one request-local delegated capability.
 * which is structural so this package stays cloud-neutral (no Cloudflare
 * `Fetcher` type import). CAS wire types live in @unidocs/protocol-cas-legacy.
 */

import { computeNodeDigest, encodeHeader, hashToHex } from "@unidocs/cas-server-common";
import { refsFromSValue } from "@unidocs/svalue-codec";
import type { CasRef, CasReadContext, CasReferences, SValue } from "@unidocs/protocol";
import { casRoutes as canonicalCasRoutes } from "@unidocs/protocol-cas";
import { casRoutes as legacyCasRoutes } from "@unidocs/protocol-cas-legacy";
import type { CasLeaseResult, CasRootRefUpdate } from "@unidocs/protocol-cas-legacy";

/** Structural interface for a fetch-capable service binding. */
export interface HttpFetcher {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export type CasClientConfig =
  | { baseUrl: string; tenantId: string; authToken?: string }
  | { baseUrl: string; stackId: string; tenantId: string; authToken?: string }
  | { fetcher: HttpFetcher; tenantId: string; accessKey: string }
  | {
    fetcher: HttpFetcher;
    tenantId: string;
    sessionId: string;
    capability: string;
    stackId?: string;
  };

/** The optional stack namespace; canonical routes are used only when present. */
function stackIdOf(config: CasClientConfig): string | undefined {
  return "stackId" in config ? config.stackId : undefined;
}

/** Tenant route builder: canonical `/stacks/...` when stackId is present. */
function tenantRoutesFor(config: CasClientConfig): {
  readContent: (hash: string) => string;
  readMetadata: (hash: string) => string;
  leaseNode: (hash: string) => string;
  leaseExisting: (hash: string) => string;
  usage: () => string;
  gc: () => string;
  rootRefs: () => string;
} {
  const tenantId = config.tenantId;
  const stackId = stackIdOf(config);
  if (stackId !== undefined) {
    return {
      readContent: hash => canonicalCasRoutes.readContent({ stackId, tenantId, hash }),
      readMetadata: hash => canonicalCasRoutes.readMetadata({ stackId, tenantId, hash }),
      leaseNode: hash => canonicalCasRoutes.leaseNode({ stackId, tenantId, hash }),
      leaseExisting: hash => canonicalCasRoutes.leaseExisting({ stackId, tenantId, hash }),
      usage: () => canonicalCasRoutes.usage({ stackId, tenantId }),
      gc: () => canonicalCasRoutes.gc({ stackId, tenantId }),
      rootRefs: () => canonicalCasRoutes.updateRootRefs({ stackId, tenantId }),
    };
  }
  return {
    readContent: hash => legacyCasRoutes.readContent({ tenantId, hash }),
    readMetadata: hash => legacyCasRoutes.readMetadata({ tenantId, hash }),
    leaseNode: hash => legacyCasRoutes.leaseNode({ tenantId, hash }),
    leaseExisting: hash => legacyCasRoutes.leaseExisting({ tenantId, hash }),
    usage: () => legacyCasRoutes.usage({ tenantId }),
    gc: () => legacyCasRoutes.gc({ tenantId }),
    rootRefs: () => legacyCasRoutes.rootRefs({ tenantId }),
  };
}

export class CasClientError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, operation: string) {
    super(`CAS ${operation} failed: ${status} ${statusText}`);
    this.name = "CasClientError";
    this.status = status;
  }
}

/** Typed result of a Root Refs write; canonical responses carry `revision`. */
export interface CasRootRefsResult {
  readonly success: boolean;
  readonly idempotent?: boolean;
  readonly revision?: number;
}

function isInternalConfig(
  config: CasClientConfig,
): config is Extract<CasClientConfig, { fetcher: HttpFetcher }> {
  return "fetcher" in config;
}

function isCapabilityConfig(
  config: CasClientConfig,
): config is Extract<CasClientConfig, { capability: string }> {
  return "capability" in config;
}

/**
 * CAS HTTP client implementing CasReadContext + upload operations.
 */
export class CasClient implements CasReadContext {
  private config: CasClientConfig;

  constructor(config: CasClientConfig) {
    if (isCapabilityConfig(config)
      && (config.capability.length === 0 || config.sessionId.length === 0)) {
      throw new TypeError("Delegated CAS capability and session ID are required");
    }
    this.config = isInternalConfig(config)
      ? config
      : { ...config, baseUrl: config.baseUrl.replace(/\/$/, "") };
  }

  private origin(): string {
    return isInternalConfig(this.config)
      ? "https://cas.internal"
      : this.config.baseUrl;
  }

  private routes(): ReturnType<typeof tenantRoutesFor> {
    return tenantRoutesFor(this.config);
  }

  private routeUrl(path: string): string {
    return `${this.origin()}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (isCapabilityConfig(this.config)) {
      h.Authorization = `Bearer ${this.config.capability}`;
    } else if (isInternalConfig(this.config)) {
      h["X-Internal-Token"] = this.config.accessKey;
      h["X-Tenant-Id"] = this.config.tenantId;
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
    const resp = await this.request(this.routeUrl(this.routes().readContent(ref.hash)));
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
    // The CAS service is content-addressed by its canonical node digest —
    // SHA-256(header ‖ contentType ‖ childHashes ‖ content) — and rejects any
    // other hash. A stored blob is a leaf node (no children), so refCount 0.
    const header = encodeHeader(bytes.length, contentType, 0);
    const digest = await computeNodeDigest(header, contentType, [], bytes);
    const hash = hashToHex(digest);
    await this.ensureNode(hash, bytes, contentType);
    return hash;
  }

  /** Read CAS node metadata. */
  async metadata(ref: CasRef): Promise<{ hash: string; size: number; contentType: string; refs: readonly string[] }> {
    const resp = await this.request(this.routeUrl(this.routes().readMetadata(ref.hash)));
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "metadata");
    }
    const body = await resp.json() as { metadata: { hash: string; size: number; contentType: string; refs: string[] } };
    return body.metadata;
  }

  /**
   * Lease a node, uploading content when the node is not already ready.
   *
  * POST /tenants/{tenantId}/cas/nodes/{hash}
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

    const resp = await this.request(this.routeUrl(this.routes().leaseNode(hash)), {
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
  * POST /tenants/{tenantId}/cas/nodes/{hash}/lease
   */
  async leaseExisting(hash: string, requestedDurationMs?: number): Promise<CasLeaseResult> {
    const extra: Record<string, string> = {};
    if (requestedDurationMs != null) extra["X-CAS-Lease-Duration"] = String(requestedDurationMs);

    const resp = await this.request(this.routeUrl(this.routes().leaseExisting(hash)), {
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
   * In canonical stack mode (capability + `stackId`) this posts to
   * `/stacks/{stackId}/tenants/{tenantId}/root-refs` and returns the typed
   * `{success, idempotent, revision}` response. Without `stackId` it keeps
   * the legacy tenant-scoped routes; the shared-key mode still uses
   * `/_internal/root-refs`.
   */
  async updateRootRefs(update: CasRootRefUpdate): Promise<CasRootRefsResult> {
    if (!isInternalConfig(this.config)) {
      throw new Error("updateRootRefs is only available in Editor (service-binding) mode");
    }
    const rootRefsPath = isCapabilityConfig(this.config)
      ? this.routes().rootRefs()
      : "/_internal/root-refs";
    const resp = await this.request(this.routeUrl(rootRefsPath), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "updateRootRefs");
    }
    return resp.json() as Promise<CasRootRefsResult>;
  }
}

/**
 * Aggregate CAS references from a batch of SValue operations by walking
 * branded SBlobs. Returns hash → count map with positive occurrence counts.
 */
export function aggregateRefs(operations: readonly SValue[]): CasReferences {
  return refsFromSValue(operations as SValue);
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
  updateRootRefs(update: { requestId: string; changes: CasReferences }): Promise<CasRootRefsResult>;
}

/** Lease every SBlob hash referenced by a delta. Empty maps are a no-op. */
export async function leaseOpRefs(
  operations: readonly SValue[],
  cas: CasLeaseGateway,
): Promise<CasReferences> {
  const refs = aggregateRefs(operations);
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
