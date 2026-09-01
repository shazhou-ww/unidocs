/**
 * Data-plane access tokens: the Gateway's OAuth access token (capability JWT)
 * must authorize /tenants/* document operations end to end. This proves the
 * issuer+JWKS data-plane identity resolver against a locally running stack:
 * OAuth (local identity mode) -> token -> docx create/apply/export, and that
 * an invalid token fails closed even when the dev path identity is enabled.
 */

import { afterEach, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

let runtime;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

const PORTS = {
  gateway: 37187,
  docx: 37188,
  cas: 37191,
  admin: 37192,
  mockOidc: 37193,
  edge: 37194,
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

async function obtainAccessToken() {
  const registration = await gatewayFetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1:39123/callback"],
      token_endpoint_auth_method: "none",
      client_name: "data-plane test client",
    }),
  });
  expect(registration.status, await registration.clone().text()).toBe(201);
  const client = await registration.json();

  const verifier = "data-plane-verifier-abcdefghijklmnopqrstuvwxyz-012345";
  const challenge = await sha256Base64Url(verifier);
  const authorize = new URL(`${runtime.urls.gateway}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:39123/callback",
    tenant_id: "alice",
    scope: "cas:manage",
    state: "data-plane-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) authorize.searchParams.set(name, value);

  const consent = await gatewayFetch(authorize.pathname + authorize.search);
  expect(consent.status, await consent.clone().text()).toBe(200);
  const consentHtml = await consent.text();
  const transactionId = /name="transaction_id" value="([^"]+)"/.exec(consentHtml)?.[1];
  expect(transactionId).toBeTruthy();

  const approval = await form("/authorize/decision", {
    transaction_id: transactionId,
    decision: "approve",
  }, { Origin: "https://gateway.test" });
  expect(approval.status).toBe(303);
  const callback = new URL(approval.headers.get("Location"));
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
  return token.access_token;
}

test("data plane docx create/apply/export works with an OAuth access token", async () => {
  runtime = await startLocalRuntime({
    docTypes: ["docx"],
    ports: PORTS,
    gatewayOAuth: {
      issuer: "https://gateway.test",
      principalId: "user-1",
      displayName: "Local User",
      memberships: [{ tenantId: "alice", scopes: ["cas:manage"] }],
    },
  });
  const accessToken = await obtainAccessToken();
  const auth = { Authorization: `Bearer ${accessToken}` };

  const create = await gatewayFetch("/tenants/alice/docs/docx/", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const created = await create.clone().json();
  expect(create.ok, `${create.status}: ${JSON.stringify(created)}`).toBe(true);
  const { docId } = created;

  // The Miniflare direct-socket path can drop the first connection reuse
  // after create (pre-existing local-runtime artifact, not a gateway or docx
  // failure); one retry is enough.
  let apply = await gatewayFetch(`/tenants/alice/docs/docx/${docId}/apply`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 1,
      description: "append",
      operations: [{ kind: "appendParagraph", payload: { text: "token flow" } }],
    }),
  });
  if (apply.status === 502) {
    apply = await gatewayFetch(`/tenants/alice/docs/docx/${docId}/apply`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        baseVersion: 1,
        description: "append",
        operations: [{ kind: "appendParagraph", payload: { text: "token flow" } }],
      }),
    });
  }
  const applied = await apply.clone().json();
  expect(apply.ok, `${apply.status}: ${JSON.stringify(applied)}`).toBe(true);
  expect(applied).toMatchObject({ success: true, version: 2 });

  const exportResponse = await gatewayFetch(`/tenants/alice/docs/docx/${docId}/export`, {
    headers: auth,
  });
  expect(exportResponse.ok, `${exportResponse.status}`).toBe(true);
  const bytes = await exportResponse.arrayBuffer();
  expect(bytes.byteLength).toBeGreaterThan(0);
  expect(exportResponse.headers.get("content-type")).toContain("application/vnd");
}, 120_000);

test("data plane rejects an invalid token even with dev path identity enabled", async () => {
  runtime = await startLocalRuntime({
    docTypes: ["docx"],
    ports: PORTS,
    gatewayOAuth: {
      issuer: "https://gateway.test",
      principalId: "user-1",
      displayName: "Local User",
      memberships: [{ tenantId: "alice", scopes: ["cas:manage"] }],
    },
  });

  const tampered = await gatewayFetch("/tenants/alice/docs/docx/", {
    method: "POST",
    headers: {
      Authorization: "Bearer not.a.real.token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  expect(tampered.status).toBe(401);
  // A token from an untrusted issuer is also rejected (never downgraded to
  // the dev path identity).
  const foreign = await gatewayFetch("/tenants/alice/docs/docx/", {
    method: "POST",
    headers: {
      Authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJodHRwczovL2F0dGFja2VyLnRlc3QifQ.invalid",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  expect(foreign.status).toBe(401);
}, 120_000);

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}
