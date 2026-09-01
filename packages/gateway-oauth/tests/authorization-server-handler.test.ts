import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createGatewayOAuthAuthorizationServerHandler,
  systemGatewayOAuthHash,
  type GatewayOAuthAuthorizationTransaction,
  type GatewayOAuthRegisteredClient,
  type GatewayOAuthStoredAuthorizationCode,
  type GatewayOAuthStoredRefreshToken,
} from "../src/index.js";

let clients: Map<string, GatewayOAuthRegisteredClient>;
let transactions: Map<string, GatewayOAuthAuthorizationTransaction>;
let codes: Map<string, GatewayOAuthStoredAuthorizationCode>;
let refresh: Map<string, GatewayOAuthStoredRefreshToken>;
let randomValues: string[];

beforeEach(() => {
  clients = new Map();
  transactions = new Map();
  codes = new Map();
  refresh = new Map();
  randomValues = ["client-1", "transaction-1", "code-1", "family-1", "refresh-1", "jti-1"];
});

function handler() {
  const clock = { now: () => 1_000 };
  const random = { opaque: () => randomValues.shift() ?? "random" };
  const clientStore = {
    find: async (id: string) => clients.get(id) ?? null,
    putIfAbsent: async (client: GatewayOAuthRegisteredClient) => {
      if (clients.has(client.clientId)) return false;
      clients.set(client.clientId, client);
      return true;
    },
  };
  const transactionStore = {
    putIfAbsent: async (transaction: GatewayOAuthAuthorizationTransaction) => {
      transactions.set(transaction.transactionId, transaction);
      return true;
    },
    take: async (id: string) => {
      const value = transactions.get(id) ?? null;
      transactions.delete(id);
      return value;
    },
  };
  const codeStore = {
    putIfAbsent: async (code: GatewayOAuthStoredAuthorizationCode) => {
      codes.set(code.codeHash, code);
      return true;
    },
    take: async (hash: string) => {
      const value = codes.get(hash) ?? null;
      codes.delete(hash);
      return value;
    },
  };
  const refreshStore = {
    putInitial: async (token: GatewayOAuthStoredRefreshToken) => {
      refresh.set(token.tokenHash, token);
      return true;
    },
    rotate: vi.fn(),
    revoke: vi.fn(),
  };
  return createGatewayOAuthAuthorizationServerHandler({
    issuer: "https://gateway.example/oauth",
    identity: {
      currentUser: async request => request.headers.get("Authorization") === "Session user-1"
        ? { principalId: "user-1", displayName: "User One" }
        : null,
    },
    registration: { clients: clientStore, clock, random },
    authorization: {
      clients: clientStore,
      transactions: transactionStore,
      codes: codeStore,
      memberships: {
        find: async (principalId, tenantId) => principalId === "user-1" && tenantId === "tenant-1"
          ? { tenantId, scopes: ["cas:read"] }
          : null,
        defaultForPrincipal: async (principalId) => principalId === "user-1"
          ? { tenantId: "tenant-1", scopes: ["cas:read"] }
          : null,
        provisionDefault: async (principalId, email) => {
          const local = email?.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          return local
            ? { tenantId: local, scopes: ["cas:read"] as const }
            : null;
        },
      },
      clock,
      random,
    },
    token: {
      codes: codeStore,
      refreshTokens: refreshStore,
      capabilityIssuer: { issue: async () => "capability-token" },
      audience: "https://cas.example/stacks/stack-1",
      clock,
      random,
    },
    renderConsent: view => Response.json(view),
  });
}

