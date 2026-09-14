import { expect, test, vi } from "vitest";
import { createLoopbackAuthorizationReceiver, runAdminMcpRevokeProbe } from "../../../scripts/admin-mcp-revoke-probe.mjs";

test("revoke probe rotates, revokes, reauthorizes and never logs credentials", async () => {
  const origin = "https://portal.test";
  const redirectUri = "http://127.0.0.1:43210/callback";
  const clientId = "private-client-id";
  const secrets = ["private-code-1", "private-code-2", "private-access-1", "private-access-2", "private-access-3", "private-refresh-1", "private-refresh-2", "private-refresh-3", clientId];
  let authorizationCount = 0;
  const revoked = new Set();
  const receiver = {
    redirectUri,
    authorize: vi.fn(async (authorizationUrl, state) => {
      const url = new URL(authorizationUrl);
      expect(url.searchParams.get("state")).toBe(state);
      expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(url.searchParams.get("scope")).toBe("admin:read");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      authorizationCount += 1;
      return `private-code-${authorizationCount}`;
    }),
    close: vi.fn(async () => { }),
  };
  const tokenGrant = new Map([
    ["private-access-1", "private-refresh-1"],
    ["private-access-2", "private-refresh-2"],
    ["private-access-3", "private-refresh-3"],
  ]);
  const fetcher = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({
      authorization_endpoint: `${origin}/oauth/admin-mcp/authorize`,
      token_endpoint: `${origin}/oauth/admin-mcp/token`,
      registration_endpoint: `${origin}/oauth/admin-mcp/register`,
      revocation_endpoint: `${origin}/oauth/admin-mcp/revoke`,
    });
    if (url.pathname === "/oauth/admin-mcp/register") return Response.json({ client_id: clientId, redirect_uris: [redirectUri] }, { status: 201 });
    if (url.pathname === "/oauth/admin-mcp/token") {
      const body = new URLSearchParams(init.body);
      if (body.get("grant_type") === "authorization_code") {
        const suffix = body.get("code") === "private-code-1" ? "1" : "3";
        return Response.json({ access_token: `private-access-${suffix}`, refresh_token: `private-refresh-${suffix}`, token_type: "bearer", scope: "admin:read" });
      }
      const refreshToken = body.get("refresh_token");
      if (revoked.has(refreshToken)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      expect(refreshToken).toBe("private-refresh-1");
      return Response.json({ access_token: "private-access-2", refresh_token: "private-refresh-2", token_type: "bearer", scope: "admin:read" });
    }
    if (url.pathname === "/oauth/admin-mcp/revoke") {
      const body = new URLSearchParams(init.body);
      expect(body.get("token_type_hint")).toBe("refresh_token");
      expect(body.get("client_id")).toBe(clientId);
      revoked.add(body.get("token"));
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/mcp") {
      const accessToken = new Headers(init.headers).get("authorization")?.slice("Bearer ".length);
      const refreshToken = tokenGrant.get(accessToken);
      if (!refreshToken || revoked.has(refreshToken)) return Response.json({ error: "invalid_token" }, { status: 401 });
      return Response.json({ result: { structuredContent: { memberId: "member", identity: { email: "admin@example.com" }, scopes: ["admin:read"] } } });
    }
    return new Response(null, { status: 404 });
  });
  const logs = [];
  const result = await runAdminMcpRevokeProbe({ origin, expectedEmail: "admin@example.com", receiver, fetcher, log: value => logs.push(value) });
  expect(result).toEqual({ email: "admin@example.com", scopes: ["admin:read"], revoked: true, reauthorized: true, cleanedUp: true });
  expect(receiver.authorize).toHaveBeenCalledTimes(2);
  expect(receiver.close).toHaveBeenCalledOnce();
  expect(revoked).toEqual(new Set(["private-refresh-2", "private-refresh-3"]));
  const output = logs.join("\n");
  for (const secret of secrets) expect(output).not.toContain(secret);
});

test("loopback receiver accepts only the pending state without returning the code in its page", async () => {
  let callbackBody = "";
  const receiver = await createLoopbackAuthorizationReceiver({
    timeoutMs: 1_000,
    openBrowser: async authorizationUrl => {
      const authorization = new URL(authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "private-loopback-code");
      const response = await fetch(callback);
      callbackBody = await response.text();
    },
  });
  try {
    const authorization = new URL("https://portal.test/oauth/admin-mcp/authorize");
    authorization.searchParams.set("redirect_uri", receiver.redirectUri);
    authorization.searchParams.set("state", "expected-state");
    expect(await receiver.authorize(authorization.href, "expected-state")).toBe("private-loopback-code");
    expect(callbackBody).toContain("Authorization received");
    expect(callbackBody).not.toContain("private-loopback-code");
  } finally {
    await receiver.close();
  }
});