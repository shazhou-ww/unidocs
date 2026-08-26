export type CapabilityErrorCode =
  | "invalid_token"
  | "missing_token"
  | "insufficient_permission"
  | "resource_scope_mismatch";

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

  constructor(code: "invalid_token" | "missing_token", message: string) {
    super(code, message);
    this.name = "CapabilityAuthenticationError";
  }
}

export class CapabilityAuthorizationError extends CapabilityError {
  readonly status = 403 as const;

  constructor(
    code: "insufficient_permission" | "resource_scope_mismatch",
    message: string,
  ) {
    super(code, message);
    this.name = "CapabilityAuthorizationError";
  }
}