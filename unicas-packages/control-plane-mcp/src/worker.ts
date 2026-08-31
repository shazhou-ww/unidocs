/** OAuth-protected remote MCP ingress for the Unicas control plane. */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createOAuthAuthorizationHandler } from "./auth.js";
import {
  CONTROL_PLANE_MCP_PATH,
  CONTROL_PLANE_MCP_SCOPES,
  emailAllowed,
  mcpConfigFromEnv,
} from "./config.js";
import type { ControlPlaneMcpEnvConfig } from "./config.js";
import { createControlPlaneMcpServer } from "./server.js";
import type { ControlPlaneMcpGrantProps } from "./server.js";

export interface Env extends ControlPlaneMcpEnvConfig {
  CAS_CONTROL_DB: D1Database;
  OAUTH_KV: KVNamespace;
  CAS_TENANT_AUDIT_READER?: Fetcher;
}

type ExecutionContextWithProps = ExecutionContext & {
  props?: ControlPlaneMcpGrantProps;
};

const VERIFIED_OAUTH_CONTEXT = Symbol.for("cloudflare.workers-oauth-provider.verified-context.v1");

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = mcpConfigFromEnv(env);
    const props = (ctx as ExecutionContextWithProps).props;
    if (!props) return Response.json({ error: "MCP_AUTH_CONTEXT_MISSING" }, { status: 500 });
    if (!emailAllowed(props.emailForDisplay, env.ADMIN_EMAIL_ALLOWLIST)) {
      return Response.json({ error: "MCP_ACCESS_NOT_ALLOWED" }, { status: 403 });
    }
    attachVerifiedOAuthContext(request, ctx, props, config.resource);
    const handler = createMcpHandler(
      () => createControlPlaneMcpServer(env.CAS_CONTROL_DB, {
        auditReader: env.CAS_TENANT_AUDIT_READER,
        auditReaderKey: env.CAS_AUDIT_READER_KEY,
        publicOrigin: config.publicOrigin,
        mutationsEnabled: env.MCP_MUTATIONS_ENABLED === "true",
      }),
      {
        route: CONTROL_PLANE_MCP_PATH,
        allowedOriginHostnames: [...config.allowedOriginHostnames],
        authContext: { props },
      },
    );
    return handler(request, env, ctx);
  },
};

function attachVerifiedOAuthContext(
  request: Request,
  ctx: ExecutionContext,
  props: ControlPlaneMcpGrantProps,
  resource: string,
): void {
  const target = ctx as ExecutionContext & Record<PropertyKey, unknown>;
  if (VERIFIED_OAUTH_CONTEXT in target) return;
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) throw new Error("validated MCP request is missing its bearer token");
  target[VERIFIED_OAUTH_CONTEXT] = {
    version: 1,
    token,
    clientId: props.oauthClientId,
    scopes: [...props.scopes],
    resource,
    props,
  };
}

export function createControlPlaneMcpWorker(config: ReturnType<typeof mcpConfigFromEnv>) {
  return new OAuthProvider<Env>({
    apiRoute: CONTROL_PLANE_MCP_PATH,
    apiHandler: mcpApiHandler,
    defaultHandler: createOAuthAuthorizationHandler(),
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    accessTokenTTL: 15 * 60,
    refreshTokenTTL: 8 * 60 * 60,
    scopesSupported: [...CONTROL_PLANE_MCP_SCOPES],
    tokenExchangeCallback: ({ props, requestedScope }) => ({
      accessTokenProps: {
        ...(props as ControlPlaneMcpGrantProps),
        scopes: requestedScope,
      },
    }),
    resourceMetadata: {
      resource: config.resource,
      authorization_servers: [config.publicOrigin],
      scopes_supported: [...CONTROL_PLANE_MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Unicas control plane",
    },
  });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const worker = createControlPlaneMcpWorker(mcpConfigFromEnv(env));
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;