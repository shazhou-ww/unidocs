/**
 * Canonical stack-scoped CAS tenant server (Cloudflare Workers).
 *
 * Task 4: full stack authorization — resolves the verified issuer to its
 * stack authority (read-only CAS_CONTROL_DB repository), enforces
 * issuer-derived stack equality, token tenant equality, the exact operation
 * permission matrix, and a valid issuer-signed refDomain for Root Refs writes,
 * with a 30s cache / 60s hard stale bound / fail-closed policy and a static
 * legacy-stack bootstrap. `sub` is an opaque audit identity.
 *
 * Storage/DO dispatch lands in Tasks 5-6; authorized handlers return 501
 * until then. The legacy tenant-scoped runtime has been retired (its frozen
 * protocol lives on in `@unicas/protocol-legacy`).
 */

import { AuthorityRepository } from "@unicas/control-plane";
import { matchCasRoute } from "@unicas/protocol";
import { CasLeaseDurationHeader, CasRefsHeader } from "@unicas/protocol";
import type { CasRoute } from "@unicas/protocol";
import {
  CapabilityError,
} from "@unidocs/service-auth";
import { StackCapabilityVerifier } from "./auth.js";
import type { StackAuthEvent, StaticLegacyStackConfig, VerifiedStackCall } from "./auth.js";
import { AuditReadError, listRootDomainEvents, listRootDomainRefs, listRootDomains } from "./audit-reads.js";
import { canonicalComposite } from "./do-names.js";
import { migrateStackTenantSchema } from "./schema.js";

export { CasDurableObject } from "./tenant-do.js";
export { RootRefDomainDurableObject } from "./domain-do.js";

export interface Env {
  /** Read-only tenant authority registry (issuer → stack and keys). */
  CAS_CONTROL_DB: D1Database;
  /** Tenant-scoped node/audit storage; migrated by this worker at startup. */
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  CAS_DO: DurableObjectNamespace;
  /** Root Ref domain DO namespace (tenant DO calls it one-way). */
  CAS_DOMAIN_DO: DurableObjectNamespace;
  /** Shared secret for the private audit-reader RPC (admin BFF ↔ this worker). */
  CAS_AUDIT_READER_KEY?: string;
  /** Static legacy-stack bootstrap (migration window; registry wins). */
  LEGACY_STACK_ID?: string;
  LEGACY_STACK_ISSUER?: string;
  LEGACY_STACK_AUDIENCE?: string;
  LEGACY_STACK_ALGORITHM?: string;
  /** JSON JWKS for the static legacy stack. */
  LEGACY_STACK_JWKS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Provision the stack-scoped tenant schema on first request (idempotent).
    await migrateStackTenantSchema(env.CAS_DB);
    const url = new URL(request.url);
    // Private readiness probe (unreachable through cas-edge: not under
    // /stacks or /admin). Never forwarded to tenant storage.
    if (request.method === "GET" && url.pathname === "/_internal/health") {
      return Response.json({ ok: true, service: "unidocs-cas" });
    }
    // Narrow private audit-reader RPC for the admin BFF (never an HTTP route;
    // cas-edge only dispatches /stacks and /admin, so this is unreachable
    // from the public front door).
    if (
      url.pathname === "/_internal/audit/domains"
      || url.pathname === "/_internal/audit/refs"
      || url.pathname === "/_internal/audit/events"
    ) {
      return handleAuditRpc(request, env, url);
    }
    const route = matchCasRoute(request.method, url.pathname);
    if (!route) {
      return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
    }
    const verifier = verifierFor(env);
    let call;
    try {
      call = await verifier.verify(request, route);
    } catch (error) {
      return authErrorResponse(error);
    }
    if (route.operation === "updateRootRefs") {
      return dispatchUpdateRootRefs(request, env, call);
    }
    return dispatchNodeOperation(request, env, route, call);
  },
};

