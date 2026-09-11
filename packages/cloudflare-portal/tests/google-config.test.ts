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

test.each([
  { GATEWAY_OIDC_CLIENT_ID: "" }, { GATEWAY_OIDC_CLIENT_SECRET: "" },
  { GATEWAY_OIDC_ISSUER: "https://untrusted.example" },
])("rejects missing or non-Google Gateway configuration without exposing credentials %#", changed => {
  expect(() => portalGoogleConfigFromGateway({ ...settings, ...changed }, "https://portal.example")).toThrow("Gateway Google OIDC");
  try { portalGoogleConfigFromGateway({ ...settings, ...changed }, "https://portal.example"); } catch (error) {
    expect(String(error)).not.toContain(settings.GATEWAY_OIDC_CLIENT_SECRET);
  }
});

test.each(["http://portal.example", "https://portal.example/", "https://portal.example/path", "https://user:password@portal.example", "https://portal.example?next=1"])("rejects noncanonical Portal origin %s", origin => {
  expect(() => portalGoogleConfigFromGateway(settings, origin)).toThrow();
});