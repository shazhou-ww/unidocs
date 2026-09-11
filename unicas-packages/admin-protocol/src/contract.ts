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
const StackIdSchema = z.string().min(1);
const RevisionSchema = z.number().int().nonnegative();
const stackParams = z.object({ stackId: StackIdSchema }).readonly();
const fileRootParams = z.object({ stackId: StackIdSchema, rootId: z.string().min(1) }).readonly();
const rootDomainParams = z.object({ stackId: StackIdSchema, refDomain: z.string().min(1) }).readonly();
const invitationParams = z.object({ token: z.string().min(1) }).readonly();
const pageQuery = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().min(1).optional(),
}).readonly();
const createHeaders = z.object({ "idempotency-key": z.string().min(1).optional() }).readonly();
const mutationHeaders = z.object({ "if-match": RevisionSchema }).readonly();

function pageSchema(item: z.ZodType) {
  return z.object({
    items: z.array(item).readonly(),
    nextCursor: z.string().min(1).nullable(),
  }).readonly();
}

export const meContract = adminProcedure
  .route({ method: "GET", path: "/admin/me", operationId: "me", summary: "Read the current administrator", description: "Returns the authenticated operator identity and all stack memberships.", inputStructure: "detailed", tags: ["Identity"] })
  .input(z.object({}).readonly())
  .output(z.object({ identity: CasOperatorIdentitySchema, memberships: z.array(CasStackMemberSchema).readonly() }).readonly().meta({ id: "CasAdminMeResponse" }));

export const listStacksContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks", operationId: "listStacks", summary: "List stacks", description: "Lists stacks visible to the current administrator with cursor pagination.", inputStructure: "detailed", tags: ["Stacks"] })
  .input(z.object({ query: pageQuery.optional() }).readonly())
  .output(pageSchema(CasStackSchema).meta({ id: "CasAdminListStacksResponse" }));

export const createStackContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks", operationId: "createStack", summary: "Create a stack", description: "Creates a stack and adds the current administrator as its first equal member.", inputStructure: "detailed", successStatus: 201, tags: ["Stacks"] })
  .input(z.object({ headers: createHeaders.optional(), body: z.object({ displayName: z.string().min(1) }).readonly() }).readonly())
  .output(CasStackSchema);

export const getStackContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}", operationId: "getStack", summary: "Read a stack", description: "Returns one stack visible to the current administrator.", inputStructure: "detailed", tags: ["Stacks"] })
  .input(z.object({ params: stackParams }).readonly()).output(CasStackSchema);

export const patchStackContract = adminProcedure
  .route({ method: "PATCH", path: "/admin/stacks/{stackId}", operationId: "patchStack", summary: "Update a stack", description: "Updates stack display metadata under an optimistic concurrency precondition.", inputStructure: "detailed", tags: ["Stacks"] })
  .input(z.object({ params: stackParams, headers: mutationHeaders, body: z.object({ displayName: z.string().min(1).optional(), description: z.string().optional() }).readonly() }).readonly())
  .output(CasStackSchema);

export const listMembersContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/members", operationId: "listMembers", summary: "List stack members", description: "Lists equal-authority administrator members for a stack.", inputStructure: "detailed", tags: ["Members"] })
  .input(z.object({ params: stackParams, query: pageQuery.optional() }).readonly())
  .output(pageSchema(CasStackMemberSchema).meta({ id: "CasAdminListMembersResponse" }));

export const deleteMemberContract = adminProcedure
  .route({ method: "DELETE", path: "/admin/stacks/{stackId}/members", operationId: "deleteMember", summary: "Remove a stack member", description: "Removes an identity-keyed member while preserving the final-member invariant.", inputStructure: "detailed", tags: ["Members"] })
  .input(z.object({ params: stackParams, headers: mutationHeaders, query: CasOperatorIdentityKeySchema }).readonly())
  .output(z.object({ ok: z.literal(true) }).readonly());

