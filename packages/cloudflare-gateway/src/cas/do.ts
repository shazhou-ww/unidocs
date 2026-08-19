/**
 * CAS Durable Object — per-user queue.
 *
 * Serializes all mutable CAS operations for one user:
 * - lease claims and extensions
 * - upload completion
 * - child-reference creation
 * - root-reference count updates
 * - garbage collection
 *
 * D1 and R2 are the durable stores; the DO is the concurrency boundary
 * that prevents a lease claim from racing a GC deletion decision.
 */

import {
  type CasHash,
  type CasNodeDescriptor,
  type CasLeaseResult,
  type CasRootRefUpdate,
  type CasUsage,
  type CasGcResult,
  type CasNodeMetadata,
  type CasNodeState,
  HASH_SIZE,
  encodeHeader,
  computeNodeDigest,
  hashToHex,
  hexToHash,
  validateHash,
  validateContentType,
  validateContentLength,
} from "@unidocs/cas";

interface CasEnv {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
}

interface LeaseRequestBody {
  size: number;
  contentType: string;
  refs: string[];
  requestedDurationMs: number;
}

/** Default lease duration if not specified. */
const DEFAULT_LEASE_MS = 15 * 60 * 1000; // 15 minutes

/** Minimum lease duration. */
const MIN_LEASE_MS = 60 * 1000; // 1 minute

