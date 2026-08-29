/** Stable admin-client error carrying the HTTP status and wire error code. */

export class AdminClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "AdminClientError";
    this.status = status;
    this.code = code;
  }
}
