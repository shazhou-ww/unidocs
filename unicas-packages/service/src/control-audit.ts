/**
 * Control-audit action vocabulary. Events are append-only; the `action` and
 * `target` strings are stable identifiers, not free-form descriptions.
 */

export const ControlAuditActions = {
  identityCreated: "operator.identity.created",
  identityUpdated: "operator.identity.updated",
  stackCreated: "stack.created",
  stackPatched: "stack.patched",
  memberInvited: "member.invited",
  memberInvitationAccepted: "member.invitation.accepted",
  memberRemoved: "member.removed",
  issuerPut: "issuer.put",
  oauthIssuerInspected: "oauth_issuer.inspection.created",
  oauthIssuerActivated: "oauth_issuer.activated",
  issuerKeyCreated: "issuer.key.created",
  issuerKeyDeleted: "issuer.key.deleted",
  sessionLogin: "session.login",
  sessionLoginFailed: "session.login_failed",
  sessionLogout: "session.logout",
} as const;

export type ControlAuditAction =
  (typeof ControlAuditActions)[keyof typeof ControlAuditActions];
