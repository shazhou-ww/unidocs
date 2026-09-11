import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  CasControlAuditEventSchema,
  CasHashSchema,
  CasManagedCapabilitySchema,
  CasMemberInvitationSchema,
  CasOAuthIssuerInspectionSchema,
  CasOperatorIdentityKeySchema,
  CasOperatorIdentitySchema,
  CasPlaygroundFileRootSchema,
  CasRefDomainSchema,
  CasRootRefBalanceSchema,
  CasRootRefEventSchema,
  CasStackMemberSchema,
  CasStackOAuthIssuerSchema,
  CasStackSchema,
} from "./schemas.js";

export const CasAdminApiBasePath = "/admin";

const ErrorDataSchema = z.object({ message: z.string().optional() }).readonly();
const error = (status: number, message: string) => ({ status, message, data: ErrorDataSchema });

export const CasAdminApiErrorMap = {
  ADMIN_AUTH_REQUIRED: error(401, "Administrator authentication is required"),
  STACK_MEMBERSHIP_REQUIRED: error(403, "Stack membership is required"),
  PLATFORM_AUTH_REQUIRED: error(403, "Platform operator authentication is required"),
  NOT_FOUND: error(404, "The requested control-plane resource was not found"),
  LAST_MEMBER: error(409, "The final stack member cannot be removed"),
  ISSUER_CONFLICT: error(409, "The OAuth issuer conflicts with current state"),
  RATE_LIMITED: error(429, "The control-plane request was rate limited"),
  SERVICE_UNAVAILABLE: error(503, "The control-plane service is unavailable"),
  PRECONDITION_REQUIRED: error(428, "An If-Match precondition is required"),
  REVISION_MISMATCH: error(412, "The If-Match revision does not match"),
  IDEMPOTENCY_CONFLICT: error(409, "The idempotency key was reused with another request"),
  INVALID_CURSOR: error(400, "The pagination cursor is invalid"),
  ROOT_REF_SNAPSHOT_CHANGED: error(409, "The Root Ref snapshot changed during pagination"),
  FORBIDDEN_PLATFORM_ACTION: error(403, "The platform action is forbidden"),
  INVALID_REQUEST: error(400, "The control-plane request is invalid"),
} as const;

const adminProcedure = oc.errors(CasAdminApiErrorMap);
const StackIdSchema = z.string().min(1)
  .describe("Opaque UniCAS-generated stack identifier.");
const RevisionSchema = z.number().int().nonnegative()
  .describe("Exact current resource revision used as the `If-Match` precondition.");
const stackParams = z.object({ stackId: StackIdSchema }).readonly();
const fileRootParams = z.object({
  stackId: StackIdSchema,
  rootId: z.string().min(1).describe("Playground-owned stable file-root identifier."),
}).readonly();
const rootDomainParams = z.object({
  stackId: StackIdSchema,
  refDomain: z.string().min(1).describe("Capability-derived business lifecycle namespace to inspect."),
}).readonly();
const invitationParams = z.object({
  token: z.string().min(1).describe("Single-use bearer invitation token. Treat it as a secret."),
}).readonly();
const pageQuery = z.object({
  limit: z.number().int().min(1).max(1000).optional()
    .describe("Maximum records to return, from 1 through 1000."),
  cursor: z.string().min(1).optional()
    .describe("Opaque `nextCursor` from the preceding page. Do not parse or modify it."),
}).readonly();
const createHeaders = z.object({
  "idempotency-key": z.string().min(1).optional()
    .describe("Caller-generated retry identity scoped to the administrator, method, and canonical route."),
}).readonly();
const mutationHeaders = z.object({
  "if-match": RevisionSchema,
}).readonly();

function pageSchema(item: z.ZodType) {
  return z.object({
    items: z.array(item).readonly().describe("Records in this page."),
    nextCursor: z.string().min(1).nullable()
      .describe("Opaque cursor for the next page, or null when the snapshot is exhausted."),
  }).readonly();
}

export const meContract = adminProcedure
  .route({ method: "GET", path: "/admin/me", operationId: "me", summary: "Read the current administrator", description: "Returns the immutable OIDC identity key for the current administrator together with every stack membership visible to that identity. Use this operation after login to populate stack selection and authorization-aware navigation. Display name and email are informational only and must not be used as ownership keys.", inputStructure: "detailed", tags: ["Identity"] })
  .input(z.object({}).readonly())
  .output(z.object({
    identity: CasOperatorIdentitySchema.describe("Authenticated administrator identity."),
    memberships: z.array(CasStackMemberSchema).readonly().describe("Stacks this identity may administer."),
  }).readonly().meta({ id: "CasAdminMeResponse" }));

