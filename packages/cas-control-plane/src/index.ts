/**
 * Cloud-neutral control-plane service surface.
 * Task 1 freezes the package boundary; Task 2 implements persistence and OIDC.
 */
export type {
  CasAdminEndpointContracts,
  CasOperatorIdentity,
  CasPlatformOperatorAction,
  CasStack,
  CasStackId,
  CasStackMember,
} from "@unidocs/protocol-cas-admin";

export {
  CasAdminErrorCodes,
  casPlatformOperatorPolicy,
  casStackMembershipPolicy,
} from "@unidocs/protocol-cas-admin";

/** Marker that this package is the sole writer path for CAS_CONTROL_DB. */
export const CAS_CONTROL_PLANE_PACKAGE = "@unidocs/cas-control-plane" as const;