/** Maximum lease duration. */
const MAX_LEASE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Generate a random upload token. */
function generateUploadToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class CasDurableObject implements DurableObject {
  private env: CasEnv;

  constructor(state: DurableObjectState, env: CasEnv) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname;
    const userId = request.headers.get("X-User-Id");

    if (!userId) {
      return Response.json({ error: "Missing X-User-Id header" }, { status: 401 });
    }

    try {
      switch (action) {
        case "/lease":
          return await this.handleLease(request, userId);
        case "/leaseExisting":
          return await this.handleLeaseExisting(request, userId);
        case "/upload":
          return await this.handleUpload(request, userId);
        case "/read":
          return await this.handleRead(request, userId);
        case "/metadata":
          return await this.handleMetadata(request, userId);
        case "/updateRootRefs":
          return await this.handleUpdateRootRefs(request, userId);
        case "/usage":
          return await this.handleUsage(userId);
        case "/gc":
          return await this.handleGc(request, userId);
        default:
          return Response.json({ error: `Unknown action: ${action}` }, { status: 404 });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error("[CAS DO] Error:", { action, userId, message, stack });
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // ─── Lease ────────────────────────────────────────────────

  private async handleLease(request: Request, userId: string): Promise<Response> {
    const body = (await request.json()) as LeaseRequestBody;
    const hash = request.headers.get("X-CAS-Hash")!;

    validateHash(hash);
    validateContentType(body.contentType);

    if (!Array.isArray(body.refs)) {
      throw new Error("refs must be an array");
    }
    for (const ref of body.refs) {
      validateHash(ref);
    }

    const durationMs = clamp(
      body.requestedDurationMs || DEFAULT_LEASE_MS,
      MIN_LEASE_MS,
      MAX_LEASE_MS,
    );

    const result = await this.claimLease(
      userId,
      {
        hash,
        size: body.size,
        contentType: body.contentType,
        refs: body.refs,
      },
      durationMs,
    );

    return Response.json(result);
  }

  private async claimLease(userId: string, 
    descriptor: CasNodeDescriptor,
    durationMs: number,
  ): Promise<CasLeaseResult & { uploadToken?: string }> {
    const now = Date.now();
    const db = this.env.CAS_DB;

    // Check if node already exists
    const existing = await db
      .prepare("SELECT * FROM cas_nodes WHERE user_id = ? AND hash = ?")
      .bind(userId, descriptor.hash)
      .first<{
        content_size: number;
        content_type: string;
        lease_started_at: number;
        lease_expires_at: number;
        child_ref_count: number;
        root_ref_count: number;
      }>();

    if (existing) {
      // Verify immutable metadata matches
      if (
        existing.content_size !== descriptor.size ||
        existing.content_type !== descriptor.contentType
      ) {
        throw new Error("Immutable metadata mismatch");
      }

      // Check if R2 content exists (ready?)
      const r2Key = `users/${userId}/nodes/${descriptor.hash}`;
      const r2Obj = await this.env.CAS_R2.head(r2Key);
      const ready = r2Obj !== null;

      // Extend lease
      const leaseStartedAt = existing.lease_expires_at > now
        ? existing.lease_started_at
        : now;
      const leaseExpiresAt = now + durationMs;

      await db
        .prepare(
          "UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE user_id = ? AND hash = ?",
        )
        .bind(leaseStartedAt, leaseExpiresAt, userId, descriptor.hash)
        .run();

      return {
        hash: descriptor.hash,
        ready,
        uploadRequired: !ready,
        leaseStartedAt,
        leaseExpiresAt,
        uploadToken: !ready ? generateUploadToken() : undefined,
      };
    }

    // New node: verify all children are ready
    for (const childHash of descriptor.refs) {
      const childR2Key = `users/${userId}/nodes/${childHash}`;
      const childR2 = await this.env.CAS_R2.head(childR2Key);
      if (!childR2) {
        throw new Error(`Child node ${childHash} is not ready`);
      }
    }

    // Insert node row + edges in one transaction
    const leaseStartedAt = now;
    const leaseExpiresAt = now + durationMs;

    const batch: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO cas_nodes (user_id, hash, content_size, content_type, lease_started_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(userId, descriptor.hash, descriptor.size, descriptor.contentType, leaseStartedAt, leaseExpiresAt),
    ];

    // Insert ordered edges and increment child ref counts
    for (let i = 0; i < descriptor.refs.length; i++) {
      batch.push(
        db.prepare(
          "INSERT INTO cas_edges (user_id, parent_hash, ordinal, child_hash) VALUES (?, ?, ?, ?)",
        ).bind(userId, descriptor.hash, i, descriptor.refs[i]),
      );
      batch.push(
        db.prepare(
          "UPDATE cas_nodes SET child_ref_count = child_ref_count + 1 WHERE user_id = ? AND hash = ?",
        ).bind(userId, descriptor.refs[i]),
      );
    }

    await db.batch(batch);

    // Check if R2 content exists
    const r2Key = `users/${userId}/nodes/${descriptor.hash}`;
    const r2Obj = await this.env.CAS_R2.head(r2Key);
    const ready = r2Obj !== null;

    return {
      hash: descriptor.hash,
      ready,
      uploadRequired: !ready,
      leaseStartedAt,
      leaseExpiresAt,
      uploadToken: !ready ? generateUploadToken() : undefined,
    };
  }

  // ─── Lease Existing ───────────────────────────────────────

  private async handleLeaseExisting(request: Request, userId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash")!;
    const durationMs = Number(request.headers.get("X-CAS-Duration") || DEFAULT_LEASE_MS);

    validateHash(hash);

    const now = Date.now();
    const db = this.env.CAS_DB;

    const existing = await db
      .prepare("SELECT * FROM cas_nodes WHERE user_id = ? AND hash = ?")
      .bind(userId, hash)
      .first<{
        lease_started_at: number;
        lease_expires_at: number;
      }>();

    if (!existing) {
      throw new Error(`Node ${hash} not found`);
    }

    // Check if ready
    const r2Key = `users/${userId}/nodes/${hash}`;
    const r2Obj = await this.env.CAS_R2.head(r2Key);
    if (!r2Obj) {
      throw new Error(`Node ${hash} is not ready`);
    }

    const clamped = clamp(durationMs, MIN_LEASE_MS, MAX_LEASE_MS);
    const leaseStartedAt = existing.lease_expires_at > now
      ? existing.lease_started_at
      : now;
    const leaseExpiresAt = now + clamped;

    await db
      .prepare("UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE user_id = ? AND hash = ?")
      .bind(leaseStartedAt, leaseExpiresAt, userId, hash)
      .run();

    const result: CasLeaseResult = {
      hash,
      ready: true,
      uploadRequired: false,
      leaseStartedAt,
      leaseExpiresAt,
    };

    return Response.json(result);
  }

  // ─── Upload ───────────────────────────────────────────────

  private async handleUpload(request: Request, userId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash")!;
    const uploadToken = request.headers.get("X-CAS-Upload-Token");

    validateHash(hash);

    if (!uploadToken) {
      throw new Error("Missing upload token");
    }

    const now = Date.now();
    const db = this.env.CAS_DB;

    // Check lease is still valid
    const node = await db
      .prepare("SELECT * FROM cas_nodes WHERE user_id = ? AND hash = ?")
      .bind(userId, hash)
      .first<{
        content_size: number;
        content_type: string;
        lease_expires_at: number;
      }>();

    if (!node) {
      throw new Error(`Node ${hash} not found`);
    }

    if (node.lease_expires_at <= now) {
      throw new Error("Lease expired");
    }

    // Read and validate content
    const content = new Uint8Array(await request.arrayBuffer());
    validateContentLength(content.length, node.content_size);

    // Validate digest
    const refs = await db
      .prepare("SELECT child_hash FROM cas_edges WHERE user_id = ? AND parent_hash = ? ORDER BY ordinal ASC")
      .bind(userId, hash)
      .all<{ child_hash: string }>();

    const childHashes = refs.results.map((r) => hexToHash(r.child_hash));
    const header = encodeHeader(node.content_size, node.content_type, childHashes.length);
    const digest = await computeNodeDigest(header, node.content_type, childHashes, content);
    const computedHex = hashToHex(digest);

    if (computedHex !== hash) {
      throw new Error(`Digest mismatch: expected ${hash}, got ${computedHex}`);
    }

    // Write to R2 at canonical key
    const r2Key = `users/${userId}/nodes/${hash}`;
    await this.env.CAS_R2.put(r2Key, content);

    const result: CasLeaseResult = {
      hash,
      ready: true,
      uploadRequired: false,
      leaseStartedAt: node.lease_expires_at > now
        ? (await db
            .prepare("SELECT lease_started_at FROM cas_nodes WHERE user_id = ? AND hash = ?")
            .bind(userId, hash)
            .first<{ lease_started_at: number }>())!.lease_started_at
        : now,
      leaseExpiresAt: node.lease_expires_at,
    };

    return Response.json(result);
  }

  // ─── Read ─────────────────────────────────────────────────

  private async handleRead(request: Request, userId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash")!;
    validateHash(hash);

    const r2Key = `users/${userId}/nodes/${hash}`;
    const obj = await this.env.CAS_R2.get(r2Key);
    if (!obj) {
      return Response.json({ error: "Not found or not ready" }, { status: 404 });
    }

    return new Response(obj.body, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  // ─── Metadata ─────────────────────────────────────────────

  private async handleMetadata(request: Request, userId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash")!;
    validateHash(hash);

    const db = this.env.CAS_DB;
    const node = await db
      .prepare("SELECT * FROM cas_nodes WHERE user_id = ? AND hash = ?")
      .bind(userId, hash)
      .first<{
        content_size: number;
        content_type: string;
        lease_started_at: number;
        lease_expires_at: number;
        child_ref_count: number;
        root_ref_count: number;
      }>();

    if (!node) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const edges = await db
      .prepare("SELECT child_hash FROM cas_edges WHERE user_id = ? AND parent_hash = ? ORDER BY ordinal ASC")
      .bind(userId, hash)
      .all<{ child_hash: string }>();

    const metadata: CasNodeMetadata = {
      hash,
      size: node.content_size,
      contentType: node.content_type,
      refs: edges.results.map((e) => e.child_hash),
    };

    const state: CasNodeState = {
      leaseStartedAt: node.lease_started_at,
      leaseExpiresAt: node.lease_expires_at,
      childRefCount: node.child_ref_count,
      rootRefCount: node.root_ref_count,
    };

    return Response.json({ metadata, state });
  }

  // ─── Root Refs ────────────────────────────────────────────

  private async handleUpdateRootRefs(request: Request, userId: string): Promise<Response> {
    const body = (await request.json()) as CasRootRefUpdate;

    if (!body.requestId || typeof body.requestId !== "string") {
      throw new Error("requestId is required");
    }
    if (!body.changes || typeof body.changes !== "object") {
      throw new Error("changes is required");
    }

    const db = this.env.CAS_DB;
    const now = Date.now();

    // Idempotency check
    const existing = await db
      .prepare("SELECT payload_hash FROM cas_root_ref_requests WHERE user_id = ? AND request_id = ?")
      .bind(userId, body.requestId)
      .first<{ payload_hash: string }>();

    // Compute payload hash for idempotency
    const payloadStr = JSON.stringify(body.changes, Object.keys(body.changes).sort());
    const payloadDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadStr));
    const payloadHash = hashToHex(new Uint8Array(payloadDigest));

    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new Error("Conflicting request ID");
      }
      return Response.json({ success: true, idempotent: true });
    }

    // Validate all targets exist and compute resulting counts
    const entries = Object.entries(body.changes);
    if (entries.length === 0) {
      throw new Error("Empty change set");
    }

    const batch: D1PreparedStatement[] = [];

    for (const [hash, delta] of entries) {
      validateHash(hash);
      if (!Number.isSafeInteger(delta) || delta === 0) {
        throw new Error(`Invalid delta for ${hash}: ${delta}`);
      }

      const node = await db
        .prepare("SELECT root_ref_count FROM cas_nodes WHERE user_id = ? AND hash = ?")
        .bind(userId, hash)
        .first<{ root_ref_count: number }>();

      if (!node) {
        throw new Error(`Node ${hash} not found`);
      }

      const newCount = node.root_ref_count + delta;
      if (newCount < 0) {
        throw new Error(`Root ref count would go negative for ${hash}`);
      }

      batch.push(
        db.prepare(
          "UPDATE cas_nodes SET root_ref_count = root_ref_count + ? WHERE user_id = ? AND hash = ?",
        ).bind(delta, userId, hash),
      );
    }

    // Record idempotency
    batch.push(
      db.prepare(
        "INSERT INTO cas_root_ref_requests (user_id, request_id, payload_hash, applied_at) VALUES (?, ?, ?, ?)",
      ).bind(userId, body.requestId, payloadHash, now),
    );

    await db.batch(batch);

    return Response.json({ success: true });
  }

  // ─── Usage ────────────────────────────────────────────────

  private async handleUsage(userId: string): Promise<Response> {
    const db = this.env.CAS_DB;

    const stats = await db
      .prepare(
        `SELECT
          COUNT(*) as nodeCount,
          COALESCE(SUM(content_size), 0) as readyContentBytes,
          COUNT(CASE WHEN lease_expires_at > 0 THEN 1 END) as leasedNodeCount
         FROM cas_nodes WHERE user_id = ?`,
      )
      .bind(userId)
      .first<{ nodeCount: number; readyContentBytes: number; leasedNodeCount: number }>();

    // Count not-ready nodes (no R2 content)
    const allNodes = await db
      .prepare("SELECT hash FROM cas_nodes WHERE user_id = ?")
      .bind(userId)
      .all<{ hash: string }>();

    let notReadyCount = 0;
    for (const node of allNodes.results) {
      const r2Key = `users/${userId}/nodes/${node.hash}`;
      const r2Obj = await this.env.CAS_R2.head(r2Key);
      if (!r2Obj) notReadyCount++;
    }

    const usage: CasUsage = {
      nodeCount: stats?.nodeCount ?? 0,
      readyContentBytes: stats?.readyContentBytes ?? 0,
      notReadyNodeCount: notReadyCount,
      leasedNodeCount: stats?.leasedNodeCount ?? 0,
    };

    return Response.json(usage);
  }

  // ─── GC ───────────────────────────────────────────────────

  private async handleGc(request: Request, userId: string): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { maxNodes?: number };
    const maxNodes = body.maxNodes ?? 100;

    const db = this.env.CAS_DB;
    const now = Date.now();

    // Find eligible nodes
    const eligible = await db
      .prepare(
        `SELECT hash, content_size FROM cas_nodes
         WHERE user_id = ?
           AND child_ref_count = 0
           AND root_ref_count = 0
           AND lease_expires_at <= ?
         LIMIT ?`,
      )
      .bind(userId, now, maxNodes)
      .all<{ hash: string; content_size: number }>();

    let deleted = 0;
    let reclaimedBytes = 0;

    for (const node of eligible.results) {
      // Re-check eligibility
      const fresh = await db
        .prepare(
          "SELECT child_ref_count, root_ref_count, lease_expires_at FROM cas_nodes WHERE user_id = ? AND hash = ?",
        )
        .bind(userId, node.hash)
        .first<{ child_ref_count: number; root_ref_count: number; lease_expires_at: number }>();

      if (!fresh || fresh.child_ref_count > 0 || fresh.root_ref_count > 0 || fresh.lease_expires_at > now) {
        continue;
      }

      // Delete R2 content
      const r2Key = `users/${userId}/nodes/${node.hash}`;
      await this.env.CAS_R2.delete(r2Key);

      // Delete edges and decrement child ref counts
      const edges = await db
        .prepare("SELECT child_hash, COUNT(*) as cnt FROM cas_edges WHERE user_id = ? AND parent_hash = ? GROUP BY child_hash")
        .bind(userId, node.hash)
        .all<{ child_hash: string; cnt: number }>();

      const batch: D1PreparedStatement[] = [
        db.prepare("DELETE FROM cas_edges WHERE user_id = ? AND parent_hash = ?")
          .bind(userId, node.hash),
        db.prepare("DELETE FROM cas_nodes WHERE user_id = ? AND hash = ?")
          .bind(userId, node.hash),
      ];

      for (const edge of edges.results) {
        batch.push(
          db.prepare(
            "UPDATE cas_nodes SET child_ref_count = child_ref_count - ? WHERE user_id = ? AND hash = ?",
          ).bind(edge.cnt, userId, edge.child_hash),
        );
      }

      await db.batch(batch);

      deleted++;
      reclaimedBytes += node.content_size;
    }

    const result: CasGcResult = {
      examined: eligible.results.length,
      deleted,
      reclaimedContentBytes: reclaimedBytes,
    };

    return Response.json(result);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
