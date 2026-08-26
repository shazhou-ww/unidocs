export type CapabilityErrorCode =
  | "invalid_token"
  | "missing_token"
  | "insufficient_permission"
  | "resource_scope_mismatch"
  | "unknown_issuer"
  | "issuer_disabled"
  | "registry_unavailable"
  | "unsupported_algorithm";

export abstract class CapabilityError extends Error {
  abstract readonly status: 401 | 403;
  readonly code: CapabilityErrorCode;

  protected constructor(code: CapabilityErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class CapabilityAuthenticationError extends CapabilityError {
  readonly status = 401 as const;

  constructor(
    code:
      | "invalid_token"
      | "missing_token"
      | "unknown_issuer"
      | "issuer_disabled"
      | "registry_unavailable",
    message: string,
  ) {
    super(code, message);
    this.name = "CapabilityAuthenticationError";
  }
}

export class CapabilityAuthorizationError extends CapabilityError {
  readonly status = 403 as const;

  constructor(
    code:
      | "insufficient_permission"
      | "resource_scope_mismatch"
      | "unsupported_algorithm"
      | "registry_unavailable",
    message: string,
  ) {
    super(code, message);
    this.name = "CapabilityAuthorizationError";
  }
}