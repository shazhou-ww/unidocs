/**
 * Control-plane error model. The service throws `ControlPlaneError`; public
 * service methods convert it (and unexpected failures) into the frozen
 * `CasAdminErrorResponse` shape.
 */

import {
  CasAdminErrorCodes,
  casAdminErrorHttpStatus,
} from "@unicas/admin-protocol";
import type {
  CasAdminErrorCode,
  CasAdminErrorResponse,
} from "@unicas/admin-protocol";

export class ControlPlaneError extends Error {
  readonly code: CasAdminErrorCode;

  constructor(code: CasAdminErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ControlPlaneError";
    this.code = code;
  }
}

export function adminError(
  code: CasAdminErrorCode,
  message?: string,
): CasAdminErrorResponse {
  return { error: code, ...(message ? { message } : {}) };
}

export function httpStatusForCode(code: CasAdminErrorCode): number {
  return casAdminErrorHttpStatus[code];
}

/** Convert a thrown value into a stable CasAdminErrorResponse. */
export function toAdminError(error: unknown): CasAdminErrorResponse {
  if (error instanceof ControlPlaneError) {
    return adminError(error.code, error.message);
  }
  if (isUniqueConstraintError(error, "cas_stack_issuer.issuer")) {
    return adminError(CasAdminErrorCodes.ISSUER_CONFLICT);
  }
  if (isUniqueConstraintError(error, "cas_stack_issuer_keys")) {
    return adminError(CasAdminErrorCodes.KEY_STATE_CONFLICT, "issuer key already exists");
  }
  // Unknown database or internal failure. 503 keeps clients from retrying a
  // request that may still have partially committed (D1 batches are atomic).
  return adminError(
    CasAdminErrorCodes.SERVICE_UNAVAILABLE,
    "control plane operation failed",
  );
}

function isUniqueConstraintError(error: unknown, subject: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("UNIQUE constraint failed")
    && error.message.includes(subject)
  );
}

export { CasAdminErrorCodes };
