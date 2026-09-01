/**
 * Root Ref domain Durable Object — the single writer for one
 * `(stackId, refDomain)` event log.
 *
 * Serializes writes from different tenants in the same domain and executes the
 * atomic D1 transaction (idempotency, revision allocation, aggregate updates,
 * event append, projection update, idempotency insert). Receives ONLY the
 * canonical command forwarded by a tenant DO; never accepts identity headers
 * from an external caller. Domain DOs never call tenant DOs, so lock ordering
 * cannot cycle.
 */

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { canonicalizeRootRefsUpdate, executeDomainUpdate, withDomainRetry } from "./root-refs.js";
import { RootRefsErrorCodes, RootRefsValidationError } from "./root-refs.js";

export interface RootRefDomainDoEnv {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  /** Test/ops override for the retry attempt bound. */
  CAS_RETRY_MAX_ATTEMPTS?: string;
}

export class RootRefDomainDurableObject {
  readonly #env: RootRefDomainDoEnv;

  constructor(_state: DurableObjectState, env: RootRefDomainDoEnv) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    let stackId: string;
    let tenantId: string;
    let refDomain: string;
    let body: { requestId?: unknown; changes?: unknown };
    try {
      stackId = requireHeader(request, "X-CAS-Stack-Id");
      tenantId = requireHeader(request, "X-CAS-Tenant-Id");
      refDomain = requireHeader(request, "X-CAS-Ref-Domain");
      body = (await request.json()) as { requestId?: unknown; changes?: unknown };
    } catch (error) {
      if (error instanceof RootRefsValidationError) {
        return errorResponse(error.status, error.code, error.message);
      }
      return errorResponse(400, RootRefsErrorCodes.INVALID_REQUEST, "domain command body is not valid JSON");
    }
    try {
      const canonical = await canonicalizeRootRefsUpdate({
        requestId: body.requestId,
        changes: body.changes,
        refDomain,
      });
      const result = await withDomainRetry(
        () => executeDomainUpdate({
          db: this.#env.CAS_DB,
          bucket: this.#env.CAS_R2,
          stackId,
          tenantId,
          refDomain,
          canonical,
        }),
        { maxAttempts: parseMaxAttempts(this.#env.CAS_RETRY_MAX_ATTEMPTS) },
      );
      return Response.json({ success: true, idempotent: result.idempotent, revision: result.revision });
    } catch (error) {
      if (error instanceof RootRefsValidationError) {
        return errorResponse(error.status, error.code, error.message);
      }
      return errorResponse(503, RootRefsErrorCodes.BUSY, "root refs update failed");
    }
  }
}

function requireHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value || value.length === 0) {
    throw new RootRefsValidationError(400, RootRefsErrorCodes.INVALID_REQUEST, `missing ${name}`);
  }
  return value;
}

function parseMaxAttempts(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}