function form(path: string, values: Record<string, string>, headers?: HeadersInit): Request {
  return new Request(`https://gateway.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(values),
  });
}

describe("Gateway OAuth authorization server HTTP handler", () => {
  test("routes registration, authenticated authorization, consent, and code exchange", async () => {
    const fetchOAuth = handler();
    const registration = await fetchOAuth(new Request("https://gateway.example/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://app.example/callback"] }),
    }));
    expect(registration?.status).toBe(201);
    expect(await registration?.json()).toMatchObject({ client_id: "client-1" });

    const verifier = "handler-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
    const challenge = await systemGatewayOAuthHash.sha256Base64Url(verifier);
    const authorizeUrl = new URL("https://gateway.example/oauth/authorize");
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://app.example/callback",
      tenant_id: "tenant-1",
      scope: "cas:read",
      state: "state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })) authorizeUrl.searchParams.set(name, value);
    const consent = await fetchOAuth(new Request(authorizeUrl, {
      headers: { Authorization: "Session user-1" },
    }));
    expect(consent?.status).toBe(200);
    expect(await consent?.json()).toMatchObject({
      authorization: { transactionId: "transaction-1" },
      user: { principalId: "user-1" },
    });

    const approval = await fetchOAuth(form("/oauth/authorize/decision", {
      transaction_id: "transaction-1",
      decision: "approve",
    }, {
      Origin: "https://gateway.example",
      Authorization: "Session user-1",
    }));
    expect(approval?.status).toBe(303);
    expect(approval?.headers.get("Location"))
      .toBe("https://app.example/callback?state=state-1&code=code-1");

    const token = await fetchOAuth(form("/oauth/token", {
      grant_type: "authorization_code",
      code: "code-1",
      client_id: "client-1",
      redirect_uri: "https://app.example/callback",
      code_verifier: verifier,
    }));
    expect(token?.status).toBe(200);
    expect(await token?.json()).toMatchObject({
      access_token: "capability-token",
      refresh_token: "refresh-1",
      token_type: "Bearer",
    });
  });

  test("does not create authorization state before authentication", async () => {
    const fetchOAuth = handler();
    const response = await fetchOAuth(new Request(
      "https://gateway.example/oauth/authorize?response_type=code",
    ));
    expect(response?.status).toBe(401);
    expect(transactions).toHaveLength(0);
  });

  test("accepts a consent decision with a literal null Origin (proxy chains)", async () => {
    const fetchOAuth = handler();
    clients.set("client-1", {
      clientId: "client-1",
      redirectUris: ["https://app.example/callback"],
      clientName: null,
      createdAt: 1,
    });
    transactions.set("transaction-1", {
      transactionId: "transaction-1",
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      tenantId: "tenant-1",
      principalId: "user-1",
      requestedScopes: ["cas:read"],
      state: null,
      codeChallenge: "A".repeat(43),
      createdAt: 1,
      expiresAt: 2_000,
    });
    // Some browsers/proxies send Origin: "null" even for same-origin form
    // POSTs; the random transaction_id remains the CSRF protection.
    const nullOrigin = await fetchOAuth(form("/oauth/authorize/decision", {
      transaction_id: "transaction-1",
      decision: "approve",
    }, { Origin: "null", Authorization: "Session user-1" }));
    expect(nullOrigin?.status).toBe(303);
    expect(nullOrigin?.headers.get("Location"))
      .toBe("https://app.example/callback?code=client-1");
  });

  test("auto-provisions the account tenant from the email on first login", async () => {
    const clock = { now: () => 1_000 };
    const random = { opaque: () => "transaction-2" };
    const challenge = await systemGatewayOAuthHash.sha256Base64Url(
      "provision-verifier-abcdefghijklmnopqrstuvwxyz-0123456789",
    );
    const clients = new Map<string, GatewayOAuthRegisteredClient>();
    clients.set("client-1", {
      clientId: "client-1",
      redirectUris: ["https://app.example/callback"],
      clientName: null,
      createdAt: 1,
    });
    const transactions = new Map<string, GatewayOAuthAuthorizationTransaction>();
    const provisioned: Array<{ principalId: string; email?: string }> = [];
    const provisionHandler = createGatewayOAuthAuthorizationServerHandler({
      issuer: "https://gateway.example/oauth",
      identity: {
        currentUser: async () => ({
          principalId: "user-2",
          displayName: "Alice",
          email: "alice@example.com",
        }),
      },
      registration: {
        clients: {
          find: async id => clients.get(id) ?? null,
          putIfAbsent: async () => true,
        },
        clock,
        random,
      },
      authorization: {
        clients: {
          find: async id => clients.get(id) ?? null,
          putIfAbsent: async () => true,
        },
        transactions: {
          putIfAbsent: async transaction => {
            transactions.set(transaction.transactionId, transaction);
            return true;
          },
          take: async id => {
            const value = transactions.get(id) ?? null;
            transactions.delete(id);
            return value;
          },
        },
        codes: {
          putIfAbsent: async () => true,
          take: async () => null,
        },
        memberships: {
          find: async () => null,
          defaultForPrincipal: async () => null,
          provisionDefault: async (principalId, email) => {
            provisioned.push({ principalId, email });
            return { tenantId: "alice", scopes: ["cas:read"] as const };
          },
        },
        clock,
        random,
      },
      token: {
        codes: { putIfAbsent: async () => true, take: async () => null },
        refreshTokens: {
          putInitial: async () => true,
          rotate: vi.fn(),
          revoke: vi.fn(),
        },
        capabilityIssuer: { issue: async () => "capability-token" },
        audience: "https://cas.example/stacks/stack-1",
        clock,
        random,
      },
      renderConsent: view => Response.json(view),
    });

    const authorizeUrl = new URL("https://gateway.example/oauth/authorize");
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://app.example/callback",
      scope: "cas:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })) authorizeUrl.searchParams.set(name, value);

    const consent = await provisionHandler(new Request(authorizeUrl));
    expect(consent?.status).toBe(200);
    const body = await consent?.json() as { authorization?: { tenantId?: string } };
    expect(body.authorization?.tenantId).toBe("alice");
    expect(provisioned).toEqual([{ principalId: "user-2", email: "alice@example.com" }]);
  });

  test("resolves the default tenant membership when tenant_id is absent", async () => {
    const fetchOAuth = handler();
    clients.set("client-1", {
      clientId: "client-1",
      redirectUris: ["https://app.example/callback"],
      clientName: null,
      createdAt: 1,
    });

    const challenge = await systemGatewayOAuthHash.sha256Base64Url("default-tenant-verifier-abcdefghijklmnopqrstuvwxyz-012345");
    const authorizeUrl = new URL("https://gateway.example/oauth/authorize");
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://app.example/callback",
      scope: "cas:read",
      state: "state-default",
      code_challenge: challenge,
      code_challenge_method: "S256",
      // No tenant_id: the gateway derives the principal's default tenant.
    })) authorizeUrl.searchParams.set(name, value);

    const consent = await fetchOAuth(new Request(authorizeUrl, {
      headers: { Authorization: "Session user-1" },
    }));
    expect(consent?.status).toBe(200);
    const body = await consent?.json() as { authorization?: { tenantId?: string } };
    expect(body.authorization?.tenantId).toBe("tenant-1");
  });

  test("rejects cross-origin and cross-user consent and consumes the transaction", async () => {
    const fetchOAuth = handler();
    clients.set("client-1", {
      clientId: "client-1",
      redirectUris: ["https://app.example/callback"],
      clientName: null,
      createdAt: 1,
    });
    transactions.set("transaction-1", {
      transactionId: "transaction-1",
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      tenantId: "tenant-1",
      principalId: "user-1",
      requestedScopes: ["cas:read"],
      state: null,
      codeChallenge: "A".repeat(43),
      createdAt: 1,
      expiresAt: 2_000,
    });
    const crossOrigin = await fetchOAuth(form("/oauth/authorize/decision", {
      transaction_id: "transaction-1",
      decision: "approve",
    }, { Origin: "https://attacker.example", Authorization: "Session user-1" }));
    expect(crossOrigin?.status).toBe(403);
    expect(transactions).toHaveLength(1);

    const noSession = await fetchOAuth(form("/oauth/authorize/decision", {
      transaction_id: "transaction-1",
      decision: "approve",
    }, { Origin: "https://gateway.example" }));
    expect(noSession?.status).toBe(401);
    expect(transactions).toHaveLength(1);
  });

  test("returns null for unrelated paths and rejects wrong methods and media types", async () => {
    const fetchOAuth = handler();
    await expect(fetchOAuth(new Request("https://gateway.example/documents"))).resolves.toBeNull();
    expect((await fetchOAuth(new Request("https://gateway.example/oauth/register")))?.status).toBe(405);
    const badMedia = await fetchOAuth(new Request("https://gateway.example/oauth/register", {
      method: "POST",
      body: "{}",
    }));
    expect(badMedia?.status).toBe(400);
  });
});
