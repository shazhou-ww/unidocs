import { implement, ORPCError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { CasClientError } from "@unicas/tenant-blob-client";
import { agentApiContract, AgentApiErrorMap } from "@unidocs/protocol-platform";
import {
  createTenantSubmissionService, TenantAccessError, TenantOperationError,
  type CommittedSubmissionReceipt, type DocumentLocationValidator, type SnapshotVerifier, type TenantContext,
  type TenantSubmissionRepository,
} from "@unidocs/portal-service";
import { readBoundedJsonRequest } from "../bounded-json-request.js";
import type { SnapshotStore } from "../snapshot-store.js";
import { CasUnavailableError } from "./cas-unavailable.js";
import { MAX_SNAPSHOT_BYTES, validateSnapshotBytes } from "./snapshot-validator.js";

export interface AgentHttpDependencies {
  readonly submissions: TenantSubmissionRepository;
  readonly snapshots: SnapshotStore;
  readonly validateLocation: DocumentLocationValidator;
}

type SubmissionService = ReturnType<typeof createTenantSubmissionService>;

interface AgentHttpContext {
  readonly tenant: TenantContext;
  readonly requestId: string;
  readonly submissions: SubmissionService;
  /** Set only when THIS request's repository commit wrote the receipt; a replay never sets it. */
  readonly commit: { receipt?: CommittedSubmissionReceipt };
}

/**
 * A coarse bound on the whole request, so the Worker never buffers an
 * unbounded body. It is not the submission's real limit: the per-reply text,
 * attachment, location payload and 50-thread-update bounds are enforced
 * precisely by the submission service.
 */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Only the codes the Agent contract declares. Each status is read from
 * `AgentApiErrorMap`, so a code missing there does not compile; the values are
 * the tenant API's for the same codes. A service or repository code outside
 * this map is an unexpected failure (500), not a silently invented status.
 */
const STATUS = {
  invalid_request: AgentApiErrorMap.INVALID_REQUEST.status,
  unauthorized: AgentApiErrorMap.UNAUTHORIZED.status,
  forbidden: AgentApiErrorMap.FORBIDDEN.status,
  not_found: AgentApiErrorMap.NOT_FOUND.status,
  content_unavailable: AgentApiErrorMap.CONTENT_UNAVAILABLE.status,
  location_contract_violation: AgentApiErrorMap.LOCATION_CONTRACT_VIOLATION.status,
  unavailable: AgentApiErrorMap.UNAVAILABLE.status,
} as const;

type AgentErrorCode = keyof typeof STATUS;

function isAgentErrorCode(code: string): code is AgentErrorCode {
  return Object.hasOwn(STATUS, code);
}

const SUBMISSION_PATH = /^\/api\/v1\/tenants\/[^/]+\/documents\/[^/]+\/submissions(?:\/.*)?$/;

/** `/api/v1/tenants/{t}/documents/{d}/submissions` and everything below it. */
export function isSubmissionPath(pathname: string): boolean {
  return SUBMISSION_PATH.test(pathname);
}

function failure(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };
}

/**
 * Reads at most `limit` bytes. A stream that runs past it is cancelled at the
 * first chunk over the limit and `null` is returned, so an oversized blob is
 * never buffered whole.
 */
async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * R3 over the portal's snapshot store. A read failure is classified the way
 * `version-repository.ts`'s `readSnapshot` classifies it - a CAS 404 or the
 * store's size mismatch is `content_unavailable`, anything else `unavailable` -
 * with one addition: a store that could not be built at all (a missing CAS
 * binding) is recognised by type and logged as `portal_cas_unavailable`.
 * Every other `unavailable` is logged too, because the service turns it into a
 * coded error that carries no cause and the adapter logs only uncoded errors.
 */
function createSnapshotVerifier(snapshots: SnapshotStore, requestId: string): SnapshotVerifier {
  function readFailure(error: unknown): "content_unavailable" | "unavailable" {
    if (error instanceof CasUnavailableError) {
      console.error(JSON.stringify({ event: "portal_cas_unavailable", requestId, ...failure(error.cause) }));
      return "unavailable";
    }
    if (error instanceof CasClientError && error.status === 404) return "content_unavailable";
    if (error instanceof Error && /bytes, but the version record declares/.test(error.message)) return "content_unavailable";
    console.error(JSON.stringify({ event: "portal_snapshot_read_failed", requestId, ...failure(error) }));
    return "unavailable";
  }

  return async (ref, schema) => {
    // Declared oversize is refused before any CAS traffic; the streaming cap
    // below still holds against a blob larger than it claims.
    if (ref.size > MAX_SNAPSHOT_BYTES) return "invalid_request";
    let bytes: Uint8Array | null;
    try {
      bytes = await readAtMost(await snapshots.read(ref), MAX_SNAPSHOT_BYTES);
    } catch (error) {
      return readFailure(error);
    }
    if (bytes === null) return "invalid_request";
    if (bytes.byteLength !== ref.size) return "content_unavailable";
    const validation = validateSnapshotBytes(bytes, schema);
    return validation.ok ? "ok" : validation.code;
  };
}