export const createMemberInvitationContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks/{stackId}/member-invitations", operationId: "createMemberInvitation", summary: "Create a member invitation", description: "Creates a short-lived stack invitation and returns its one-time acceptance URL.", inputStructure: "detailed", successStatus: 201, tags: ["Members"] })
  .input(z.object({ params: stackParams, headers: createHeaders.optional(), body: z.object({ emailConstraint: z.string().optional() }).readonly().optional() }).readonly())
  .output(z.object({ invitation: CasMemberInvitationSchema, acceptUrl: z.url() }).readonly().meta({ id: "CasAdminCreateMemberInvitationResponse" }));

export const acceptMemberInvitationContract = adminProcedure
  .route({ method: "POST", path: "/admin/member-invitations/{token}/accept", operationId: "acceptMemberInvitation", summary: "Accept a member invitation", description: "Consumes an invitation token and adds the authenticated identity to the stack.", inputStructure: "detailed", tags: ["Members"] })
  .input(z.object({ params: invitationParams }).readonly()).output(CasStackMemberSchema);

export const listPlaygroundFileRootsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/playground/file-roots", operationId: "listPlaygroundFileRoots", summary: "List Playground file roots", description: "Lists Playground-owned records that retain CAS manifests.", inputStructure: "detailed", tags: ["Playground"] })
  .input(z.object({ params: stackParams }).readonly())
  .output(z.object({ items: z.array(CasPlaygroundFileRootSchema).readonly() }).readonly().meta({ id: "CasAdminListPlaygroundFileRootsResponse" }));

export const createPlaygroundFileRootContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks/{stackId}/playground/file-roots", operationId: "createPlaygroundFileRoot", summary: "Create a Playground file root", description: "Creates a Playground record that retains one CAS manifest.", inputStructure: "detailed", successStatus: 201, tags: ["Playground"] })
  .input(z.object({ params: stackParams, body: z.object({ rootId: z.string().min(1), name: z.string().min(1), manifestHash: CasHashSchema }).readonly() }).readonly())
  .output(CasPlaygroundFileRootSchema);

export const patchPlaygroundFileRootContract = adminProcedure
  .route({ method: "PATCH", path: "/admin/stacks/{stackId}/playground/file-roots/{rootId}", operationId: "patchPlaygroundFileRoot", summary: "Update a Playground file root", description: "Replaces Playground root metadata and manifest under If-Match.", inputStructure: "detailed", tags: ["Playground"] })
  .input(z.object({ params: fileRootParams, headers: mutationHeaders, body: z.object({ name: z.string().min(1), manifestHash: CasHashSchema }).readonly() }).readonly())
  .output(CasPlaygroundFileRootSchema);

export const deletePlaygroundFileRootContract = adminProcedure
  .route({ method: "DELETE", path: "/admin/stacks/{stackId}/playground/file-roots/{rootId}", operationId: "deletePlaygroundFileRoot", summary: "Delete a Playground file root", description: "Deletes a Playground root under If-Match and releases its retained manifest.", inputStructure: "detailed", tags: ["Playground"] })
  .input(z.object({ params: fileRootParams, headers: mutationHeaders }).readonly())
  .output(z.object({ ok: z.literal(true) }).readonly());

export const getOAuthIssuerContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/oauth-issuer", operationId: "getOAuthIssuer", summary: "Read the active OAuth issuer", description: "Returns the discovered OAuth issuer binding for a stack, or null when optional.", inputStructure: "detailed", tags: ["OAuth Issuer"] })
  .input(z.object({ params: stackParams, query: z.object({ optional: z.boolean().optional() }).readonly().optional() }).readonly())
  .output(CasStackOAuthIssuerSchema.nullable());

export const inspectOAuthIssuerContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks/{stackId}/oauth-issuer/inspections", operationId: "inspectOAuthIssuer", summary: "Inspect an OAuth issuer", description: "Discovers issuer metadata and keys and returns a short-lived activation challenge.", inputStructure: "detailed", successStatus: 201, tags: ["OAuth Issuer"] })
  .input(z.object({ params: stackParams, body: z.object({ issuer: z.url() }).readonly() }).readonly())
  .output(CasOAuthIssuerInspectionSchema);

