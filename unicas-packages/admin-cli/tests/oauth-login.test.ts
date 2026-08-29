import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildOpenBrowserCommand, runLoginFlow } from "../src/oauth/login.js";
import { TokenStore } from "../src/store.js";
import { FAKE_ORIGIN, FakeAdminApi } from "./helpers/fake-server.js";

const ISSUER = "https://mock-provider.example";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_URL = `${ISSUER}/token`;
const JWKS_URL = `${ISSUER}/jwks`;
const CLIENT_ID = "cli-google-client";
const EMAIL = "alice@example.com";

interface MockGoogle {
  readonly privateKey: CryptoKey;
  readonly publicJwk: Record<string, unknown>;
  issueIdToken: (claims: Record<string, unknown>) => Promise<string>;
}

async function createMockGoogle(): Promise<MockGoogle> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  return {
    privateKey,
    publicJwk,
    issueIdToken: (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "mock-kid" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(privateKey),
  };
}

interface OidcHolder {
  nonce: string | null;
}

/** Composes Google OIDC endpoints with the fake /admin API behind one fetch. */
function composeFetch(google: MockGoogle, admin: FakeAdminApi, holder: OidcHolder): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.toString() === DISCOVERY_URL) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN_URL,
        jwks_uri: JWKS_URL,
      });
    }
    if (url.toString() === JWKS_URL) {
      return Response.json({ keys: [{ ...google.publicJwk, kid: "mock-kid", alg: "RS256", use: "sig" }] });
    }
    if (url.toString() === TOKEN_URL) {
      const idToken = await google.issueIdToken({
        iss: ISSUER,
        sub: "google-user-123",
        aud: CLIENT_ID,
        nonce: holder.nonce ?? "any",
        email: EMAIL,
        email_verified: true,
        name: "Alice",
      });
      return Response.json({ id_token: idToken, access_token: "google-access" });
    }
    return admin.fetch(url, init);
  }) as typeof fetch;
}

let dir: string;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unicas-cli-login-"));
  store = new TokenStore({ path: join(dir, "session.json") });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runLoginFlow", () => {
  test("performs the Google OIDC dance and exchanges for a BFF session", async () => {
    const google = await createMockGoogle();
    const admin = new FakeAdminApi();
    const holder: OidcHolder = { nonce: null };
    const fetchImpl = composeFetch(google, admin, holder);
    let resolveAuthorize: (url: URL) => void = () => undefined;
    const authorizeUrlPromise = new Promise<URL>((resolve) => {
      resolveAuthorize = resolve;
    });
    let callbackPort = 0;

    const flow = runLoginFlow({
      adminOrigin: FAKE_ORIGIN,
      googleClientId: CLIENT_ID,
      googleIssuer: ISSUER,
      store,
      openBrowser: false,
      fetchImpl,
      log: () => undefined,
      onCallbackServerStarted: (port) => {
        callbackPort = port;
      },
      onAuthorizeUrl: (url) => resolveAuthorize(url),
    });
    const flowResult = flow.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const authorizeUrl = await authorizeUrlPromise;
    expect(callbackPort).toBeGreaterThan(0);
    expect(authorizeUrl.origin).toBe(ISSUER);
    expect(authorizeUrl.pathname).toBe("/authorize");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toContain(`127.0.0.1:${callbackPort}/callback`);

    const state = authorizeUrl.searchParams.get("state") ?? "";
    // The provider echoes the authorize request's nonce into the id_token.
    holder.nonce = authorizeUrl.searchParams.get("nonce") ?? null;
    const callbackResponse = await fetch(
      `http://127.0.0.1:${callbackPort}/callback?code=auth-code-1&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);

    const outcome = await flowResult;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.identity.email).toBe(EMAIL);

    const session = await store.load();
    expect(session.adminOrigin).toBe(FAKE_ORIGIN);
    expect(session.cookie).toContain("cas_admin_session=");
    expect(session.csrfToken).toBe("cli-csrf-1");
    expect(session.identity?.subject).toBe("google-user-123");

    const exchange = admin.requests.find(
      (request) => request.pathname === "/admin/auth/exchange" && request.method === "POST",
    );
    expect(exchange).toBeDefined();
    expect(exchange?.body).toMatchObject({ nonce: expect.any(String) });
    expect((exchange?.body as { idToken?: string }).idToken).toBeTruthy();
  });

  test("rejects the callback when the state does not match", async () => {
    const google = await createMockGoogle();
    const admin = new FakeAdminApi();
    const holder: OidcHolder = { nonce: null };
    let callbackPort = 0;
    let resolveAuthorize: (url: URL) => void = () => undefined;
    const authorizeUrlPromise = new Promise<URL>((resolve) => {
      resolveAuthorize = resolve;
    });

    const flow = runLoginFlow({
      adminOrigin: FAKE_ORIGIN,
      googleClientId: CLIENT_ID,
      googleIssuer: ISSUER,
      store,
      openBrowser: false,
      fetchImpl: composeFetch(google, admin, holder),
      log: () => undefined,
      onCallbackServerStarted: (port) => {
        callbackPort = port;
      },
      onAuthorizeUrl: (url) => resolveAuthorize(url),
    });
    const flowResult = flow.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await authorizeUrlPromise;
    const response = await fetch(
      `http://127.0.0.1:${callbackPort}/callback?code=evil-code&state=wrong-state`,
    );
    expect(response.status).toBe(400);
    const outcome = await flowResult;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect((outcome.error as Error).message).toMatch(/state mismatch/i);
  });
});

describe("buildOpenBrowserCommand", () => {
  test("quotes the authorization URL on Windows so cmd does not split at '&'", () => {
    const url = `${ISSUER}/authorize?response_type=code&client_id=abc&scope=openid`;
    const command = buildOpenBrowserCommand(url, "win32");
    expect(command.command).toBe("cmd");
    expect(command.windowsVerbatimArguments).toBe(true);
    expect(command.args).toEqual(["/c", "start", '""', "/b", `"${url}"`]);
    expect(command.args[4]).toContain("&client_id=abc");
  });

  test("passes the URL unmodified on macOS and Linux", () => {
    const url = `${ISSUER}/authorize?response_type=code&client_id=abc`;
    expect(buildOpenBrowserCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(buildOpenBrowserCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });
});
