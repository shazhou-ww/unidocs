/**
 * Stable control-plane error codes. HTTP status is a projection of these codes;
 * clients must key off `error`, not status alone.
 */
export const CasAdminErrorCodes = {
  ADMIN_AUTH_REQUIRED: "ADMIN_AUTH_REQUIRED",
  STACK_MEMBERSHIP_REQUIRED: "STACK_MEMBERSHIP_REQUIRED",
  PLATFORM_AUTH_REQUIRED: "PLATFORM_AUTH_REQUIRED",
  NOT_FOUND: "NOT_FOUND",
  LAST_MEMBER: "LAST_MEMBER",
  ISSUER_CONFLICT: "ISSUER_CONFLICT",
  KEY_STATE_CONFLICT: "KEY_STATE_CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  PRECONDITION_REQUIRED: "PRECONDITION_REQUIRED",
  REVISION_MISMATCH: "REVISION_MISMATCH",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  INVALID_CURSOR: "INVALID_CURSOR",
  ROOT_REF_SNAPSHOT_CHANGED: "ROOT_REF_SNAPSHOT_CHANGED",
  FORBIDDEN_PLATFORM_ACTION: "FORBIDDEN_PLATFORM_ACTION",
  /**
   * Task 2 amendment: generic client error for invalid/malformed request
   * input (illegal refDomain/kid/displayName, empty bodies, bad limits).
   * The frozen set had no 400-class code besides INVALID_CURSOR.
   */
  INVALID_REQUEST: "INVALID_REQUEST",
} as const;

export type CasAdminErrorCode =
  (typeof CasAdminErrorCodes)[keyof typeof CasAdminErrorCodes];

export interface CasAdminErrorResponse {
  readonly error: CasAdminErrorCode;
  readonly message?: string;
}

/** Canonical HTTP status for each stable control-plane error. */
export const casAdminErrorHttpStatus: Readonly<Record<CasAdminErrorCode, number>> = {
  ADMIN_AUTH_REQUIRED: 401,
  STACK_MEMBERSHIP_REQUIRED: 403,
  PLATFORM_AUTH_REQUIRED: 403,
  NOT_FOUND: 404,
  LAST_MEMBER: 409,
  ISSUER_CONFLICT: 409,
  KEY_STATE_CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  PRECONDITION_REQUIRED: 428,
  REVISION_MISMATCH: 412,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_CURSOR: 400,
  ROOT_REF_SNAPSHOT_CHANGED: 409,
  FORBIDDEN_PLATFORM_ACTION: 403,
  INVALID_REQUEST: 400,
};
