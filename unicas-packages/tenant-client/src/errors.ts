export class CasClientError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, operation: string, detail?: string) {
    super(`CAS ${operation} failed: ${status} ${statusText}${detail ? `: ${detail}` : ""}`);
    this.name = "CasClientError";
    this.status = status;
  }
}