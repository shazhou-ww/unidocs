/**
 * Cloud-neutral CAS control-plane service library.
 *
 * Sole writer path for CAS_CONTROL_DB. Does not import tenant worker/DO
 * implementation modules and has no binding to tenant D1/R2/DO.
 */

/** Marker that this package is the sole writer path for CAS_CONTROL_DB. */
export const CAS_CONTROL_PLANE_PACKAGE = "@unicas/control-plane" as const;

export {
  ControlPlaneService,
} from "./service.js";
export type {
  ControlPlaneServiceOptions,
} from "./service.js";
export type {
  ControlPlaneCallContext,
  ControlPlaneOperations,
  ControlSessionRepository,
  ServiceMutationInput,
  StoredSession,
} from "@unicas/service";

export { AuthorityRepository } from "./authority.js";
export type {
  RegisteredStackKey,
  ResolvedStackAuthority,
  StackAuthorityResolver,
} from "./authority.js";

export { buildStackJwks } from "@unicas/service";

export { ControlPlaneError, adminError, toAdminError } from "@unicas/service";

export { ControlAuditActions } from "@unicas/service";
export type { ControlAuditAction } from "@unicas/service";

export {
  buildPossessionChallenge,
  parsePossessionChallenge,
  validatePublicJwk,
  verifyPossessionProof,
} from "@unicas/service";
export type { PossessionChallengeInput } from "@unicas/service";

export {
  canonicalJson,
  CONTROL_LIST_DEFAULT_LIMIT,
  CONTROL_LIST_MAX_LIMIT,
  INVITATION_TTL_MS,
  isSupportedKeyAlgorithm,
  LEGACY_DOMAIN,
  normalizeEmailConstraint,
  parseControlListLimit,
  POSSESSION_CHALLENGE_TTL_MS,
  sha256Hex,
  STACK_ID_PATTERN,
  validateAudience,
  validateDisplayName,
  validateEmailConstraint,
  validateInvitationToken,
  validateIssuer,
  validateKid,
} from "@unicas/service";
export type { SupportedKeyAlgorithm } from "@unicas/service";

export {
  generateEventId,
  generateInvitationId,
  generateInvitationToken,
  generateNonce,
  generateSessionId,
  generateStackId,
} from "@unicas/service";

export { encodeControlListCursor, decodeControlListCursor } from "@unicas/service";
export type { ControlListCursor } from "@unicas/service";