export const listStacksContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks", operationId: "listStacks", summary: "List stacks", description: "Lists stacks for which the current immutable identity key is a member. Results use snapshot-bound cursor pagination: pass `nextCursor` unchanged to continue and restart from the first page when a cursor is rejected. The response includes each stack's status and revision so clients can render suspension state and prepare conditional updates.", inputStructure: "detailed", tags: ["Stacks"] })
  .input(z.object({ query: pageQuery.optional() }).readonly())
  .output(pageSchema(CasStackSchema).meta({ id: "CasAdminListStacksResponse" }));

export const createStackContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks", operationId: "createStack", summary: "Create a stack", description: "Creates a stack with a UniCAS-generated immutable identifier and adds the current administrator as its first equal-authority member. Supply `Idempotency-Key` before retrying an uncertain request; the same key and input replay the original result, while changed input is rejected as `IDEMPOTENCY_CONFLICT`.", inputStructure: "detailed", successStatus: 201, tags: ["Stacks"] })
  .input(z.object({
    headers: createHeaders.optional(),
    body: z.object({ displayName: z.string().min(1).describe("Initial administrator-visible stack name.") }).readonly(),
  }).readonly())
  .output(CasStackSchema);

export const getStackContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}", operationId: "getStack", summary: "Read a stack", description: "Returns the selected stack when the current administrator is a member. The response revision is the exact value required by subsequent conditional updates. A suspended stack remains readable to administrators even though normal tenant traffic is blocked.", inputStructure: "detailed", tags: ["Stacks"] })
  .input(z.object({ params: stackParams }).readonly()).output(CasStackSchema);

export const patchStackContract = adminProcedure
  .route({ method: "PATCH", path: "/admin/stacks/{stackId}", operationId: "patchStack", summary: "Update a stack", description: "Updates administrator-visible stack metadata without changing the immutable stack identifier or membership. Send the current `revision` as `If-Match`; a stale value returns `REVISION_MISMATCH`, after which the client should read the stack again and reconcile rather than blindly retrying.", inputStructure: "detailed", tags: ["Stacks"] })
  .input(z.object({
    params: stackParams, headers: mutationHeaders, body: z.object({
      displayName: z.string().min(1).optional().describe("Replacement stack name when supplied."),
      description: z.string().optional().describe("Replacement stack description when supplied; use an empty string to clear it."),
    }).readonly()
  }).readonly())
  .output(CasStackSchema);

export const listMembersContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/members", operationId: "listMembers", summary: "List stack members", description: "Lists every equal-authority administrator identity in the stack. Membership is keyed by OIDC issuer and subject; display names and emails can change without changing authority. Results use opaque snapshot-bound cursor pagination.", inputStructure: "detailed", tags: ["Members"] })
  .input(z.object({ params: stackParams, query: pageQuery.optional() }).readonly())
  .output(pageSchema(CasStackMemberSchema).meta({ id: "CasAdminListMembersResponse" }));

export const deleteMemberContract = adminProcedure
  .route({ method: "DELETE", path: "/admin/stacks/{stackId}/members", operationId: "deleteMember", summary: "Remove a stack member", description: "Removes the member selected by exact OIDC issuer and subject. The current membership revision must be supplied through `If-Match`. UniCAS rejects removal of the final member with `LAST_MEMBER`; transfer administration by accepting another member invitation before removing the old identity.", inputStructure: "detailed", tags: ["Members"] })
  .input(z.object({ params: stackParams, headers: mutationHeaders, query: CasOperatorIdentityKeySchema }).readonly())
  .output(z.object({ ok: z.literal(true) }).readonly());

export const createMemberInvitationContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks/{stackId}/member-invitations", operationId: "createMemberInvitation", summary: "Create a member invitation", description: "Creates a short-lived, single-use invitation for the stack. When `emailConstraint` is supplied, the accepting authenticated account must match it. The bearer token is returned only inside `acceptUrl`; deliver it through a trusted channel and do not log it. Use `Idempotency-Key` to safely recover an uncertain creation result.", inputStructure: "detailed", successStatus: 201, tags: ["Members"] })
  .input(z.object({
    params: stackParams, headers: createHeaders.optional(), body: z.object({
      emailConstraint: z.string().optional().describe("Optional email that the accepting authenticated account must match."),
    }).readonly().optional()
  }).readonly())
  .output(z.object({
    invitation: CasMemberInvitationSchema.describe("Persistent invitation record without the bearer token."),
    acceptUrl: z.url().describe("One-time URL containing the secret acceptance token. It is returned only at creation."),
  }).readonly().meta({ id: "CasAdminCreateMemberInvitationResponse" }));

