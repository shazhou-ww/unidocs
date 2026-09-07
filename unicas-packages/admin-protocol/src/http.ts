import type {
  CasControlAuditEvent,
  CasOAuthIssuerInspection,
  CasMemberInvitation,
  CasOperatorIdentity,
  CasOperatorIdentityKey,
  CasPlaygroundFileRoot,
  CasRefDomain,
  CasRootRefBalance,
  CasRootRefEvent,
  CasStack,
  CasStackId,
  CasStackMember,
  CasStackOAuthIssuer,
} from "./types.js";
import type { CasAdminErrorResponse } from "./errors.js";
import type {
  CasAdminCreateHeaders,
  CasAdminMutationPreconditions,
  CasAdminPage,
  CasAdminPageQuery,
} from "./concurrency.js";

export interface CasAdminStackPath {
  readonly stackId: CasStackId;
}

export interface CasAdminRootDomainPath extends CasAdminStackPath {
  readonly refDomain: string;
}

export interface CasAdminPlaygroundFileRootPath extends CasAdminStackPath {
  readonly rootId: string;
}

export interface CasAdminListPlaygroundFileRootsRequest {
  readonly path: CasAdminStackPath;
}

export type CasAdminListPlaygroundFileRootsResponse =
  | { readonly items: readonly CasPlaygroundFileRoot[] }
  | CasAdminErrorResponse;

export interface CasAdminCreatePlaygroundFileRootRequest {
  readonly path: CasAdminStackPath;
  readonly body: {
    readonly rootId: string;
    readonly name: string;
    readonly manifestHash: string;
  };
}

export type CasAdminCreatePlaygroundFileRootResponse = CasPlaygroundFileRoot | CasAdminErrorResponse;

export interface CasAdminPatchPlaygroundFileRootRequest {
  readonly path: CasAdminPlaygroundFileRootPath;
  readonly headers: CasAdminMutationPreconditions;
  readonly body: {
    readonly name: string;
    readonly manifestHash: string;
  };
}

export type CasAdminPatchPlaygroundFileRootResponse = CasPlaygroundFileRoot | CasAdminErrorResponse;

export interface CasAdminDeletePlaygroundFileRootRequest {
  readonly path: CasAdminPlaygroundFileRootPath;
  readonly headers: CasAdminMutationPreconditions;
}

export type CasAdminDeletePlaygroundFileRootResponse = { readonly ok: true } | CasAdminErrorResponse;

export interface CasAdminMeResponse {
  readonly identity: CasOperatorIdentity;
  readonly memberships: readonly CasStackMember[];
}

export interface CasAdminListStacksRequest {
  readonly query?: CasAdminPageQuery;
}

export type CasAdminListStacksResponse =
  | CasAdminPage<CasStack>
  | CasAdminErrorResponse;

export interface CasAdminCreateStackRequest {
  readonly headers?: CasAdminCreateHeaders;
  readonly body: { readonly displayName: string };
}

export type CasAdminCreateStackResponse = CasStack | CasAdminErrorResponse;

export interface CasAdminGetStackRequest {
  readonly path: CasAdminStackPath;
}

export type CasAdminGetStackResponse = CasStack | CasAdminErrorResponse;

export interface CasAdminPatchStackRequest {
  readonly path: CasAdminStackPath;
  readonly headers: CasAdminMutationPreconditions;
  readonly body: {
    readonly displayName?: string;
    readonly description?: string;
  };
}

export type CasAdminPatchStackResponse = CasStack | CasAdminErrorResponse;

export interface CasAdminListMembersRequest {
  readonly path: CasAdminStackPath;
  readonly query?: CasAdminPageQuery;
}

export type CasAdminListMembersResponse =
  | CasAdminPage<CasStackMember>
  | CasAdminErrorResponse;

export interface CasAdminDeleteMemberRequest {
  readonly path: CasAdminStackPath;
  readonly headers: CasAdminMutationPreconditions;
  readonly query: CasOperatorIdentityKey;
}

export type CasAdminDeleteMemberResponse =
  | { readonly ok: true }
  | CasAdminErrorResponse;

export interface CasAdminCreateMemberInvitationRequest {
  readonly path: CasAdminStackPath;
  readonly headers?: CasAdminCreateHeaders;
  readonly body?: { readonly emailConstraint?: string };
}

export type CasAdminCreateMemberInvitationResponse =
  | {
    readonly invitation: CasMemberInvitation;
    /** Returned once; CAS stores only the token hash. */
    readonly acceptUrl: string;
  }
  | CasAdminErrorResponse;

export interface CasAdminAcceptMemberInvitationRequest {
  readonly path: { readonly token: string };
}

export type CasAdminAcceptMemberInvitationResponse =
  | CasStackMember
  | CasAdminErrorResponse;

export interface CasAdminGetOAuthIssuerRequest {
  readonly path: CasAdminStackPath;
  readonly query?: { readonly optional?: boolean };
}

export type CasAdminGetOAuthIssuerResponse =
  | CasStackOAuthIssuer
  | null
  | CasAdminErrorResponse;

export interface CasAdminGetManagedIssuerRequest {
  readonly path: CasAdminStackPath;
}

export type CasAdminGetManagedIssuerResponse =
  | CasStackOAuthIssuer
  | CasAdminErrorResponse;

export interface CasAdminPatchManagedIssuerRequest {
  readonly path: CasAdminStackPath;
  readonly headers: CasAdminMutationPreconditions;
  readonly body: { readonly enabled: boolean };
}

