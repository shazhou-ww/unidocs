import type {
  CasControlAuditEvent,
  CasOAuthIssuerInspection,
  CasMemberInvitation,
  CasOperatorIdentity,
  CasOperatorIdentityKey,
  CasRefDomain,
  CasRootRefBalance,
  CasRootRefEvent,
  CasStack,
  CasStackId,
  CasStackIssuer,
  CasStackIssuerKey,
  CasStackMember,
  CasStackOAuthIssuer,
  CasIssuerKeyState,
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

export interface CasAdminGetIssuerRequest {
  readonly path: CasAdminStackPath;
}

export type CasAdminGetIssuerResponse = CasStackIssuer | CasAdminErrorResponse;

export interface CasAdminGetOAuthIssuerRequest {
  readonly path: CasAdminStackPath;
}

export type CasAdminGetOAuthIssuerResponse =
  | CasStackOAuthIssuer
  | CasAdminErrorResponse;

export interface CasAdminInspectOAuthIssuerRequest {
  readonly path: CasAdminStackPath;
  readonly body: {
    readonly issuer: string;
    readonly audience: string;
    readonly capabilityMaxLifetimeSeconds?: number;
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

export interface CasAdminPutIssuerRequest {
  readonly path: CasAdminStackPath;
  readonly headers: CasAdminMutationPreconditions;
  readonly body: {
    readonly issuer: string;
    readonly audience: string;
    readonly capabilityMaxLifetimeSeconds?: number;
  };
}

export type CasAdminPutIssuerResponse = CasStackIssuer | CasAdminErrorResponse;

export interface CasAdminListIssuerKeysRequest {
  readonly path: CasAdminStackPath;
}

export type CasAdminListIssuerKeysResponse =
  | { readonly keys: readonly CasStackIssuerKey[] }
  | CasAdminErrorResponse;

export interface CasAdminCreateIssuerKeyRequest {
  readonly path: CasAdminStackPath;
  readonly headers?: CasAdminCreateHeaders;
  readonly body: {
    readonly kid: string;
    readonly algorithm: string;
    readonly publicJwk: Readonly<Record<string, unknown>>;
    /** Proof of private-key possession (implementation-defined challenge response). */
    readonly possessionProof: string;
  };
}

export type CasAdminCreateIssuerKeyResponse =
  | CasStackIssuerKey
  | CasAdminErrorResponse;

export interface CasAdminDeleteIssuerKeyRequest {
  readonly path: CasAdminStackPath & { readonly kid: string };
  readonly headers: CasAdminMutationPreconditions;
  readonly body?: { readonly toState?: Extract<CasIssuerKeyState, "retiring" | "revoked"> };
}

export type CasAdminDeleteIssuerKeyResponse =
  | CasStackIssuerKey
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
  getIssuer: { request: CasAdminGetIssuerRequest; response: CasAdminGetIssuerResponse };
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
  putIssuer: { request: CasAdminPutIssuerRequest; response: CasAdminPutIssuerResponse };
  listIssuerKeys: {
    request: CasAdminListIssuerKeysRequest;
    response: CasAdminListIssuerKeysResponse;
  };
  createIssuerKey: {
    request: CasAdminCreateIssuerKeyRequest;
    response: CasAdminCreateIssuerKeyResponse;
  };
  deleteIssuerKey: {
    request: CasAdminDeleteIssuerKeyRequest;
    response: CasAdminDeleteIssuerKeyResponse;
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