export const acceptMemberInvitationContract = adminProcedure
  .route({ method: "POST", path: "/admin/member-invitations/{token}/accept", operationId: "acceptMemberInvitation", summary: "Accept a member invitation", description: "Consumes a valid pending invitation and adds the currently authenticated immutable identity key as an equal-authority stack member. An email-constrained invitation is accepted only when the authenticated account matches. Tokens are single-use and expire at the invitation deadline; callers must not retry with a different identity after acceptance.", inputStructure: "detailed", tags: ["Members"] })
  .input(z.object({ params: invitationParams }).readonly()).output(CasStackMemberSchema);

export const listPlaygroundFileRootsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/playground/file-roots", operationId: "listPlaygroundFileRoots", summary: "List Playground file roots", description: "Lists Playground-owned business records whose manifest hashes retain CAS DAGs. These records are not CAS node metadata: they provide application meaning and business-root retention. Each revision can be used for a later conditional replacement or deletion.", inputStructure: "detailed", tags: ["Playground"] })
  .input(z.object({ params: stackParams }).readonly())
  .output(z.object({ items: z.array(CasPlaygroundFileRootSchema).readonly() }).readonly().meta({ id: "CasAdminListPlaygroundFileRootsResponse" }));

export const createPlaygroundFileRootContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks/{stackId}/playground/file-roots", operationId: "createPlaygroundFileRoot", summary: "Create a Playground file root", description: "Creates a Playground business record and acquires retention for its CAS manifest. `rootId` is chosen by the Playground workflow and must be stable; `manifestHash` must identify the prepared immutable manifest. The returned revision is required for future replacement or deletion.", inputStructure: "detailed", successStatus: 201, tags: ["Playground"] })
  .input(z.object({
    params: stackParams, body: z.object({
      rootId: z.string().min(1).describe("Stable Playground business-record identifier."),
      name: z.string().min(1).describe("Initial administrator-visible file name."),
      manifestHash: CasHashSchema.describe("Prepared CAS manifest to retain as the file root."),
    }).readonly()
  }).readonly())
  .output(CasPlaygroundFileRootSchema);

export const patchPlaygroundFileRootContract = adminProcedure
  .route({ method: "PATCH", path: "/admin/stacks/{stackId}/playground/file-roots/{rootId}", operationId: "patchPlaygroundFileRoot", summary: "Update a Playground file root", description: "Replaces the file name and retained manifest under optimistic concurrency. Send the current root revision in `If-Match`. On success the new manifest becomes the business root and the previous manifest is released as one atomic application update; on `REVISION_MISMATCH`, read and reconcile current state before retrying.", inputStructure: "detailed", tags: ["Playground"] })
  .input(z.object({
    params: fileRootParams, headers: mutationHeaders, body: z.object({
      name: z.string().min(1).describe("Replacement administrator-visible file name."),
      manifestHash: CasHashSchema.describe("Replacement prepared CAS manifest to retain."),
    }).readonly()
  }).readonly())
  .output(CasPlaygroundFileRootSchema);

export const deletePlaygroundFileRootContract = adminProcedure
  .route({ method: "DELETE", path: "/admin/stacks/{stackId}/playground/file-roots/{rootId}", operationId: "deletePlaygroundFileRoot", summary: "Delete a Playground file root", description: "Deletes the Playground business record and releases its retained manifest under the exact current `If-Match` revision. Released nodes are not necessarily deleted immediately: child references, other Root Refs, and leases continue to protect them until a later garbage-collection pass.", inputStructure: "detailed", tags: ["Playground"] })
  .input(z.object({ params: fileRootParams, headers: mutationHeaders }).readonly())
  .output(z.object({ ok: z.literal(true) }).readonly());

export const getOAuthIssuerContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/oauth-issuer", operationId: "getOAuthIssuer", summary: "Read the active OAuth issuer", description: "Returns the stack's discovered OAuth issuer binding, including exact issuer/audience values, public endpoint locations, refresh health, maximum capability lifetime, and current revision. With `optional=true`, an unconfigured issuer is represented by `null`; otherwise the absence is reported as `NOT_FOUND`.", inputStructure: "detailed", tags: ["OAuth Issuer"] })
  .input(z.object({
    params: stackParams, query: z.object({
      optional: z.boolean().optional().describe("Return null instead of `NOT_FOUND` when no external issuer is configured."),
    }).readonly().optional()
  }).readonly())
  .output(CasStackOAuthIssuerSchema.nullable());