function errorResponse(code: AgentErrorCode, message: string, requestId: string): Response {
  return Response.json({ error: { code, message, requestId } }, { status: STATUS[code] });
}

/**
 * The Agent API (`agentApiContract`) over the submission service. Built like
 * `tenant-http.ts`: a bounded, strictly parsed body; errors mapped only around
 * the procedure call; only the unexpected logged.
 *
 * Retain (R8): after a submission commits a version, its snapshot blob is
 * retained, after the D1 commit and never before it. A retain failure is
 * logged as `portal_snapshot_retain_failed` and does not change the response:
 * the commit cannot be undone. A replayed receipt is not retained again. The
 * adapter tells a fresh commit from a replay by wrapping the repository's
 * `commit` for the request: only a `committed` outcome from this request's own
 * commit marks the receipt as fresh. A receipt the service returns from
 * `findReceipt` - a replay, or a twin that committed first - never passes
 * through that wrapper.
 */
export function createAgentHttp(dependencies: AgentHttpDependencies):
  (request: Request, tenant: TenantContext, requestId: string) => Promise<Response> {
  const implementation = implement(agentApiContract).$context<AgentHttpContext>();
  const { snapshots } = dependencies;

  const router = implementation.router({
    submissions: {
      create: implementation.submissions.create.handler(async ({ input, context }) => {
        const receipt = await context.submissions.create(context.tenant, input.params.tenantId, input.params.documentId, input.body);
        const snapshot = input.body.newSnapshotBlob;
        if (context.commit.receipt?.version && snapshot !== undefined) {
          try {
            await snapshots.retain(snapshot, context.requestId);
          } catch (error) {
            console.error(JSON.stringify({ event: "portal_snapshot_retain_failed", requestId: context.requestId, blobHash: snapshot.blobHash, ...failure(error) }));
          }
        }
        return receipt;
      }),
      get: implementation.submissions.get.handler(({ input, context }) =>
        context.submissions.get(context.tenant, input.params.tenantId, input.params.documentId, input.params.submissionId)),
    },
  });

  return async (request, tenant, requestId) => {
    const path = new URL(request.url).pathname;
    // R10: submissions are the Agent's alone. Refused before the body is read,
    // so a session caller learns nothing about what its body would have done.
    if (tenant.transport !== "bearer") return errorResponse("forbidden", new TenantAccessError("forbidden").message, requestId);

    let boundedRequest = request;
    if (request.method === "POST") {
      const bounded = await readBoundedJsonRequest(request, MAX_BODY_BYTES);
      if (!bounded.ok) {
        return errorResponse("invalid_request", bounded.reason === "not_json" ? "A JSON request body is required" : "Invalid or oversized JSON request", requestId);
      }
      boundedRequest = bounded.request;
    }

    const commit: AgentHttpContext["commit"] = {};
    const repository = dependencies.submissions;
    const submissions = createTenantSubmissionService({
      findReceipt: (...args) => repository.findReceipt(...args),
      loadState: (...args) => repository.loadState(...args),
      loadContract: (...args) => repository.loadContract(...args),
      commit: async command => {
        const outcome = await repository.commit(command);
        if (outcome.kind === "committed") commit.receipt = outcome.receipt;
        return outcome;
      },
    }, { validateLocation: dependencies.validateLocation, verifySnapshot: createSnapshotVerifier(snapshots, requestId) });

    const handler = new OpenAPIHandler(router, {
      clientInterceptors: [async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          if ((error instanceof TenantAccessError || error instanceof TenantOperationError) && isAgentErrorCode(error.code)) {
            throw new ORPCError(error.code.toUpperCase(), { status: STATUS[error.code], message: error.message, data: { requestId } });
          }
          if (!(error instanceof ORPCError) || error.status >= 500) {
            // Name and message only: repository errors can carry SQL fragments.
            console.error(JSON.stringify({ event: "portal_operation_failed", requestId, path, ...failure(error) }));
          }
          throw error;
        }
      }],
      customErrorResponseBodyEncoder: error => {
        if (error.status === 500) return { error: { code: "internal_error", message: "Agent operation failed", requestId } };
        if (error.code === "BAD_REQUEST") return { error: { code: "invalid_request", message: "The request is invalid", requestId } };
        return { error: { code: error.code.toLowerCase(), message: error.message, requestId } };
      },
    });
    const result = await handler.handle(boundedRequest, { context: { tenant, requestId, submissions, commit } });
    if (!result.matched) return errorResponse("not_found", "The requested resource was not found", requestId);
    return result.response;
  };
}
