import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  completeGatewayOAuthAuthorization,
  exchangeGatewayOAuthAuthorizationCode,
  refreshGatewayOAuthAccessToken,
  revokeGatewayOAuthRefreshToken,
  startGatewayOAuthAuthorization,
  systemGatewayOAuthHash,
  type GatewayOAuthAuthorizationTransaction,
  type GatewayOAuthRegisteredClient,
  type GatewayOAuthStoredAuthorizationCode,
  type GatewayOAuthStoredRefreshToken,
} from "../src/index.js";

const verifier = "correct-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
const wrongVerifier = "incorrect-verifier-abcdefghijklmnopqrstuvwxyz-0123456";
let challenge: string;
let now: number;
let randomValues: string[];
let transactions: Map<string, GatewayOAuthAuthorizationTransaction>;
let codes: Map<string, GatewayOAuthStoredAuthorizationCode>;
let refreshTokens: Map<string, GatewayOAuthStoredRefreshToken>;
let usedRefreshTokens: Map<string, string>;
let revokedRefreshFamilies: Set<string>;
let issued: Array<Record<string, unknown>>;

beforeEach(async () => {
  challenge = await systemGatewayOAuthHash.sha256Base64Url(verifier);
  now = 1_000;
  randomValues = [
    "transaction-id",
    "authorization-code",
    "refresh-family",
    "refresh-token",
    "access-token-jti",
  ];
  transactions = new Map();
  codes = new Map();
  refreshTokens = new Map();
  usedRefreshTokens = new Map();
  revokedRefreshFamilies = new Set();
  issued = [];
});

function ports(membershipScopes = ["cas:read", "cas:write"] as const) {
  const client: GatewayOAuthRegisteredClient = {
    clientId: "public-client",
    redirectUris: ["https://app.example/callback"],
    clientName: "App",
    createdAt: 1,
  };
  return {
    clients: {
      find: async (id: string) => id === client.clientId ? client : null,
      putIfAbsent: vi.fn(),
    },
    transactions: {
      putIfAbsent: async (transaction: GatewayOAuthAuthorizationTransaction) => {
        if (transactions.has(transaction.transactionId)) return false;
        transactions.set(transaction.transactionId, transaction);
        return true;
      },
      take: async (id: string) => {
        const value = transactions.get(id) ?? null;
        transactions.delete(id);
        return value;
      },
    },
    codes: {
      putIfAbsent: async (code: GatewayOAuthStoredAuthorizationCode) => {
        if (codes.has(code.codeHash)) return false;
        codes.set(code.codeHash, code);
        return true;
      },
      take: async (hash: string) => {
        const value = codes.get(hash) ?? null;
        codes.delete(hash);
        return value;
      },
    },
    memberships: {
      find: async (principalId: string, tenantId: string) =>
        principalId === "user-1" && tenantId === "tenant-1"
          ? { tenantId, scopes: membershipScopes, refDomain: "documents" }
          : null,
    },
    refreshTokens: {
      putInitial: async (token: GatewayOAuthStoredRefreshToken) => {
        if (refreshTokens.has(token.tokenHash)) return false;
        refreshTokens.set(token.tokenHash, token);
        return true;
      },
      rotate: async (input: { currentHash: string; nextHash: string; now: number }) => {
        const current = refreshTokens.get(input.currentHash);
        if (!current) {
          const replayedFamily = usedRefreshTokens.get(input.currentHash);
          if (!replayedFamily) return { status: "invalid" as const };
          revokedRefreshFamilies.add(replayedFamily);
          for (const [hash, token] of refreshTokens) {
            if (token.familyId === replayedFamily) refreshTokens.delete(hash);
          }
          return { status: "replayed" as const };
        }
        if (revokedRefreshFamilies.has(current.familyId)) return { status: "invalid" as const };
        refreshTokens.delete(input.currentHash);
        usedRefreshTokens.set(input.currentHash, current.familyId);
        const replacement = Object.freeze({
          ...current,
          tokenHash: input.nextHash,
          generation: current.generation + 1,
          createdAt: input.now,
        });
        refreshTokens.set(input.nextHash, replacement);
        return { status: "rotated" as const, token: replacement };
      },
      revoke: async (tokenHash: string, clientId: string) => {
        const token = refreshTokens.get(tokenHash);
        if (!token || token.clientId !== clientId) return;
        revokedRefreshFamilies.add(token.familyId);
        for (const [hash, candidate] of refreshTokens) {
          if (candidate.familyId === token.familyId) refreshTokens.delete(hash);
        }
      },
    },
    clock: { now: () => now },
    random: { opaque: () => randomValues.shift() ?? "fallback-random" },
  };
}

