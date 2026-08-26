/**
 * Tenant CAS Durable Object — per-`(stackId, tenantId)` command queue.
 *
 * All commands for one tenant are serialized here (single-threaded DO): a
 * second Root Ref command, GC, or lease for the same tenant cannot race an
 * in-flight update. Root Refs commands are canonicalized and forwarded ONE
 * way to the `(stackId, refDomain)` domain DO; the domain DO never calls back,
 * so lock ordering cannot cycle. The other tenant node operations (read,
 * lease, usage, GC) land as storage dispatch in the follow-on tasks; they
 * return 501 here.
 */

import type { D1Database, R2Bucket, DurableObjectNamespace } from "@cloudflare/workers-types";
import { canonicalComposite } from "./do-names.js";
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

    if (url.pathname === "/updateRootRefs" && request.method === "POST") {
      return this.#forwardRootRefs(request, stackId, tenantId);
    }
    return Response.json(
      { error: "SERVICE_UNAVAILABLE", message: "tenant CAS operation not implemented yet" },
      { status: 501 },
    );
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

function requireHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value || value.length === 0) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `missing ${name}`);
  }
  return value;
}