export type CasAdminPatchManagedIssuerResponse =
  | CasStackOAuthIssuer
  | CasAdminErrorResponse;

export interface CasManagedCapability {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
  readonly expiresAt: number;
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly permissions: readonly string[];
}

export interface CasAdminMintManagedCapabilityRequest {
  readonly path: CasAdminStackPath;
}

export type CasAdminMintManagedCapabilityResponse =
  | CasManagedCapability
  | CasAdminErrorResponse;

export interface CasAdminInspectOAuthIssuerRequest {
  readonly path: CasAdminStackPath;
  readonly body: {
    readonly issuer: string;
  };
}

export type CasAdminInspectOAuthIssuerResponse =
  | CasOAuthIssuerInspection
  | CasAdminErrorResponse;

export interface CasAdminActivateOAuthIssuerRequest {
  readonly path: CasAdminStackPath;
  readonly headers: CasAdminMutationPreconditions;
  readonly body: {
    readonly inspectionId: string;
    readonly activationProof: string;
  };
}

export type CasAdminActivateOAuthIssuerResponse =
  | CasStackOAuthIssuer
  | CasAdminErrorResponse;

export interface CasAdminListRefDomainsRequest {
  readonly path: CasAdminStackPath;
}

export type CasAdminListRefDomainsResponse =
  | { readonly domains: readonly CasRefDomain[] }
  | CasAdminErrorResponse;

export interface CasAdminListControlAuditEventsRequest {
  readonly path: CasAdminStackPath;
  readonly query?: CasAdminPageQuery & { readonly after?: string };
}

export type CasAdminListControlAuditEventsResponse =
  | CasAdminPage<CasControlAuditEvent>
  | CasAdminErrorResponse;

export interface CasAdminListRootDomainRefsRequest {
  readonly path: CasAdminRootDomainPath;
  readonly query?: {
    readonly tenantId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  };
}

export type CasAdminListRootDomainRefsResponse =
  | {
    readonly revision: number;
    readonly refs: readonly CasRootRefBalance[];
    readonly nextCursor: string | null;
  }
  | CasAdminErrorResponse;

export interface CasAdminListRootDomainEventsRequest {
  readonly path: CasAdminRootDomainPath;
  readonly query?: {
    readonly tenantId?: string;
    readonly after?: number;
    readonly limit?: number;
  };
}

export type CasAdminListRootDomainEventsResponse =
  | {
    readonly events: readonly CasRootRefEvent[];
    readonly latestRevision: number;
    readonly nextAfter: number;
  }
  | CasAdminErrorResponse;

export interface CasAdminEndpointContracts {
  me: { request: Record<string, never>; response: CasAdminMeResponse | CasAdminErrorResponse };
  listStacks: {
    request: CasAdminListStacksRequest;
    response: CasAdminListStacksResponse;
  };
  createStack: {
    request: CasAdminCreateStackRequest;
    response: CasAdminCreateStackResponse;
  };
  getStack: { request: CasAdminGetStackRequest; response: CasAdminGetStackResponse };
  patchStack: {
    request: CasAdminPatchStackRequest;
    response: CasAdminPatchStackResponse;
  };
  listMembers: {
    request: CasAdminListMembersRequest;
    response: CasAdminListMembersResponse;
  };
  listPlaygroundFileRoots: {
    request: CasAdminListPlaygroundFileRootsRequest;
    response: CasAdminListPlaygroundFileRootsResponse;
  };
  createPlaygroundFileRoot: {
    request: CasAdminCreatePlaygroundFileRootRequest;
    response: CasAdminCreatePlaygroundFileRootResponse;
  };
  patchPlaygroundFileRoot: {
    request: CasAdminPatchPlaygroundFileRootRequest;
    response: CasAdminPatchPlaygroundFileRootResponse;
  };
  deletePlaygroundFileRoot: {
    request: CasAdminDeletePlaygroundFileRootRequest;
    response: CasAdminDeletePlaygroundFileRootResponse;
  };
  deleteMember: {
    request: CasAdminDeleteMemberRequest;
    response: CasAdminDeleteMemberResponse;
  };
  createMemberInvitation: {
    request: CasAdminCreateMemberInvitationRequest;
    response: CasAdminCreateMemberInvitationResponse;
  };
  acceptMemberInvitation: {
    request: CasAdminAcceptMemberInvitationRequest;
    response: CasAdminAcceptMemberInvitationResponse;
  };
  getOAuthIssuer: {
    request: CasAdminGetOAuthIssuerRequest;
    response: CasAdminGetOAuthIssuerResponse;
  };
  inspectOAuthIssuer: {
    request: CasAdminInspectOAuthIssuerRequest;
    response: CasAdminInspectOAuthIssuerResponse;
  };
  activateOAuthIssuer: {
    request: CasAdminActivateOAuthIssuerRequest;
    response: CasAdminActivateOAuthIssuerResponse;
  };
  listRefDomains: {
    request: CasAdminListRefDomainsRequest;
    response: CasAdminListRefDomainsResponse;
  };
  listControlAuditEvents: {
    request: CasAdminListControlAuditEventsRequest;
    response: CasAdminListControlAuditEventsResponse;
  };
  listRootDomainRefs: {
    request: CasAdminListRootDomainRefsRequest;
    response: CasAdminListRootDomainRefsResponse;
  };
  listRootDomainEvents: {
    request: CasAdminListRootDomainEventsRequest;
    response: CasAdminListRootDomainEventsResponse;
  };
}
