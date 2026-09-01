import {
  completeGatewayOAuthAuthorization,
  startGatewayOAuthAuthorization,
  type GatewayOAuthAuthorizationPorts,
  type GatewayOAuthPendingAuthorization,
} from "./authorization.js";
import {
  registerGatewayOAuthClient,
  type GatewayOAuthClientRegistrationPorts,
  type GatewayOAuthClientRegistrationRequest,
} from "./client-registration.js";
import { GatewayOAuthProtocolError } from "./errors.js";
import { canonicalizeGatewayOAuthIssuer } from "./metadata.js";
import type { GatewayOAuthAuthenticatedUser, GatewayOAuthIdentityPort } from "./ports.js";
import {
  exchangeGatewayOAuthAuthorizationCode,
  refreshGatewayOAuthAccessToken,
  revokeGatewayOAuthRefreshToken,
  type GatewayOAuthTokenPorts,
} from "./token.js";

export interface GatewayOAuthConsentView {
  readonly authorization: GatewayOAuthPendingAuthorization;
  readonly user: GatewayOAuthAuthenticatedUser;
  readonly decisionEndpoint: string;
}

export interface GatewayOAuthAuthorizationServerHandlerConfig {
  readonly issuer: string;
  readonly identity: GatewayOAuthIdentityPort;
  readonly registration: GatewayOAuthClientRegistrationPorts;
  readonly authorization: GatewayOAuthAuthorizationPorts;
  readonly token: GatewayOAuthTokenPorts;
  readonly renderConsent: (view: GatewayOAuthConsentView) => Response | Promise<Response>;
  readonly authenticationRequired?: (request: Request) => Response | Promise<Response>;
}

export type GatewayOAuthAuthorizationServerHandler = (request: Request) => Promise<Response | null>;

