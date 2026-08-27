/**
 * In-memory fake of the Unicas control-plane edge: RFC 9728/8414 discovery,
 * RFC 7591 DCR, RFC 7009 revocation, the token endpoint, and a minimal
 * stateless MCP Streamable HTTP server. Lets every CLI test run without the
 * network or a real OAuth provider.
 */

export interface FakeToolResult {
  readonly structuredContent: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface FakeServerOptions {
  /** Number of initial MCP POSTs to reject with 401 (triggers OAuth refresh). */
  readonly authChallengeCount?: number;
  /** scopes_supported advertised in protected-resource metadata. */
  readonly scopesSupported?: readonly string[];
  /** Per-tool results returned by tools/call. */
  readonly toolResults?: Record<string, FakeToolResult>;
  /** Called for every recorded request. */
  readonly onRequest?: (request: RecordedRequest) => void;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly pathname: string;
  readonly body: unknown;
  /** Raw request body string (form-encoded token requests are not JSON). */
  readonly rawBody: string;
  readonly authorization: string | null;
}

export const FAKE_ORIGIN = "https://unicas.test";
export const FAKE_RESOURCE = `${FAKE_ORIGIN}/mcp`;

export class FakeServer {
  readonly requests: RecordedRequest[] = [];
  readonly #options: FakeServerOptions;
  #authChallengesRemaining: number;

  constructor(options: FakeServerOptions = {}) {
    this.#options = options;
    this.#authChallengesRemaining = options.authChallengeCount ?? 0;
  }

  get fetch(): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit) => this.#handle(input, init);
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body instanceof URLSearchParams
      ? init.body.toString()
      : typeof init?.body === "string" ? init.body : "";
    const body = rawBody.length > 0 ? parseJson(rawBody) : undefined;
    const authorization = extractHeader(init?.headers, "authorization");
    this.requests.push({
      method,
      url: url.toString(),
      pathname: url.pathname,
      body,
      rawBody,
      authorization,
    });
    this.#options.onRequest?.(this.requests[this.requests.length - 1]);

    if (url.pathname === "/mcp" && method === "GET") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    if (url.pathname === "/mcp" && method === "POST") {
      return this.#handleMcp(body);
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json(200, {
        resource: FAKE_RESOURCE,
        authorization_servers: [FAKE_ORIGIN],
        scopes_supported: [...(this.#options.scopesSupported ?? ["control:read", "control:write", "control:security"])],
        bearer_methods_supported: ["header"],
        resource_name: "Unicas control plane",
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: FAKE_ORIGIN,
        authorization_endpoint: `${FAKE_ORIGIN}/oauth/authorize`,
        token_endpoint: `${FAKE_ORIGIN}/oauth/token`,
        registration_endpoint: `${FAKE_ORIGIN}/oauth/register`,
        revocation_endpoint: `${FAKE_ORIGIN}/oauth/token/revoke`,
        scopes_supported: ["control:read", "control:write", "control:security"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/oauth/register" && method === "POST") {
      const metadata = (body ?? {}) as Record<string, unknown>;
      return json(201, {
        client_id: "cli-client-1",
        client_id_issued_at: 1_700_000_000,
        client_secret_expires_at: 0,
        token_endpoint_auth_method: "none",
        redirect_uris: metadata.redirect_uris ?? [],
        grant_types: metadata.grant_types ?? [],
        response_types: metadata.response_types ?? [],
        client_name: metadata.client_name ?? "Unicas CLI",
      });
    }
    if (url.pathname === "/oauth/token" && method === "POST") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const grantType = form.get("grant_type");
      return json(200, {
        access_token: `access-${Date.now()}-${grantType}`,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: `refresh-${Date.now()}`,
        scope: form.get("scope") ?? "control:read control:write control:security",
      });
    }
    if (url.pathname === "/oauth/token/revoke" && method === "POST") {
      return new Response(null, { status: 200 });
    }
    // Path-aware discovery probe: /mcp/.well-known/... does not exist.
    if (url.pathname.endsWith("/.well-known/oauth-protected-resource")
      || url.pathname.endsWith("/.well-known/oauth-authorization-server")) {
      return new Response(null, { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }

  #handleMcp(body: unknown): Response {
    if (this.#authChallengesRemaining > 0) {
      this.#authChallengesRemaining -= 1;
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${FAKE_ORIGIN}/.well-known/oauth-protected-resource", error="invalid_token"`,
        },
      });
    }
    const message = (body ?? {}) as Record<string, unknown>;
    if (message.method === "initialize") {
      const params = (message.params ?? {}) as { protocolVersion?: string };
      // A compliant server negotiates to a version the client supports; the
      // real agents-based server does the same for older SDK clients.
      const protocolVersion = params.protocolVersion ?? "2025-11-25";
      return jsonRpc(message, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fake-control-plane", version: "1.0.0" },
      });
    }
    if (message.method === "tools/list") {
      return jsonRpc(message, {
        tools: [
          { name: "whoami", description: "Current Unicas operator", inputSchema: { type: "object", properties: {} } },
          { name: "list_stacks", description: "List Unicas stacks", inputSchema: { type: "object", properties: {} } },
        ],
      });
    }
    if (message.method === "tools/call") {
      const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = params.name ?? "";
      const toolResult = this.#options.toolResults?.[name] ?? {
        structuredContent: { ok: true, name, arguments: params.arguments ?? {} },
      };
      return jsonRpc(message, {
        content: [{ type: "text", text: JSON.stringify(toolResult.structuredContent) }],
        structuredContent: toolResult.structuredContent,
        isError: toolResult.isError === true,
      });
    }
    return jsonRpc(message, {});
  }
}

function jsonRpc(request: Record<string, unknown>, result: unknown): Response {
  return json(200, {
    jsonrpc: "2.0",
    id: request.id ?? null,
    result,
  });
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function extractHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  const normalized = new Headers(headers);
  return normalized.get(name);
}
