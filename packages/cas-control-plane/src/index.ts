/**
 * Cloud-neutral CAS control-plane service library.
 *
 * Sole writer path for CAS_CONTROL_DB. Does not import tenant worker/DO
 * implementation modules and has no binding to tenant D1/R2/DO.
 */

/** Marker that this package is the sole writer path for CAS_CONTROL_DB. */
export const CAS_CONTROL_PLANE_PACKAGE = "@unidocs/cas-control-plane" as const;

export {
  ControlPlaneService,
} from "./service.js";
export type {
  ControlPlaneCallContext,
  ControlPlaneServiceOptions,
  ServiceMutationInput,
} from "./service.js";

export { ControlSessionStore } from "./sessions.js";
export type { StoredSession } from "./sessions.js";

export {
  CONTROL_SCHEMA_MIGRATIONS,
  migrateControlSchema,
} from "./schema.js";

export { ControlPlaneError, adminError, toAdminError } from "./errors.js";

export { ControlAuditActions } from "./audit.js";
export type { ControlAuditAction } from "./audit.js";

export {
  buildPossessionChallenge,
  parsePossessionChallenge,
  validatePublicJwk,
  verifyPossessionProof,
} from "./possession.js";
export type { PossessionChallengeInput } from "./possession.js";

export {
  canonicalJson,
  CONTROL_LIST_DEFAULT_LIMIT,
  CONTROL_LIST_MAX_LIMIT,
  INVITATION_TTL_MS,
  isReservedRefDomain,
  isSupportedKeyAlgorithm,
  LEGACY_DOMAIN,
  normalizeEmailConstraint,
  parseControlListLimit,
  POSSESSION_CHALLENGE_TTL_MS,
  REF_DOMAIN_PATTERN,
  sha256Hex,
  STACK_ID_PATTERN,
  validateAudience,
  validateDisplayName,
  validateEmailConstraint,
  validateInvitationToken,
  validateIssuer,
  validateKid,
  validateRefDomain,
} from "./validation.js";
export type { SupportedKeyAlgorithm } from "./validation.js";

export {
  generateEventId,
  generateInvitationId,
  generateInvitationToken,
  generateNonce,
  generateSessionId,
  generateStackId,
} from "./ids.js";

export { encodeControlListCursor, decodeControlListCursor } from "./cursor.js";
export type { ControlListCursor } from "./cursor.js";