/** Private audit-reader RPC. Requires the shared reader key; fail closed. */
async function handleAuditRpc(request: Request, env: Env, url: URL): Promise<Response> {
  const expectedKey = env.CAS_AUDIT_READER_KEY;
  if (!expectedKey || request.headers.get("X-CAS-Audit-Reader-Key") !== expectedKey) {
    return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const stackId = url.searchParams.get("stackId") ?? "";
  const refDomain = url.searchParams.get("refDomain") ?? "";
  try {
    if (url.pathname === "/_internal/audit/domains") {
      const domains = await listRootDomains({ db: env.CAS_DB, stackId });
      return Response.json({ domains }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/_internal/audit/refs") {
      const page = await listRootDomainRefs({
        db: env.CAS_DB,
        stackId,
        refDomain,
        tenantId: url.searchParams.get("tenantId") ?? undefined,
        limit: optionalNumber(url.searchParams.get("limit")),
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return Response.json({ revision: page.revision, refs: page.refs, nextCursor: page.nextCursor }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const page = await listRootDomainEvents({
      db: env.CAS_DB,
      stackId,
      refDomain,
      tenantId: url.searchParams.get("tenantId") ?? undefined,
      after: optionalNumber(url.searchParams.get("after")),
      limit: optionalNumber(url.searchParams.get("limit")),
    });
    return Response.json({ events: page.events, latestRevision: page.latestRevision, nextAfter: page.nextAfter }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AuditReadError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: "SERVICE_UNAVAILABLE", message: "audit read failed" }, { status: 503 });
  }
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Forward the verified Root Refs write to the tenant DO for this
 * (stackId, tenantId). The DO request is built fresh from the VERIFIED
 * context — caller headers, body metadata, and any caller-supplied
 * stack/tenant/domain are never forwarded.
 */
async function dispatchUpdateRootRefs(
  request: Request,
  env: Env,
  call: VerifiedStackCall,
): Promise<Response> {
  if (call.refDomain === undefined) {
    return Response.json(
      { error: "ROOT_REF_INVALID", message: "Root Refs write requires a verified refDomain" },
      { status: 403 },
    );
  }
  const doId = env.CAS_DO.idFromName(canonicalComposite(call.stackId, call.tenantId));
  const stub = env.CAS_DO.get(doId);
  const body = await request.text();
  return stub.fetch("https://tenant.internal/updateRootRefs", {
    method: "POST",
    headers: {
      "X-CAS-Stack-Id": call.stackId,
      "X-CAS-Tenant-Id": call.tenantId,
      "X-CAS-Ref-Domain": call.refDomain,
    },
    body,
  });
}

/**
 * Forward a verified node operation to the tenant DO for this
 * (stackId, tenantId). The DO request is built fresh from the VERIFIED
 * context — stack/tenant identity always comes from the verified call, never
 * from caller headers. Only content-metadata headers (Content-Type, child
 * refs, lease duration) and the content body are copied through.
 */
async function dispatchNodeOperation(
  request: Request,
  env: Env,
  route: CasRoute,
  call: VerifiedStackCall,
): Promise<Response> {
  const doId = env.CAS_DO.idFromName(canonicalComposite(call.stackId, call.tenantId));
  const stub = env.CAS_DO.get(doId);
  const headers: Record<string, string> = {
    "X-CAS-Stack-Id": call.stackId,
    "X-CAS-Tenant-Id": call.tenantId,
  };
  let doPath = "";
  let method = "GET";
  let body: BodyInit | null | undefined;
  switch (route.operation) {
    case "readContent":
      doPath = "/read";
      headers["X-CAS-Hash"] = route.hash;
      const range = request.headers.get("Range");
      if (range) headers.Range = range;
      break;
    case "readMetadata":
      doPath = "/metadata";
      headers["X-CAS-Hash"] = route.hash;
      break;
    case "leaseNode":
      doPath = "/leaseNode";
      method = "POST";
      headers["X-CAS-Hash"] = route.hash;
      const contentType = request.headers.get("Content-Type");
      if (contentType) headers["Content-Type"] = contentType;
      const refs = request.headers.get(CasRefsHeader);
      if (refs) headers[CasRefsHeader] = refs;
      const leaseDuration = request.headers.get(CasLeaseDurationHeader);
      if (leaseDuration) headers[CasLeaseDurationHeader] = leaseDuration;
      const legacyLength = request.headers.get("Content-Length");
      if (legacyLength) headers["Content-Length"] = legacyLength;
      body = request.body;
      break;
    case "leaseExisting":
      doPath = "/lease";
      method = "POST";
      headers["X-CAS-Hash"] = route.hash;
      const existingDuration = request.headers.get(CasLeaseDurationHeader);
      if (existingDuration) headers[CasLeaseDurationHeader] = existingDuration;
      const canonicalType = request.headers.get("Content-Type");
      if (canonicalType) headers["Content-Type"] = canonicalType;
      const canonicalLength = request.headers.get("Content-Length");
      if (canonicalLength) headers["Content-Length"] = canonicalLength;
      body = request.body;
      break;
    case "usage":
      doPath = "/usage";
      break;
    case "gc":
      doPath = "/gc";
      method = "POST";
      body = request.body;
      break;
    default:
      return Response.json(
        { error: "SERVICE_UNAVAILABLE", message: `CAS ${route.operation} is not implemented yet` },
        { status: 501 },
      );
  }
  return stub.fetch(`https://tenant.internal${doPath}`, {
    method,
    headers,
    ...(body === null || body === undefined ? {} : { body }),
  });
}

const verifiers = new WeakMap<object, StackCapabilityVerifier>();

function verifierFor(env: Env): StackCapabilityVerifier {
  const key = env as object;
  let verifier = verifiers.get(key);
  if (!verifier) {
    verifier = new StackCapabilityVerifier({
      repository: new AuthorityRepository(env.CAS_CONTROL_DB),
      ...staticLegacyConfig(env),
      onEvent: (event: StackAuthEvent) => {
        console.log(JSON.stringify({ event: "cas_stack_authorization", ...event }));
      },
    });
    verifiers.set(key, verifier);
  }
  return verifier;
}

function staticLegacyConfig(env: Env): { staticLegacyStack?: StaticLegacyStackConfig } {
  const { LEGACY_STACK_ID, LEGACY_STACK_ISSUER, LEGACY_STACK_AUDIENCE, LEGACY_STACK_ALGORITHM, LEGACY_STACK_JWKS } = env;
  if (!LEGACY_STACK_ID || !LEGACY_STACK_ISSUER || !LEGACY_STACK_AUDIENCE || !LEGACY_STACK_ALGORITHM || !LEGACY_STACK_JWKS) {
    return {};
  }
  let jwks: unknown;
  try {
    jwks = JSON.parse(LEGACY_STACK_JWKS);
  } catch {
    throw new TypeError("LEGACY_STACK_JWKS must be valid JSON");
  }
  if (
    typeof jwks !== "object" || jwks === null
    || !Array.isArray((jwks as { keys?: unknown }).keys)
    || (jwks as { keys: unknown[] }).keys.length === 0
  ) {
    throw new TypeError("LEGACY_STACK_JWKS must be a JWKS object with keys");
  }
  return {
    staticLegacyStack: {
      stackId: LEGACY_STACK_ID,
      issuer: LEGACY_STACK_ISSUER,
      audience: LEGACY_STACK_AUDIENCE,
      algorithm: LEGACY_STACK_ALGORITHM,
      jwks: jwks as StaticLegacyStackConfig["jwks"],
    },
  };
}

function authErrorResponse(error: unknown): Response {
  if (error instanceof CapabilityError) {
    return Response.json(
      { error: error.message },
      { status: error.status },
    );
  }
  return Response.json({ error: "CAS capability validation failed" }, { status: 401 });
}

export { StackCapabilityVerifier, permissionFor } from "./auth.js";
export type { StackAuthEvent, StaticLegacyStackConfig, VerifiedStackCall } from "./auth.js";

export {
  migrateStackTenantSchema,
  readCutoverState,
  readLegacyStackId,
  readSchemaMeta,
  writeCutoverState,
  writeLegacyStackId,
} from "./schema.js";
export type { CutoverState } from "./schema.js";

export { canonicalComposite, decodeComposite, stackCanonicalNodeKey, stackNodeKey } from "./do-names.js";

export { runLegacyBaseline } from "./baseline.js";
export type { LegacyBaselineResult, LegacyBaselineRow } from "./baseline.js";

export {
  deleteMigratedSources,
  discoverR2Sources,
  manifestStats,
  parseHistoricalNodeKey,
  runR2Migration,
  verifyR2Digests,
} from "./r2-migration.js";
export type { R2ManifestStatus, R2MigrationOptions, R2MigrationStats } from "./r2-migration.js";

export { CutoverController, canTransitionCutover, shouldUseStacklessFallback } from "./cutover.js";
export type { CutoverContext } from "./cutover.js";

export type {
  CanonicalRootRefsUpdate,
  DomainUpdateResult,
  DomainRetryOptions,
  RootRefsErrorCode,
} from "./root-refs.js";
export { RootRefsRetryableError, RootRefsValidationError } from "./root-refs.js";

export type {
  RootDomainBalanceRow,
  RootDomainEventRow,
  RootDomainEventsPage,
  RootDomainRefsPage,
} from "./audit-reads.js";
export { AuditReadError } from "./audit-reads.js";
