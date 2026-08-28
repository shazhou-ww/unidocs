/**
 * SDK `OAuthClientProvider` implementation backed by the persisted session.
 *
 * Two usage modes share this class:
 *
 * - Interactive (`unicas login`): `redirectUrl`, `clientMetadata`, and
 *   `onRedirect` are supplied, so the SDK's `auth()` orchestrator performs
 *   discovery, dynamic client registration, PKCE, and authorization, then
 *   hands the authorization URL to `onRedirect` (local callback server +
 *   browser). The caller feeds the returned code back through
 *   `auth(provider, { authorizationCode })`.
 * - Non-interactive (every other command and `unicas mcp`): no `onRedirect`;
 *   `redirectToAuthorization` throws `NeedsLoginError`, turning "no valid
 *   session" into a clear CLI error instead of a browser attempt. Token
 *   refresh on 401 keeps working automatically through the same provider.
 */

import { randomBytes } from "node:crypto";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { PersistedSession } from "../store.js";

/** Raised when an operation requires an interactive `unicas login`. */
export class NeedsLoginError extends Error {
  constructor(message = "No valid Unicas session; run `unicas login` first") {
    super(message);
    this.name = "NeedsLoginError";
  }
}

/**
 * Fallback registration metadata for non-interactive use. Interactive flows
 * always supply their own `clientMetadata` with the live callback URL.
 */
const DEFAULT_REDIRECT_URL = "http://127.0.0.1/callback";

const DEFAULT_CLIENT_METADATA: OAuthClientMetadata = {
  client_name: "Unicas CLI",
  redirect_uris: [DEFAULT_REDIRECT_URL],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};

export interface PersistentOAuthClientProviderOptions {
  /** Current in-memory session; mutated by save hooks and persisted via onSave. */
  readonly session: PersistedSession;
  /** Persist the mutated session (e.g. write to the token store). */
  readonly onSave: (session: PersistedSession) => void | Promise<void>;
  /** Redirect URI for interactive flows; undefined for non-interactive use. */
  readonly redirectUrl?: string;
  /** Client metadata for dynamic registration in interactive flows. */
  readonly clientMetadata?: OAuthClientMetadata;
  /** Invoked with the authorization URL during interactive flows. */
  readonly onRedirect?: (url: URL) => void | Promise<void>;
  /** Fixed state value for interactive flows; a random one is generated otherwise. */
  readonly state?: string;
}

export class PersistentOAuthClientProvider implements OAuthClientProvider {
  readonly #options: PersistentOAuthClientProviderOptions;
  #codeVerifier: string | undefined;
  #generatedState: string | undefined;

  constructor(options: PersistentOAuthClientProviderOptions) {
    this.#options = options;
  }

  get redirectUrl(): string | URL | undefined {
    // A redirect URL must always be visible to the SDK: a provider without one
    // is treated as a non-interactive (client_credentials) flow and never gets
    // the refresh branch. Non-interactive use never opens this URL (see
    // `redirectToAuthorization`).
    return this.#options.redirectUrl ?? DEFAULT_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.#options.clientMetadata ?? DEFAULT_CLIENT_METADATA;
  }

  state(): string | Promise<string> {
    const fixed = this.#options.state;
    if (fixed !== undefined) return fixed;
    this.#generatedState ??= randomBytes(16).toString("base64url");
    return this.#generatedState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.#options.session.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.#options.session.clientInformation = clientInformation;
    await this.#options.onSave(this.#options.session);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.#options.session.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.#options.session.tokens = tokens;
    await this.#options.onSave(this.#options.session);
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.#options.session.discoveryState = state;
    await this.#options.onSave(this.#options.session);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.#options.session.discoveryState;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.#codeVerifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this.#codeVerifier) {
      throw new Error("no PKCE code verifier saved for this authorization");
    }
    return this.#codeVerifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.#options.onRedirect) {
      throw new NeedsLoginError(
        `Authorization required: open ${authorizationUrl.origin}/oauth/authorize in a browser, or run \`unicas login\``,
      );
    }
    await this.#options.onRedirect(authorizationUrl);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const session = this.#options.session;
    if (scope === "tokens" || scope === "all") session.tokens = undefined;
    if (scope === "client" || scope === "all") session.clientInformation = undefined;
    if (scope === "verifier" || scope === "all") this.#codeVerifier = undefined;
    if (scope === "discovery" || scope === "all") session.discoveryState = undefined;
    await this.#options.onSave(session);
  }
}