export function createGatewayOAuthAuthorizationServerHandler(
  config: GatewayOAuthAuthorizationServerHandlerConfig,
): GatewayOAuthAuthorizationServerHandler {
  const issuer = canonicalizeGatewayOAuthIssuer(config.issuer);
  const issuerUrl = new URL(issuer);
  const basePath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
  const paths = {
    authorize: `${basePath}/authorize`,
    decision: `${basePath}/authorize/decision`,
    token: `${basePath}/token`,
    register: `${basePath}/register`,
    revoke: `${basePath}/revoke`,
  };

  return async request => {
    const url = new URL(request.url);
    try {
      if (url.pathname === paths.register) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const input = await boundedJson(request) as Partial<GatewayOAuthClientRegistrationRequest>;
        if (!Array.isArray(input.redirect_uris)
          || !input.redirect_uris.every(value => typeof value === "string")) {
          throw protocolError("redirect_uris must be an array of strings");
        }
        const response = await registerGatewayOAuthClient({
          redirect_uris: input.redirect_uris,
          ...(typeof input.token_endpoint_auth_method === "string"
            ? { token_endpoint_auth_method: input.token_endpoint_auth_method }
            : {}),
          ...(typeof input.client_name === "string" ? { client_name: input.client_name } : {}),
        }, config.registration);
        return oauthJson(response, 201);
      }

      if (url.pathname === paths.authorize) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const user = await config.identity.currentUser(request);
        if (!user) {
          return config.authenticationRequired
            ? config.authenticationRequired(request)
            : oauthJson({ error: "login_required" }, 401);
        }
        const authorization = await startGatewayOAuthAuthorization({
          responseType: requiredQuery(url, "response_type"),
          clientId: requiredQuery(url, "client_id"),
          redirectUri: requiredQuery(url, "redirect_uri"),
          // Optional: when absent the gateway resolves the principal's
          // default tenant membership (server-derived, never client authority).
          ...(url.searchParams.has("tenant_id") ? { tenantId: url.searchParams.get("tenant_id")! } : {}),
          scope: requiredQuery(url, "scope"),
          codeChallenge: requiredQuery(url, "code_challenge"),
          codeChallengeMethod: requiredQuery(url, "code_challenge_method"),
          authenticatedPrincipalId: user.principalId,
          ...(url.searchParams.has("state") ? { state: url.searchParams.get("state")! } : {}),
        }, config.authorization);
        return config.renderConsent({
          authorization,
          user,
          decisionEndpoint: new URL(paths.decision, url.origin).href,
        });
      }

      if (url.pathname === paths.decision) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        // The consent form posts back to the same host that served it. The
        // issuer origin is also accepted so a gateway that hosts the OAuth
        // surface on both its app domain and its registered issuer domain
        // keeps both same-origin flows working.
        const origin = request.headers.get("Origin");
        if (origin !== url.origin && origin !== issuerUrl.origin) {
          throw new GatewayOAuthProtocolError("invalid_request", 403, "consent origin is not allowed");
        }
        const user = await config.identity.currentUser(request);
        if (!user) return oauthJson({ error: "login_required" }, 401);
        const form = await boundedForm(request);
        const decision = form.get("decision");
        if (decision !== "approve" && decision !== "deny") {
          throw protocolError("decision must be approve or deny");
        }
        const result = await completeGatewayOAuthAuthorization(
          requiredForm(form, "transaction_id"),
          { approved: decision === "approve", user },
          config.authorization,
        );
        const redirect = new URL(result.redirectUri);
        if (result.state !== null) redirect.searchParams.set("state", result.state);
        if (result.code) redirect.searchParams.set("code", result.code);
        if (result.error) redirect.searchParams.set("error", result.error);
        return new Response(null, {
          status: 303,
          headers: { Location: redirect.href, "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === paths.token) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const form = await boundedForm(request);
        const grantType = requiredForm(form, "grant_type");
        const response = grantType === "authorization_code"
          ? await exchangeGatewayOAuthAuthorizationCode({
            grantType,
            code: requiredForm(form, "code"),
            clientId: requiredForm(form, "client_id"),
            redirectUri: requiredForm(form, "redirect_uri"),
            codeVerifier: requiredForm(form, "code_verifier"),
          }, config.token)
          : await refreshGatewayOAuthAccessToken({
            grantType,
            refreshToken: requiredForm(form, "refresh_token"),
            clientId: requiredForm(form, "client_id"),
          }, config.token);
        return oauthJson(response, 200);
      }

      if (url.pathname === paths.revoke) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const form = await boundedForm(request);
        await revokeGatewayOAuthRefreshToken(
          requiredForm(form, "token"),
          requiredForm(form, "client_id"),
          config.token,
        );
        return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
      }
      return null;
    } catch (error) {
      if (error instanceof GatewayOAuthProtocolError) return error.toResponse();
      if (error instanceof SyntaxError) return protocolError("request body is invalid").toResponse();
      throw error;
    }
  };
}

async function boundedJson(request: Request): Promise<unknown> {
  return JSON.parse(await boundedBody(request, "application/json"));
}

async function boundedForm(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await boundedBody(request, "application/x-www-form-urlencoded"));
}

async function boundedBody(request: Request, expectedType: string): Promise<string> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== expectedType) {
    throw protocolError(`Content-Type must be ${expectedType}`);
  }
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > 64 * 1024) throw protocolError("request body is too large");
  const body = await request.text();
  if (body.length > 64 * 1024) throw protocolError("request body is too large");
  return body;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) throw protocolError(`${name} is required`);
  return value;
}

function requiredForm(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1 || values[0]!.length === 0) throw protocolError(`${name} is required exactly once`);
  return values[0]!;
}

function protocolError(description: string): GatewayOAuthProtocolError {
  return new GatewayOAuthProtocolError("invalid_request", 400, description);
}

function methodNotAllowed(allow: "GET" | "POST"): Response {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow } });
}

function oauthJson(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}
