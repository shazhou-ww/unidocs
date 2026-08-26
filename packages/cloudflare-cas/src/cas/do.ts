/**
 * CAS Durable Object — per-tenant queue.
 *
 * Serializes all mutable CAS operations for one tenant:
 * - lease with content and lease extensions
 * - child-reference creation
 * - root-reference count updates
 * - garbage collection
 *
 * D1 and R2 are the durable stores; the DO is the concurrency boundary
 * that prevents a lease claim from racing a GC deletion decision.
 */

import type { CasNodeDescriptor, CasLeaseResult, CasAssignRootsRequest, CasRootRefUpdate, CasUsage, CasGcResult, CasNodeMetadata, CasNodeState } from "@unidocs/protocol-cas-legacy";
import { encodeHeader, concatenateNodeBytes, decodeHeader, parseNodeBytes, computeNodeDigest, hashToHex, hexToHash, validateHash, validateContentType, validateContentLength, validateChildRefs, validateDecodedHeader } from "@unidocs/cas-server-common";
import { decodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { SValueContentType } from "@unidocs/protocol";

interface CasEnv {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
}

/** Default lease duration if not specified. */
const DEFAULT_LEASE_MS = 15 * 60 * 1000; // 15 minutes

/** Minimum lease duration. */
const MIN_LEASE_MS = 60 * 1000; // 1 minute

/** Maximum lease duration. */
const MAX_LEASE_MS = 24 * 60 * 60 * 1000; // 24 hours

class CasHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class CasDurableObject implements DurableObject {
  private env: CasEnv;

  constructor(state: DurableObjectState, env: CasEnv) {
    this.env = env;
  }

  private r2Key(tenantId: string, hash: string): string {
    return `tenants/${tenantId}/nodes/${hash}`;
  }

  private legacyR2Key(tenantId: string, hash: string): string {
    return `users/${tenantId}/nodes/${hash}`;
  }

  private async ensureR2Object(tenantId: string, hash: string): Promise<R2Object | null> {
    const key = this.r2Key(tenantId, hash);
    const current = await this.env.CAS_R2.head(key);
    if (current) return current;

    const legacyKey = this.legacyR2Key(tenantId, hash);
    const legacy = await this.env.CAS_R2.get(legacyKey);
    if (!legacy) return null;
    await this.env.CAS_R2.put(key, legacy.body);
    await this.env.CAS_R2.delete(legacyKey);
    return this.env.CAS_R2.head(key);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname;
    const tenantId = request.headers.get("X-Tenant-Id");

    if (!tenantId) {
      return Response.json({ error: "Missing X-Tenant-Id header" }, { status: 401 });
    }

    try {
      switch (action) {
        case "/leaseWithContent":
          return await this.handleLeaseWithContent(request, tenantId);
        case "/leasePortableNode":
          return await this.handleLeasePortableNode(request, tenantId);
        case "/leaseExisting":
          return await this.handleLeaseExisting(request, tenantId);
        case "/read":
          return await this.handleRead(request, tenantId);
        case "/readNode":
          return await this.handleReadNode(request, tenantId);
        case "/metadata":
          return await this.handleMetadata(request, tenantId);
        case "/updateRootRefs":
          return await this.handleUpdateRootRefs(request, tenantId);
        case "/assignRoots":
          return await this.handleAssignRoots(request, tenantId);
        case "/usage":
          return await this.handleUsage(tenantId);
        case "/gc":
          return await this.handleGc(request, tenantId);
        default:
          return Response.json({ error: `Unknown action: ${action}` }, { status: 404 });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const status = err instanceof CasHttpError ? err.status : 500;
      if (status >= 500) {
        console.error("[CAS DO] Error:", { action, tenantId, message, stack });
      }
      return Response.json({ error: message }, { status });
    }
  }

  // ─── Lease with content ───────────────────────────────────

  private async handleLeaseWithContent(request: Request, tenantId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash") ?? "";
    try {
      validateHash(hash);
    } catch {
      throw new CasHttpError(400, "Invalid hash");
    }

    const contentType = request.headers.get("Content-Type");
    if (!contentType) {
      throw new CasHttpError(400, "Content-Type is required");
    }
    try {
      validateContentType(contentType);
    } catch (err) {
      throw new CasHttpError(400, err instanceof Error ? err.message : String(err));
    }

    const lengthHeader = request.headers.get("Content-Length");
    const size = Number(lengthHeader);
    if (!Number.isFinite(size) || size < 0) {
      throw new CasHttpError(400, "Content-Length is required");
    }

    let refs: string[];
    try {
      refs = parseRefsHeader(request.headers.get("X-CAS-Refs"));
    } catch (err) {
      throw new CasHttpError(400, err instanceof Error ? err.message : String(err));
    }

    const durationMs = parseDurationMs(request.headers.get("X-CAS-Lease-Duration"));
    const descriptor: CasNodeDescriptor = { hash, size, contentType, refs };

    return this.leaseNode(
      tenantId,
      descriptor,
      durationMs,
      async () => new Uint8Array(await request.arrayBuffer()),
      () => cancelBody(request),
    );
  }

  private async handleLeasePortableNode(request: Request, tenantId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash") ?? "";
    try {
      validateHash(hash);
    } catch {
      throw new CasHttpError(400, "Invalid hash");
    }
    const durationMs = parseDurationMs(request.headers.get("X-CAS-Lease-Duration"));
    let parsed: ReturnType<typeof parseNodeBytes>;
    try {
      parsed = parseNodeBytes(new Uint8Array(await request.arrayBuffer()));
      const decoded = decodeHeader(parsed.header);
      validateDecodedHeader(decoded);
      validateContentType(parsed.contentType);
      const refs = parsed.childHashes.map(hashToHex);
      validateChildRefs(refs, decoded.refCount);
      return this.leaseNode(
        tenantId,
        {
          hash,
          size: parsed.content.length,
          contentType: parsed.contentType,
          refs,
        },
        durationMs,
        async () => parsed.content,
        async () => undefined,
      );
    } catch (err) {
      if (err instanceof CasHttpError) throw err;
      throw new CasHttpError(400, err instanceof Error ? err.message : String(err));
    }
  }

  private async leaseNode(
    tenantId: string,
    descriptor: CasNodeDescriptor,
    durationMs: number,
    provideContent: () => Promise<Uint8Array>,
    cancelContent: () => Promise<void>,
  ): Promise<Response> {
    const { hash, size, contentType, refs } = descriptor;

    const now = Date.now();
    const db = this.env.CAS_DB;
    const r2Key = this.r2Key(tenantId, hash);

    const existing = await db
      .prepare("SELECT content_size, content_type, lease_started_at, lease_expires_at FROM cas_nodes WHERE tenant_id = ? AND hash = ?")
      .bind(tenantId, hash)
      .first<{
        content_size: number;
        content_type: string;
        lease_started_at: number;
        lease_expires_at: number;
      }>();

    const existingRefs = existing
      ? (await db
        .prepare("SELECT child_hash FROM cas_edges WHERE tenant_id = ? AND parent_hash = ? ORDER BY ordinal ASC")
        .bind(tenantId, hash)
        .all<{ child_hash: string }>())
        .results.map((row) => row.child_hash)
      : [];

    const r2Head = await this.ensureR2Object(tenantId, hash);

    if (existing && r2Head) {
      if (!metadataMatches(existing, existingRefs, descriptor)) {
        await cancelContent();
        throw new CasHttpError(409, "Immutable metadata mismatch");
      }
      await cancelContent();
      return Response.json(await this.extendLease(tenantId, hash, existing.lease_started_at, existing.lease_expires_at, durationMs, now));
    }

    for (const childHash of refs) {
      const childR2 = await this.ensureR2Object(tenantId, childHash);
      if (!childR2) {
        await cancelContent();
        throw new CasHttpError(409, `Child node ${childHash} is not ready`);
      }
    }

    const content = await provideContent();
    try {
      validateContentLength(content.length, size);
    } catch (err) {
      throw new CasHttpError(400, err instanceof Error ? err.message : String(err));
    }

    if (contentType === SValueContentType) {
      let derivedRefs: readonly string[];
      try {
        derivedRefs = decodeSValueWithRefs(content).refs;
      } catch (err) {
        throw new CasHttpError(
          400,
          `Invalid SValue content: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!sameRefs(refs, derivedRefs)) {
        throw new CasHttpError(400, "SValue child refs do not match encoded content");
      }
    }

    const childHashes = refs.map(hexToHash);
    const header = encodeHeader(size, contentType, childHashes.length);
    const digest = await computeNodeDigest(header, contentType, childHashes, content);
    const computedHex = hashToHex(digest);
    if (computedHex !== hash) {
      throw new CasHttpError(400, `Digest mismatch: expected ${hash}, got ${computedHex}`);
    }

    if (existing && !metadataMatches(existing, existingRefs, descriptor)) {
      throw new CasHttpError(409, "Immutable metadata mismatch");
    }

    await this.env.CAS_R2.put(r2Key, content);

    const leaseStartedAt = existing && existing.lease_expires_at > now ? existing.lease_started_at : now;
    const leaseExpiresAt = now + durationMs;

    if (existing) {
      await db
        .prepare("UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE tenant_id = ? AND hash = ?")
        .bind(leaseStartedAt, leaseExpiresAt, tenantId, hash)
        .run();
    } else {
      const batch: D1PreparedStatement[] = [
        db.prepare(
          `INSERT INTO cas_nodes (tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(tenantId, hash, size, contentType, leaseStartedAt, leaseExpiresAt),
      ];
      for (let i = 0; i < refs.length; i++) {
        batch.push(
          db.prepare(
            "INSERT INTO cas_edges (tenant_id, parent_hash, ordinal, child_hash) VALUES (?, ?, ?, ?)",
          ).bind(tenantId, hash, i, refs[i]),
        );
        batch.push(
          db.prepare(
            "UPDATE cas_nodes SET child_ref_count = child_ref_count + 1 WHERE tenant_id = ? AND hash = ?",
          ).bind(tenantId, refs[i]),
        );
      }
      await db.batch(batch);
    }

    const result: CasLeaseResult = {
      hash,
      ready: true,
      leaseStartedAt,
      leaseExpiresAt,
    };
    return Response.json(result);
  }

  private async extendLease(
    tenantId: string,
    hash: string,
    currentStartedAt: number,
    currentExpiresAt: number,
    durationMs: number,
    now: number,
  ): Promise<CasLeaseResult> {
    const leaseStartedAt = currentExpiresAt > now ? currentStartedAt : now;
    const leaseExpiresAt = now + durationMs;
    await this.env.CAS_DB
      .prepare("UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE tenant_id = ? AND hash = ?")
      .bind(leaseStartedAt, leaseExpiresAt, tenantId, hash)
      .run();
    return { hash, ready: true, leaseStartedAt, leaseExpiresAt };
  }

  // ─── Lease Existing ───────────────────────────────────────

  private async handleLeaseExisting(request: Request, tenantId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash") ?? "";
    try {
      validateHash(hash);
    } catch {
      throw new CasHttpError(400, "Invalid hash");
    }

    const durationMs = parseDurationMs(request.headers.get("X-CAS-Lease-Duration"));
    const now = Date.now();
    const db = this.env.CAS_DB;

    const existing = await db
      .prepare("SELECT lease_started_at, lease_expires_at FROM cas_nodes WHERE tenant_id = ? AND hash = ?")
      .bind(tenantId, hash)
      .first<{
        lease_started_at: number;
        lease_expires_at: number;
      }>();

    if (!existing) {
      throw new CasHttpError(404, `Node ${hash} not found`);
    }

    const r2Obj = await this.ensureR2Object(tenantId, hash);
    if (!r2Obj) {
      throw new CasHttpError(409, `Node ${hash} is not ready`);
    }

    return Response.json(
      await this.extendLease(tenantId, hash, existing.lease_started_at, existing.lease_expires_at, durationMs, now),
    );
  }

  // ─── Read ─────────────────────────────────────────────────

  private async handleRead(request: Request, tenantId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash")!;
    validateHash(hash);

    const r2Key = this.r2Key(tenantId, hash);
    await this.ensureR2Object(tenantId, hash);
    const obj = await this.env.CAS_R2.get(r2Key);
    if (!obj) {
      return Response.json({ error: "Not found or not ready" }, { status: 404 });
    }

    return new Response(obj.body, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  private async handleReadNode(request: Request, tenantId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash") ?? "";
    validateHash(hash);
    const node = await this.env.CAS_DB
      .prepare("SELECT content_size, content_type FROM cas_nodes WHERE tenant_id = ? AND hash = ?")
      .bind(tenantId, hash)
      .first<{ content_size: number; content_type: string }>();
    if (!node) throw new CasHttpError(404, `Node ${hash} not found`);

    await this.ensureR2Object(tenantId, hash);
    const object = await this.env.CAS_R2.get(this.r2Key(tenantId, hash));
    if (!object) throw new CasHttpError(404, `Node ${hash} is not ready`);
    const content = new Uint8Array(await object.arrayBuffer());
    if (content.length !== node.content_size) {
      throw new Error(`Stored content length mismatch for ${hash}`);
    }
    const edges = await this.env.CAS_DB
      .prepare("SELECT child_hash FROM cas_edges WHERE tenant_id = ? AND parent_hash = ? ORDER BY ordinal ASC")
      .bind(tenantId, hash)
      .all<{ child_hash: string }>();
    const refs = edges.results.map(edge => hexToHash(edge.child_hash));
    const header = encodeHeader(content.length, node.content_type, refs.length);
    const bytes = concatenateNodeBytes(
      header,
      new TextEncoder().encode(node.content_type),
      refs,
      content,
    );
    return new Response(Uint8Array.from(bytes).buffer, {
      headers: {
        "Content-Length": String(bytes.length),
        "Content-Type": "application/vnd.unidocs.cas-node",
      },
    });
  }

  // ─── Metadata ─────────────────────────────────────────────

  private async handleMetadata(request: Request, tenantId: string): Promise<Response> {
    const hash = request.headers.get("X-CAS-Hash")!;
    validateHash(hash);

    const db = this.env.CAS_DB;
    const node = await db
      .prepare("SELECT * FROM cas_nodes WHERE tenant_id = ? AND hash = ?")
      .bind(tenantId, hash)
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
      .prepare("SELECT child_hash FROM cas_edges WHERE tenant_id = ? AND parent_hash = ? ORDER BY ordinal ASC")
      .bind(tenantId, hash)
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

  private async handleUpdateRootRefs(request: Request, tenantId: string): Promise<Response> {
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
      .prepare("SELECT payload_hash FROM cas_root_ref_requests WHERE tenant_id = ? AND request_id = ?")
      .bind(tenantId, body.requestId)
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
        .prepare("SELECT root_ref_count FROM cas_nodes WHERE tenant_id = ? AND hash = ?")
        .bind(tenantId, hash)
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
          "UPDATE cas_nodes SET root_ref_count = root_ref_count + ? WHERE tenant_id = ? AND hash = ?",
        ).bind(delta, tenantId, hash),
      );
    }

    // Record idempotency
    batch.push(
      db.prepare(
        "INSERT INTO cas_root_ref_requests (tenant_id, request_id, payload_hash, applied_at) VALUES (?, ?, ?, ?)",
      ).bind(tenantId, body.requestId, payloadHash, now),
    );

    await db.batch(batch);

    return Response.json({ success: true });
  }

  private async handleAssignRoots(request: Request, tenantId: string): Promise<Response> {
    const body = (await request.json()) as CasAssignRootsRequest;
    validateRequestId(body.requestId);
    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      throw new CasHttpError(400, "assignments must be a non-empty array");
    }
    if (body.assignments.length > 1_000) {
      throw new CasHttpError(400, "assignments exceeds the limit of 1000");
    }

    const assignments = body.assignments.map((assignment) => {
      if (!assignment || typeof assignment !== "object") {
        throw new CasHttpError(400, "Invalid root assignment");
      }
      validateRootOwner(assignment.owner);
      if (assignment.hash !== null) {
        try {
          validateHash(assignment.hash);
        } catch (err) {
          throw new CasHttpError(400, err instanceof Error ? err.message : String(err));
        }
      }
      return { owner: assignment.owner, hash: assignment.hash };
    }).sort((left, right) => left.owner.localeCompare(right.owner));

    for (let index = 1; index < assignments.length; index++) {
      if (assignments[index - 1].owner === assignments[index].owner) {
        throw new CasHttpError(400, `Duplicate root owner: ${assignments[index].owner}`);
      }
    }

    const payloadHash = await hashJson({ kind: "assignRoots", assignments });
    const db = this.env.CAS_DB;
    const existingRequest = await db
      .prepare("SELECT payload_hash FROM cas_root_ref_requests WHERE tenant_id = ? AND request_id = ?")
      .bind(tenantId, body.requestId)
      .first<{ payload_hash: string }>();

    if (existingRequest) {
      if (existingRequest.payload_hash !== payloadHash) {
        throw new CasHttpError(409, "Conflicting request ID");
      }
      return Response.json({ success: true, idempotent: true });
    }

    const changes = new Map<string, number>();
    const priorByOwner = new Map<string, string | null>();

    for (const assignment of assignments) {
      const prior = await db
        .prepare("SELECT hash FROM cas_root_owners WHERE tenant_id = ? AND owner = ?")
        .bind(tenantId, assignment.owner)
        .first<{ hash: string }>();
      const priorHash = prior?.hash ?? null;
      priorByOwner.set(assignment.owner, priorHash);

      if (priorHash === assignment.hash) continue;
      if (priorHash !== null) addCount(changes, priorHash, -1);
      if (assignment.hash !== null) {
        const node = await db
          .prepare("SELECT root_ref_count FROM cas_nodes WHERE tenant_id = ? AND hash = ?")
          .bind(tenantId, assignment.hash)
          .first<{ root_ref_count: number }>();
        if (!node) throw new CasHttpError(404, `Node ${assignment.hash} not found`);
        const ready = await this.ensureR2Object(tenantId, assignment.hash);
        if (!ready) throw new CasHttpError(409, `Node ${assignment.hash} is not ready`);
        addCount(changes, assignment.hash, 1);
      }
    }

    for (const [hash, delta] of changes) {
      if (delta === 0) continue;
      const node = await db
        .prepare("SELECT root_ref_count FROM cas_nodes WHERE tenant_id = ? AND hash = ?")
        .bind(tenantId, hash)
        .first<{ root_ref_count: number }>();
      if (!node) throw new CasHttpError(409, `Assigned node ${hash} is missing`);
      const nextCount = node.root_ref_count + delta;
      if (!Number.isSafeInteger(nextCount) || nextCount < 0) {
        throw new CasHttpError(409, `Root ref count would be invalid for ${hash}`);
      }
    }

    const batch: D1PreparedStatement[] = [];
    for (const [hash, delta] of changes) {
      if (delta === 0) continue;
      batch.push(
        db.prepare(
          "UPDATE cas_nodes SET root_ref_count = root_ref_count + ? WHERE tenant_id = ? AND hash = ?",
        ).bind(delta, tenantId, hash),
      );
    }
    for (const assignment of assignments) {
      const priorHash = priorByOwner.get(assignment.owner) ?? null;
      if (priorHash === assignment.hash) continue;
      if (assignment.hash === null) {
        batch.push(
          db.prepare("DELETE FROM cas_root_owners WHERE tenant_id = ? AND owner = ?")
            .bind(tenantId, assignment.owner),
        );
      } else if (priorHash === null) {
        batch.push(
          db.prepare("INSERT INTO cas_root_owners (tenant_id, owner, hash) VALUES (?, ?, ?)")
            .bind(tenantId, assignment.owner, assignment.hash),
        );
      } else {
        batch.push(
          db.prepare("UPDATE cas_root_owners SET hash = ? WHERE tenant_id = ? AND owner = ?")
            .bind(assignment.hash, tenantId, assignment.owner),
        );
      }
    }
    batch.push(
      db.prepare(
        "INSERT INTO cas_root_ref_requests (tenant_id, request_id, payload_hash, applied_at) VALUES (?, ?, ?, ?)",
      ).bind(tenantId, body.requestId, payloadHash, Date.now()),
    );
    await db.batch(batch);

    return Response.json({ success: true, idempotent: false });
  }

  // ─── Usage ────────────────────────────────────────────────

  private async handleUsage(tenantId: string): Promise<Response> {
    const db = this.env.CAS_DB;

    const stats = await db
      .prepare(
        `SELECT
          COUNT(*) as nodeCount,
          COALESCE(SUM(content_size), 0) as readyContentBytes,
          COUNT(CASE WHEN lease_expires_at > 0 THEN 1 END) as leasedNodeCount
          FROM cas_nodes WHERE tenant_id = ?`,
      )
        .bind(tenantId)
      .first<{ nodeCount: number; readyContentBytes: number; leasedNodeCount: number }>();

    // Count not-ready nodes (no R2 content)
    const allNodes = await db
      .prepare("SELECT hash FROM cas_nodes WHERE tenant_id = ?")
      .bind(tenantId)
      .all<{ hash: string }>();

    let notReadyCount = 0;
    for (const node of allNodes.results) {
      const r2Obj = await this.ensureR2Object(tenantId, node.hash);
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

  private async handleGc(request: Request, tenantId: string): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { maxNodes?: number };
    const maxNodes = body.maxNodes ?? 100;

    const db = this.env.CAS_DB;
    const now = Date.now();

    // Find eligible nodes
    const eligible = await db
      .prepare(
        `SELECT hash, content_size FROM cas_nodes
         WHERE tenant_id = ?
           AND child_ref_count = 0
           AND root_ref_count = 0
           AND lease_expires_at <= ?
         LIMIT ?`,
      )
      .bind(tenantId, now, maxNodes)
      .all<{ hash: string; content_size: number }>();

    let deleted = 0;
    let reclaimedBytes = 0;

    for (const node of eligible.results) {
      // Re-check eligibility
      const fresh = await db
        .prepare(
          "SELECT child_ref_count, root_ref_count, lease_expires_at FROM cas_nodes WHERE tenant_id = ? AND hash = ?",
        )
        .bind(tenantId, node.hash)
        .first<{ child_ref_count: number; root_ref_count: number; lease_expires_at: number }>();

      if (!fresh || fresh.child_ref_count > 0 || fresh.root_ref_count > 0 || fresh.lease_expires_at > now) {
        continue;
      }

      // Delete R2 content
      await Promise.all([
        this.env.CAS_R2.delete(this.r2Key(tenantId, node.hash)),
        this.env.CAS_R2.delete(this.legacyR2Key(tenantId, node.hash)),
      ]);

      // Delete edges and decrement child ref counts
      const edges = await db
        .prepare("SELECT child_hash, COUNT(*) as cnt FROM cas_edges WHERE tenant_id = ? AND parent_hash = ? GROUP BY child_hash")
        .bind(tenantId, node.hash)
        .all<{ child_hash: string; cnt: number }>();

      const batch: D1PreparedStatement[] = [
        db.prepare("DELETE FROM cas_edges WHERE tenant_id = ? AND parent_hash = ?")
          .bind(tenantId, node.hash),
        db.prepare("DELETE FROM cas_nodes WHERE tenant_id = ? AND hash = ?")
          .bind(tenantId, node.hash),
      ];

      for (const edge of edges.results) {
        batch.push(
          db.prepare(
            "UPDATE cas_nodes SET child_ref_count = child_ref_count - ? WHERE tenant_id = ? AND hash = ?",
          ).bind(edge.cnt, tenantId, edge.child_hash),
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

function parseDurationMs(header: string | null): number {
  if (header == null || header === "") return DEFAULT_LEASE_MS;
  const n = Number(header);
  if (!Number.isFinite(n)) {
    throw new CasHttpError(400, "Invalid lease duration");
  }
  return clamp(n, MIN_LEASE_MS, MAX_LEASE_MS);
}

function parseRefsHeader(header: string | null): string[] {
  if (!header || header.trim() === "") return [];
  const refs = header.split(",").map((s) => s.trim()).filter(Boolean);
  for (const ref of refs) {
    validateHash(ref);
  }
  return refs;
}

function metadataMatches(
  existing: { content_size: number; content_type: string },
  existingRefs: string[],
  descriptor: CasNodeDescriptor,
): boolean {
  return existing.content_size === descriptor.size
    && existing.content_type === descriptor.contentType
    && existingRefs.length === descriptor.refs.length
    && existingRefs.every((ref, i) => ref === descriptor.refs[i]);
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // Body may already be consumed or locked.
  }
}

function addCount(changes: Map<string, number>, hash: string, delta: number): void {
  changes.set(hash, (changes.get(hash) ?? 0) + delta);
}

function validateRequestId(requestId: unknown): asserts requestId is string {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 512) {
    throw new CasHttpError(400, "requestId must contain 1-512 characters");
  }
}

function validateRootOwner(owner: unknown): asserts owner is string {
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 512) {
    throw new CasHttpError(400, "root owner must contain 1-512 characters");
  }
  if (!/^[\x20-\x7e]+$/.test(owner)) {
    throw new CasHttpError(400, "root owner must contain printable ASCII only");
  }
}

async function hashJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return hashToHex(new Uint8Array(digest));
}
