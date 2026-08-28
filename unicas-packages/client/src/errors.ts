export class CasClientError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, operation: string) {
    super(`CAS ${operation} failed: ${status} ${statusText}`);
    this.name = "CasClientError";
    this.status = status;
  }
}