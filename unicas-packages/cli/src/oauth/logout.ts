/**
 * `unicas logout`: RFC 7009 token revocation against the discovered
 * authorization server, then local session deletion.
 *
 * Revocation failures never leave the CLI "logged in": the local session is
 * deleted regardless, because a token the server already rejected cannot be
 * refreshed. An explicit network failure reports the server response but still
 * clears the local file at the caller's discretion (see `logoutCommand`).
 */

import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { PersistedSession, TokenStore } from "../store.js";

export interface LogoutOptions {
  readonly serverUrl: string;
  readonly store: TokenStore;
  readonly session: PersistedSession;
  readonly fetchImpl?: typeof fetch;
}

export interface LogoutResult {
  readonly revoked: boolean;
  readonly revocationError: string | null;
  readonly hadTokens: boolean;
  readonly hadClientInformation: boolean;
}

export async function revokeAndClearSession(options: LogoutOptions): Promise<LogoutResult> {
  const { session, store } = options;
  const hadTokens = session.tokens?.refresh_token !== undefined || session.tokens?.access_token !== undefined;
  const hadClientInformation = session.clientInformation !== undefined;
  let revoked = false;
  let revocationError: string | null = null;

  const tokenToRevoke = session.tokens?.refresh_token ?? session.tokens?.access_token;
  if (tokenToRevoke) {
    try {
      revoked = await revokeToken({
        serverUrl: options.serverUrl,
        token: tokenToRevoke,
        tokenTypeHint: session.tokens?.refresh_token !== undefined ? "refresh_token" : "access_token",
        clientId: session.clientInformation?.client_id,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
      });
    } catch (error) {
      revocationError = error instanceof Error ? error.message : String(error);
    }
  }

  await store.clear();
  return { revoked, revocationError, hadTokens, hadClientInformation };
}

async function revokeToken(options: {
  readonly serverUrl: string;
  readonly token: string;
  readonly tokenTypeHint?: string;
  readonly clientId?: string;
  readonly fetchImpl: typeof fetch;
}): Promise<boolean> {
  const serverInfo = await discoverOAuthServerInfo(options.serverUrl, {
    fetchFn: options.fetchImpl,
  });
  const revocationEndpoint = (serverInfo.authorizationServerMetadata as OAuthMetadata | undefined)?.revocation_endpoint;
  if (!revocationEndpoint) {
    throw new Error("the authorization server does not advertise a revocation endpoint");
  }
  const body = new URLSearchParams({
    token: options.token,
  });
  if (options.tokenTypeHint) body.set("token_type_hint", options.tokenTypeHint);
  if (options.clientId) body.set("client_id", options.clientId);
  const response = await options.fetchImpl(revocationEndpoint.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  // RFC 7009: 200 means revoked; 400 with invalid_grant means the token was
  // already invalid (still a successful logout outcome).
  if (response.ok || response.status === 400) {
    return true;
  }
  const text = await response.text().catch(() => "");
  throw new Error(`revocation endpoint returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
}
