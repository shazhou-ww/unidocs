/**
 * Tenant CAS Durable Object — per-`(stackId, tenantId)` command queue.
 *
 * All commands for one tenant are serialized here (single-threaded DO): a
 * Root Ref command, GC, or lease for the same tenant cannot race an in-flight
 * update. Root Refs commands are canonicalized and forwarded ONE way to the
 * `(stackId, refDomain)` domain DO; the domain DO never calls back, so lock
 * ordering cannot cycle. Node storage operations (lease, read, metadata,
 * usage, GC) run here against the stack-scoped stores, so a lease claim can
 * never race a GC deletion decision.
 */

import { CanonicalNodeContentType } from "@unicas/server-common";
import type { D1Database, R2Bucket, DurableObjectNamespace } from "@cloudflare/workers-types";
import { canonicalComposite } from "./do-names.js";
import {
  DEFAULT_GC_MAX_NODES,
  NodeOpError,
  NodeOpErrorCodes,
  leaseExisting,
  leaseCanonicalNode,
  leaseNode,
  parseLeaseDuration,
  parseRefsHeader,
  readContent,
  readMetadata,
  triggerGc,
  usage,
} from "./nodes.js";
import { canonicalizeRootRefsUpdate, parseRootRefsBody } from "./root-refs.js";
import { RootRefsErrorCodes, RootRefsValidationError } from "./root-refs.js";

export interface TenantCasDoEnv {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  /** Root Ref domain DO namespace (one-way calls only). */
  CAS_DOMAIN_DO: DurableObjectNamespace;
}

export class CasDurableObject {
  readonly #env: TenantCasDoEnv;

  constructor(_state: DurableObjectState, env: TenantCasDoEnv) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const stackId = requireHeader(request, "X-CAS-Stack-Id");
    const tenantId = requireHeader(request, "X-CAS-Tenant-Id");
    const store = {
      db: this.#env.CAS_DB,
      bucket: this.#env.CAS_R2,
      stackId,
      tenantId,
    };

