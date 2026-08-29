/**
 * `unicas logout`: end the BFF session server-side, then delete the local
 * session. The local session is always cleared; a server-side failure is
 * reported but never leaves the CLI "logged in".
 */

import type { PersistedSession, TokenStore } from "../store.js";

export interface LogoutOptions {
  readonly adminOrigin: string;
  readonly store: TokenStore;
  readonly session: PersistedSession;
  readonly fetchImpl?: typeof fetch;
}

export interface LogoutResult {
  readonly revoked: boolean;
  readonly revocationError: string | null;
}

export async function revokeAndClearSession(options: LogoutOptions): Promise<LogoutResult> {
  const { session, store } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let revoked = false;
  let revocationError: string | null = null;
  if (session.cookie.length > 0) {
    try {
      const response = await fetchImpl(`${options.adminOrigin}/admin/auth/logout`, {
        method: "POST",
        headers: { Cookie: session.cookie },
      });
      revoked = response.ok;
    } catch (error) {
      revocationError = error instanceof Error ? error.message : String(error);
    }
  }
  await store.clear();
  return { revoked, revocationError };
}
