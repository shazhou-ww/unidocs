import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, test, vi } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityVerifier,
  casReadPermission,
  createPkcs8CapabilityIssuer,
} from "@unidocs/service-auth";
import {
  exchangeGatewayOAuthAuthorizationCode,
  systemGatewayOAuthHash,
  type GatewayOAuthStoredAuthorizationCode,
} from "../src/index.js";

const verifierValue = "compatibility-verifier-abcdefghijklmnopqrstuvwxyz-012345";

describe("Gateway OAuth capability compatibility", () => {
  test("produces the same verifier-bound claims as direct legacy capability issuance", async () => {
    const pair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
    const issuer = await createPkcs8CapabilityIssuer({
      issuer: "https://gateway.example/oauth",
      kid: "stack-key-1",
      privateKeyPkcs8: await exportPKCS8(pair.privateKey),
      now: () => 1_000,
      generateJti: () => "unused-default-jti",
    });
    const publicJwk = await exportJWK(pair.publicKey);
    const capabilityVerifier = new CapabilityVerifier({
      issuer: "https://gateway.example/oauth",
      audience: "https://cas.example/stacks/stack-1",
      algorithm: CapabilityAlgorithm,
      jwks: { keys: [{ ...publicJwk, kid: "stack-key-1", alg: CapabilityAlgorithm }] },
      allowedPermissionKinds: ["cas:read"],
      now: () => 1_000,
    });
    const permissions = [casReadPermission("tenant-1")];
    const direct = await issuer.issue({
      subject: "user-1",
      audience: "https://cas.example/stacks/stack-1",
      tenantId: "tenant-1",
      permissions,
      refDomain: "documents",
      lifetimeSeconds: 120,
      jti: "oauth-jti",
    });

    const rawCode = "one-time-code";
    const codeHash = await systemGatewayOAuthHash.sha256Base64Url(rawCode);
    const codeChallenge = await systemGatewayOAuthHash.sha256Base64Url(verifierValue);
    const stored: GatewayOAuthStoredAuthorizationCode = {
      codeHash,
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      principalId: "user-1",
      tenantId: "tenant-1",
      scopes: ["cas:read"],
      permissions,
      codeChallenge,
      refDomain: "documents",
      createdAt: 990,
      expiresAt: 1_050,
    };
    const oauth = await exchangeGatewayOAuthAuthorizationCode({
      grantType: "authorization_code",
      code: rawCode,
      clientId: "public-client",
      redirectUri: "https://app.example/callback",
      codeVerifier: verifierValue,
    }, {
      codes: { putIfAbsent: vi.fn(), take: async hash => hash === codeHash ? stored : null },
      refreshTokens: {
        putInitial: async () => true,
        rotate: vi.fn(),
        revoke: vi.fn(),
      },
      capabilityIssuer: issuer,
      audience: "https://cas.example/stacks/stack-1",
      clock: { now: () => 1_000 },
      random: {
        opaque: byteLength => byteLength === 24
          ? "oauth-jti"
          : byteLength === 48
            ? "refresh-token"
            : "refresh-family",
      },
    });

    const [directVerified, oauthVerified] = await Promise.all([
      capabilityVerifier.verify(direct),
      capabilityVerifier.verify(oauth.access_token),
    ]);
    expect(oauthVerified.protectedHeader).toEqual(directVerified.protectedHeader);
    expect(oauthVerified.claims).toEqual(directVerified.claims);
  });
});
