import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import { renderCloudflareGatewayOAuthConsent } from "../src/oauth-consent.js";
import {
  createCloudflareGatewayOAuthIdentity,
  type CloudflareGatewayOAuthIdentityBindings,
} from "../src/oauth-identity.js";

const ISSUER = "https://gateway.test/oauth/unidocs-cloudflare";
const SESSION_KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes

describe("Cloudflare Gateway OAuth identity and consent", () => {
  test("is fail closed unless a local or OIDC mode is enabled", async () => {
    const production = createCloudflareGatewayOAuthIdentity({}, ISSUER);
    await expect(production.identity.currentUser(new Request("https://gateway.example/authorize")))
      .resolves.toBeNull();
    await expect(production.handleLogin(new Request("https://gateway.example/oauth/unidocs-cloudflare/login")))
      .resolves.toBeNull();
    expect(production.authenticationRequired(new Request("https://gateway.example/authorize")).status).toBe(401);
  });

  test("supports the explicit development-only local mode on development hosts", async () => {
    const local = createCloudflareGatewayOAuthIdentity({
      GATEWAY_OAUTH_LOCAL_IDENTITY: "unsafe-development-only",
      GATEWAY_OAUTH_LOCAL_PRINCIPAL: "user-1",
      GATEWAY_OAUTH_LOCAL_DISPLAY_NAME: "Local User",
    }, ISSUER);
    await expect(local.identity.currentUser(new Request("http://127.0.0.1:8787/authorize")))
      .resolves.toEqual({ principalId: "user-1", displayName: "Local User" });
    await expect(local.identity.currentUser(new Request("https://gateway.example/authorize")))
      .resolves.toBeNull();
  });

  test("rejects misspelled or incomplete development identity configuration", () => {
    expect(() => createCloudflareGatewayOAuthIdentity({
      GATEWAY_OAUTH_LOCAL_IDENTITY: "true",
      GATEWAY_OAUTH_LOCAL_PRINCIPAL: "user-1",
    }, ISSUER)).toThrow("invalid value");
    expect(() => createCloudflareGatewayOAuthIdentity({
      GATEWAY_OAUTH_LOCAL_IDENTITY: "unsafe-development-only",
    }, ISSUER)).toThrow("GATEWAY_OAUTH_LOCAL_PRINCIPAL");
  });

  test("runs the OIDC upstream login round trip and restores the session", async () => {
    const oidcIssuer = "https://oidc.test";
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const clientId = "gateway-client";
    let pendingNonce = "";

    const fetches: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetches.push(url);
      if (url === `${oidcIssuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: oidcIssuer,
          authorization_endpoint: `${oidcIssuer}/authorize`,
          token_endpoint: `${oidcIssuer}/token`,
          jwks_uri: `${oidcIssuer}/jwks`,
        });
      }
      if (url === `${oidcIssuer}/jwks`) {
        return Response.json({ keys: [{ ...publicJwk, kid: "oidc-key", alg: "RS256", use: "sig" }] });
      }
      if (url === `${oidcIssuer}/token`) {
        const idToken = await new SignJWT({
          nonce: pendingNonce,
          email: "alice@example.com",
          email_verified: true,
          name: "Alice",
        })
          .setProtectedHeader({ alg: "RS256", kid: "oidc-key", typ: "JWT" })
          .setIssuer(oidcIssuer)
          .setAudience(clientId)
          .setSubject("google-user-1")
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey);
        return Response.json({ id_token: idToken, access_token: "at", token_type: "Bearer" });
      }
      throw new Error(`unexpected OIDC fetch: ${url}`);
    }) as typeof fetch;

    try {
      const bindings: CloudflareGatewayOAuthIdentityBindings = {
        GATEWAY_OIDC_CLIENT_ID: clientId,
        GATEWAY_OIDC_CLIENT_SECRET: "secret",
        GATEWAY_OIDC_ISSUER: oidcIssuer,
        GATEWAY_PUBLIC_ORIGIN: "https://gateway.test",
        GATEWAY_SESSION_ENCRYPTION_KEY: SESSION_KEY,
      };
      const identity = createCloudflareGatewayOAuthIdentity(bindings, ISSUER);

      // Unauthenticated authorize request redirects to the login start.
      const required = identity.authenticationRequired(
        new Request("https://gateway.test/oauth/unidocs-cloudflare/authorize?response_type=code"),
      );
      expect(required.status).toBe(303);
      const loginUrl = new URL(required.headers.get("Location")!);
      expect(loginUrl.pathname).toBe("/oauth/unidocs-cloudflare/login");
      expect(loginUrl.searchParams.get("continue")).toContain("/authorize");

      // Login start redirects to the upstream with PKCE + sealed state.
      const started = await identity.handleLogin(new Request(loginUrl));
      expect(started!.status).toBe(303);
      const upstream = new URL(started!.headers.get("Location")!);
      expect(upstream.origin).toBe(oidcIssuer);
      expect(upstream.searchParams.get("client_id")).toBe(clientId);
      expect(upstream.searchParams.get("code_challenge_method")).toBe("S256");
      const sealedState = upstream.searchParams.get("state")!;
      expect(sealedState).toBeTruthy();

      // A forged callback state is rejected before any token exchange.
      const badCallback = await identity.handleLogin(new Request(
        "https://gateway.test/oauth/unidocs-cloudflare/login/callback?code=abc&state=forged",
      ));
      expect(badCallback!.status).toBe(400);
      expect(fetches.some(url => url.endsWith("/token"))).toBe(false);

      // Complete the round trip: unseal the state, sign the id_token with the
      // real nonce, and confirm the session is restored for currentUser.
      const state = JSON.parse(await unseal(sealedState, SESSION_KEY)) as {
        nonce: string;
        verifier: string;
        continue: string;
        exp: number;
      };
      pendingNonce = state.nonce;
      const finished = await identity.handleLogin(new Request(
        `https://gateway.test/oauth/unidocs-cloudflare/login/callback?code=exchange-code&state=${encodeURIComponent(sealedState)}`,
      ));
      expect(finished!.status).toBe(303);
      expect(new URL(finished!.headers.get("Location")!).pathname)
        .toBe("/oauth/unidocs-cloudflare/authorize");
      const sessionCookie = finished!.headers.get("Set-Cookie")!;
      expect(sessionCookie).toContain("gw_sess=");
      expect(sessionCookie).toContain("HttpOnly");

      const authenticated = await identity.identity.currentUser(
        new Request("https://gateway.test/oauth/unidocs-cloudflare/authorize", {
          headers: { Cookie: sessionCookie.split(";")[0]! },
        }),
      );
      expect(authenticated).toEqual({ principalId: "google-user-1", displayName: "Alice" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("renders a no-store, framed-off consent form with escaped untrusted labels", async () => {
    const response = renderCloudflareGatewayOAuthConsent({
      authorization: {
        transactionId: "transaction-1",
        clientId: "<client>",
        tenantId: "tenant-1",
        scopes: ["cas:read"],
        expiresAt: 1_600,
      },
      user: { principalId: "user-1", displayName: "Alice & Bob" },
      decisionEndpoint: "https://gateway.test/authorize/decision",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain("Alice &amp; Bob");
    expect(html).toContain("&lt;client&gt;");
    expect(html).not.toContain("<client>");
    expect(html).toContain('name="transaction_id" value="transaction-1"');
    expect(html).toContain('name="decision" value="approve"');
  });
});

/** Mirrors the gateway's AES-256-GCM cookie seal for round-trip tests. */
async function unseal(value: string, sessionKey: string): Promise<string> {
  const combined = base64UrlDecode(value);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionKey));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
