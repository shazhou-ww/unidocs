/** Stable node-operation error carrying HTTP presentation metadata. */
export class NodeOpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers?: HeadersInit;

  constructor(status: number, code: string, message: string, headers?: HeadersInit) {
    super(message);
    this.name = "NodeOpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const NodeOpErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NODE_NOT_FOUND",
  NOT_READY: "NODE_NOT_READY",
  CONFLICT: "NODE_CONFLICT",
  UPLOAD_CONFLICT: "CAS_UPLOAD_CONFLICT",
  UPLOAD_INCOMPLETE: "CAS_UPLOAD_INCOMPLETE",
  DIGEST_MISMATCH: "CAS_DIGEST_MISMATCH",
  UPLOAD_EXPIRED: "CAS_UPLOAD_EXPIRED",
  UPLOAD_INVALID: "CAS_UPLOAD_INVALID",
  STORAGE: "STORAGE_ERROR",
} as const;

export type NodeOpErrorCode = (typeof NodeOpErrorCodes)[keyof typeof NodeOpErrorCodes];