/**
 * Admin-client types. The admin client is a typed HTTP transport for the
 * `/admin` control-plane API (the BFF surface), mirroring how
 * `@unicas/tenant-client` wraps the tenant data-plane HTTP API: one plain
 * function per operation, a factory binding common parameters, no encoding,
 * no business abstraction.
 *
 * Authentication is the OIDC BFF session: the caller supplies a session
 * provider that yields the session cookie plus the CSRF token (browser and
 * CLI obtain sessions differently; both present the same cookie shape).
 */

/** Fetch shape (admin packages never depend on tenant packages). */
export type AdminHttpFetcher = typeof fetch;

/** A valid BFF session: the `cas_admin_session` cookie + its CSRF token. */
export interface AdminClientSession {
  /** Raw `Cookie` header value, e.g. `cas_admin_session=...`. */
  readonly cookie: string;
  /** CSRF token the BFF issued with this session (sent on mutations). */
  readonly csrfToken: string;
}

export interface AdminClientConfig {
  /** Origin of the control-plane `/admin` API. */
  readonly baseUrl: string;
  /** Supplies the current session; throws when the operator must log in. */
  readonly getSession: () => Promise<AdminClientSession>;
  readonly fetcher?: AdminHttpFetcher;
}

export interface AdminClientRead<T> {
  readonly value: T;
  /** Current ETag (for `If-Match` preconditions on the next mutation). */
  readonly etag: string;
}
