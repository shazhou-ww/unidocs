/**
 * Frozen threat mitigations for the CAS control plane. Implementations must
 * preserve these invariants; this module is the contract checklist.
 */
export const casAdminThreatModel = {
  oidcAccountLinking: {
    identityKey: "(identityIssuer, subject)",
    emailIsDisplayOnly: true,
    banEmailAsOwnershipKey: true,
  },
  stackTakeover: {
    requireMembershipForStackRoutes: true,
    invitationBindsImmutableOidcIdentity: true,
    lastMemberCannotBeDeleted: true,
    managementTransferRequiresAddThenRemove: true,
  },
  issuerJwksSubstitution: {
    registryAuthoritativeInControlDb: true,
    neverFetchTokenSuppliedJwksUrl: true,
    neverAcceptAdministratorSuppliedJwksUrl: true,
    discoveryIssuerMustExactlyMatchRegisteredIssuer: true,
    issuerControlProofUsesDiscoveredJwks: true,
    issuerGloballyUnique: true,
    oneActiveIssuerPerStack: true,
  },
  keyRotation: {
    states: ["active", "retiring", "revoked"] as const,
    requireProofOfPossessionOnRegister: true,
    overlappingActiveAndRetiringAllowed: true,
    revokedRejectedAfterPropagationBound: true,
  },
  confusedDeputy: {
    tenantJwtNeverAcceptedOnAdminRoutes: true,
    adminSessionNeverAcceptedOnTenantRoutes: true,
    stripTenantAuthorizationOnAdminDispatch: true,
    stripAdminSessionOnTenantDispatch: true,
  },
  webuiCsrfSessionTheft: {
    sessionCookie: "HttpOnly+Secure+SameSite",
    csrfAndOriginChecksRequired: true,
    noLongLivedBearerInBrowser: true,
    noGoogleClientSecretInBrowser: true,
  },
  controlAuditTampering: {
    appendOnlyEvents: true,
    mutationAndAuditSameTransaction: true,
    stackMembersCannotRewriteHistory: true,
  },
} as const;
