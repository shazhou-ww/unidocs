import { describe, expect, test } from "vitest";
import {
  CAS_ADMIN_IDEMPOTENCY_RETENTION_MS,
  CAS_STACK_MEMBER_AUTHORITY,
  CasAdminErrorCodes,
  casAdminErrorHttpStatus,
  casAdminThreatModel,
  casAuthPlanePolicy,
  casPlatformOperatorPolicy,
  casStackMembershipPolicy,
  formatCasAdminETag,
  isPlatformActionGrantableByStackMembership,
  parseCasAdminETag,
} from "../src/index.js";
import type {
  CasAdminEndpointContracts,
  CasAdminListRootDomainEventsResponse,
  CasAdminListRootDomainRefsResponse,
  CasPlatformOperatorCapability,
} from "../src/index.js";

describe("control-plane contract freezes", () => {
  test("stable errors map to the documented HTTP statuses", () => {
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.ADMIN_AUTH_REQUIRED]).toBe(401);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED]).toBe(403);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.LAST_MEMBER]).toBe(409);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.PRECONDITION_REQUIRED]).toBe(428);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.REVISION_MISMATCH]).toBe(412);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.IDEMPOTENCY_CONFLICT]).toBe(409);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.INVALID_CURSOR]).toBe(400);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.ROOT_REF_SNAPSHOT_CHANGED]).toBe(409);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.FORBIDDEN_PLATFORM_ACTION]).toBe(403);
    expect(casAdminErrorHttpStatus[CasAdminErrorCodes.INVALID_REQUEST]).toBe(400);
  });

  test("ETag round-trips integer revisions", () => {
    expect(formatCasAdminETag(1843)).toBe('"1843"');
    expect(parseCasAdminETag('"1843"')).toBe(1843);
    expect(parseCasAdminETag("W/\"1843\"")).toBeNull();
    expect(CAS_ADMIN_IDEMPOTENCY_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("equal membership and last-member protection are frozen", () => {
    expect(CAS_STACK_MEMBER_AUTHORITY).toBe("equal_administrator");
    expect(casStackMembershipPolicy.equalAuthority).toBe(true);
    expect(casStackMembershipPolicy.perMemberRbac).toBe(false);
    expect(casStackMembershipPolicy.managementTransfer).toBe("add_member_then_remove_member");
    expect(casStackMembershipPolicy.lastMemberProtection).toBe("LAST_MEMBER");
  });

  test("platform operator plane is disjoint from stack membership", () => {
    expect(casPlatformOperatorPolicy.disjointFromStackMembership).toBe(true);
    expect(casPlatformOperatorPolicy.actions).toEqual([
      "suspend_stack",
      "unsuspend_stack",
      "disaster_recovery",
    ]);
    expect(isPlatformActionGrantableByStackMembership("suspend_stack")).toBe(false);
    expect(isPlatformActionGrantableByStackMembership("disaster_recovery")).toBe(false);

    const capability: CasPlatformOperatorCapability = {
      action: "suspend_stack",
      grantedByStackMembership: false,
    };
    expect(capability.grantedByStackMembership).toBe(false);
  });

  test("auth planes reject the other credential class", () => {
    expect(casAuthPlanePolicy.stackAdminPlane.pathPrefix).toBe("/admin");
    expect(casAuthPlanePolicy.stackAdminPlane.rejects).toContain("stack_issuer_jwt_capability");
    expect(casAuthPlanePolicy.tenantDataPlane.pathPrefix).toBe("/stacks");
    expect(casAuthPlanePolicy.tenantDataPlane.rejects).toContain("oidc_bff_session");
  });

  test("threat model checklist is present for required attack surfaces", () => {
    expect(casAdminThreatModel.oidcAccountLinking.banEmailAsOwnershipKey).toBe(true);
    expect(casAdminThreatModel.stackTakeover.lastMemberCannotBeDeleted).toBe(true);
    expect(casAdminThreatModel.issuerJwksSubstitution.neverFetchTokenSuppliedJwksUrl).toBe(true);
    expect(casAdminThreatModel.keyRotation.states).toEqual([
      "active",
      "retiring",
      "revoked",
    ]);
    expect(casAdminThreatModel.confusedDeputy.tenantJwtNeverAcceptedOnAdminRoutes).toBe(true);
    expect(casAdminThreatModel.webuiCsrfSessionTheft.noLongLivedBearerInBrowser).toBe(true);
    expect(casAdminThreatModel.controlAuditTampering.appendOnlyEvents).toBe(true);
  });

  test("endpoint contract keys cover admin resource families", () => {
    const keys: Array<keyof CasAdminEndpointContracts> = [
      "me",
      "listStacks",
      "createStack",
      "getStack",
      "patchStack",
      "listMembers",
      "deleteMember",
      "createMemberInvitation",
      "acceptMemberInvitation",
      "getIssuer",
      "putIssuer",
      "listIssuerKeys",
      "createIssuerKey",
      "deleteIssuerKey",
      "listRefDomains",
      "listControlAuditEvents",
      "listRootDomainRefs",
      "listRootDomainEvents",
    ];
    expect(keys).toHaveLength(18);
  });

  test("root-ref audit response shapes accept negative balances", () => {
    const refs: CasAdminListRootDomainRefsResponse = {
      revision: 1,
      refs: [{ tenantId: "t", hash: "a".repeat(64), count: -1 }],
      nextCursor: null,
    };
    const events: CasAdminListRootDomainEventsResponse = {
      events: [{
        revision: 1,
        tenantId: "t",
        requestId: "r1",
        changes: { ["a".repeat(64)]: -1 },
        appliedAt: 1,
      }],
      latestRevision: 1,
      nextAfter: 1,
    };
    expect(refs.refs[0]?.count).toBe(-1);
    expect(events.events).toHaveLength(1);
  });
});
