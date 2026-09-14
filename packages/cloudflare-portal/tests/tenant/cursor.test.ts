import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/tenant/cursor.js";

/**
 * Builds a base64url cursor from an arbitrary byte payload, the same way
 * encodeCursor does internally. Used to hand decodeCursor payloads that
 * are well-formed enough to clear the regex/length guard and reach a
 * specific branch of the decode pipeline (base64 -> UTF-8 -> JSON -> shape
 * checks), so each malformed-input test can pin down exactly which branch
 * rejects it.
 */
function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function cursorFor(value: unknown): string {
  return base64urlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

describe("cursor", () => {
  it("round-trips a key", () => {
    const key = { at: 1_757_000_000, id: "doc-1" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it("survives an id containing the delimiter", () => {
    const key = { at: 1, id: "doc:with:colons" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it("is url-safe and carries no padding", () => {
    expect(encodeCursor({ at: 1, id: "doc-1" })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses a cursor that isn't base64url", () => {
    expect(decodeCursor("not-base64!!")).toBeNull();
  });

  it("refuses an empty cursor", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("refuses a cursor past the contract's length bound", () => {
    expect(decodeCursor("A".repeat(1_025))).toBeNull();
  });

  it.each([
    ["base64url that decodes to invalid UTF-8", base64urlFromBytes(
      // '[1,"' + an invalid UTF-8 continuation byte + '"]'. Without
      // { fatal: true } this decodes (via U+FFFD replacement) to the
      // valid, right-shaped JSON [1, "\uFFFD"] and would wrongly be
      // accepted, so this case pins down the fatal flag specifically.
      new Uint8Array([0x5b, 0x31, 0x2c, 0x22, 0xff, 0x22, 0x5d]),
    )],
    ["valid UTF-8 that isn't JSON", base64urlFromBytes(new TextEncoder().encode("hello world"))],
    ["JSON that parses but isn't an array", cursorFor({ at: 1, id: "doc-1" })],
    ["an array shorter than the [at, id] pair", cursorFor([1])],
    ["an array longer than the [at, id] pair", cursorFor([1, "x", "extra"])],
    ["at that isn't a number", cursorFor(["1", "x"])],
    ["at that is negative", cursorFor([-1, "x"])],
    ["at that is fractional", cursorFor([1.5, "x"])],
    ["id that isn't a string", cursorFor([1, 5])],
    ["id that is empty", cursorFor([1, ""])],
  ] as const)("rejects %s without throwing", (_label, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});