export const inspectOAuthIssuerContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks/{stackId}/oauth-issuer/inspections", operationId: "inspectOAuthIssuer", summary: "Inspect an OAuth issuer", description: "Performs bounded public HTTPS OAuth/OIDC discovery without forwarding administrator credentials, validates exact issuer identity and compatible public signing keys, and returns a short-lived activation challenge. Inspection proves configuration compatibility, not control. Sign the exact returned challenge as a compact JWS with a private key corresponding to one of `keys`; never upload or disclose that private key.", inputStructure: "detailed", successStatus: 201, tags: ["OAuth Issuer"] })
  .input(z.object({
    params: stackParams, body: z.object({
      issuer: z.url().describe("Canonical public HTTPS issuer to discover. Metadata must report this exact issuer."),
    }).readonly()
  }).readonly())
  .output(CasOAuthIssuerInspectionSchema);

export const activateOAuthIssuerContract = adminProcedure
  .route({ method: "PUT", path: "/admin/stacks/{stackId}/oauth-issuer", operationId: "activateOAuthIssuer", summary: "Activate an OAuth issuer", description: "Activates a current inspection after verifying its compact-JWS ownership proof against the public keys captured during discovery. Send the pending issuer revision in `If-Match`. The inspection and challenge must be unexpired and unchanged; successful activation makes this issuer authoritative for subsequent tenant capability verification.", inputStructure: "detailed", tags: ["OAuth Issuer"] })
  .input(z.object({
    params: stackParams, headers: mutationHeaders, body: z.object({
      inspectionId: z.string().min(1).describe("Current unexpired inspection identity."),
      activationProof: z.string().min(1).describe("Compact JWS over the inspection's exact challenge bytes."),
    }).readonly()
  }).readonly())
  .output(CasStackOAuthIssuerSchema);

export const getManagedIssuerContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/managed-issuer", operationId: "getManagedIssuer", summary: "Read the managed issuer", description: "Returns the UniCAS-managed issuer configuration for the stack, including endpoints, status, public-key digest, capability lifetime cap, and revision. This resource is separate from an administrator-activated external issuer and is intended for managed administrative workflows.", inputStructure: "detailed", tags: ["Managed Issuer"] })
  .input(z.object({ params: stackParams }).readonly()).output(CasStackOAuthIssuerSchema);

export const patchManagedIssuerContract = adminProcedure
  .route({ method: "PATCH", path: "/admin/stacks/{stackId}/managed-issuer", operationId: "patchManagedIssuer", summary: "Update the managed issuer", description: "Enables or disables capability issuance by the UniCAS-managed issuer under optimistic concurrency. Send the current issuer revision through `If-Match`. Disabling prevents new managed issuance; callers must not assume it revokes already-issued capabilities before their expiry.", inputStructure: "detailed", tags: ["Managed Issuer"] })
  .input(z.object({
    params: stackParams, headers: mutationHeaders, body: z.object({
      enabled: z.boolean().describe("True to enable managed issuance; false to disable it."),
    }).readonly()
  }).readonly())
  .output(CasStackOAuthIssuerSchema);

export const mintManagedCapabilityContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks/{stackId}/managed-capabilities", operationId: "mintManagedCapability", summary: "Mint a managed capability", description: "Mints a short-lived tenant bearer capability from the active managed issuer for the administrative Playground workflow. The response includes the exact resource scope, permissions, and expiry. Treat `accessToken` as a secret: keep it in memory, send it only to the tenant plane, and never write it to logs or durable browser storage.", inputStructure: "detailed", successStatus: 201, tags: ["Managed Issuer"] })
  .input(z.object({ params: stackParams }).readonly()).output(CasManagedCapabilitySchema);

export const listRefDomainsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/ref-domains", operationId: "listRefDomains", summary: "List observed refDomains", description: "Lists business lifecycle namespaces observed in successful, capability-authorized Root Ref writes for the stack. A refDomain is orthogonal to tenant ownership and comes from the verified tenant capability, not from an administrator mutation. Use a returned value to inspect its balances and event history.", inputStructure: "detailed", tags: ["Root Ref Audit"] })
  .input(z.object({ params: stackParams }).readonly())
  .output(z.object({ domains: z.array(CasRefDomainSchema).readonly() }).readonly().meta({ id: "CasAdminListRefDomainsResponse" }));

