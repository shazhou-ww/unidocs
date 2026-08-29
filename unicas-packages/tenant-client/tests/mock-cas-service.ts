import { hashToHex, parseNodeBytes, sha256 } from "@unicas/tenant-protocol";
import { matchCasRoute } from "@unicas/tenant-protocol";
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

  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    this.tokens.push(request.headers.get("Authorization") ?? "");
    const url = new URL(request.url);
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
    if (request.body === null) {
      if (existing === undefined) return Response.json({ error: "NODE_NOT_FOUND" }, { status: 404, statusText: "Not Found" });
      existing.leaseExpiresAt = now + 60_000;
      return Response.json({ hash, ready: true, leaseStartedAt: existing.leaseStartedAt, leaseExpiresAt: existing.leaseExpiresAt });
    }

    const canonical = new Uint8Array(await request.arrayBuffer());
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
    return Response.json({
      hash,
      ready: true,
      leaseStartedAt: stored.leaseStartedAt,
      leaseExpiresAt: stored.leaseExpiresAt,
    });
  }
}
