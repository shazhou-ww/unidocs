/**
 * Browser API client for the `/admin` BFF. Browser code never holds Google
 * secrets, session signing material, refresh tokens, or storage bindings.
 * It calls the BFF with the HttpOnly session cookie, and the BFF enforces
 * membership. The Playground may explicitly request a 120-second tenant
 * capability. The CSRF token is read from the shell's meta tag.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpiredError";
  }
}

let sessionCsrfToken = "";

export function readCsrfToken(): string {
  return sessionCsrfToken
    || document.querySelector<HTMLMetaElement>('meta[name="x-csrf-token"]')?.content
    || "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "network request failed");
  }
  const responseCsrfToken = response.headers.get("X-CSRF-Token");
  if (responseCsrfToken) sessionCsrfToken = responseCsrfToken;
  if (response.status === 401) {
    // Session missing/expired: restart the OIDC flow from the current page.
    const returnTo = `${window.location.pathname}${window.location.hash}`;
    window.location.href = `/admin/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
    throw new SessionExpiredError();
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = body as { error?: unknown; message?: unknown } | null;
    const code = typeof error?.error === "string" ? error.error : `HTTP_${response.status}`;
    const message = typeof error?.message === "string" ? error.message : undefined;
    throw new ApiError(response.status, code, message);
  }
  return body as T;
}

/** All mutating calls include the resource revision for optimistic concurrency. */
export function ifMatch(revision: number): Record<string, string> {
  return { "If-Match": `"${revision}"` };
}
