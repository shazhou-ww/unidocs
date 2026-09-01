import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  decodeControlListCursor,
  encodeControlListCursor,
  isSupportedKeyAlgorithm,
  normalizeEmailConstraint,
  parseControlListLimit,
  sha256Hex,
  validateAudience,
  validateDisplayName,
  validateEmailConstraint,
  validateInvitationToken,
  validateIssuer,
  validateKid,
} from "../src/index.js";

describe("control-plane validation", () => {
  test("displayName bounds and control characters", () => {
    expect(validateDisplayName("My Stack")).toBeNull();
    expect(validateDisplayName("")).not.toBeNull();
    expect(validateDisplayName("   ")).not.toBeNull();
    expect(validateDisplayName("a".repeat(121))).not.toBeNull();
    expect(validateDisplayName("a\u0007b")).not.toBeNull();
    expect(validateDisplayName(42)).not.toBeNull();
  });

  test("kid is bounded and URL-safe", () => {
    expect(validateKid("k1")).toBeNull();
    expect(validateKid("key-2026_A")).toBeNull();
    expect(validateKid("")).not.toBeNull();
    expect(validateKid("key with space")).not.toBeNull();
    expect(validateKid("x".repeat(65))).not.toBeNull();
  });

  test("issuer must be an https URL without credentials", () => {
    expect(validateIssuer("https://accounts.google.com")).toBeNull();
    expect(validateIssuer("https://issuer.example/realms/x")).toBeNull();
    expect(validateIssuer("http://insecure.example")).not.toBeNull();
    expect(validateIssuer("not a url")).not.toBeNull();
    expect(validateIssuer("https://user:pass@host.example")).not.toBeNull();
  });

  test("audience and email constraint", () => {
    expect(validateAudience("unidocs-cas")).toBeNull();
    expect(validateAudience("")).not.toBeNull();
    expect(validateAudience("a".repeat(257))).not.toBeNull();
    expect(validateEmailConstraint(undefined)).toBeNull();
    expect(validateEmailConstraint(null)).toBeNull();
    expect(validateEmailConstraint("person@example.com")).toBeNull();
    expect(validateEmailConstraint("bad-email")).not.toBeNull();
    expect(normalizeEmailConstraint("  Person@Example.COM ")).toBe("person@example.com");
    expect(normalizeEmailConstraint(undefined)).toBeNull();
  });

  test("invitation tokens are bounded URL-safe strings", () => {
    expect(validateInvitationToken("a".repeat(32))).toBeNull();
    expect(validateInvitationToken("a".repeat(31))).not.toBeNull();
    expect(validateInvitationToken("a".repeat(129))).not.toBeNull();
    expect(validateInvitationToken("has space!")).not.toBeNull();
  });

  test("list limits clamp to the control-plane bounds", () => {
    expect(parseControlListLimit(undefined)).toBe(50);
    expect(parseControlListLimit(10)).toBe(10);
    expect(parseControlListLimit(200)).toBe(200);
    expect(parseControlListLimit(201)).toBeNull();
    expect(parseControlListLimit(0)).toBeNull();
    expect(parseControlListLimit(-1)).toBeNull();
    expect(parseControlListLimit(10.5)).toBeNull();
  });

  test("supported key algorithms", () => {
    expect(isSupportedKeyAlgorithm("ES256")).toBe(true);
    expect(isSupportedKeyAlgorithm("RS256")).toBe(true);
    expect(isSupportedKeyAlgorithm("EdDSA")).toBe(true);
    expect(isSupportedKeyAlgorithm("HS256")).toBe(false);
  });

  test("canonical JSON is stable and sha256 is deterministic", async () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(JSON.stringify({ b: 1, a: 2 }));
    const h1 = await sha256Hex("same");
    const h2 = await sha256Hex("same");
    const h3 = await sha256Hex("other");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).not.toBe(h3);
  });

  test("list cursors round-trip and reject malformed input", () => {
    const encoded = encodeControlListCursor({ version: 1, snapshot: 7, last: "cas_x" });
    expect(decodeControlListCursor(encoded)).toEqual({ version: 1, snapshot: 7, last: "cas_x" });
    expect(decodeControlListCursor("not-base64!")).toBeNull();
    expect(decodeControlListCursor(encodeControlListCursor({ version: 2, snapshot: 1, last: "x" }))).toBeNull();
    expect(decodeControlListCursor(encodeControlListCursor({ version: 1, snapshot: 1.5, last: "x" }))).toBeNull();
    expect(decodeControlListCursor(encodeControlListCursor({ version: 1, snapshot: 1, last: "" }))).toBeNull();
  });
});
