import { hashToHex, parseNodeBytes, sha256 } from "@unicas/codec";
import { CasUploadIdHeader, CasUploadLengthHeader, matchCasRoute } from "@unicas/tenant-protocol";
import type { CasRootRefUpdate } from "@unicas/tenant-protocol";
import type { HttpFetcher } from "../src/index.js";

interface StoredNode {
  readonly canonical: Uint8Array;
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly refs: readonly string[];
  leaseStartedAt: number;
  leaseExpiresAt: number;
}

export class MockCasService implements HttpFetcher {
  readonly nodes = new Map<string, StoredNode>();
  readonly tokens: string[] = [];
  readonly rootRefUpdates: CasRootRefUpdate[] = [];
  gcCalls: { maxNodes?: number }[] = [];
  readonly directUploads = new Map<string, Uint8Array>();
  readonly uploadSessions = new Map<string, { uploadId: string; canonical?: Uint8Array }>();

  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://r2.test") return this.#upload(url.pathname.slice(1), request);
    this.tokens.push(request.headers.get("Authorization") ?? "");
    const route = matchCasRoute(request.method, url.pathname);
    if (route === null) return Response.json({ error: "NOT_FOUND" }, { status: 404, statusText: "Not Found" });

    switch (route.operation) {
      case "readContent":
        return this.#readContent(route.hash, request.headers.get("Range"));
      case "readMetadata":
        return this.#readMetadata(route.hash);
      case "lease":
        return this.#lease(route.hash, request);
      case "updateRootRefs": {
        this.rootRefUpdates.push(await request.json() as CasRootRefUpdate);
        return Response.json({ success: true, idempotent: false, revision: this.rootRefUpdates.length });
      }
      case "usage":
        return Response.json({
          nodeCount: this.nodes.size,
          readyContentBytes: [...this.nodes.values()].reduce((total, node) => total + node.content.length, 0),
          readyStoredBytes: [...this.nodes.values()].reduce((total, node) => total + node.canonical.length, 0),
          reservedBytes: 0,
          notReadyNodeCount: 0,
          leasedNodeCount: this.nodes.size,
        });
      case "gc": {
        const options = request.body === null ? {} : await request.json() as { maxNodes?: number };
        this.gcCalls.push(options);
        return Response.json({ examined: this.nodes.size, deleted: 0, reclaimedContentBytes: 0 });
      }
      default:
        return Response.json({ error: "NOT_IMPLEMENTED" }, { status: 501 });
    }
  }

  #readContent(hash: string, rangeHeader: string | null): Response {
    const node = this.nodes.get(hash);
    if (node === undefined) return Response.json({ error: "NODE_NOT_FOUND" }, { status: 404, statusText: "Not Found" });
    if (rangeHeader === null) return new Response(Uint8Array.from(node.content).buffer);
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (match === null) return Response.json({ error: "INVALID_RANGE" }, { status: 416, statusText: "Range Not Satisfiable" });
    const start = Number(match[1]);
    const end = match[2] === "" ? node.content.length : Number(match[2]) + 1;
    return new Response(Uint8Array.from(node.content.slice(start, end)).buffer, { status: 206 });
  }

  #readMetadata(hash: string): Response {
    const node = this.nodes.get(hash);
    if (node === undefined) return Response.json({ error: "NODE_NOT_FOUND" }, { status: 404, statusText: "Not Found" });
    return Response.json({
      metadata: {
        hash,
        size: node.content.length,
        contentType: node.contentType,
        refs: node.refs,
      },
    });
  }

  async #lease(hash: string, request: Request): Promise<Response> {
    const now = Date.now();
    const existing = this.nodes.get(hash);
    const uploadLength = request.headers.get(CasUploadLengthHeader);
    const uploadId = request.headers.get(CasUploadIdHeader);
    if (uploadLength !== null) {
      if (existing !== undefined) {
        return Response.json({ hash, ready: true, leaseStartedAt: existing.leaseStartedAt, leaseExpiresAt: existing.leaseExpiresAt });
      }
      const session = this.uploadSessions.get(hash) ?? { uploadId: `upload-${this.uploadSessions.size + 1}` };
      this.uploadSessions.set(hash, session);
      return Response.json({
        hash,
        ready: false,
        status: "upload_required",
        uploadId: session.uploadId,
        expiresAt: now + 60_000,
        upload: {
          method: "PUT",
          url: `https://r2.test/${session.uploadId}`,
          headers: {
            "Content-Length": uploadLength,
            "Content-Type": "application/vnd.unidocs.cas-node.v1",
            "If-None-Match": "*",
          },
        },
      });
    }
    if (uploadId !== null) {
      if (existing !== undefined) {
        return Response.json({ hash, ready: true, leaseStartedAt: existing.leaseStartedAt, leaseExpiresAt: existing.leaseExpiresAt });
      }
      const session = this.uploadSessions.get(hash);
      const canonical = session === undefined ? undefined : this.directUploads.get(session.uploadId);
      if (session?.uploadId !== uploadId || canonical === undefined) {
        return Response.json({ error: "CAS_UPLOAD_INCOMPLETE" }, { status: 412, statusText: "Precondition Failed" });
      }
      return this.#storeCanonical(hash, canonical, now);
    }
    if (request.body === null) {
      if (existing === undefined) return Response.json({ error: "NODE_NOT_FOUND" }, { status: 404, statusText: "Not Found" });
      existing.leaseExpiresAt = now + 60_000;
      return Response.json({ hash, ready: true, leaseStartedAt: existing.leaseStartedAt, leaseExpiresAt: existing.leaseExpiresAt });
    }

    return this.#storeCanonical(hash, new Uint8Array(await request.arrayBuffer()), now);
  }

  async #upload(uploadId: string, request: Request): Promise<Response> {
    if (request.method !== "PUT") return new Response(null, { status: 405 });
    if (this.directUploads.has(uploadId)) return new Response(null, { status: 412, statusText: "Precondition Failed" });
    this.directUploads.set(uploadId, new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  }

  async #storeCanonical(hash: string, canonical: Uint8Array, now: number): Promise<Response> {
    const existing = this.nodes.get(hash);
    if (hashToHex(await sha256(canonical)) !== hash) {
      return Response.json({ error: "DIGEST_MISMATCH" }, { status: 400, statusText: "Bad Request" });
    }
    const parsed = parseNodeBytes(canonical);
    const stored: StoredNode = {
      canonical,
      content: parsed.content,
      contentType: parsed.contentType,
      refs: parsed.childHashes.map(hashToHex),
      leaseStartedAt: existing?.leaseStartedAt ?? now,
      leaseExpiresAt: now + 60_000,
    };
    this.nodes.set(hash, stored);
    this.uploadSessions.delete(hash);
    return Response.json({
      hash,
      ready: true,
      leaseStartedAt: stored.leaseStartedAt,
      leaseExpiresAt: stored.leaseExpiresAt,
    });
  }
}