async function authorize(corePorts = ports()) {
  const pending = await startGatewayOAuthAuthorization({
    responseType: "code",
    clientId: "public-client",
    redirectUri: "https://app.example/callback",
    tenantId: "tenant-1",
    scope: "cas:read cas:write",
    state: "opaque-state",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  }, corePorts);
  return completeGatewayOAuthAuthorization(pending.transactionId, {
    approved: true,
    user: { principalId: "user-1", displayName: "User One" },
  }, corePorts);
}

describe("Gateway OAuth authorization code flow", () => {
  test("binds consent, tenant membership, PKCE, and capability issuance", async () => {
    const corePorts = ports();
    const authorization = await authorize(corePorts);
    expect(authorization).toEqual({
      redirectUri: "https://app.example/callback",
      state: "opaque-state",
      code: "authorization-code",
    });
    expect(transactions).toHaveLength(0);
    expect([...codes.values()][0]).toMatchObject({
      clientId: "public-client",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read", "cas:write"],
      refDomain: "documents",
    });

    const token = await exchangeGatewayOAuthAuthorizationCode({
      grantType: "authorization_code",
      code: authorization.code!,
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      codeVerifier: verifier,
    }, {
      codes: corePorts.codes,
      refreshTokens: corePorts.refreshTokens,
      capabilityIssuer: {
        issue: async input => {
          issued.push(input as unknown as Record<string, unknown>);
          return "signed-capability";
        },
      },
      audience: "https://cas.example/stacks/stack-1",
      clock: corePorts.clock,
      random: corePorts.random,
    });
    expect(token).toEqual({
      access_token: "signed-capability",
      token_type: "Bearer",
      expires_in: 120,
      scope: "cas:read cas:write",
      refresh_token: "refresh-token",
    });
    expect(issued[0]).toMatchObject({
      subject: "user-1",
      audience: "https://cas.example/stacks/stack-1",
      tenantId: "tenant-1",
      permissions: ["tenants:tenant-1:cas:read", "tenants:tenant-1:cas:write"],
      refDomain: "documents",
      jti: "access-token-jti",
    });
    expect(codes).toHaveLength(0);
  });

  test("burns an authorization code after a wrong verifier", async () => {
    const corePorts = ports();
    const authorization = await authorize(corePorts);
    const exchange = (codeVerifier: string) => exchangeGatewayOAuthAuthorizationCode({
      grantType: "authorization_code",
      code: authorization.code!,
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      codeVerifier,
    }, {
      codes: corePorts.codes,
      refreshTokens: corePorts.refreshTokens,
      capabilityIssuer: { issue: vi.fn() },
      audience: "cas",
      clock: corePorts.clock,
    });
    await expect(exchange(wrongVerifier)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchange(verifier)).rejects.toThrow("invalid or already used");
  });

  test("rejects redirect mismatch and plain or malformed PKCE before creating state", async () => {
    const corePorts = ports();
    const base = {
      responseType: "code",
      clientId: "public-client",
      redirectUri: "https://attacker.example/callback",
      tenantId: "tenant-1",
      scope: "cas:read",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    };
    await expect(startGatewayOAuthAuthorization(base, corePorts))
      .rejects.toThrow("redirect_uri is not registered");
    await expect(startGatewayOAuthAuthorization({
      ...base,
      redirectUri: "https://app.example/callback",
      codeChallengeMethod: "plain",
    }, corePorts)).rejects.toThrow("must be S256");
    expect(transactions).toHaveLength(0);
  });

  test("enforces membership scopes and consumes denied transactions", async () => {
    const restrictedPorts = ports(["cas:read"]);
    await expect(authorize(restrictedPorts)).rejects.toMatchObject({
      code: "invalid_scope",
      status: 403,
    });
    expect(transactions).toHaveLength(0);

    randomValues = ["denied-transaction"];
    const pending = await startGatewayOAuthAuthorization({
      responseType: "code",
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      tenantId: "tenant-1",
      scope: "cas:read",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }, restrictedPorts);
    const denied = await completeGatewayOAuthAuthorization(pending.transactionId, {
      approved: false,
      user: { principalId: "user-1", displayName: null },
    }, restrictedPorts);
    expect(denied).toEqual({
      redirectUri: "https://app.example/callback",
      state: null,
      error: "access_denied",
    });
    await expect(completeGatewayOAuthAuthorization(pending.transactionId, {
      approved: false,
      user: { principalId: "user-1", displayName: null },
    }, restrictedPorts)).rejects.toThrow("already used");
  });

  test("rejects expired transactions and authorization codes", async () => {
    const corePorts = ports();
    const pending = await startGatewayOAuthAuthorization({
      responseType: "code",
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      tenantId: "tenant-1",
      scope: "cas:read",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }, corePorts);
    now = pending.expiresAt;
    await expect(completeGatewayOAuthAuthorization(pending.transactionId, {
      approved: true,
      user: { principalId: "user-1", displayName: null },
    }, corePorts)).rejects.toThrow("has expired");

    now = 2_000;
    randomValues = ["transaction-2", "code-2"];
    const authorization = await authorize(corePorts);
    now += 60;
    await expect(exchangeGatewayOAuthAuthorizationCode({
      grantType: "authorization_code",
      code: authorization.code!,
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      codeVerifier: verifier,
    }, {
      codes: corePorts.codes,
      refreshTokens: corePorts.refreshTokens,
      capabilityIssuer: { issue: vi.fn() },
      audience: "cas",
      clock: corePorts.clock,
    })).rejects.toThrow("exchange failed");
  });

  test("rotates refresh tokens and revokes the family when an old token is replayed", async () => {
    const corePorts = ports();
    const authorization = await authorize(corePorts);
    const initial = await exchangeGatewayOAuthAuthorizationCode({
      grantType: "authorization_code",
      code: authorization.code!,
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      codeVerifier: verifier,
    }, {
      codes: corePorts.codes,
      refreshTokens: corePorts.refreshTokens,
      capabilityIssuer: { issue: async () => "access-1" },
      audience: "cas",
      clock: corePorts.clock,
      random: corePorts.random,
    });

    randomValues = ["refresh-token-2", "access-token-jti-2"];
    const rotated = await refreshGatewayOAuthAccessToken({
      grantType: "refresh_token",
      refreshToken: initial.refresh_token,
      clientId: "public-client",
    }, {
      codes: corePorts.codes,
      refreshTokens: corePorts.refreshTokens,
      capabilityIssuer: { issue: async () => "access-2" },
      audience: "cas",
      clock: corePorts.clock,
      random: corePorts.random,
    });
    expect(rotated).toMatchObject({
      access_token: "access-2",
      refresh_token: "refresh-token-2",
    });

    await expect(refreshGatewayOAuthAccessToken({
      grantType: "refresh_token",
      refreshToken: initial.refresh_token,
      clientId: "public-client",
    }, {
      codes: corePorts.codes,
      refreshTokens: corePorts.refreshTokens,
      capabilityIssuer: { issue: vi.fn() },
      audience: "cas",
      clock: corePorts.clock,
    })).rejects.toThrow("already used");
    expect(refreshTokens).toHaveLength(0);

    await expect(refreshGatewayOAuthAccessToken({
      grantType: "refresh_token",
      refreshToken: rotated.refresh_token,
      clientId: "public-client",
    }, {
      codes: corePorts.codes,
      refreshTokens: corePorts.refreshTokens,
      capabilityIssuer: { issue: vi.fn() },
      audience: "cas",
      clock: corePorts.clock,
    })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  test("explicit refresh-token revocation is idempotent and family-wide", async () => {
    const corePorts = ports();
    const authorization = await authorize(corePorts);
    const initial = await exchangeGatewayOAuthAuthorizationCode({
      grantType: "authorization_code",
      code: authorization.code!,
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      codeVerifier: verifier,
    }, {
      codes: corePorts.codes,
      refreshTokens: corePorts.refreshTokens,
      capabilityIssuer: { issue: async () => "access" },
      audience: "cas",
      clock: corePorts.clock,
      random: corePorts.random,
    });
    await revokeGatewayOAuthRefreshToken(initial.refresh_token, "public-client", {
      refreshTokens: corePorts.refreshTokens,
    });
    await revokeGatewayOAuthRefreshToken(initial.refresh_token, "public-client", {
      refreshTokens: corePorts.refreshTokens,
    });
    expect(refreshTokens).toHaveLength(0);
  });
});
