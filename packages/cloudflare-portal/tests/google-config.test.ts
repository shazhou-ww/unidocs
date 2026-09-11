import { expect, test } from "vitest";
import { portalGoogleConfigFromGateway } from "../src/index.js";

const settings = {
  GATEWAY_OIDC_CLIENT_ID: "gateway-google-client",
  GATEWAY_OIDC_CLIENT_SECRET: "test-only-client-secret",
  GATEWAY_OIDC_ISSUER: "https://accounts.google.com/",
  GATEWAY_PUBLIC_ORIGIN: "https://gateway.example",
  GATEWAY_OIDC_REDIRECT_PATH: "/oauth/login/callback",
  GATEWAY_SESSION_ENCRYPTION_KEY: "not-used-by-portal",
};

test("defaults to the selected production hostname without taking over the Gateway callback", () => {
  expect(portalGoogleConfigFromGateway(settings)).toMatchObject({
    origin: "https://unidocs.shazhou.work",
    redirectUri: "https://unidocs.shazhou.work/admin/auth/callback",
    clientId: settings.GATEWAY_OIDC_CLIENT_ID,
  });
});

test("reuses Gateway Google credentials but keeps Portal origin, callback and sessions independent", () => {
  expect(portalGoogleConfigFromGateway(settings, "https://portal.example")).toEqual({
    issuer: "https://accounts.google.com",
    clientId: settings.GATEWAY_OIDC_CLIENT_ID,
    clientSecret: settings.GATEWAY_OIDC_CLIENT_SECRET,
    origin: "https://portal.example",
    redirectUri: "https://portal.example/admin/auth/callback",
  });
});

// Missing credentials and a non-Google issuer are rejected by different
// guards (see portalGoogleConfigFromGateway), so each case names its own
// message instead of sharing one substring.
test.each([
  [{ GATEWAY_OIDC_CLIENT_ID: "" }, "Gateway Google OIDC client ID and secret are required"],
  [{ GATEWAY_OIDC_CLIENT_SECRET: "" }, "Gateway Google OIDC client ID and secret are required"],
  [{ GATEWAY_OIDC_ISSUER: "https://untrusted.example" }, "Gateway requires the Google issuer"],
])("rejects missing or non-Google Gateway configuration without exposing credentials %#", (changed, message) => {
  expect(() => portalGoogleConfigFromGateway({ ...settings, ...changed }, "https://portal.example")).toThrow(message);
  try { portalGoogleConfigFromGateway({ ...settings, ...changed }, "https://portal.example"); } catch (error) {
    expect(String(error)).not.toContain(settings.GATEWAY_OIDC_CLIENT_SECRET);
  }
});

test.each(["http://portal.example", "https://portal.example/", "https://portal.example/path", "https://user:password@portal.example", "https://portal.example?next=1"])("rejects noncanonical Portal origin %s", origin => {
  expect(() => portalGoogleConfigFromGateway(settings, origin)).toThrow();
});

// Local development signs in against real Google: only the origin is
// relaxed to loopback, the issuer is untouched.
test("accepts a loopback origin for local development, still with the Google issuer", () => {
  expect(portalGoogleConfigFromGateway(settings, "http://127.0.0.1:8795")).toMatchObject({
    origin: "http://127.0.0.1:8795",
    redirectUri: "http://127.0.0.1:8795/admin/auth/callback",
    issuer: "https://accounts.google.com",
  });
  expect(portalGoogleConfigFromGateway(settings, "http://localhost:8795").origin).toBe("http://localhost:8795");
});

// A bare `toThrow(TypeError)` proves *a* guard fired, not *which* one — every
// rejection path in portalGoogleConfigFromGateway throws TypeError, so a case
// meant to fail on the origin could silently start passing on the issuer
// instead. Each case below also names the guard that must fire.
test.each([
  ["a public origin over http", { ...settings }, "http://unidocs.shazhou.work", "Portal requires a canonical HTTPS origin, or a loopback origin in local development"],
  ["a loopback-looking hostname that is not loopback", { ...settings }, "http://127.0.0.1.evil.test:8795", "Portal requires a canonical HTTPS origin, or a loopback origin in local development"],
  ["a loopback origin with a path", { ...settings }, "http://127.0.0.1:8795/admin", "Portal requires a canonical origin"],
  ["a loopback origin with a non-Google issuer", { ...settings, GATEWAY_OIDC_ISSUER: "http://accounts.example" }, "http://127.0.0.1:8795", "Gateway requires the Google issuer"],
  ["a production origin with a loopback-looking issuer", { ...settings, GATEWAY_OIDC_ISSUER: "http://127.0.0.1:8793" }, "https://unidocs.shazhou.work", "Gateway requires the Google issuer"],
])("refuses %s", (_label, override, origin, message) => {
  expect(() => portalGoogleConfigFromGateway(override, origin)).toThrow(TypeError);
  expect(() => portalGoogleConfigFromGateway(override, origin)).toThrow(message);
});