    try {
      if (url.pathname === "/updateRootRefs" && request.method === "POST") {
        return await this.#forwardRootRefs(request, stackId, tenantId);
      }
      if (url.pathname === "/leaseNode" && request.method === "POST") {
        return jsonResponse(await this.#handleLeaseNode(request, store));
      }
      if ((url.pathname === "/lease" || url.pathname === "/leaseExisting") && request.method === "POST") {
        return jsonResponse(await this.#handleLease(request, store));
      }
      if (url.pathname === "/read" && request.method === "GET") {
        return await this.#handleRead(request, store);
      }
      if (url.pathname === "/metadata" && request.method === "GET") {
        return await this.#handleMetadata(request, store);
      }
      if (url.pathname === "/usage" && request.method === "GET") {
        return jsonResponse(await usage(store));
      }
      if (url.pathname === "/gc" && request.method === "POST") {
        return jsonResponse(await this.#handleGc(request, store));
      }
      return Response.json(
        { error: "SERVICE_UNAVAILABLE", message: "tenant CAS operation not implemented yet" },
        { status: 501 },
      );
    } catch (error) {
      if (error instanceof NodeOpError) {
        return Response.json(
          { error: error.code, message: error.message },
          { status: error.status, headers: error.headers },
        );
      }
      return Response.json(
        { error: RootRefsErrorCodes.INVALID_REQUEST, message: "tenant CAS operation failed" },
        { status: 400 },
      );
    }
  }

  // ─── Node storage operations ──────────────────────────────

  async #handleLeaseNode(request: Request, store: Parameters<typeof leaseNode>[0]): Promise<unknown> {
    const hash = requireHeader(request, "X-CAS-Hash");
    const contentType = request.headers.get("Content-Type") ?? "";
    const content = new Uint8Array(await request.arrayBuffer());
    return leaseNode(store, {
      hash,
      contentType,
      contentLength: content.length,
      refs: parseRefsHeader(request.headers.get("X-CAS-Refs")),
      leaseDurationMs: parseLeaseDuration(request.headers.get("X-CAS-Lease-Duration")),
      content,
    });
  }

  async #handleLease(request: Request, store: Parameters<typeof leaseExisting>[0]): Promise<unknown> {
    const hash = requireHeader(request, "X-CAS-Hash");
    const leaseDurationMs = parseLeaseDuration(request.headers.get("X-CAS-Lease-Duration"));
    if (request.body !== null) {
      if (request.headers.get("Content-Type") !== CanonicalNodeContentType) {
        throw new NodeOpError(415, NodeOpErrorCodes.INVALID_REQUEST, `Content-Type must be ${CanonicalNodeContentType}`);
      }
      const lengthHeader = request.headers.get("Content-Length");
      const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "Invalid Content-Length");
      }
      return leaseCanonicalNode(store, {
        hash,
        leaseDurationMs,
        body: request.body,
        declaredLength,
      });
    }
    return leaseExisting(store, {
      hash,
      leaseDurationMs,
    });
  }

  async #handleRead(request: Request, store: Parameters<typeof readContent>[0]): Promise<Response> {
    const hash = requireHeader(request, "X-CAS-Hash");
    const content = await readContent(store, hash, request.headers.get("Range"));
    if (content === null) {
      return Response.json({ error: NodeOpErrorCodes.NOT_FOUND, message: `Node ${hash} not found or not ready` }, { status: 404 });
    }
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Content-Length": String(content.range === undefined
        ? content.contentSize
        : content.range.end - content.range.start + 1),
      "Content-Type": content.contentType,
    });
    if (content.range !== undefined) {
      headers.set("Content-Range", `bytes ${content.range.start}-${content.range.end}/${content.contentSize}`);
    }
    return new Response(content.body, {
      status: content.range === undefined ? 200 : 206,
      headers,
    });
  }

  async #handleMetadata(request: Request, store: Parameters<typeof readMetadata>[0]): Promise<Response> {
    const hash = requireHeader(request, "X-CAS-Hash");
    const result = await readMetadata(store, hash);
    if (result === null) {
      return Response.json({ error: NodeOpErrorCodes.NOT_FOUND, message: `Node ${hash} not found` }, { status: 404 });
    }
    return jsonResponse(result);
  }

  async #handleGc(request: Request, store: Parameters<typeof triggerGc>[0]): Promise<unknown> {
    const body = await request.json().catch(() => null) as { maxNodes?: number } | null;
    const maxNodes = body?.maxNodes ?? DEFAULT_GC_MAX_NODES;
    if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
      throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "maxNodes must be a positive integer");
    }
    return triggerGc(store, maxNodes);
  }

  /** Canonicalize the caller update and forward one command to the domain DO. */
  async #forwardRootRefs(
    request: Request,
    stackId: string,
    tenantId: string,
  ): Promise<Response> {
    let refDomain: string;
    let canonical;
    try {
      refDomain = requireHeader(request, "X-CAS-Ref-Domain");
      const text = await request.text();
      const parsed = parseRootRefsBody(text);
      canonical = await canonicalizeRootRefsUpdate({ ...parsed, refDomain });
    } catch (error) {
      if (error instanceof RootRefsValidationError) {
        return Response.json({ error: error.code, message: error.message }, { status: error.status });
      }
      return Response.json(
        { error: RootRefsErrorCodes.INVALID_REQUEST, message: "root refs update is invalid" },
        { status: 400 },
      );
    }
    const domainId = this.#env.CAS_DOMAIN_DO.idFromName(canonicalComposite(stackId, refDomain));
    const stub = this.#env.CAS_DOMAIN_DO.get(domainId);
    const response = await stub.fetch("https://domain.internal/update", {
      method: "POST",
      headers: {
        "X-CAS-Stack-Id": stackId,
        "X-CAS-Tenant-Id": tenantId,
        "X-CAS-Ref-Domain": refDomain,
      },
      body: JSON.stringify({
        requestId: canonical.requestId,
        changes: Object.fromEntries(canonical.entries),
      }),
    });
    // Pass the domain DO's response through. The workers-types/DOM global
    // Response types disagree structurally; the runtime value is the same.
    return response as unknown as Response;
  }
}

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}

function requireHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value || value.length === 0) {
    throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, `missing ${name}`);
  }
  return value;
}
