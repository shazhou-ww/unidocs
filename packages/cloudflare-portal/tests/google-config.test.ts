import { expect, test } from "vitest";
import { isLocalDevOrigin, LOCAL_DEV_ORIGIN_PATTERN, portalGoogleConfigFromGateway } from "../src/index.js";

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
  [{ GATEWAY_OIDC_ISSUER: "https://untrusted.example" }, "Portal requires the Google issuer"],
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
  ["a public origin over http", "http://unidocs.shazhou.work", "Portal requires a canonical HTTPS origin, or a loopback origin for local development"],
  ["a loopback-looking hostname that is not loopback", "http://127.0.0.1.evil.test:8795", "Portal requires a canonical HTTPS origin, or a loopback origin for local development"],
  ["a loopback origin with a path", "http://127.0.0.1:8795/admin", "Portal requires a canonical origin"],
  ["a loopback origin without a port", "http://127.0.0.1", "Portal requires a canonical HTTPS origin, or a loopback origin for local development"],
])("refuses %s", (_label, origin, message) => {
  expect(() => portalGoogleConfigFromGateway(settings, origin)).toThrow(TypeError);
  expect(() => portalGoogleConfigFromGateway(settings, origin)).toThrow(message);
});

// The origin allowance is orthogonal to the issuer: a loopback origin does
// not relax it, and a loopback-looking issuer does not smuggle itself in
// through a production origin either.
test("the issuer requirement is unchanged by the origin allowance", () => {
  const wrongIssuer = { ...settings, GATEWAY_OIDC_ISSUER: "http://127.0.0.1:8793" };
  expect(() => portalGoogleConfigFromGateway(wrongIssuer, "http://127.0.0.1:8795")).toThrow("Portal requires the Google issuer");
  expect(() => portalGoogleConfigFromGateway(wrongIssuer, "https://unidocs.shazhou.work")).toThrow("Portal requires the Google issuer");
});

// `isLocalDevOrigin` and the pattern behind it are exported package API, so
// they are pinned directly here rather than only through
// `portalGoogleConfigFromGateway` — which rejects most of these on its own
// canonicality guard and so would keep passing however the predicate rotted.

test("the pattern is anchored at both ends", () => {
  // Each anchor gets its own spellings, because a suffix case cannot observe
  // the leading `^` and a prefix case cannot observe the trailing `$`: drop
  // either anchor and exactly one of the two groups below starts matching.
  // The predicate's own canonicality check would still refuse all of these,
  // which is exactly why the anchors need pinning where the anchors live.
  for (const spelling of [
    // Trailing `$`: everything after the port.
    "http://127.0.0.1:8795@evil.test",
    "http://127.0.0.1:8795.evil.test",
    "http://127.0.0.1:8795/admin",
    "http://localhost:8795@evil.test",
    "http://localhost:8795.evil.test",
    // Leading `^`: everything before the scheme.
    "xhttp://127.0.0.1:8795",
    "https://evil.test/redirect?to=http://127.0.0.1:8795",
    " http://localhost:8795",
  ]) expect(LOCAL_DEV_ORIGIN_PATTERN.test(spelling), spelling).toBe(false);
  expect(LOCAL_DEV_ORIGIN_PATTERN.test("http://127.0.0.1:8795")).toBe(true);
  expect(LOCAL_DEV_ORIGIN_PATTERN.test("http://localhost:8795")).toBe(true);
});

test("isLocalDevOrigin accepts exactly the two spellings the local runtime binds", () => {
  expect(isLocalDevOrigin("http://127.0.0.1:8795")).toBe(true);
  expect(isLocalDevOrigin("http://localhost:8795")).toBe(true);
});

// The hostile sweep, asserted against the predicate itself rather than
// against a caller that guards it first: userinfo either side of the host,
// trailing-dot and suffix hostnames, case, IPv6, the shorthand and
// decimal/octal/hex spellings of 127.0.0.1, out-of-range and malformed ports,
// whitespace (including a trailing newline — JS `$` is not Perl's), punycode,
// ideographic dots, non-http schemes, and anything carrying a path, query or
// fragment.
test.each([
  "http://127.0.0.1:8795@evil.test",
  "http://evil.test@127.0.0.1:8795",
  "http://user:pass@127.0.0.1:8795",
  "http://127.0.0.1.:8795",
  "http://127.0.0.1:8795.evil.test",
  "http://127.0.0.1.evil.test:8795",
  "http://LOCALHOST:8795",
  "http://127.0.0.1:8795 ",
  " http://127.0.0.1:8795",
  "http://127.0.0.1:8795\n",
  "http://[::1]:8795",
  "http://127.1:8795",
  "http://2130706433:8795",
  "http://0x7f000001:8795",
  "http://0177.0.0.1:8795",
  "https://127.0.0.1:8795",
  "http://127.0.0.1:123456",
  "http://127.0.0.1:99999",
  "http://127.0.0.1:65536",
  "http://xn--127-0-0-1.evil.test:8795",
  "http://127\u30020\u30020\u30021:8795",
  "http://127.0.0.1:8795/",
  "http://127.0.0.1:8795/admin",
  "http://127.0.0.1:8795?next=1",
  "http://127.0.0.1:8795#fragment",
  "http://localhost:8795@evil.test",
  "http://localhost.evil.test:8795",
  "http://localhost:8795.evil.test",
  "//127.0.0.1:8795",
  "http://127.0.0.0.1:8795",
  "ws://127.0.0.1:8795",
  "http://127.0.0.1",
  "http://127.0.0.1:",
  // Canonically `http://127.0.0.1`, which the pattern refuses for having no
  // explicit port; the predicate agrees rather than accepting one spelling of
  // an origin it rejects in the other.
  "http://127.0.0.1:80",
])("isLocalDevOrigin refuses %j whatever the caller checked", spelling => {
  expect(isLocalDevOrigin(spelling)).toBe(false);
});
