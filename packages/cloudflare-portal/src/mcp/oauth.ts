import { OAuthError, OAuthProvider, type OAuthHelpers, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { ADMIN_MCP_SCOPES, normalizeAdministratorEmail, requireBoundAdministrator, validateAdminIdentity, type AdminIdentity, type AdminMcpMember, type VerifiedAdminMcpGrant } from "@unidocs/portal-service";
import { dispatchAdminMcp } from "./dispatcher.js";
import { consumeAdminMcpAuthorizationCode, consumeAdminMcpRefreshToken } from "./refresh-consumption.js";
import type { D1Database } from "@cloudflare/workers-types";
import { D1AdminMcpMembers } from "./members.js";

export interface AdminMcpOAuthEnv {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

export interface AdminMcpOAuthGrant {
  readonly memberId: string;
  readonly identity: AdminIdentity;
  readonly authorizedAt: number;
}

export interface AdminMcpOAuthOptions {
  readonly publicOrigin: string;
  readonly allowedEmails: readonly string[];
  readonly findMember?: (memberId: string) => Promise<AdminMcpMember | null>;
  readonly now?: () => number;
  readonly authorize?: (request: Request, helpers: OAuthHelpers) => Promise<Response>;
  readonly api?: (request: Request, grant: VerifiedAdminMcpGrant) => Promise<Response>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readGrant(value: unknown, now: number): AdminMcpOAuthGrant {
  if (!record(value) || typeof value.memberId !== "string" || !value.memberId
    || typeof value.authorizedAt !== "number" || !Number.isSafeInteger(value.authorizedAt)
    || value.authorizedAt < 0 || value.authorizedAt > now || now >= value.authorizedAt + 28_800
    || !record(value.identity)) throw new Error("Invalid grant");
  const identity = value.identity;
  if (typeof identity.issuer !== "string" || typeof identity.subject !== "string" || typeof identity.email !== "string"
    || (identity.authenticatedAt !== null && typeof identity.authenticatedAt !== "number")
    || (identity.loginConfirmedAt !== undefined && typeof identity.loginConfirmedAt !== "number")
    || (identity.loginConfirmation !== undefined && identity.loginConfirmation !== "authorization-code-v1")) throw new Error("Invalid identity");
  return { memberId: value.memberId, authorizedAt: value.authorizedAt, identity: validateAdminIdentity({
    issuer: identity.issuer, subject: identity.subject, email: identity.email, authenticatedAt: identity.authenticatedAt,
    loginConfirmedAt: identity.loginConfirmedAt, loginConfirmation: identity.loginConfirmation,
  }, now) };
}

function validRedirect(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    return url.protocol === "https:"
      || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
      || (["vscode:", "vscode-insiders:"].includes(url.protocol) && !!url.hostname);
  } catch { return false; }
}

function error(code: string, status = 400): Response {
  return Response.json({ error: code, error_description: "Admin MCP authorization request rejected" }, { status });
}

export function createAdminMcpOAuth(options: AdminMcpOAuthOptions) {
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || origin.protocol !== "https:") throw new Error("MCP requires a canonical HTTPS origin");
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const resource = `${origin.origin}/mcp`;
  const tokenPath = "/oauth/admin-mcp/token";
  const revokePath = "/oauth/admin-mcp/revoke";

  async function activeGrant(value: unknown, env: AdminMcpOAuthEnv): Promise<AdminMcpOAuthGrant> {
    const grant = readGrant(value, now());
    const member = await (options.findMember ? options.findMember(grant.memberId) : new D1AdminMcpMembers(env.DB).findById(grant.memberId));
    requireBoundAdministrator(grant.identity, member);
    if (!member || member.memberId !== grant.memberId
      || !options.allowedEmails.map(normalizeAdministratorEmail).includes(normalizeAdministratorEmail(member.email))) throw new Error("Access denied");
    return { ...grant, identity: { ...grant.identity, email: normalizeAdministratorEmail(member.email) } };
  }

  function createProvider(env: AdminMcpOAuthEnv, refreshToken: string | null, authorizationCode: string | null) {
    return new OAuthProvider<AdminMcpOAuthEnv>({
    apiRoute: "/mcp",
    apiHandler: { async fetch(request, env, context) {
      try {
        const props: unknown = context.props;
        const grant = await activeGrant(props, env);
        if (!record(props) || typeof props.clientId !== "string" || !Array.isArray(props.scopes)
          || !props.scopes.every((scope: unknown) => typeof scope === "string" && (ADMIN_MCP_SCOPES as readonly string[]).includes(scope))) return error("invalid_token", 401);
        if (!options.api) return error("temporarily_unavailable", 503);
        return options.api(request, { memberId: grant.memberId, identity: grant.identity, clientId: props.clientId, scopes: props.scopes });
      } catch { return error("invalid_token", 401); }
    } },
    defaultHandler: { async fetch(request, env) {
      if (!["/oauth/admin-mcp/authorize", "/oauth/admin-mcp/google/callback"].includes(new URL(request.url).pathname)) return error("invalid_request", 404);
      if (!options.authorize || !env.OAUTH_PROVIDER) return error("temporarily_unavailable", 503);
      return options.authorize(request, env.OAUTH_PROVIDER);
    } },
    authorizeEndpoint: `${origin.origin}/oauth/admin-mcp/authorize`,
    tokenEndpoint: `${origin.origin}${tokenPath}`,
    clientRegistrationEndpoint: `${origin.origin}/oauth/admin-mcp/register`,
    accessTokenTTL: 900,
    refreshTokenTTL: 28_800,
    clientRegistrationTTL: 90 * 24 * 3600,
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: false,
    scopesSupported: [...ADMIN_MCP_SCOPES],
    resourceMetadata: { resource, authorization_servers: [origin.origin], scopes_supported: ["admin:read"], bearer_methods_supported: ["header"], resource_name: "UniDocs Admin Portal" },
    clientRegistrationCallback: ({ clientMetadata }) => {
      if (clientMetadata.token_endpoint_auth_method !== "none"
        || clientMetadata.software_statement !== undefined
        || typeof clientMetadata.client_name !== "string" || !clientMetadata.client_name.trim() || clientMetadata.client_name.length > 256
        || !Array.isArray(clientMetadata.redirect_uris) || clientMetadata.redirect_uris.length < 1 || clientMetadata.redirect_uris.length > 10
        || !clientMetadata.redirect_uris.every(validRedirect)) return { code: "invalid_client_metadata", description: "A public client with valid redirect URIs is required" };
    },
    tokenExchangeCallback: async (exchange: TokenExchangeCallbackOptions) => {
      try {
        const grant = await activeGrant(exchange.props, env);
        const remaining = grant.authorizedAt + 28_800 - now();
        if (grant.memberId !== exchange.userId || (exchange.grantType === "authorization_code" && now() >= grant.authorizedAt + 300)
          || exchange.requestedScope.some(scope => !(ADMIN_MCP_SCOPES as readonly string[]).includes(scope))) throw new Error("Invalid grant");
        if (exchange.grantType === "refresh_token" || exchange.grantType === "authorization_code") {
          const refreshing = exchange.grantType === "refresh_token";
          const credential = refreshing ? refreshToken : authorizationCode;
          if (!credential || remaining < 60) throw new Error("Invalid credential");
          let consumed: boolean;
          try {
            consumed = refreshing
              ? await consumeAdminMcpRefreshToken(env.DB, credential, now(), grant.authorizedAt + 28_800)
              : await consumeAdminMcpAuthorizationCode(env.DB, credential, now(), grant.authorizedAt + 300);
          } catch {
            throw new OAuthError("temporarily_unavailable", { statusCode: 503, description: "Credential consumption is unavailable" });
          }
          if (!consumed) throw new Error("Credential already consumed");
        }
        return {
          newProps: grant,
          accessTokenProps: { ...grant, clientId: exchange.clientId, scopes: exchange.requestedScope },
          accessTokenScope: exchange.requestedScope,
          accessTokenTTL: Math.min(900, remaining),
          ...(exchange.grantType === "authorization_code" ? { refreshTokenTTL: remaining } : {}),
        };
      } catch (failure) {
        if (failure instanceof OAuthError) throw failure;
        throw new OAuthError("invalid_grant", { description: "Administrator grant is no longer valid" });
      }
    },
    onError: ({ code, status, headers }) => Response.json({ error: code, error_description: "Admin MCP authorization request rejected" }, { status, headers }),
  });
  }

  return {
    async fetch(request: Request, env: AdminMcpOAuthEnv, context: ExecutionContext, enabled = true): Promise<Response> {
      return await dispatchAdminMcp(request, { enabled, publicOrigin: origin.origin, handler: async sanitized => {
        const url = new URL(sanitized.url);
        let refreshToken: string | null = null;
        let authorizationCode: string | null = null;
        if (url.pathname === "/oauth/admin-mcp/authorize" && sanitized.method === "GET") {
          const params = url.searchParams;
          if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return error("invalid_request");
          if (params.has("resource") && params.get("resource") !== resource) return error("invalid_target");
          if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256"
            || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "")) return error("invalid_request");
          const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
          if (scopes.length === 0 || scopes.some(scope => !(ADMIN_MCP_SCOPES as readonly string[]).includes(scope))) return error("invalid_scope");
        }
        if (url.pathname === revokePath || url.pathname === tokenPath) {
          if (sanitized.method !== "POST") return error("invalid_request", 405);
          if (sanitized.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") return error("invalid_request");
          const body = new URLSearchParams(await sanitized.text());
          if ([...new Set(body.keys())].some(key => body.getAll(key).length !== 1)) return error("invalid_request");
          if (url.pathname === revokePath ? (!body.has("token") || body.has("grant_type")) : (body.has("token") || !body.has("grant_type"))) return error("invalid_request");
          if (body.has("resource") && body.get("resource") !== resource) return error("invalid_target");
          if (url.pathname === tokenPath && body.get("grant_type") === "refresh_token") refreshToken = body.get("refresh_token");
          if (url.pathname === tokenPath && body.get("grant_type") === "authorization_code") authorizationCode = body.get("code");
          url.pathname = tokenPath;
          sanitized = new Request(url, { method: "POST", headers: sanitized.headers, body: body.toString() });
        }
        const response = await createProvider(env, refreshToken, authorizationCode).fetch(sanitized, env, context);
        if (url.pathname === "/.well-known/oauth-authorization-server" && response.ok) {
          const metadata = await response.json<Record<string, unknown>>();
          return Response.json({ ...metadata, revocation_endpoint: `${origin.origin}${revokePath}` });
        }
        return response;
      } }) ?? new Response(null, { status: 404 });
    },
  };
}