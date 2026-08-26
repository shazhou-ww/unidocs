/**
 * Frozen authorization semantics for the stack control plane.
 * Runtime enforcement lives in cas-admin-webui / cas-control-plane; this module
 * is the contract those implementations must satisfy.
 */

import type { CasPlatformOperatorAction } from "./types.js";
import { CasAdminErrorCodes } from "./errors.js";

/** Every stack member has identical administrator authority. */
export const casStackMembershipPolicy = {
  equalAuthority: true,
  /**
   * Management transfer is add-then-remove: invite/accept a replacement member,
   * then delete the previous member. Direct ownership transfer tokens do not exist.
   */
  managementTransfer: "add_member_then_remove_member" as const,
  /** Deleting the final member is rejected with LAST_MEMBER. */
  lastMemberProtection: CasAdminErrorCodes.LAST_MEMBER,
  /** No per-member RBAC or token-scope system on `/admin` routes in MVP. */
  perMemberRbac: false,
} as const;

/**
 * Platform suspension/recovery is a disjoint authority plane. Stack membership
 * never grants these actions, and members cannot elevate themselves.
 */
export const casPlatformOperatorPolicy = {
  plane: "cas_platform_operator" as const,
  disjointFromStackMembership: true,
  actions: [
    "suspend_stack",
    "unsuspend_stack",
    "disaster_recovery",
  ] as const satisfies readonly CasPlatformOperatorAction[],
  stackMemberGrantForbiddenError: CasAdminErrorCodes.FORBIDDEN_PLATFORM_ACTION,
} as const;

/** Credential classes accepted by each authentication plane. */
export const casAuthPlanePolicy = {
  tenantDataPlane: {
    pathPrefix: "/stacks",
    credential: "stack_issuer_jwt_capability",
    rejects: ["oidc_bff_session", "platform_operator_session"] as const,
  },
  stackAdminPlane: {
    pathPrefix: "/admin",
    credential: "google_oidc_bff_session",
    rejects: ["stack_issuer_jwt_capability"] as const,
  },
  platformOperatorPlane: {
    pathPrefix: null,
    credential: "cas_platform_operator",
    rejects: ["stack_issuer_jwt_capability", "stack_membership_alone"] as const,
  },
} as const;

export function isPlatformActionGrantableByStackMembership(
  _action: CasPlatformOperatorAction,
): false {
  return false;
}
