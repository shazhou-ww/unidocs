import type {
  CasAdminAcceptMemberInvitationRequest,
  CasAdminAcceptMemberInvitationResponse,
  CasAdminActivateOAuthIssuerRequest,
  CasAdminActivateOAuthIssuerResponse,
  CasAdminCreateMemberInvitationRequest,
  CasAdminCreateMemberInvitationResponse,
  CasAdminCreateStackRequest,
  CasAdminCreateStackResponse,
  CasAdminCreatePlaygroundFileRootRequest,
  CasAdminCreatePlaygroundFileRootResponse,
  CasAdminDeletePlaygroundFileRootRequest,
  CasAdminDeletePlaygroundFileRootResponse,
  CasAdminDeleteMemberRequest,
  CasAdminDeleteMemberResponse,
  CasAdminErrorResponse,
  CasAdminGetOAuthIssuerRequest,
  CasAdminGetOAuthIssuerResponse,
  CasAdminGetManagedIssuerRequest,
  CasAdminGetManagedIssuerResponse,
  CasAdminMintManagedCapabilityRequest,
  CasAdminMintManagedCapabilityResponse,
  CasAdminInspectOAuthIssuerRequest,
  CasAdminInspectOAuthIssuerResponse,
  CasAdminGetStackRequest,
  CasAdminGetStackResponse,
  CasAdminListControlAuditEventsRequest,
  CasAdminListControlAuditEventsResponse,
  CasAdminListMembersRequest,
  CasAdminListMembersResponse,
  CasAdminListPlaygroundFileRootsRequest,
  CasAdminListPlaygroundFileRootsResponse,
  CasAdminListStacksRequest,
  CasAdminListStacksResponse,
  CasAdminMeResponse,
  CasAdminPatchStackRequest,
  CasAdminPatchStackResponse,
  CasAdminPatchPlaygroundFileRootRequest,
  CasAdminPatchPlaygroundFileRootResponse,
  CasAdminPatchManagedIssuerRequest,
  CasAdminPatchManagedIssuerResponse,
  CasOperatorIdentityKey,
} from "@unicas/admin-protocol";
import type { ControlAuditAction } from "./control-audit.js";

/** Authenticated caller context supplied by an ingress after session checks. */
export interface ControlPlaneCallContext {
  readonly identity: CasOperatorIdentityKey;
  /** Display metadata from the verified identity profile (email is display-only). */
  readonly profile?: {
    readonly displayName: string | null;
    readonly emailForDisplay: string | null;
  };
  readonly requestId?: string;
  readonly traceId?: string;
  readonly caller?: {
    readonly channel: "admin-webui" | "mcp";
    readonly oauthClientHandle?: string;
    readonly toolName?: string;
  };
}

/** Service-level mutation input: raw precondition headers, parsed by the service. */
export interface ServiceMutationInput {
  /** Raw `If-Match` header value; absent means "no precondition". */
  readonly ifMatch?: string;
  /** Raw `Idempotency-Key` header value for creation endpoints. */
  readonly idempotencyKey?: string;
}

/** Cloud-neutral control-plane operations consumed by admin presentation layers. */
export interface ControlPlaneOperations {
  me(ctx: ControlPlaneCallContext): Promise<CasAdminMeResponse | CasAdminErrorResponse>;
  listStacks(ctx: ControlPlaneCallContext, request: CasAdminListStacksRequest): Promise<CasAdminListStacksResponse>;
  createStack(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminCreateStackRequest, "headers">,
    mutation?: ServiceMutationInput,
  ): Promise<CasAdminCreateStackResponse>;
  getStack(ctx: ControlPlaneCallContext, request: CasAdminGetStackRequest): Promise<CasAdminGetStackResponse>;
  patchStack(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminPatchStackRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminPatchStackResponse>;
  listMembers(ctx: ControlPlaneCallContext, request: CasAdminListMembersRequest): Promise<CasAdminListMembersResponse>;
  listPlaygroundFileRoots(ctx: ControlPlaneCallContext, request: CasAdminListPlaygroundFileRootsRequest): Promise<CasAdminListPlaygroundFileRootsResponse>;
  createPlaygroundFileRoot(ctx: ControlPlaneCallContext, request: CasAdminCreatePlaygroundFileRootRequest): Promise<CasAdminCreatePlaygroundFileRootResponse>;
  patchPlaygroundFileRoot(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminPatchPlaygroundFileRootRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminPatchPlaygroundFileRootResponse>;
  deletePlaygroundFileRoot(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminDeletePlaygroundFileRootRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminDeletePlaygroundFileRootResponse>;
  deleteMember(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminDeleteMemberRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminDeleteMemberResponse>;
  createMemberInvitation(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminCreateMemberInvitationRequest, "headers">,
    mutation?: ServiceMutationInput,
  ): Promise<CasAdminCreateMemberInvitationResponse>;
  acceptMemberInvitation(
    ctx: ControlPlaneCallContext,
    request: CasAdminAcceptMemberInvitationRequest,
  ): Promise<CasAdminAcceptMemberInvitationResponse>;
  getOAuthIssuer(
    ctx: ControlPlaneCallContext,
    request: CasAdminGetOAuthIssuerRequest,
  ): Promise<CasAdminGetOAuthIssuerResponse>;
  getManagedOAuthIssuer(
    ctx: ControlPlaneCallContext,
    request: CasAdminGetManagedIssuerRequest,
  ): Promise<CasAdminGetManagedIssuerResponse>;
  patchManagedOAuthIssuer(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminPatchManagedIssuerRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminPatchManagedIssuerResponse>;
  mintManagedCapability(
    ctx: ControlPlaneCallContext,
    request: CasAdminMintManagedCapabilityRequest,
  ): Promise<CasAdminMintManagedCapabilityResponse>;
  inspectOAuthIssuer(
    ctx: ControlPlaneCallContext,
    request: CasAdminInspectOAuthIssuerRequest,
  ): Promise<CasAdminInspectOAuthIssuerResponse>;
  activateOAuthIssuer(
    ctx: ControlPlaneCallContext,
    request: Omit<CasAdminActivateOAuthIssuerRequest, "headers">,
    mutation: ServiceMutationInput,
  ): Promise<CasAdminActivateOAuthIssuerResponse>;
  listControlAuditEvents(
    ctx: ControlPlaneCallContext,
    request: CasAdminListControlAuditEventsRequest,
  ): Promise<CasAdminListControlAuditEventsResponse>;
  recordSessionAudit(
    ctx: ControlPlaneCallContext,
    action: ControlAuditAction,
    target: string,
    stackId?: string | null,
  ): Promise<void>;
}

/** Opaque encrypted browser session persisted by a platform adapter. */
export interface StoredSession {
  readonly sessionId: string;
  readonly encryptedPayload: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/** Cloud-neutral persistence port for BFF login and authenticated sessions. */
export interface ControlSessionRepository {
  create(sessionId: string, encryptedPayload: string, ttlMs: number): Promise<void>;
  read(sessionId: string): Promise<StoredSession | null>;
  touch(sessionId: string, ttlMs: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
  pruneExpired(): Promise<number>;
}
