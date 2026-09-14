import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/tenant/cursor.js";

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

  it("refuses malformed input rather than throwing", () => {
    expect(decodeCursor("not-base64!!")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ at: "no", id: 1 })))).toBeNull();
  });

  it("refuses a cursor past the contract's length bound", () => {
    expect(decodeCursor("A".repeat(1_025))).toBeNull();
  });
});
