import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://unidocs.shazhou.work";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const AUTHORIZATION_TIMEOUT_MS = 10 * 60_000;

function requireResponse(response, expectedStatus, message) {
  if (response.status !== expectedStatus) throw new Error(message);
  return response;
}

async function responseJson(response, message) {
  try {
    return await response.json();
  } catch {
    throw new Error(message);
  }
}

function canonicalOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== value) throw new Error("--origin must be a canonical HTTPS origin");
  return parsed.origin;
}

function normalizedEmail(value) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized !== value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("--expected-email must be a normalized email address");
  }
  return normalized;
}

function openDefaultBrowser(url) {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => { });
  child.unref();
}

function callbackPage(success) {
  const title = success ? "Authorization received" : "Authorization rejected";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><main><h1>${title}</h1><p>${success ? "Return to the terminal to continue the probe." : "Return to the terminal and review the probe status."}</p></main></body></html>`;
}

export async function createLoopbackAuthorizationReceiver(options = {}) {
  const openBrowser = options.openBrowser ?? openDefaultBrowser;
  const timeoutMs = options.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS;
  let pending = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback" || !pending) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    const valid = url.searchParams.get("state") === current.state && typeof url.searchParams.get("code") === "string" && !url.searchParams.has("error");
    response.writeHead(valid ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    response.end(callbackPage(valid));
    if (valid) current.resolve(url.searchParams.get("code"));
    else current.reject(new Error("OAuth authorization was rejected"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback callback listener is unavailable");
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    async authorize(authorizationUrl, state) {
      if (pending) throw new Error("Another OAuth authorization is already pending");
      const code = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null;
          reject(new Error("OAuth authorization timed out"));
        }, timeoutMs);
        pending = { state, resolve, reject, timer };
      });
      try {
        await openBrowser(authorizationUrl);
      } catch {
        clearTimeout(pending?.timer);
        pending = null;
        throw new Error("Unable to open the OAuth authorization page");
      }
      return code;
    },
    async close() {
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("OAuth callback listener closed"));
        pending = null;
      }
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function postForm(fetcher, url, body) {
  return fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

async function issueTokens(fetcher, tokenEndpoint, body) {
  const response = requireResponse(await postForm(fetcher, tokenEndpoint, body), 200, "OAuth token exchange failed");
  const tokens = await responseJson(response, "OAuth token response was invalid");
  if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string" || tokens.token_type?.toLowerCase() !== "bearer") {
    throw new Error("OAuth token response was incomplete");
  }
  return tokens;
}

async function callWhoami(fetcher, resource, accessToken) {
  const response = await fetcher(resource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": "whoami",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name: "whoami",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "admin-mcp-revoke-probe", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  if (response.status === 401) return { status: 401, identity: null };
  requireResponse(response, 200, "MCP whoami call failed");
  const payload = await responseJson(response, "MCP whoami response was invalid");
  const identity = payload?.result?.structuredContent;
  if (payload?.result?.isError || typeof identity?.identity?.email !== "string" || !Array.isArray(identity?.scopes)) {
    throw new Error("MCP whoami response was incomplete");
  }
  return { status: 200, identity };
}

async function beginAuthorization(receiver, authorizationEndpoint, client, resource) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const url = new URL(authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: receiver.redirectUri,
    response_type: "code",
    scope: "admin:read",
    resource,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const code = await receiver.authorize(url.href, state);
  return { code, verifier };
}

export async function runAdminMcpRevokeProbe(options) {
  const origin = canonicalOrigin(options.origin ?? DEFAULT_ORIGIN);
  const expectedEmail = normalizedEmail(options.expectedEmail);
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? console.log;
  const receiver = options.receiver ?? await createLoopbackAuthorizationReceiver();
  const resource = `${origin}/mcp`;
  let currentRefreshToken = null;
  let client = null;
  let revocationEndpoint = null;
  try {
    log("Admin MCP revoke probe: discovery");
    const metadataResponse = requireResponse(await fetcher(`${origin}/.well-known/oauth-authorization-server`), 200, "OAuth metadata discovery failed");
    const metadata = await responseJson(metadataResponse, "OAuth metadata response was invalid");
    const expectedEndpoints = {
      authorization_endpoint: `${origin}/oauth/admin-mcp/authorize`,
      token_endpoint: `${origin}/oauth/admin-mcp/token`,
      registration_endpoint: `${origin}/oauth/admin-mcp/register`,
      revocation_endpoint: `${origin}/oauth/admin-mcp/revoke`,
    };
    if (Object.entries(expectedEndpoints).some(([key, value]) => metadata[key] !== value)) throw new Error("OAuth metadata endpoints were not canonical");
    revocationEndpoint = metadata.revocation_endpoint;

    const registration = requireResponse(await fetcher(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "UniDocs Admin MCP revoke acceptance probe",
        redirect_uris: [receiver.redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }), 201, "Dynamic client registration failed");
    client = await responseJson(registration, "Dynamic client registration response was invalid");
    if (typeof client.client_id !== "string" || !client.redirect_uris?.includes(receiver.redirectUri)) throw new Error("Dynamic client registration response was incomplete");

    log("Admin MCP revoke probe: authorize in the browser");
    const firstAuthorization = await beginAuthorization(receiver, metadata.authorization_endpoint, client, resource);
    let tokens = await issueTokens(fetcher, metadata.token_endpoint, {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: receiver.redirectUri,
      code: firstAuthorization.code,
      code_verifier: firstAuthorization.verifier,
      resource,
    });
    currentRefreshToken = tokens.refresh_token;
    const initialIdentity = await callWhoami(fetcher, resource, tokens.access_token);
    if (initialIdentity.identity.identity.email.toLowerCase() !== expectedEmail) throw new Error("MCP identity did not match --expected-email");
    log("Admin MCP revoke probe: initial whoami verified");

    const refreshed = await issueTokens(fetcher, metadata.token_endpoint, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: currentRefreshToken,
      scope: "admin:read",
      resource,
    });
    if (refreshed.refresh_token === currentRefreshToken) throw new Error("OAuth refresh token did not rotate");
    currentRefreshToken = refreshed.refresh_token;
    tokens = refreshed;
    const refreshedIdentity = await callWhoami(fetcher, resource, tokens.access_token);
    if (refreshedIdentity.identity.identity.email.toLowerCase() !== expectedEmail) throw new Error("Refreshed MCP identity changed unexpectedly");
    log("Admin MCP revoke probe: refresh rotation verified");

    requireResponse(await postForm(fetcher, revocationEndpoint, { token: currentRefreshToken, client_id: client.client_id, token_type_hint: "refresh_token" }), 200, "RFC 7009 revocation failed");
    const revokedRefreshToken = currentRefreshToken;
    currentRefreshToken = null;
    if ((await callWhoami(fetcher, resource, tokens.access_token)).status !== 401) throw new Error("Revoked access token remained usable");
    const replay = requireResponse(await postForm(fetcher, metadata.token_endpoint, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: revokedRefreshToken,
      scope: "admin:read",
      resource,
    }), 400, "Revoked refresh token was not rejected");
    const replayError = await responseJson(replay, "Revoked refresh response was invalid");
    if (replayError.error !== "invalid_grant") throw new Error("Revoked refresh token returned the wrong error");
    log("Admin MCP revoke probe: RFC 7009 denial verified");

    log("Admin MCP revoke probe: reauthorize in the browser");
    const secondAuthorization = await beginAuthorization(receiver, metadata.authorization_endpoint, client, resource);
    const reauthorized = await issueTokens(fetcher, metadata.token_endpoint, {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: receiver.redirectUri,
      code: secondAuthorization.code,
      code_verifier: secondAuthorization.verifier,
      resource,
    });
    currentRefreshToken = reauthorized.refresh_token;
    const finalIdentity = await callWhoami(fetcher, resource, reauthorized.access_token);
    if (finalIdentity.identity.identity.email.toLowerCase() !== expectedEmail) throw new Error("Reauthorized MCP identity did not match --expected-email");
    requireResponse(await postForm(fetcher, revocationEndpoint, { token: currentRefreshToken, client_id: client.client_id, token_type_hint: "refresh_token" }), 200, "Final probe grant cleanup failed");
    currentRefreshToken = null;
    log("Admin MCP revoke probe: reauthorization verified and temporary grant revoked");
    return { email: expectedEmail, scopes: finalIdentity.identity.scopes, revoked: true, reauthorized: true, cleanedUp: true };
  } finally {
    if (currentRefreshToken && client?.client_id && revocationEndpoint) {
      await postForm(fetcher, revocationEndpoint, { token: currentRefreshToken, client_id: client.client_id, token_type_hint: "refresh_token" }).catch(() => { });
    }
    await receiver.close();
  }
}

function parseArguments(argv) {
  const options = { origin: DEFAULT_ORIGIN, expectedEmail: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--origin") options.origin = argv[++index];
    else if (argument === "--expected-email") options.expectedEmail = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runAdminMcpRevokeProbe(parseArguments(process.argv.slice(2)));
    console.log(`Admin MCP revoke probe passed for ${result.email}; no credentials were printed or persisted.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Admin MCP revoke probe failed");
    process.exitCode = 1;
  }
}