export const listControlAuditEventsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/audit-events", operationId: "listControlAuditEvents", summary: "List control audit events", description: "Lists append-only control-plane events for administrator actions, including immutable actor identity, canonical action and target, ingress channel, and available request/trace correlation. Results are audit evidence rather than current resource state. Use the opaque cursor for snapshot pagination or `after` for a caller-maintained continuation boundary.", inputStructure: "detailed", tags: ["Audit"] })
  .input(z.object({
    params: stackParams, query: pageQuery.unwrap().extend({
      after: z.string().optional().describe("Return events after this opaque audit continuation identity."),
    }).readonly().optional()
  }).readonly())
  .output(pageSchema(CasControlAuditEventSchema).meta({ id: "CasAdminListControlAuditEventsResponse" }));

export const listRootDomainRefsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/root-ref-domains/{refDomain}/refs", operationId: "listRootDomainRefs", summary: "List Root Ref balances", description: "Lists current per-tenant node balances for one observed refDomain at a stable snapshot revision. Optionally filter to one tenant. Continue with `nextCursor` unchanged; if the underlying snapshot can no longer be served, restart from the first page rather than combining revisions.", inputStructure: "detailed", tags: ["Root Ref Audit"] })
  .input(z.object({
    params: rootDomainParams, query: z.object({
      tenantId: z.string().optional().describe("Restrict balances to one tenant within the stack."),
      limit: z.number().int().positive().optional().describe("Maximum balances to return."),
      cursor: z.string().optional().describe("Opaque `nextCursor` from the preceding page."),
    }).readonly().optional()
  }).readonly())
  .output(z.object({
    revision: RevisionSchema.describe("Root Ref snapshot revision shared by every page in this traversal."),
    refs: z.array(CasRootRefBalanceSchema).readonly().describe("Tenant and node balances in this page."),
    nextCursor: z.string().nullable().describe("Opaque next-page cursor, or null when the snapshot is exhausted."),
  }).readonly().meta({ id: "CasAdminListRootDomainRefsResponse" }));

export const listRootDomainEventsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/root-ref-domains/{refDomain}/events", operationId: "listRootDomainEvents", summary: "List Root Ref events", description: "Lists the append-only history of atomic Root Ref commits for one observed refDomain. Each event preserves the tenant, idempotency requestId, complete signed delta set, revision, and commit time. Use `nextAfter` as the next request's `after` value to consume history incrementally; `latestRevision` indicates the head observed by this response.", inputStructure: "detailed", tags: ["Root Ref Audit"] })
  .input(z.object({
    params: rootDomainParams, query: z.object({
      tenantId: z.string().optional().describe("Restrict events to one tenant within the stack."),
      after: RevisionSchema.optional().describe("Return events after this domain-local revision."),
      limit: z.number().int().positive().optional().describe("Maximum events to return."),
    }).readonly().optional()
  }).readonly())
  .output(z.object({
    events: z.array(CasRootRefEventSchema).readonly().describe("Append-only Root Ref commit events in revision order."),
    latestRevision: RevisionSchema.describe("Latest domain revision visible when the response was produced."),
    nextAfter: RevisionSchema.describe("Continuation revision to supply as `after` on the next request."),
  }).readonly().meta({ id: "CasAdminListRootDomainEventsResponse" }));

export const casAdminApiContract = {
  identity: { me: meContract },
  stacks: { list: listStacksContract, create: createStackContract, get: getStackContract, update: patchStackContract },
  members: { list: listMembersContract, remove: deleteMemberContract, createInvitation: createMemberInvitationContract, acceptInvitation: acceptMemberInvitationContract },
  playground: { listRoots: listPlaygroundFileRootsContract, createRoot: createPlaygroundFileRootContract, updateRoot: patchPlaygroundFileRootContract, deleteRoot: deletePlaygroundFileRootContract },
  oauthIssuer: { get: getOAuthIssuerContract, inspect: inspectOAuthIssuerContract, activate: activateOAuthIssuerContract },
  managedIssuer: { get: getManagedIssuerContract, update: patchManagedIssuerContract, mintCapability: mintManagedCapabilityContract },
  audit: { listRefDomains: listRefDomainsContract, listControlEvents: listControlAuditEventsContract, listRootRefs: listRootDomainRefsContract, listRootEvents: listRootDomainEventsContract },
};

export type CasAdminApiContract = typeof casAdminApiContract;