export const activateOAuthIssuerContract = adminProcedure
  .route({ method: "PUT", path: "/admin/stacks/{stackId}/oauth-issuer", operationId: "activateOAuthIssuer", summary: "Activate an OAuth issuer", description: "Activates an inspected issuer after validating its signed control proof.", inputStructure: "detailed", tags: ["OAuth Issuer"] })
  .input(z.object({ params: stackParams, headers: mutationHeaders, body: z.object({ inspectionId: z.string().min(1), activationProof: z.string().min(1) }).readonly() }).readonly())
  .output(CasStackOAuthIssuerSchema);

export const getManagedIssuerContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/managed-issuer", operationId: "getManagedIssuer", summary: "Read the managed issuer", description: "Returns the UniCAS-managed issuer configuration for a stack.", inputStructure: "detailed", tags: ["Managed Issuer"] })
  .input(z.object({ params: stackParams }).readonly()).output(CasStackOAuthIssuerSchema);

export const patchManagedIssuerContract = adminProcedure
  .route({ method: "PATCH", path: "/admin/stacks/{stackId}/managed-issuer", operationId: "patchManagedIssuer", summary: "Update the managed issuer", description: "Enables or disables the managed issuer under If-Match.", inputStructure: "detailed", tags: ["Managed Issuer"] })
  .input(z.object({ params: stackParams, headers: mutationHeaders, body: z.object({ enabled: z.boolean() }).readonly() }).readonly())
  .output(CasStackOAuthIssuerSchema);

export const mintManagedCapabilityContract = adminProcedure
  .route({ method: "POST", path: "/admin/stacks/{stackId}/managed-capabilities", operationId: "mintManagedCapability", summary: "Mint a managed capability", description: "Mints a short-lived tenant capability from the stack's managed issuer.", inputStructure: "detailed", successStatus: 201, tags: ["Managed Issuer"] })
  .input(z.object({ params: stackParams }).readonly()).output(CasManagedCapabilitySchema);

export const listRefDomainsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/ref-domains", operationId: "listRefDomains", summary: "List observed refDomains", description: "Lists refDomains observed in successful Root Ref audit writes.", inputStructure: "detailed", tags: ["Root Ref Audit"] })
  .input(z.object({ params: stackParams }).readonly())
  .output(z.object({ domains: z.array(CasRefDomainSchema).readonly() }).readonly().meta({ id: "CasAdminListRefDomainsResponse" }));

export const listControlAuditEventsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/audit-events", operationId: "listControlAuditEvents", summary: "List control audit events", description: "Lists append-only administrator control-plane audit events.", inputStructure: "detailed", tags: ["Audit"] })
  .input(z.object({ params: stackParams, query: pageQuery.unwrap().extend({ after: z.string().optional() }).readonly().optional() }).readonly())
  .output(pageSchema(CasControlAuditEventSchema).meta({ id: "CasAdminListControlAuditEventsResponse" }));

export const listRootDomainRefsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/root-ref-domains/{refDomain}/refs", operationId: "listRootDomainRefs", summary: "List Root Ref balances", description: "Lists tenant balances for one observed refDomain at a stable revision.", inputStructure: "detailed", tags: ["Root Ref Audit"] })
  .input(z.object({ params: rootDomainParams, query: z.object({ tenantId: z.string().optional(), limit: z.number().int().positive().optional(), cursor: z.string().optional() }).readonly().optional() }).readonly())
  .output(z.object({ revision: RevisionSchema, refs: z.array(CasRootRefBalanceSchema).readonly(), nextCursor: z.string().nullable() }).readonly().meta({ id: "CasAdminListRootDomainRefsResponse" }));

export const listRootDomainEventsContract = adminProcedure
  .route({ method: "GET", path: "/admin/stacks/{stackId}/root-ref-domains/{refDomain}/events", operationId: "listRootDomainEvents", summary: "List Root Ref events", description: "Lists append-only Root Ref mutation events for one observed refDomain.", inputStructure: "detailed", tags: ["Root Ref Audit"] })
  .input(z.object({ params: rootDomainParams, query: z.object({ tenantId: z.string().optional(), after: RevisionSchema.optional(), limit: z.number().int().positive().optional() }).readonly().optional() }).readonly())
  .output(z.object({ events: z.array(CasRootRefEventSchema).readonly(), latestRevision: RevisionSchema, nextAfter: RevisionSchema }).readonly().meta({ id: "CasAdminListRootDomainEventsResponse" }));

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