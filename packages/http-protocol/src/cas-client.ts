/**
 * CAS client wire abstractions — the shape of talking to the CAS service
 * over HTTP, shared by the client implementation (@unidocs/cas-client) and
 * the gateway routing (@unidocs/server-core).
 */

/** Structural interface for a fetch-capable binding (e.g. a Cloudflare service binding). */
export interface HttpFetcher {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export type CasClientConfig =
  | { baseUrl: string; userId: string; authToken?: string }
  | { fetcher: HttpFetcher; userId: string; internalToken: string };

export class CasClientError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, operation: string) {
    super(`CAS ${operation} failed: ${status} ${statusText}`);
    this.name = "CasClientError";
    this.status = status;
  }
}
