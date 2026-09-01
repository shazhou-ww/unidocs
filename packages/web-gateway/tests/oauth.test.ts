import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  completeLogin,
  exchangeCode,
  generateVerifier,
  refreshSession,
  s256Challenge,
} from "../src/ui/oauth.js";

const OAUTH_BASE = "http://127.0.0.1:8787/oauth/unidocs-cloudflare";
const REDIRECT_URI = "http://127.0.0.1:5174/ui/callback";

vi.mock("../src/ui/config.js", () => ({
  API_PREFIX: "",
  GATEWAY_ORIGIN: "http://127.0.0.1:8787",
  DEFAULT_DOC_TYPES: ["docx"],
  CLIENT_NAME: "unidocs-gateway-webui",
  REDIRECT_PATH: "/ui/callback",
  REDIRECT_URI: "http://127.0.0.1:5174/ui/callback",
  OAUTH_BASE: "http://127.0.0.1:8787/oauth/unidocs-cloudflare",
  API_BASE: "http://127.0.0.1:8787",
}));

/** A capability-shaped access token with a tenantId claim. */
function accessToken(tenantId: string): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "unidocs-cap+jwt" }));
  const payload = btoa(JSON.stringify({ ver: 1, iss: "issuer", sub: "user", aud: "aud", tenantId, permissions: [] }));
  return `${header}.${payload}.signature`;
}

function mockStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  });
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => void session.set(key, value),
    removeItem: (key: string) => void session.delete(key),
    clear: () => session.clear(),
  });
}

beforeEach(() => {
  mockStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gateway webui OAuth client", () => {
  test("registers a public client once and caches the client_id", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${OAUTH_BASE}/register`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.redirect_uris).toEqual([REDIRECT_URI]);
      expect(body.token_endpoint_auth_method).toBe("none");
      return Response.json({ client_id: "client-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ensureClientId } = await import("../src/ui/oauth.js");
    expect(await ensureClientId(REDIRECT_URI)).toBe("client-1");
    expect(await ensureClientId(REDIRECT_URI)).toBe("client-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("exchanges an authorization code for a token session with the tenant from the token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${OAUTH_BASE}/register`) {
        return Response.json({ client_id: "client-1" });
      }
      if (url === `${OAUTH_BASE}/token`) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("code-1");
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("code_verifier")).toBeTruthy();
        return Response.json({
          access_token: accessToken("alice"),
          refresh_token: "rt-1",
          token_type: "Bearer",
          expires_in: 120,
          scope: "cas:read",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await exchangeCode({ code: "code-1", verifier: "verifier-1", redirectUri: REDIRECT_URI });
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBe("rt-1");
    expect(session.tenantId).toBe("alice");
    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("rotates the refresh token and keeps the tenant", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${OAUTH_BASE}/register`) return Response.json({ client_id: "client-1" });
      if (url === `${OAUTH_BASE}/token`) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("rt-1");
        return Response.json({
          access_token: accessToken("alice"),
          refresh_token: "rt-2",
          expires_in: 120,
          scope: "cas:read",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await refreshSession({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      scope: "cas:read",
      tenantId: "alice",
    });
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBe("rt-2");
    expect(session.tenantId).toBe("alice");
  });

  test("completes the authorize callback with matching state and PKCE", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${OAUTH_BASE}/register`) return Response.json({ client_id: "client-1" });
      if (url === `${OAUTH_BASE}/token`) {
        return Response.json({
          access_token: accessToken("alice"),
          refresh_token: "rt-1",
          expires_in: 120,
          scope: "cas:manage",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    sessionStorage.setItem("unidocs.oauth.state", "state-1");
    sessionStorage.setItem(
      "unidocs.oauth.pkce",
      JSON.stringify({ verifier: "verifier-1", redirectUri: REDIRECT_URI }),
    );

    const callback = new URL(`http://127.0.0.1:5174/ui/callback?code=code-1&state=state-1`);
    const session = await completeLogin(callback);
    expect(session.tenantId).toBe("alice");
  });

  test("rejects a callback with mismatched state", async () => {
    const fetchMock = vi.fn(async () => Response.json({ client_id: "client-1" }));
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.setItem("unidocs.oauth.state", "expected");
    const callback = new URL(`http://127.0.0.1:5174/ui/callback?code=code-1&state=wrong`);
    await expect(completeLogin(callback)).rejects.toThrow("state does not match");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/token"),
      expect.anything(),
    );
  });

  test("PKCE challenge matches the standard S256 derivation", async () => {
    const verifier = generateVerifier();
    expect(verifier).toHaveLength(43);
    const challenge = await s256Challenge(verifier);
    const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expectedB64 = Buffer.from(expected).toString("base64url");
    expect(challenge).toBe(expectedB64);
  });
});
