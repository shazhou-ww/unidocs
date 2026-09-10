import { describe, expect, test } from "vitest";
import { AdminAccessError, googleIdentityFromVerifiedClaims, googleIdentityFromConfirmedLogin, validateAdminIdentity, normalizeAdministratorEmail, requireBootstrapIdentity, requireBoundAdministrator, requireRecentAuthentication } from "../src/index.js";

const now = 1_800_000_000;
const claims = { iss: "https://accounts.google.com", sub: "google-subject", email: " Admin.Name+tag@Gmail.com ", email_verified: true, auth_time: now };
const identity = googleIdentityFromVerifiedClaims(claims, now);

describe("administrator identity policy", () => {
  test("keeps login confirmation separate from absent or old Google authentication time", () => {
    const confirmed = googleIdentityFromConfirmedLogin({ ...claims, auth_time: undefined }, now);
    expect(confirmed).toMatchObject({ authenticatedAt: null, loginConfirmedAt: now, loginConfirmation: "authorization-code-v1" });
    expect(validateAdminIdentity(confirmed, now + 100)).toEqual(confirmed);
    expect(() => requireBootstrapIdentity(confirmed, confirmed.email, now)).not.toThrow();
    expect(() => requireRecentAuthentication(confirmed, now + 300)).not.toThrow();
    expect(() => requireRecentAuthentication(confirmed, now + 301)).toThrow();
    expect(() => requireRecentAuthentication(confirmed, now - 1)).toThrow();
    const old = googleIdentityFromConfirmedLogin({ ...claims, auth_time: now - 3600 }, now);
    expect(old.authenticatedAt).toBe(now - 3600);
    expect(() => requireRecentAuthentication(old, now)).not.toThrow();
  });

  test("unmarked timestamps and token claims do not grant callback confirmation", () => {
    const unconfirmed = { ...identity, authenticatedAt: null, loginConfirmedAt: now };
    expect(() => validateAdminIdentity(unconfirmed, now)).toThrow();
    expect(() => requireRecentAuthentication(unconfirmed, now)).toThrow();
    expect(() => validateAdminIdentity({ ...identity, loginConfirmation: "authorization-code-v1" }, now)).toThrow();
    const bearer = googleIdentityFromVerifiedClaims({ ...claims, auth_time: now - 3600, loginConfirmedAt: now, loginConfirmation: "authorization-code-v1" }, now);
    expect(bearer).not.toHaveProperty("loginConfirmedAt");
    expect(() => requireRecentAuthentication(bearer, now)).toThrow();
    expect(() => googleIdentityFromVerifiedClaims({ ...claims, auth_time: undefined, iat: now }, now)).toThrow();
    expect(() => googleIdentityFromConfirmedLogin({ ...claims, auth_time: "bad" }, now)).toThrow();
  });
  test("normalizes case and whitespace without conflating Gmail aliases", () => {
    expect(identity.email).toBe("admin.name+tag@gmail.com");
    expect(normalizeAdministratorEmail("AdminName@gmail.com")).not.toBe(identity.email);
    expect(() => normalizeAdministratorEmail("not-an-email")).toThrow();
    expect(googleIdentityFromVerifiedClaims({ ...claims, iss: "accounts.google.com" }, now).issuer).toBe("https://accounts.google.com");
  });

  test.each([
    { iss: "https://attacker.example" }, { sub: "" }, { sub: "has whitespace" }, { sub: "a".repeat(256) }, { sub: "\u00e9" },
    { email_verified: false }, { email_verified: "true" }, { email: "invalid" },
    { auth_time: undefined }, { auth_time: "1800000000" }, { auth_time: now + 31 },
    { auth_time: -1 }, { auth_time: NaN },
  ])("rejects invalid verified claim fields %#", changed => {
    expect(() => googleIdentityFromVerifiedClaims({ ...claims, ...changed }, now)).toThrow(AdminAccessError);
  });

  test("requires active issuer/subject binding, not a matching email alone", () => {
    const member = { memberId: "member", issuer: identity.issuer, subject: identity.subject, active: true };
    expect(requireBoundAdministrator(identity, member)).toBe(member);
    for (const invalid of [null, { ...member, active: false }, { ...member, subject: "other" }, { ...member, issuer: "https://other.example" }]) {
      expect(() => requireBoundAdministrator(identity, invalid)).toThrow(AdminAccessError);
    }
  });

  test("requires recent authentication for privilege changes and bootstrap", () => {
    expect(() => requireRecentAuthentication(identity, now + 300)).not.toThrow();
    expect(() => requireRecentAuthentication(identity, now + 301)).toThrow(AdminAccessError);
    expect(() => requireRecentAuthentication(identity, now - 31)).toThrow(AdminAccessError);
    expect(() => requireRecentAuthentication(identity, now + 0.5)).toThrow(AdminAccessError);
    expect(() => requireRecentAuthentication({ ...identity, authenticatedAt: -1 }, 0)).toThrow(AdminAccessError);
    expect(() => requireBootstrapIdentity(identity, "ADMIN.NAME+tag@gmail.com", now)).not.toThrow();
    expect(() => requireBootstrapIdentity(identity, null, now)).toThrow(AdminAccessError);
    expect(() => requireBootstrapIdentity(identity, "other@gmail.com", now)).toThrow(AdminAccessError);
    expect(() => requireBootstrapIdentity(identity, identity.email, now + 301)).toThrow(AdminAccessError);
  });
});