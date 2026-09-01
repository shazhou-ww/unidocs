import { afterEach, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

let runtime;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

const PORTS = {
  gateway: 36987,
  cas: 36991,
  admin: 36992,
  mockOidc: 36993,
  edge: 36994,
};

function gatewayFetch(path, init = {}) {
  return fetch(`${runtime.urls.gateway}${path}`, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

function form(path, values, headers = {}) {
  return gatewayFetch(path, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(values),
  });
}

test("Cloudflare Gateway completes public-client OAuth and issues a UniCAS capability", async () => {
  runtime = await startLocalRuntime({
    docTypes: [],
    ports: PORTS,
    gatewayOAuth: {
      issuer: "https://gateway.test",
      principalId: "user-1",
      displayName: "Local User",
      memberships: [{ tenantId: "alice", scopes: ["cas:manage"] }],
    },
  });

  const registration = await gatewayFetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1:39123/callback"],
      token_endpoint_auth_method: "none",
      client_name: "Local conformance client",
    }),
  });
  const client = await registration.json();
  expect(registration.status, JSON.stringify(client)).toBe(201);
  expect(client).not.toHaveProperty("client_secret");

  const verifier = "cloudflare-oauth-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
  const challenge = await sha256Base64Url(verifier);
  const authorize = new URL(`${runtime.urls.gateway}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:39123/callback",
    tenant_id: "alice",
    scope: "cas:manage",
    state: "opaque-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) authorize.searchParams.set(name, value);

  const consent = await fetch(authorize, { headers: { Connection: "close" } });
  const consentHtml = await consent.text();
  expect(consent.status, consentHtml).toBe(200);
  const transactionId = /name="transaction_id" value="([^"]+)"/.exec(consentHtml)?.[1];
  expect(transactionId).toBeTruthy();

  const approval = await form("/authorize/decision", {
    transaction_id: transactionId,
    decision: "approve",
  }, { Origin: "https://gateway.test" });
  expect(approval.status).toBe(303);
  const callback = new URL(approval.headers.get("Location"));
  expect(callback.origin).toBe("http://127.0.0.1:39123");
  expect(callback.searchParams.get("state")).toBe("opaque-state");
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenResponse = await form("/token", {
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:39123/callback",
    code_verifier: verifier,
  });
  const token = await tokenResponse.json();
  expect(tokenResponse.status, JSON.stringify(token)).toBe(200);
  expect(token).toMatchObject({ token_type: "Bearer", scope: "cas:manage" });

  const usage = await fetch(
    `${runtime.urls.edge}/stacks/${runtime.stackFixture.stackId}/tenants/alice/cas/usage`,
    {
      headers: {
        Connection: "close",
        Authorization: `Bearer ${token.access_token}`,
      },
    },
  );
  expect(usage.status, await usage.clone().text()).toBe(200);

  const replayedCode = await form("/token", {
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:39123/callback",
    code_verifier: verifier,
  });
  expect(replayedCode.status).toBe(400);
  await expect(replayedCode.json()).resolves.toMatchObject({ error: "invalid_grant" });

  const refreshedResponse = await form("/token", {
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: client.client_id,
  });
  const refreshed = await refreshedResponse.json();
  expect(refreshedResponse.status, JSON.stringify(refreshed)).toBe(200);
  expect(refreshed.refresh_token).not.toBe(token.refresh_token);

  const replayedRefresh = await form("/token", {
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: client.client_id,
  });
  expect(replayedRefresh.status).toBe(400);

  const revokedFamily = await form("/token", {
    grant_type: "refresh_token",
    refresh_token: refreshed.refresh_token,
    client_id: client.client_id,
  });
  expect(revokedFamily.status).toBe(400);
}, 90_000);

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}
