import { describe, expect, test } from "vitest";
import { configFromEnv, SessionCrypto } from "../src/admin-bff/index.js";
import { checkCsrfToken, checkSameOrigin, isMutatingMethod } from "../src/admin-bff/csrf.js";
import type { AdminSessionPayload } from "../src/admin-bff/session.js";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

describe("session crypto", () => {
  const keys = { v1: randomKey() };

  test("payloads encrypt and decrypt round-trip", async () => {
    const crypto = new SessionCrypto(keys);
    const payload: AdminSessionPayload = {
      v: 1,
      authenticated: true,
      identityIssuer: "https://accounts.google.com",
      subject: "sub-1",
      displayName: "Alice",
      emailForDisplay: "alice@example.com",
      csrfToken: "csrf-1",
    };
    const jwe = await crypto.encrypt(payload);
    await expect(crypto.decrypt(jwe)).resolves.toEqual(payload);
  });

  test("newest key encrypts and older keys still decrypt", async () => {
    const first = new SessionCrypto(keys);
    const jwe = await first.encrypt({
      v: 1,
      authenticated: false,
      identityIssuer: "",
      subject: "",
      displayName: null,
      emailForDisplay: null,
      csrfToken: "",
    });
    // Add a newer key: new sessions use it, old ones still decrypt.
    const rotated = new SessionCrypto({ v1: keys.v1!, v2: randomKey() });
    await expect(rotated.decrypt(jwe)).resolves.toMatchObject({ v: 1 });
    const newer = await rotated.encrypt({
      v: 1,
      authenticated: true,
      identityIssuer: "issuer",
      subject: "s",
      displayName: null,
      emailForDisplay: null,
      csrfToken: "t",
    });
    await expect(new SessionCrypto({ v2: randomKey() }).decrypt(newer)).rejects.toThrow();
  });

  test("malformed JWE and wrong-size keys fail closed", async () => {
    const crypto = new SessionCrypto(keys);
    await expect(crypto.decrypt("not-a-jwe")).rejects.toThrow();
    expect(() => new SessionCrypto({ bad: "short" })).toThrow();
    expect(() => new SessionCrypto({})).toThrow();
  });
});

describe("configFromEnv", () => {
  test("requires secrets, keys, and origin", () => {
    expect(() => configFromEnv({})).toThrow();
    expect(() => configFromEnv({
      GOOGLE_OIDC_CLIENT_ID: "id",
      GOOGLE_OIDC_CLIENT_SECRET: "secret",
      SESSION_ENCRYPTION_KEYS: JSON.stringify({ v1: randomKey() }),
    })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => configFromEnv({
      GOOGLE_OIDC_CLIENT_ID: "id",
      GOOGLE_OIDC_CLIENT_SECRET: "secret",
      SESSION_ENCRYPTION_KEYS: "not-json",
      PUBLIC_ORIGIN: "https://cas.example",
    })).toThrow(/SESSION_ENCRYPTION_KEYS/);
    const config = configFromEnv({
      GOOGLE_OIDC_CLIENT_ID: "id",
      GOOGLE_OIDC_CLIENT_SECRET: "secret",
      SESSION_ENCRYPTION_KEYS: JSON.stringify({ v1: randomKey() }),
      PUBLIC_ORIGIN: "https://cas.example",
      SESSION_COOKIE_SECURE: "false",
    });
    expect(config.googleClientId).toBe("id");
    expect(config.sessionCookieSecure).toBe(false);
    expect(config.oidcIssuer).toBe("https://accounts.google.com");
  });

  test("parses and cross-validates test account and email allowlist", () => {
    const baseEnv = {
      SESSION_ENCRYPTION_KEYS: JSON.stringify({ v1: randomKey() }),
      PUBLIC_ORIGIN: "https://cas.example",
    };
    expect(() => configFromEnv({
      ...baseEnv,
      ADMIN_TEST_ACCOUNT_EMAIL: "tester@example.com",
    })).toThrow(/configured together/);
    expect(() => configFromEnv({
      ...baseEnv,
      ADMIN_TEST_ACCOUNT_EMAIL: "tester@example.com",
      ADMIN_TEST_ACCOUNT_PASSWORD: "password",
      ADMIN_EMAIL_ALLOWLIST: "alice@example.com",
    })).toThrow(/must be included/);

    const config = configFromEnv({
      ...baseEnv,
      ADMIN_TEST_ACCOUNT_EMAIL: " Tester@Example.com ",
      ADMIN_TEST_ACCOUNT_PASSWORD: "password",
      ADMIN_EMAIL_ALLOWLIST: "alice@example.com, TESTER@example.com,alice@example.com",
    });
    expect(config.testAccount).toEqual({
      email: "tester@example.com",
      password: "password",
    });
    expect(config.emailAllowlist).toEqual(["alice@example.com", "tester@example.com"]);
  });
});

describe("csrf helpers", () => {
  test("origin must match the public origin exactly", () => {
    const request = new Request("https://cas.example/admin/stacks", {
      method: "POST",
      headers: { Origin: "https://cas.example" },
    });
    expect(checkSameOrigin(request, "https://cas.example")).toBe(true);
    const evil = new Request("https://cas.example/admin/stacks", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(checkSameOrigin(evil, "https://cas.example")).toBe(false);
    const none = new Request("https://cas.example/admin/stacks", { method: "POST" });
    expect(checkSameOrigin(none, "https://cas.example")).toBe(false);
  });

  test("csrf token comparison is exact", () => {
    const ok = new Request("https://cas.example/admin/stacks", {
      method: "POST",
      headers: { "X-CSRF-Token": "token-abc" },
    });
    expect(checkCsrfToken(ok, "token-abc")).toBe(true);
    const bad = new Request("https://cas.example/admin/stacks", {
      method: "POST",
      headers: { "X-CSRF-Token": "token-abd" },
    });
    expect(checkCsrfToken(bad, "token-abc")).toBe(false);
  });

  test("mutating method detection", () => {
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("PATCH")).toBe(true);
    expect(isMutatingMethod("PUT")).toBe(true);
    expect(isMutatingMethod("DELETE")).toBe(true);
    expect(isMutatingMethod("GET")).toBe(false);
  });
});
